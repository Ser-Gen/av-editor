/**
 * Turning a saved asset table back into a live library.
 *
 * Four origins, three different answers to "where are the bytes?":
 *
 *   - **derived** — in OPFS `media/`, put there when the app produced them.
 *   - **recorded** — already in OPFS `recordings/`, bound by sidecar id rather than copied.
 *     A recording is the one kind of media this app both makes and keeps, so duplicating it
 *     would double the largest files in the store for nothing.
 *   - **imported** — the user's own file, never copied. Offline until relinked, unless a
 *     handle stored last time still carries permission, which Chrome sometimes grants to
 *     sites it considers established. That silent path is a bonus and never assumed.
 *
 * Anything that fails simply stays offline, which the whole app already handles.
 */
import type { MediaAsset, StoredAsset } from '../types/editor';
import { getMedia } from './mediaStore';
import { getHandle, permissionState } from './handleStore';
import { fileOf } from '../capture/recordingStore';
import { silentFolderFiles } from './folderBundle';

/** Give an asset its bytes, creating the object URL the preview and thumbnails read. */
export function attachFile(asset: MediaAsset | StoredAsset, file: File): MediaAsset {
  return { ...asset, file, blobUrl: URL.createObjectURL(file) };
}

async function bytesFor(
  asset: StoredAsset,
  folder: ReadonlyMap<string, File>,
): Promise<File | null> {
  if ((asset.origin === 'derived' || asset.origin === 'pasted') && asset.opfsName) {
    return getMedia(asset.opfsName);
  }
  if (asset.origin === 'recorded' && asset.opfsName) return fileOf(asset.opfsName);
  if (asset.origin === 'imported') {
    // A folder the project was saved to covers every file inside it with one grant, so this
    // is checked before the per-file handles: one remembered permission beats twenty.
    const bundled = folder.get(asset.id);
    if (bundled) return bundled;
    const handle = await getHandle<FileSystemFileHandle>(asset.id);
    // Never `requestPermission` here: it needs a user gesture, and a load is not one.
    if (handle && (await permissionState(handle)) === 'granted') {
      return handle.getFile().catch(() => null);
    }
  }
  return null;
}

/**
 * @param provided Bytes the caller already has — the folder the user just opened. Checked
 *   first, because those files are in hand and everything else is a lookup that may fail.
 */
export async function rehydrate(
  stored: readonly StoredAsset[],
  provided?: ReadonlyMap<string, File>,
): Promise<MediaAsset[]> {
  const folder = provided ?? (await silentFolderFiles().catch(() => new Map<string, File>()));
  const out: MediaAsset[] = [];
  for (const asset of stored) {
    let file: File | null = null;
    try {
      file = await bytesFor(asset, folder);
    } catch {
      file = null;
    }
    // A recording restored from OPFS keeps the duration the capture measured, not whatever
    // the container claims — the same reason `importRecordings` prefers it on the way in.
    out.push(file ? attachFile(asset, file) : { ...asset });
  }
  return out;
}

/** Names in `media/` that some asset still claims. Everything else is garbage. */
export function reachableMedia(assets: readonly StoredAsset[]): Set<string> {
  return new Set(
    assets
      .filter((a) => (a.origin === 'derived' || a.origin === 'pasted') && !!a.opfsName)
      .map((a) => a.opfsName as string),
  );
}
