import type { MediaAsset } from '../types/editor';
import { useEditorStore } from '../store/editorStore';
import { collectAssetMemPaths } from './assetPaths';
import { buildExportPlan, buildFfmpegInputArgs } from './buildFilterGraph';
import { clearExportLogs, formatExportError, logExportError } from './exportLog';
import { fetchFile, loadFfmpeg } from './ffmpegLoader';
import { fileHasAudioStream } from './probeStreams';

export async function runExport(): Promise<void> {
  const store = useEditorStore.getState();
  const { clips, mediaLibrary, settings } = store;

  if (clips.length === 0) {
    throw new Error('Add at least one clip before exporting.');
  }

  clearExportLogs();
  store.setExportProgress(0);
  store.setFfmpegStatus('loading');

  try {
    const ffmpeg = await loadFfmpeg((p) => store.setExportProgress(Math.round(p * 30)));
    store.setFfmpegStatus('ready');

    const assetsForExport: Record<string, MediaAsset> = Object.fromEntries(
      Object.entries(mediaLibrary).map(([id, a]) => [id, { ...a }]),
    );

    for (const { assetId, path, file } of collectAssetMemPaths(clips, mediaLibrary)) {
      console.log('[Export] writeFile', path, file.name, file.size);
      await ffmpeg.writeFile(path, await fetchFile(file));

      const asset = assetsForExport[assetId];
      if (asset.type === 'video') {
        const hasAudio = await fileHasAudioStream(ffmpeg, path);
        asset.hasAudio = hasAudio;
        console.log('[Export] probe audio', path, hasAudio);
      }
    }

    const plan = buildExportPlan({
      clips,
      mediaLibrary: assetsForExport,
      settings,
      tracks: store.tracks,
    });

    console.group('[Export] Starting');
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
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      'output.mp4',
    ];

    console.log('[Export] ffmpeg', args.join(' '));
    console.groupEnd();

    ffmpeg.on('progress', ({ progress }) => {
      store.setExportProgress(30 + Math.round(progress * 70));
    });

    const exitCode = await ffmpeg.exec(args);
    console.log('[Export] exit code:', exitCode);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}. See console for FFmpeg log.`);
    }

    const data = await ffmpeg.readFile('output.mp4');
    if (!data || (data instanceof Uint8Array && data.length === 0)) {
      throw new Error('Export produced an empty file.');
    }

    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    const blob = new Blob([bytes], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `export_${Date.now()}.mp4`;
    a.click();
    URL.revokeObjectURL(url);
    await ffmpeg.deleteFile('output.mp4').catch(() => undefined);

    store.setFfmpegStatus('ready');
    store.setExportProgress(100);
    console.log('[Export] Done, size:', bytes.byteLength);
  } catch (e) {
    const message = formatExportError(e);
    logExportError(e, 'failed');
    store.setFfmpegStatus('error', message);
    throw e;
  } finally {
    setTimeout(() => store.setExportProgress(null), 1500);
  }
}
