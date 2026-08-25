import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?worker&url';
import { attachFfmpegLogging } from './exportLog';
import { publicUrl } from '../utils/publicUrl';

let instance: FFmpeg | null = null;

export async function loadFfmpeg(
  onProgress?: (ratio: number) => void,
): Promise<FFmpeg> {
  if (instance?.loaded) return instance;

  const ffmpeg = new FFmpeg();
  attachFfmpegLogging(ffmpeg, 'Load');
  ffmpeg.on('progress', ({ progress }) => onProgress?.(progress));

  await ffmpeg.load({
    classWorkerURL: new URL(ffmpegWorkerUrl, import.meta.url).href,
    coreURL: await toBlobURL(publicUrl('ffmpeg/ffmpeg-core.js'), 'text/javascript'),
    wasmURL: await toBlobURL(publicUrl('ffmpeg/ffmpeg-core.wasm'), 'application/wasm'),
  });

  instance = ffmpeg;
  return ffmpeg;
}

export function getFfmpeg(): FFmpeg | null {
  return instance;
}

export { fetchFile };
