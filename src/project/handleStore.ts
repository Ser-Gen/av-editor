/**
 * Directory and file handles, kept between visits.
 *
 * A `FileSystemHandle` is structured-cloneable but not JSON — IndexedDB is the only place it
 * can be put. That is the whole reason IndexedDB appears in this design at all: it holds
 * handles, never media.
 *
 * What a stored handle buys is a *chance* at silence. Permission reverts to `prompt` on
 * reload and `requestPermission()` needs a user gesture, so the honest promise is one click,
 * not zero. Chrome does grant persistent permission to frequently-used and installed sites,
 * and when it has, `queryPermission` says `granted` and the project reopens with no
 * interaction at all. That is treated as a bonus everywhere it appears, never as the design.
 */

const DB_NAME = 'editor-handles';
const STORE = 'handles';
const DB_VERSION = 1;

/** The directory a project was last saved to — one grant covering every file inside it. */
export const PROJECT_DIR_KEY = 'project-dir';

type PermissionMode = 'read' | 'readwrite';

interface PermissionCapable {
  queryPermission?(d: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(d: { mode: PermissionMode }): Promise<PermissionState>;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        let request: IDBRequest<T>;
        try {
          request = body(db.transaction(STORE, mode).objectStore(STORE));
        } catch {
          db.close();
          return resolve(null);
        }
        request.onsuccess = () => {
          resolve(request.result ?? null);
          db.close();
        };
        request.onerror = () => {
          resolve(null);
          db.close();
        };
      }),
  );
}

export async function putHandle(key: string, handle: FileSystemHandle): Promise<void> {
  await run('readwrite', (store) => store.put(handle, key) as IDBRequest<IDBValidKey>);
}

export async function getHandle<T extends FileSystemHandle>(key: string): Promise<T | null> {
  return (await run('readonly', (store) => store.get(key) as IDBRequest<T>)) ?? null;
}

export async function dropHandle(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key) as IDBRequest<undefined>);
}

export async function clearHandles(): Promise<void> {
  await run('readwrite', (store) => store.clear() as IDBRequest<undefined>);
  if (!idbAvailable()) return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Whether this handle can be read right now, without asking. */
export async function permissionState(
  handle: FileSystemHandle,
  mode: PermissionMode = 'read',
): Promise<PermissionState> {
  const capable = handle as unknown as PermissionCapable;
  if (!capable.queryPermission) return 'prompt';
  try {
    return await capable.queryPermission({ mode });
  } catch {
    return 'prompt';
  }
}

/** Must be called from a user gesture. Returns whether reading is now allowed. */
export async function requestPermission(
  handle: FileSystemHandle,
  mode: PermissionMode = 'read',
): Promise<boolean> {
  if ((await permissionState(handle, mode)) === 'granted') return true;
  const capable = handle as unknown as PermissionCapable;
  if (!capable.requestPermission) return false;
  try {
    return (await capable.requestPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

export function directoryPickerAvailable(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}
