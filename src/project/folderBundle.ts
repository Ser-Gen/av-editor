/**
 * Saving a copy of the project into a folder you can see, and opening one back.
 *
 * This is deliberately a *one-shot* copy, not a live link. Nothing is watched, nothing is
 * rescanned, and no permission is needed except at the moment you use it — which sidesteps
 * every hard part of the File System Access API at once. What it buys is real: portability,
 * a backup outside the browser's evictable storage, and an escape from the quota.
 *
 * It also quietly fixes the worst part of not copying imports. A folder grant covers every
 * file inside it, so a project that has ever been saved to a folder can reopen with **one**
 * permission click instead of a relink pass — see `silentFolderFiles`, which takes the free
 * case where the browser has remembered the grant outright.
 *
 * Bytes are named `<assetId>.<ext>`, so the folder needs no index: an asset finds its file
 * by prefix. That also means two library entries with the same display name cannot collide.
 */
import type { MediaAsset, ProjectFile } from '../types/editor';
import { parseProjectFile } from './projectFile';
import type { LoadedProject } from './projectFile';
import { PROJECT_DIR_KEY, getHandle, permissionState, putHandle, requestPermission } from './handleStore';
import { dirKeys, readFile, writeBlob } from './opfs';

const MEDIA_DIR = 'media';
const PROJECT_NAME = 'project.json';

interface PickerWindow {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}

export function folderPickerAvailable(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickProjectFolder(
  mode: 'read' | 'readwrite',
): Promise<FileSystemDirectoryHandle | null> {
  const picker = window as unknown as PickerWindow;
  if (!picker.showDirectoryPicker) return null;
  try {
    return await picker.showDirectoryPicker({ mode });
  } catch {
    return null; // Dismissed.
  }
}

function extensionOf(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : 'dat';
}

export function bundleName(asset: { id: string; name: string }): string {
  return `${asset.id}.${extensionOf(asset.name)}`;
}

/**
 * Write the whole project out. Imported originals go in too: they are live `File`s during a
 * session even though they were never copied into OPFS, so the bundle is self-contained even
 * though the browser's own store is not.
 */
export async function writeBundle(
  dir: FileSystemDirectoryHandle,
  project: ProjectFile,
  assets: readonly MediaAsset[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ written: number; skipped: string[] }> {
  const media = await dir.getDirectoryHandle(MEDIA_DIR, { create: true });
  const withBytes = assets.filter((a) => !!a.file);
  const skipped = assets.filter((a) => !a.file).map((a) => a.name);

  let done = 0;
  for (const asset of withBytes) {
    await writeBlob(media, bundleName(asset), asset.file as File);
    onProgress?.(++done, withBytes.length);
  }
  await writeBlob(dir, PROJECT_NAME, new Blob([JSON.stringify(project)], { type: 'application/json' }));
  await putHandle(PROJECT_DIR_KEY, dir);
  return { written: withBytes.length, skipped };
}

/** Every media file in a bundle, keyed by the asset id its name starts with. */
async function indexFolder(dir: FileSystemDirectoryHandle): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  let media: FileSystemDirectoryHandle;
  try {
    media = await dir.getDirectoryHandle(MEDIA_DIR);
  } catch {
    return out;
  }
  for await (const name of dirKeys(media)) {
    const id = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const file = await readFile(media, name);
    if (file) out.set(id, file);
  }
  return out;
}

export interface OpenedBundle {
  loaded: LoadedProject;
  files: Map<string, File>;
}

export async function readBundle(dir: FileSystemDirectoryHandle): Promise<OpenedBundle | null> {
  const text = await (async () => {
    try {
      return await (await dir.getFileHandle(PROJECT_NAME)).getFile().then((f) => f.text());
    } catch {
      return null;
    }
  })();
  if (text === null) return null;
  const loaded = parseProjectFile(text);
  if (!loaded) return null;
  await putHandle(PROJECT_DIR_KEY, dir);
  return { loaded, files: await indexFolder(dir) };
}

/**
 * The bundle's files, if the browser still lets us read the folder without asking.
 *
 * Never requests permission: a page load is not a user gesture, and asking from one would
 * fail anyway. When Chrome has remembered the grant this turns a reopened project from "one
 * relink click" into nothing at all; when it has not, it costs one silent query.
 */
export async function silentFolderFiles(): Promise<Map<string, File>> {
  const dir = await getHandle<FileSystemDirectoryHandle>(PROJECT_DIR_KEY);
  if (!dir) return new Map();
  if ((await permissionState(dir)) !== 'granted') return new Map();
  try {
    return await indexFolder(dir);
  } catch {
    return new Map();
  }
}

/** The same folder, after asking. Must be called from a user gesture. */
export async function reopenStoredFolder(): Promise<Map<string, File> | null> {
  const dir = await getHandle<FileSystemDirectoryHandle>(PROJECT_DIR_KEY);
  if (!dir) return null;
  if (!(await requestPermission(dir))) return null;
  return indexFolder(dir);
}

export async function hasStoredFolder(): Promise<boolean> {
  return !!(await getHandle<FileSystemDirectoryHandle>(PROJECT_DIR_KEY));
}
