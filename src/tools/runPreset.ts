import type { MediaAsset } from '../types/editor';
import { clearExportLogs, getRecentExportLogs } from '../export/exportLog';
import { fetchFile, loadFfmpeg } from '../export/ffmpegLoader';
import { commandLine, outputName, type SourceRange, type ToolPreset } from './presets';

/**
 * Running one library preset.
 *
 * The job is deliberately dumb: one file in, the recorded command line, one file out. It
 * never touches the timeline, never writes over the source, and holds nothing between
 * calls — so a failure or a cancellation leaves the library exactly as it was.
 *
 * A `range` narrows it to an excerpt — the cut a split produced, say. That is worth having
 * for more than convenience: the cost of every one of these presets is proportional to the
 * material fed through it, so running Stabilize over the six seconds that need it instead of
 * the four minutes around them is the difference between waiting and not bothering.
 *
 * Cancellation goes through `FFmpeg.terminate()`, which kills the worker mid-frame. That is
 * the only thing that actually stops a WASM encode, and it is why a job refuses to start
 * while an export is running: they share one FFmpeg instance, and terminating for one would
 * silently kill the other.
 */

export type JobPhase = 'loading' | 'writing' | 'running' | 'reading';

export interface JobProgress {
  phase: JobPhase;
  /** 0..100 across the whole job, not just the encode. */
  progress: number;
}

const MIME: Record<ToolPreset['ext'], string> = {
  mp4: 'video/mp4',
  gif: 'image/gif',
};

function extOf(name: string): string {
  const m = name.match(/\.(\w+)$/);
  return m ? m[1].toLowerCase() : 'dat';
}

/**
 * The last thing FFmpeg complained about, for a failure notice.
 *
 * FFmpeg's final words are usually the useful ones — the filter it could not parse, the
 * stream it could not find — while everything above them is banner and build flags.
 */
function lastComplaint(): string | null {
  const stderr = getRecentExportLogs().filter((line) => line.includes('[stderr]'));
  const tail = stderr
    .slice(-6)
    .map((line) => line.replace(/^\[[^\]]*\] \[stderr\] /, '').trim())
    .filter((line) => line.length > 0 && !/^(frame|size)=/.test(line));
  return tail.length > 0 ? tail.slice(-2).join(' ') : null;
}

/**
 * Runs `preset` over `asset` and returns the file it produced.
 *
 * Rejects with an `AbortError` when `signal` fires, and with an ordinary `Error` carrying
 * FFmpeg's own last words when the command line fails.
 */
export async function runPreset(
  asset: MediaAsset,
  preset: ToolPreset,
  range: SourceRange | undefined,
  onProgress: (update: JobProgress) => void,
  signal: AbortSignal,
): Promise<File> {
  signal.throwIfAborted();
  clearExportLogs();

  onProgress({ phase: 'loading', progress: 0 });
  const ffmpeg = await loadFfmpeg((ratio) =>
    onProgress({ phase: 'loading', progress: Math.round(ratio * 10) }),
  );
  signal.throwIfAborted();

  const input = `tool_input_${asset.id}.${extOf(asset.name)}`;
  const output = outputName(preset);

  onProgress({ phase: 'writing', progress: 10 });
  await ffmpeg.writeFile(input, await fetchFile(asset.file));
  signal.throwIfAborted();

  // A leftover from a cancelled job would otherwise make FFmpeg stop and ask whether to
  // overwrite, which in a worker means it simply never finishes.
  await ffmpeg.deleteFile(output).catch(() => undefined);

  const onFfmpegProgress = ({ progress }: { progress: number }) => {
    const clamped = Math.min(1, Math.max(0, progress));
    onProgress({ phase: 'running', progress: 15 + Math.round(clamped * 80) });
  };
  ffmpeg.on('progress', onFfmpegProgress);
  const onAbort = () => ffmpeg.terminate();
  signal.addEventListener('abort', onAbort, { once: true });

  const full = commandLine(preset, input, asset.duration, range);
  console.log('[Tools]', preset.id, 'ffmpeg', full.join(' '));

  let exitCode: number;
  try {
    onProgress({ phase: 'running', progress: 15 });
    exitCode = await ffmpeg.exec(full);
  } finally {
    ffmpeg.off('progress', onFfmpegProgress);
    signal.removeEventListener('abort', onAbort);
  }
  signal.throwIfAborted();

  if (exitCode !== 0) {
    const complaint = lastComplaint();
    throw new Error(
      `FFmpeg exited with code ${exitCode}.${complaint ? ` It said: ${complaint}` : ''}`,
    );
  }

  onProgress({ phase: 'reading', progress: 95 });
  const data = await ffmpeg.readFile(output);
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  if (bytes.byteLength === 0) {
    throw new Error('The preset ran but produced an empty file.');
  }

  // Both files are megabytes of MEMFS that nothing will ask for again.
  await ffmpeg.deleteFile(input).catch(() => undefined);
  await ffmpeg.deleteFile(output).catch(() => undefined);

  onProgress({ phase: 'reading', progress: 100 });
  return new File([new Blob([bytes], { type: MIME[preset.ext] })], output, {
    type: MIME[preset.ext],
  });
}
