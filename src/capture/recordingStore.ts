/**
 * Where recordings live on disk, and what we know about them.
 *
 * Every capture streams to OPFS rather than accumulating in the heap, so the source of
 * truth for a recording is a file plus a small JSON sidecar. The sidecar is what makes
 * crash recovery possible: it is written *before* the first byte of media and updated as
 * the recording progresses, so a tab that dies leaves behind a described, half-written
 * file rather than an anonymous one.
 */

export type CaptureSourceKind = 'screen' | 'camera' | 'mic' | 'system';

export const SOURCE_LABELS: Record<CaptureSourceKind, string> = {
  screen: 'Screen',
  camera: 'Camera',
  mic: 'Microphone',
  system: 'System audio',
};

export interface RecordingMeta {
  id: string;
  /** Shared by every source of one Record press, so they can be regrouped after a crash. */
  sessionId: string;
  kind: CaptureSourceKind;
  mimeType: string;
  /**
   * Seconds between the session's time anchor and this source actually starting. Sources
   * do not begin in the same millisecond, and this is what re-aligns them on the timeline.
   */
  startOffset: number;
  /** Epoch ms, for showing the user what a recovered file is. */
  startedAt: number;
  /**
   * `recording` — bytes still arriving (or the tab died mid-capture).
   * `raw` — capture finished, container not yet repaired.
   * `ready` — seekable: either repaired, or written that way in the first place.
   */
  state: 'recording' | 'raw' | 'ready';
  /**
   * Which engine wrote it. Recovery needs this: a WebCodecs file is a fragmented MP4 that
   * plays as far as it got, a MediaRecorder file is a live container that must be rebuilt.
   * Absent on sidecars written before phase 15, which were all MediaRecorder.
   */
  engine?: 'webcodecs' | 'mediarecorder';
  /** Measured from the time anchor, so the editor never has to trust the container. */
  durationSeconds?: number;
  /**
   * What the source actually negotiated, read off the track rather than requested. Video
   * only; recorded so a recovered file can still say what it is.
   */
  format?: { width: number; height: number; frameRate: number };
  /**
   * Why this source stopped before the session did — an unplugged camera, Chrome's "Stop
   * sharing" bar. Absent on a source that ran to the end of the take.
   */
  endedReason?: string;
  rawFile: string;
  readyFile?: string;
  bytes?: number;
}

/** A finished source, ready for the library. */
export interface RecordedSource {
  kind: CaptureSourceKind;
  file: File;
  /** Seconds after the session anchor — preserved on the timeline so sources stay aligned. */
  startOffset: number;
  duration: number;
  /** The negotiated video format, where there was one. Drives PiP framing and project fps. */
  format?: { width: number; height: number; frameRate: number };
}

/**
 * Which lane each source prefers, counting from the base of its own group: screen on the
 * base video lane, camera one above it so it composites over the screen, mic A1, system A2.
 */
export const SOURCE_LANE: Record<CaptureSourceKind, number> = {
  screen: 0,
  camera: 1,
  mic: 0,
  system: 1,
};

const DIR = 'recordings';

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

export async function recordingsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

const metaName = (id: string) => `${id}.json`;

export async function writeMeta(meta: RecordingMeta): Promise<void> {
  const dir = await recordingsDir();
  const handle = await dir.getFileHandle(metaName(meta.id), { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  await writable.close();
}

export async function readAllMeta(): Promise<RecordingMeta[]> {
  if (!opfsAvailable()) return [];
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await recordingsDir();
  } catch {
    return [];
  }
  const out: RecordingMeta[] = [];
  for await (const name of dirKeys(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      const meta = JSON.parse(await file.text()) as RecordingMeta;
      if (meta && typeof meta.id === 'string') out.push(meta);
    } catch {
      // A sidecar half-written when the tab died. Nothing to recover from it.
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

export async function fileOf(name: string): Promise<File | null> {
  try {
    const dir = await recordingsDir();
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function removeEntry(name: string): Promise<void> {
  try {
    const dir = await recordingsDir();
    await dir.removeEntry(name);
  } catch {
    // Best effort: the entry may already be gone.
  }
}

/** Drops a recording's media and its sidecar. */
export async function deleteRecording(meta: RecordingMeta): Promise<void> {
  await removeEntry(meta.rawFile);
  if (meta.readyFile) await removeEntry(meta.readyFile);
  await removeEntry(metaName(meta.id));
}

/** `keys()` is present on the handle at runtime but missing from the DOM lib types. */
export function dirKeys(dir: FileSystemDirectoryHandle): AsyncIterable<string> {
  return (dir as unknown as { keys(): AsyncIterable<string> }).keys();
}
