import type { MediaAsset } from '../types/editor';
import { useEditorStore } from '../store/editorStore';
import { collectAssetMemPaths } from './assetPaths';
import { buildExportPlan, buildFfmpegInputArgs } from './buildFilterGraph';
import { clearExportLogs, formatExportError, logExportError } from './exportLog';
import { fetchFile, loadFfmpeg } from './ffmpegLoader';
import { fileHasAudioStream } from './probeStreams';
import { WebCodecsUnsupportedError, webCodecsExportSupported } from './webcodecs/support';
import { clearExportScratch } from './webcodecs/opfs';
import { exportBlockedBy } from '../utils/offlineMedia';
import { formatBitrate, resolveExport } from '../utils/exportSettings';
import type { ResolvedExport } from '../utils/exportSettings';
import { sameAspect } from '../utils/resolution';

let activeExport: AbortController | null = null;

export function cancelExport(): void {
  activeExport?.abort(new DOMException('Export cancelled', 'AbortError'));
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function downloadFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // The click starts the fetch asynchronously; revoking immediately can truncate it.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Exports the project.
 *
 * Prefers the WebCodecs pipeline: it renders through the same WebGL compositor the
 * preview uses, so what you see is what is encoded, and it runs on the GPU. FFmpeg WASM
 * remains the fallback for browsers or media the fast path cannot handle.
 */
export async function runExport(options: { forceFfmpeg?: boolean } = {}): Promise<void> {
  const store = useEditorStore.getState();
  if (store.clips.length === 0) {
    throw new Error('Add at least one clip before exporting.');
  }
  // Offline media would encode as a silent black rectangle, and the place that gets
  // discovered is after the upload. Refusing here is the entire point of tracking it.
  const offline = exportBlockedBy(store.clips, store.mediaLibrary);
  if (offline) throw new Error(offline);

  const controller = new AbortController();
  activeExport = controller;
  clearExportLogs();
  store.setExportNotice(null);
  store.setExportProgress(0);

  try {
    if (!options.forceFfmpeg && (await webCodecsExportSupported())) {
      try {
        await runWebCodecsExport(controller.signal);
        return;
      } catch (e) {
        if (controller.signal.aborted) throw e;
        if (!(e instanceof WebCodecsUnsupportedError)) throw e;
        console.warn('[Export] fast path declined:', e.message);
        store.setExportNotice(`${e.message} Falling back to FFmpeg.`);
      }
    } else if (!options.forceFfmpeg) {
      store.setExportNotice('WebCodecs export is unavailable here — using FFmpeg.');
    }

    await runFfmpegExport(controller.signal);
  } catch (e) {
    if (isAbortError(e)) {
      store.setExportNotice('Export cancelled.');
      store.setFfmpegStatus(store.ffmpegStatus === 'error' ? 'idle' : store.ffmpegStatus);
      return;
    }
    const message = formatExportError(e);
    logExportError(e, 'failed');
    store.setFfmpegStatus('error', message);
    throw e;
  } finally {
    activeExport = null;
    setTimeout(() => store.setExportProgress(null), 1500);
  }
}

/**
 * The encoder settings for this export, with the size override checked.
 *
 * An override may scale the output but not reshape it: changing the aspect would move every
 * placed overlay and mask, which is a project edit with its own undo entry, not something an
 * export should do to a project on its way past.
 */
function outputSpec() {
  const store = useEditorStore.getState();
  const spec = resolveExport(store.exportSettings, store.settings);
  if (spec.scaled && !sameAspect(store.settings, spec)) {
    throw new Error(
      `The export size ${spec.width} × ${spec.height} is a different shape from the project ` +
        `(${store.settings.width} × ${store.settings.height}). Change the project's frame size in ` +
        `project settings, which re-anchors your overlays and masks to match.`,
    );
  }
  return spec;
}

/** One line that explains the file afterwards, in the log and in the finished notice. */
function describeSpec(spec: ResolvedExport): string {
  return (
    `${spec.width} × ${spec.height} · ${spec.fps} fps · ${formatBitrate(spec.videoBitrate)} · ` +
    `keyframes every ${spec.keyframeInterval}s · audio ${formatBitrate(spec.audioBitrate)} ` +
    `${spec.audioChannels === 1 ? 'mono' : 'stereo'}`
  );
}

async function runWebCodecsExport(signal: AbortSignal): Promise<void> {
  const store = useEditorStore.getState();
  store.setExportEngine('webcodecs');
  // Sweep any file left behind by a cancelled or crashed export.
  await clearExportScratch();

  // Lazily loaded: mediabunny's muxer and codec tables are ~500 kB and are not needed
  // until an export actually runs on the fast path.
  const { exportWithWebCodecs } = await import('./webcodecs/exportWebCodecs');

  const spec = outputSpec();
  console.log('[Export] settings', describeSpec(spec));

  const started = performance.now();
  const result = await exportWithWebCodecs(
    {
      clips: store.clips,
      mediaLibrary: store.mediaLibrary,
      settings: store.settings,
      tracks: store.tracks,
    },
    spec,
    (fraction: number) => store.setExportProgress(Math.round(fraction * 100)),
    signal,
  );

  const seconds = (performance.now() - started) / 1000;
  const speed = result.durationSeconds / seconds;
  downloadFile(result.file, `export_${Date.now()}.mp4`);
  store.setExportProgress(100);
  store.setExportNotice(
    `Exported ${result.frames} frames in ${seconds.toFixed(1)}s (${speed.toFixed(1)}× realtime) — ` +
      `${describeSpec(spec)}.`,
  );
  console.log('[Export] WebCodecs done:', result.file.size, 'bytes', `${speed.toFixed(2)}x realtime`);
}

async function runFfmpegExport(signal: AbortSignal): Promise<void> {
  const store = useEditorStore.getState();
  const { clips, mediaLibrary } = store;
  const spec = outputSpec();

  store.setExportEngine('ffmpeg');
  store.setFfmpegStatus('loading');

  const ffmpeg = await loadFfmpeg((p) => store.setExportProgress(Math.round(p * 30)));
  store.setFfmpegStatus('ready');
  signal.throwIfAborted();

  const assetsForExport: Record<string, MediaAsset> = Object.fromEntries(
    Object.entries(mediaLibrary).map(([id, a]) => [id, { ...a }]),
  );

  for (const { assetId, path, file } of collectAssetMemPaths(clips, mediaLibrary)) {
    signal.throwIfAborted();
    console.log('[Export] writeFile', path, file.name, file.size);
    await ffmpeg.writeFile(path, await fetchFile(file));

    const asset = assetsForExport[assetId];
    if (asset.type === 'video') {
      const hasAudio = await fileHasAudioStream(ffmpeg, path);
      asset.hasAudio = hasAudio;
      console.log('[Export] probe audio', path, hasAudio);
    }
  }

  // The fallback renders at the export's size and rate, not the project's, so the two engines
  // produce the same file from the same settings.
  const plan = buildExportPlan({
    clips,
    mediaLibrary: assetsForExport,
    settings: { width: spec.width, height: spec.height, fps: spec.fps },
    tracks: store.tracks,
  });

  if (plan.warnings.length > 0) {
    // Prepended, so a "falling back to FFmpeg" notice stays visible alongside it.
    const notice = `FFmpeg export: ${plan.warnings.join(' ')}`;
    const existing = useEditorStore.getState().exportNotice;
    store.setExportNotice(existing ? `${existing} ${notice}` : notice);
    console.warn('[Export]', notice);
  }

  console.group('[Export] Starting');
  console.log('Settings:', describeSpec(spec));
  console.log('Duration:', plan.duration, 's');
  console.log('Video out:', plan.videoOut, 'Audio out:', plan.audioOut);
  console.log('Inputs:', plan.inputSpecs);
  console.log('Filter complex:', plan.filterComplex);

  const fontRes = await fetch('/fonts/DejaVuSans.ttf');
  if (!fontRes.ok) {
    throw new Error(`Font not found (${fontRes.status}). Run npm run bootstrap.`);
  }
  await ffmpeg.writeFile('font.ttf', new Uint8Array(await fontRes.arrayBuffer()));

  const args = [
    ...buildFfmpegInputArgs(plan),
    '-filter_complex',
    plan.filterComplex,
    '-map',
    `[${plan.videoOut}]`,
    '-map',
    `[${plan.audioOut}]`,
    '-t',
    String(plan.duration),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    // Bitrate rather than CRF, so the number here is the same number the WebCodecs path was
    // given. CRF would produce a better file at an unpredictable size, which is exactly what
    // makes the two engines disagree about what a preset means.
    '-b:v',
    String(spec.videoBitrate),
    '-g',
    String(Math.max(1, Math.round(spec.keyframeInterval * spec.fps))),
    '-c:a',
    'aac',
    '-b:a',
    String(spec.audioBitrate),
    '-ac',
    String(spec.audioChannels),
    '-metadata',
    `creation_time=${new Date().toISOString()}`,
    '-metadata',
    'comment=Encoded in the browser with FFmpeg.',
    '-movflags',
    '+faststart',
    'output.mp4',
  ];

  console.log('[Export] ffmpeg', args.join(' '));
  console.groupEnd();

  // Registered per run and removed again: `FFmpeg.on` appends, and the instance outlives the
  // export, so a handler left behind would report the next job's progress — a library preset
  // included — as export progress.
  const onFfmpegProgress = ({ progress }: { progress: number }) => {
    store.setExportProgress(30 + Math.round(progress * 70));
  };
  ffmpeg.on('progress', onFfmpegProgress);

  const onAbort = () => ffmpeg.terminate();
  signal.addEventListener('abort', onAbort, { once: true });

  let exitCode: number;
  try {
    exitCode = await ffmpeg.exec(args);
  } finally {
    ffmpeg.off('progress', onFfmpegProgress);
    signal.removeEventListener('abort', onAbort);
  }
  console.log('[Export] exit code:', exitCode);
  signal.throwIfAborted();

  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited with code ${exitCode}. See console for FFmpeg log.`);
  }

  const data = await ffmpeg.readFile('output.mp4');
  if (!data || (data instanceof Uint8Array && data.length === 0)) {
    throw new Error('Export produced an empty file.');
  }

  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  downloadFile(new Blob([bytes], { type: 'video/mp4' }), `export_${Date.now()}.mp4`);
  await ffmpeg.deleteFile('output.mp4').catch(() => undefined);

  store.setFfmpegStatus('ready');
  store.setExportProgress(100);
  console.log('[Export] Done, size:', bytes.byteLength);
}
