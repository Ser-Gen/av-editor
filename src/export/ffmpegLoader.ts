import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?worker&url';
import { attachFfmpegLogging } from './exportLog';

let instance: FFmpeg | null = null;

export async function loadFfmpeg(
  onProgress?: (ratio: number) => void,
): Promise<FFmpeg> {
  if (instance?.loaded) return instance;

  const ffmpeg = new FFmpeg();
  attachFfmpegLogging(ffmpeg, 'Load');
  ffmpeg.on('progress', ({ progress }) => onProgress?.(progress));

  const base = '/ffmpeg';
  await ffmpeg.load({
    classWorkerURL: new URL(ffmpegWorkerUrl, import.meta.url).href,
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  instance = ffmpeg;
  return ffmpeg;
}

export function getFfmpeg(): FFmpeg | null {
  return instance;
}

export { fetchFile };
