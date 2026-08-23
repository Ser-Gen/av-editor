/**
 * The small amount of OPFS plumbing everything else here shares.
 *
 * Two things are worth knowing about the File System Access API before reading the callers.
 * There is no `rename()` — the only way to replace a file safely is to write a new one and
 * copy over, which is why `writeJsonRotating` exists. And in Chromium a writable created on
 * a file commits only when it is closed, so a half-finished write leaves the *previous*
 * contents intact rather than a truncated file. That is what makes rotation a real backstop
 * rather than a ritual.
 */

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/** `keys()` is present on the handle at runtime but missing from the DOM lib types. */
export function dirKeys(dir: FileSystemDirectoryHandle): AsyncIterable<string> {
  return (dir as unknown as { keys(): AsyncIterable<string> }).keys();
}

export async function rootDir(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

export async function subDir(name: string, create = true): Promise<FileSystemDirectoryHandle> {
  return (await rootDir()).getDirectoryHandle(name, { create });
}

export async function writeBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Blob,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => undefined);
    throw e;
  }
}

export async function readText(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return await file.text();
  } catch {
    return null;
  }
}

export async function readFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function removeEntry(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  await dir.removeEntry(name, { recursive: true }).catch(() => undefined);
}

/** Total bytes in one directory, one level deep. */
export async function dirBytes(name: string): Promise<number> {
  if (!opfsAvailable()) return 0;
  try {
    const dir = await subDir(name, false);
    let total = 0;
    for await (const entry of dirKeys(dir)) {
      const file = await readFile(dir, entry);
      if (file) total += file.size;
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Write `name`, keeping the previous contents as `prevName` first.
 *
 * The order matters: the old copy is secured *before* the new one is written, so the two
 * files are never both mid-flight. A tab killed anywhere in here leaves at least one of them
 * complete, which is all the loader needs.
 */
export async function writeJsonRotating(
  dir: FileSystemDirectoryHandle,
  name: string,
  prevName: string,
  value: unknown,
): Promise<void> {
  const existing = await readText(dir, name);
  if (existing !== null) {
    await writeBlob(dir, prevName, new Blob([existing], { type: 'application/json' }));
  }
  await writeBlob(dir, name, new Blob([JSON.stringify(value)], { type: 'application/json' }));
}

/** Ask the browser not to evict us. Best effort — Safari and Firefox may simply decline. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}
