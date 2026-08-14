import type { FFmpeg } from '@ffmpeg/ffmpeg';

/** Detect audio stream via ffprobe after the file is in MEMFS. */
export async function fileHasAudioStream(ffmpeg: FFmpeg, memPath: string): Promise<boolean> {
  const outFile = `${memPath}.streams.json`;
  try {
    const code = await ffmpeg.ffprobe([
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      '-select_streams',
      'a',
      memPath,
      '-o',
      outFile,
    ]);
    if (code !== 0) return false;

    const raw = await ffmpeg.readFile(outFile);
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
    const parsed = JSON.parse(text) as { streams?: unknown[] };
    return Array.isArray(parsed.streams) && parsed.streams.length > 0;
  } catch {
    return false;
  } finally {
    await ffmpeg.deleteFile(outFile).catch(() => undefined);
  }
}
