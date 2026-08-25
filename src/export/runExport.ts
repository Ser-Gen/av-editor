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
import { AUDIO_FORMATS, audioFileName, resolveAudioExport } from '../utils/audioExport';
import type { ResolvedAudioExport } from '../utils/audioExport';
import { ffmpegMetadataArgs, wavMetadataFormat } from '../utils/audioMetadata';
import { buildMetadataTags } from './metadataTags';
import { sameAspect } from '../utils/resolution';
import { publicUrl } from '../utils/publicUrl';

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
    // Audio-only takes neither engine's video path: it has no frames to composite, and
    // `webCodecsExportSupported()` asks about an H.264 encoder — the wrong question when
    // WAV needs no encoder at all.
    if (store.exportSettings.output === 'audio') {
      await runAudioExport(controller.signal);
      return;
    }

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

/** One line describing the audio file afterwards, matching `describeSpec` on the video side. */
function describeAudio(resolved: ResolvedAudioExport): string {
  const spec = AUDIO_FORMATS[resolved.format];
  const rate = resolved.lossless ? '16-bit' : formatBitrate(resolved.bitrate);
  return (
    `${spec.label} · ${rate} · ${(resolved.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz · ` +
    `${resolved.channels === 1 ? 'mono' : 'stereo'}`
  );
}

async function runAudioExport(signal: AbortSignal): Promise<void> {
  const store = useEditorStore.getState();
  store.setExportEngine('webcodecs');
  await clearExportScratch();

  // Lazily loaded for the same reason the video path is: mediabunny's muxers and codec tables
  // are not worth loading until an export actually runs.
  const { exportAudioTrack } = await import('./audio/exportAudioTrack');

  const resolved = resolveAudioExport(store.exportSettings);
  const metadata = store.audioMetadata;
  // Only the date is filled in by the app. The video path adds a canned comment; a music file's
  // comment field is read by people, so nothing is put there that the user did not type.
  const { tags, warning } = await buildMetadataTags(metadata, store.mediaLibrary, {
    date: new Date(),
  });
  if (warning) store.setExportNotice(warning);

  console.log('[Export] audio settings', describeAudio(resolved));
  const started = performance.now();
  const result = await exportAudioTrack(
    { clips: store.clips, mediaLibrary: store.mediaLibrary, tracks: store.tracks },
    resolved,
    tags,
    wavMetadataFormat(metadata),
    (fraction: number) => store.setExportProgress(Math.round(fraction * 100)),
    signal,
  );

  const seconds = (performance.now() - started) / 1000;
  downloadFile(result.file, audioFileName(metadata.title, resolved, Date.now()));
  store.setExportProgress(100);
  store.setExportNotice(
    [
      warning,
      `Exported ${result.durationSeconds.toFixed(1)}s of audio in ${seconds.toFixed(1)}s — ` +
        `${describeAudio(resolved)}.`,
    ]
      .filter(Boolean)
      .join(' '),
  );
  console.log('[Export] audio done:', result.file.size, 'bytes');
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

  // An MP4 carries the same descriptive fields as an MP3 — there is no reason for the video
  // export to say less about a file than the audio export does.
  const { tags, warning } = await buildMetadataTags(store.audioMetadata, store.mediaLibrary);
  if (warning) store.setExportNotice(warning);

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
    tags,
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

  if (store.audioMetadata.coverAssetId) {
    // Attaching an image through FFmpeg needs a second input and a second -map, which is a
    // different shape of change than adding a flag. Saying so beats a silently missing cover.
    const existing = useEditorStore.getState().exportNotice;
    const notice = 'Cover art is written by the WebCodecs export only, so it was left out.';
    store.setExportNotice(existing ? `${existing} ${notice}` : notice);
  }

  console.group('[Export] Starting');
  console.log('Settings:', describeSpec(spec));
  console.log('Duration:', plan.duration, 's');
  console.log('Video out:', plan.videoOut, 'Audio out:', plan.audioOut);
  console.log('Inputs:', plan.inputSpecs);
  console.log('Filter complex:', plan.filterComplex);

  const fontRes = await fetch(publicUrl('fonts/DejaVuSans.ttf'));
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
    // After the canned comment, so a typed one replaces it rather than sitting beside it.
    ...ffmpegMetadataArgs(store.audioMetadata),
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
