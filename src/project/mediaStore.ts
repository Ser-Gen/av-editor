/**
 * Bytes this app made, kept where they can be found again.
 *
 * Recordings, preset outputs, GPU bakes and captured frames have nowhere else to live: no
 * one picked them out of a folder, so nobody can be asked to find them again. They are
 * copied into OPFS and named after the asset that owns them, which makes garbage collection
 * a set difference rather than a bookkeeping problem.
 *
 * Imported files are deliberately *not* here — see `docs/persistence-plan.md`. The
 * consequence is worth remembering while reading this file: everything in `media/` belongs
 * to an asset the user cannot re-supply, so deleting one of these is irreversible in a way
 * that removing an import is not.
 */
import { dirKeys, opfsAvailable, readFile, removeEntry, subDir, writeBlob } from './opfs';

const MEDIA_DIR = 'media';

function extensionFor(name: string, mimeType: string): string {
  const fromName = name.match(/\.([A-Za-z0-9]{1,5})$/);
  if (fromName) return fromName[1].toLowerCase();
  if (mimeType.includes('mp4')) return mimeType.startsWith('audio/') ? 'm4a' : 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('gif')) return 'gif';
  return 'dat';
}

export function mediaNameFor(assetId: string, file: { name: string; type: string }): string {
  return `${assetId}.${extensionFor(file.name, file.type)}`;
}

async function mediaDir(create = true): Promise<FileSystemDirectoryHandle> {
  return subDir(MEDIA_DIR, create);
}

/**
 * Copy a produced file in. Returns the name to store on the asset, or `null` when OPFS is
 * unavailable or full — in which case the asset simply will not survive a reload, which is
 * a worse outcome than today but not a broken one.
 */
export async function putMedia(assetId: string, file: File): Promise<string | null> {
  if (!opfsAvailable()) return null;
  const name = mediaNameFor(assetId, file);
  try {
    // Materialised first. The source is often a `File` over another OPFS entry, and handing
    // a live handle to a second writable makes the copy depend on that entry outliving it.
    // A produced file is small enough to hold once and important enough to be sure about.
    const bytes = await file.arrayBuffer();
    await writeBlob(await mediaDir(), name, new Blob([bytes], { type: file.type }));

    // Read back. A silent short write here is invisible until a reload, by which point the
    // only evidence is a clip that says "offline" about a file that was never anywhere else.
    const stored = await getMedia(name);
    if (!stored || stored.size !== bytes.byteLength) {
      console.warn('[media] produced file did not survive the write', name, stored?.size, bytes.byteLength);
      await dropMedia(name);
      return null;
    }
    return name;
  } catch (e) {
    console.warn('[media] could not store produced file', name, e);
    return null;
  }
}

export async function getMedia(name: string): Promise<File | null> {
  if (!opfsAvailable()) return null;
  try {
    return await readFile(await mediaDir(false), name);
  } catch {
    return null;
  }
}

export async function dropMedia(name: string): Promise<void> {
  if (!opfsAvailable()) return;
  try {
    await removeEntry(await mediaDir(false), name);
  } catch {
    // Never existed, or the directory does not. Either way there is nothing to remove.
  }
}

export async function listMedia(): Promise<string[]> {
  if (!opfsAvailable()) return [];
  try {
    const dir = await mediaDir(false);
    const out: string[] = [];
    for await (const name of dirKeys(dir)) out.push(name);
    return out;
  } catch {
    return [];
  }
}

/**
 * Delete produced files no asset claims.
 *
 * Reachability is computed from the asset table alone and never from `derivedFrom`: an asset
 * made by a bake or a preset is a file in its own right, and outlives the original it was
 * made from. A dangling lineage is a display concern, not a lifetime one.
 *
 * **`newerThan` is not an optimisation — it is what stops this deleting live work.** "Not in
 * the project" and "garbage" are only the same thing when the project on disk is up to date.
 * A file written after the last save cannot be in it *by definition*: a bake made in a tab
 * that could not autosave, or one made in the second between being produced and the debounce
 * firing. Sweeping those took a bake the user had just made, which is precisely the failure
 * this parameter exists to prevent. Anything at or after the save is left alone; it will be
 * collected on some later load, once the project has had a chance to mention it.
 */
export function isCollectable(
  name: string,
  lastModified: number,
  keep: ReadonlySet<string>,
  newerThan: number,
): boolean {
  if (keep.has(name)) return false;
  return lastModified < newerThan;
}

export async function collectGarbage(
  keep: ReadonlySet<string>,
  newerThan: number,
): Promise<number> {
  let freed = 0;
  for (const name of await listMedia()) {
    const file = await getMedia(name);
    if (!file) continue;
    if (!isCollectable(name, file.lastModified, keep, newerThan)) continue;
    freed += file.size;
    await dropMedia(name);
  }
  return freed;
}
