/**
 * Reading and writing the project on disk.
 *
 * Three properties this file exists to hold:
 *
 *   - **A save never destroys the last good copy.** There is no `rename()` in this API, so
 *     the previous contents are copied aside before the new ones are written and the loader
 *     falls back to them. A project file is written by an app that might be killed at any
 *     instant; the cost of the extra copy is a few hundred kilobytes.
 *   - **One tab owns the project.** Two tabs autosaving into one origin is last-write-wins,
 *     and the loss is silent, which is the worst kind. A claim — asked over `BroadcastChannel`,
 *     never inferred — makes the second tab read-only and say so, rather than quietly eating
 *     the first one's work.
 *   - **Clearing means clearing.** Everything this app writes anywhere is listed here, so
 *     "Clear everything" cannot drift out of date with what is actually stored.
 */
import { fromProjectFile } from './projectFile';
import type { LoadedProject } from './projectFile';
import type { ProjectFile } from '../types/editor';
import {
  dirBytes,
  opfsAvailable,
  readText,
  removeEntry,
  rootDir,
  subDir,
  writeJsonRotating,
} from './opfs';
import { clearHandles } from './handleStore';

const PROJECT = 'project.json';
const PROJECT_PREV = 'project.prev.json';

/** Directories this app writes into, for sizing and for clearing. */
export const OPFS_DIRS = ['media', 'recordings', 'exports'] as const;

/**
 * Browser storage outside OPFS. Only UI preference lives here — panel sizes and which tab was
 * showing — but "Clear everything" has to mean it, so every key is named once, in one list,
 * shared by the writers and the eraser.
 */
export const TIMELINE_HEIGHT_KEY = 'editor.timelineHeight';
export const LIBRARY_WIDTH_KEY = 'editor.libraryWidth';
export const INSPECTOR_WIDTH_KEY = 'editor.inspectorWidth';
export const LIBRARY_TAB_KEY = 'editor.libraryTab';
export const INSPECTOR_TAB_KEY = 'editor.inspectorTab';
export const PREVIEW_VOLUME_KEY = 'editor.previewVolume';
/** How the library list is arranged. A view, never part of the project. */
export const LIBRARY_VIEW_KEY = 'editor.libraryView';
const LOCAL_KEYS = [
  TIMELINE_HEIGHT_KEY,
  LIBRARY_WIDTH_KEY,
  INSPECTOR_WIDTH_KEY,
  LIBRARY_TAB_KEY,
  INSPECTOR_TAB_KEY,
  PREVIEW_VOLUME_KEY,
  LIBRARY_VIEW_KEY,
];

export async function saveProject(project: ProjectFile): Promise<void> {
  if (!opfsAvailable()) return;
  await writeJsonRotating(await rootDir(), PROJECT, PROJECT_PREV, project);
}

/**
 * The saved project, or `null` if there is not one. Falls back to the rotated copy when the
 * current file is unreadable — which is exactly the case rotation exists for.
 */
export async function loadProject(): Promise<LoadedProject | null> {
  if (!opfsAvailable()) return null;
  const root = await rootDir();
  for (const [name, recovered] of [
    [PROJECT, false],
    [PROJECT_PREV, true],
  ] as const) {
    const text = await readText(root, name);
    if (text === null) continue;
    try {
      const parsed = fromProjectFile(JSON.parse(text));
      if (parsed) return { ...parsed, recovered };
    } catch {
      // Truncated or not JSON at all. Try the older copy.
    }
  }
  return null;
}

export async function deleteProject(): Promise<void> {
  if (!opfsAvailable()) return;
  const root = await rootDir();
  await removeEntry(root, PROJECT);
  await removeEntry(root, PROJECT_PREV);
}

// ---------------------------------------------------------------- the claim

/**
 * Which tab owns the project.
 *
 * The first version of this wrote a heartbeat file and treated a recent timestamp as "someone
 * else is here". That cannot work, and failed on the most ordinary action there is: releasing
 * the claim happens on `pagehide`, removing a file is asynchronous, and the page is gone
 * before it finishes. Every reload then found its own heartbeat and declared itself a second
 * tab — and a read-only tab does not autosave, so a reload silently stopped saving.
 *
 * Liveness cannot be inferred from a file that a dying tab was supposed to clean up. It has
 * to be *asked*, and only a tab that still exists can answer. `BroadcastChannel` does not
 * deliver a message to its own sender, so a lone tab hears nothing back and takes ownership;
 * a crashed tab cannot reply at all, so its claim evaporates with it and there is no stale
 * window to wait out.
 */
const CLAIM_CHANNEL = 'editor-project-claim';
/** Long enough for another tab's event loop to answer, short enough not to delay a load. */
const PROBE_MS = 250;

export async function claimProject(): Promise<{ owned: boolean; stop: () => void }> {
  if (typeof BroadcastChannel === 'undefined') return { owned: true, stop: () => {} };
  const channel = new BroadcastChannel(CLAIM_CHANNEL);

  const someoneAnswered = await new Promise<boolean>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'here') resolve(true);
    };
    channel.addEventListener('message', onMessage);
    channel.postMessage({ type: 'who-owns-this' });
    setTimeout(() => resolve(false), PROBE_MS);
  });

  if (someoneAnswered) {
    channel.close();
    return { owned: false, stop: () => {} };
  }

  // Ours. Answer whoever asks next, so the *next* tab is the one that goes read-only.
  channel.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'who-owns-this') channel.postMessage({ type: 'here' });
  });
  const release = () => channel.close();
  window.addEventListener('pagehide', release, { once: true });
  return { owned: true, stop: release };
}

// ------------------------------------------------------------------ clearing

export interface StorageBreakdown {
  project: number;
  media: number;
  recordings: number;
  exports: number;
  total: number;
}

/** What each part of the store is costing, for the confirm dialog and the library readout. */
export async function storageBreakdown(): Promise<StorageBreakdown> {
  if (!opfsAvailable()) {
    return { project: 0, media: 0, recordings: 0, exports: 0, total: 0 };
  }
  const root = await rootDir();
  let project = 0;
  for (const name of [PROJECT, PROJECT_PREV]) {
    const text = await readText(root, name);
    if (text !== null) project += new Blob([text]).size;
  }
  const [media, recordings, exports] = await Promise.all(OPFS_DIRS.map((d) => dirBytes(d)));
  return { project, media, recordings, exports, total: project + media + recordings + exports };
}

/**
 * Erase everything this app has stored anywhere: the project and its rotated copy, all OPFS
 * media, every recording and its sidecar, export scratch, the handle database and the one
 * `localStorage` key. Nothing is left to surprise the user on the next launch.
 */
export async function clearEverything(): Promise<void> {
  if (opfsAvailable()) {
    const root = await rootDir();
    await deleteProject();
    for (const name of OPFS_DIRS) await removeEntry(root, name);
    // Recreated empty so a capture starting straight after does not race a missing directory.
    for (const name of OPFS_DIRS) await subDir(name, true).catch(() => undefined);
  }
  await clearHandles();
  for (const key of LOCAL_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage disabled entirely; there was nothing to remove.
    }
  }
}
