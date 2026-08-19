/**
 * Finishing a recording, and finding the ones that never finished.
 *
 * Because the bytes are already on disk, a tab that dies mid-capture leaves a real file
 * rather than nothing. What it lacks is the metadata pass, and that is exactly what
 * `finalize` does — so recovery is not a special path, it is the ordinary finish applied
 * later to a file whose last cluster happens to be truncated.
 */
import { repairRecording } from './containerFix';
import type { RepairResult } from './containerFix';
import { SOURCE_LABELS, deleteRecording, fileOf, readAllMeta, removeEntry, writeMeta } from './recordingStore';
import type { RecordingMeta } from './recordingStore';

export interface FinishedRecording {
  meta: RecordingMeta;
  file: File;
  /** From the repaired container — what a player will report. */
  duration: number;
  note?: string;
}

export interface OrphanRecording {
  meta: RecordingMeta;
  /** True when the tab died mid-capture rather than the user pressing stop. */
  interrupted: boolean;
  sizeBytes: number;
  label: string;
}

/**
 * The extension has to agree with what is inside: an audio-only MP4 named `.mp4` is
 * imported as a video clip with no picture, because that is all the name says.
 */
function extensionFor(mimeType: string): string {
  if (mimeType.startsWith('audio/')) return mimeType.includes('mp4') ? 'm4a' : 'webm';
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

function fileName(meta: RecordingMeta, duration: number): string {
  const stamp = new Date(meta.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const seconds = Math.round(duration);
  return `${meta.kind}-recording_${stamp}_${seconds}s.${extensionFor(meta.mimeType)}`;
}

/**
 * Repairs the container and returns a file fit for the library. The measured duration from
 * the capture's own clock is kept on the meta as a cross-check — if the two disagree
 * sharply, the container is the one to distrust.
 */
export async function finalizeRecording(
  meta: RecordingMeta,
  onProgress?: (fraction: number) => void,
): Promise<FinishedRecording> {
  const raw = await fileOf(meta.rawFile);
  if (!raw || raw.size === 0) {
    throw new Error(`${SOURCE_LABELS[meta.kind]} recording is empty.`);
  }

  // A capture the WebCodecs engine finished is already indexed and seekable — the whole
  // point of that engine. Rebuilding it would copy a large file to change nothing.
  if (meta.state === 'ready' && meta.engine === 'webcodecs') {
    onProgress?.(1);
    const duration = meta.durationSeconds ?? 0;
    return {
      meta,
      file: new File([raw], fileName(meta, duration), { type: meta.mimeType }),
      duration,
    };
  }

  const result: RepairResult = await repairRecording(raw, `${meta.id}.fixed`, meta.mimeType, onProgress);
  const duration = result.duration || meta.durationSeconds || 0;

  const next: RecordingMeta = {
    ...meta,
    state: result.repaired ? 'ready' : 'raw',
    readyFile: result.repaired ? result.fileName : undefined,
    durationSeconds: duration,
  };
  await writeMeta(next);
  // The raw capture has served its purpose once a repaired copy exists.
  if (result.repaired) await removeEntry(meta.rawFile);

  // The type comes from the capture, not from the rebuilt file: OPFS infers a file's type
  // from its name, and an audio-only recording rebuilt into `.mp4` would come back claiming
  // to be video — enough to import a microphone take as a blank video clip.
  const named = new File([result.file], fileName(meta, duration), { type: meta.mimeType });
  return { meta: next, file: named, duration, note: result.note };
}

/** Everything on disk that is not in the current session's library — which is all of it. */
export async function findOrphans(): Promise<OrphanRecording[]> {
  const metas = await readAllMeta();
  const out: OrphanRecording[] = [];
  for (const meta of metas) {
    const name = meta.readyFile ?? meta.rawFile;
    const file = await fileOf(name);
    if (!file || file.size === 0) {
      // A sidecar with no media behind it is just litter.
      await deleteRecording(meta);
      continue;
    }
    out.push({
      meta,
      interrupted: meta.state === 'recording',
      sizeBytes: file.size,
      label: SOURCE_LABELS[meta.kind],
    });
  }
  return out;
}

/** Loads a recovered recording, repairing it first if it never got that far. */
export async function recoverRecording(meta: RecordingMeta): Promise<FinishedRecording> {
  if (meta.state === 'ready' && meta.readyFile) {
    const file = await fileOf(meta.readyFile);
    if (file) {
      const duration = meta.durationSeconds ?? 0;
      return {
        meta,
        file: new File([file], fileName(meta, duration), { type: meta.mimeType }),
        duration,
      };
    }
  }
  return finalizeRecording(meta);
}

export async function discardRecording(meta: RecordingMeta): Promise<void> {
  await deleteRecording(meta);
}
