/**
 * Turning a MediaRecorder file into one that players will scrub.
 *
 * MediaRecorder writes a *live* container: the WebM segment has unknown size and carries
 * no Duration, no SeekHead and no Cues, and Chrome's MP4 output is fragmented with no
 * top-level index. That is exactly why such a file reports `duration = Infinity` and
 * refuses to seek — the bytes are fine, the table of contents is missing.
 *
 * Rather than patch EBML by hand, remux: mediabunny reads the live file, and writing it
 * back out produces a container with the index and duration filled in. Codecs are carried
 * across untouched, so this is a copy, not a re-encode — a 5-second capture repairs in
 * about 10ms, and the picture is bit-identical.
 *
 * The input is a File backed by OPFS and the output streams to OPFS, so a 30-minute
 * recording never exists in the heap at either end.
 */
import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
} from 'mediabunny';
import type { OutputFormat } from 'mediabunny';
import { openRecordingScratch } from './recordingScratch';

export interface RepairResult {
  file: File;
  fileName: string;
  /** Read out of the repaired container, so it is what a player will report. */
  duration: number;
  /** False when repair was impossible and the raw file is being used as-is. */
  repaired: boolean;
  note?: string;
}

function outputFormatFor(mimeType: string): { format: OutputFormat; ext: string } {
  if (mimeType.includes('mp4')) return { format: new Mp4OutputFormat(), ext: 'mp4' };
  return { format: new WebMOutputFormat(), ext: 'webm' };
}

/**
 * Remuxes `raw` into `outBase.<ext>` inside the recordings directory.
 *
 * `onProgress` reports 0–1. Repair of a long recording is I/O bound, not CPU bound, but
 * it is not instant and the UI should say so.
 */
/**
 * Repair writes a second copy alongside the original, so it briefly needs room for both.
 * Finding that out halfway through means dying with a stream error on a recording the user
 * has already made — so ask first, and say so plainly while the raw file is still intact.
 */
async function roomForRepair(raw: File): Promise<string | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota === 0) return null;
    const free = quota - usage;
    // A tenth over the input covers the container rewrite plus a little headroom.
    const needed = raw.size * 1.1;
    if (free >= needed) return null;
    const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;
    return `not enough storage to rebuild the container: it needs about ${mb(needed)} beside the ${mb(raw.size)} already recorded, and only ${mb(free)} is free`;
  } catch {
    return null;
  }
}

export async function repairRecording(
  raw: File,
  outBase: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
): Promise<RepairResult> {
  const shortOfSpace = await roomForRepair(raw);
  if (shortOfSpace) {
    return {
      file: raw,
      fileName: raw.name,
      duration: await probeDurationLoosely(raw),
      repaired: false,
      note: `${shortOfSpace}. The recording is intact and will play, but it may not scrub in other players until you free some space and re-import it.`,
    };
  }

  const { format, ext } = outputFormatFor(mimeType);
  const fileName = `${outBase}.${ext}`;
  const scratch = await openRecordingScratch(fileName);

  try {
    const input = new Input({ source: new BlobSource(raw), formats: ALL_FORMATS });
    const output = new Output({
      format,
      target: new StreamTarget(scratch.writable, { chunked: true }),
    });
    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((t) => t.reason).join(', ');
      throw new Error(`no usable tracks (${reasons || 'unknown'})`);
    }
    if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);
    await conversion.execute();

    const file = await scratch.toFile();
    // Read the duration back from the repaired file rather than trusting the input: this
    // is the number a player will see, so it is the one worth reporting.
    const check = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const duration = await check.computeDuration();
    return { file, fileName, duration, repaired: true };
  } catch (e) {
    await scratch.abort();
    const message = e instanceof Error ? e.message : String(e);
    // Better a working editor with an honest warning than a lost recording: the raw file
    // still plays, it just will not scrub until it is exported.
    return {
      file: raw,
      fileName: raw.name,
      duration: await probeDurationLoosely(raw),
      repaired: false,
      note: `Could not rebuild the container (${message}). The recording is intact but may not scrub in other players.`,
    };
  }
}

/** Last resort when repair failed: whatever mediabunny can scan out of the live file. */
async function probeDurationLoosely(file: File): Promise<number> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    return await input.computeDuration();
  } catch {
    return 0;
  }
}
