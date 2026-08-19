import type { FFmpeg } from '@ffmpeg/ffmpeg';

const AUDIO_STREAM_LINE = /Stream #\d+:\d+.*:\s*Audio:/;

/**
 * Detect an audio stream by parsing what `ffmpeg -i` prints about the input.
 *
 * The bundled single-threaded core aborts inside `ffprobe`, which used to make
 * this return false for every file — silently dropping the audio of every video
 * clip from the export. Running `-i` with no output is cheap: FFmpeg lists the
 * streams, complains that no output was given, and exits without decoding.
 */
export async function fileHasAudioStream(ffmpeg: FFmpeg, memPath: string): Promise<boolean> {
  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => lines.push(message);

  ffmpeg.on('log', onLog);
  try {
    await ffmpeg.exec(['-hide_banner', '-i', memPath]);
  } catch (e) {
    console.warn('[Export] audio probe failed for', memPath, e);
  } finally {
    ffmpeg.off('log', onLog);
  }

  return lines.some((line) => AUDIO_STREAM_LINE.test(line));
}
