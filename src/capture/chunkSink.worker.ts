/**
 * Writes recording chunks to an OPFS file from a worker.
 *
 * A sync access handle is only available off the main thread, and it is the reason this
 * worker exists: it lets each chunk land on disk with a flush, so a tab that is killed
 * mid-recording leaves a file containing every byte acknowledged so far. The main thread
 * hands over ArrayBuffers and forgets them, which is what keeps the heap flat.
 */
import { OUT_OF_SPACE } from './quota';

interface OpenMsg {
  type: 'open';
  dir: string;
  file: string;
}
interface WriteMsg {
  type: 'write';
  data: ArrayBuffer;
  seq: number;
  /** Byte offset to write at. Omitted means "append" — MediaRecorder only ever appends. */
  at?: number;
}
interface CloseMsg {
  type: 'close';
}
type Msg = OpenMsg | WriteMsg | CloseMsg;

interface SyncHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
  truncate(size: number): void;
}

let handle: SyncHandle | null = null;
/** Where an appending write goes next, and — since a muxer may revisit its header — the
 * furthest byte ever written, which is the file's real size. */
let appendAt = 0;
let size = 0;

async function open(msg: OpenMsg): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(msg.dir, { create: true });
  const fileHandle = await dir.getFileHandle(msg.file, { create: true });
  handle = await (
    fileHandle as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }
  ).createSyncAccessHandle();
  // A reused name must not leave the tail of an older, longer recording behind.
  handle.truncate(0);
  appendAt = 0;
  size = 0;
}

self.onmessage = async (event: MessageEvent<Msg>) => {
  const msg = event.data;
  try {
    if (msg.type === 'open') {
      await open(msg);
      self.postMessage({ type: 'opened' });
      return;
    }

    if (msg.type === 'write') {
      if (!handle) throw new Error('sink not open');
      const view = new Uint8Array(msg.data);
      const at = msg.at ?? appendAt;
      // `write` returns how many bytes it actually took. Out of quota it takes fewer —
      // silently, with no exception — so ignoring this return value loses the tail of a
      // recording and reports success. Treat a short write as the failure it is.
      const written = handle.write(view, { at });
      appendAt = at + written;
      size = Math.max(size, appendAt);
      if (written < view.byteLength) {
        handle.flush();
        throw new Error(
          `ran out of storage after ${size} bytes (wrote ${written} of ${view.byteLength})`,
        );
      }
      // Flush per chunk: the point of streaming to disk is that a crash keeps what it
      // already acknowledged, and unflushed bytes are not on disk.
      handle.flush();
      self.postMessage({ type: 'wrote', seq: msg.seq, bytes: size });
      return;
    }

    if (msg.type === 'close') {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
      self.postMessage({ type: 'closed', bytes: size });
    }
  } catch (e) {
    // A quota failure is not like other write failures: the file on disk is intact and
    // valid, and the only thing to do is stop cleanly and say so. It is named here so the
    // session can tell the two apart.
    const quota = e instanceof DOMException && e.name === 'QuotaExceededError';
    self.postMessage({
      type: 'error',
      message: quota ? OUT_OF_SPACE : e instanceof Error ? e.message : String(e),
      quota,
    });
  }
};
