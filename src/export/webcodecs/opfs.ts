/**
 * Scratch files in the Origin Private File System.
 *
 * The muxer writes here rather than into an in-memory buffer, so a long export's peak
 * heap is bounded by the encoder queue instead of by the size of the finished file.
 * The result is handed back as a `File` backed by disk — turning it into an object URL
 * for download never materialises the bytes in the heap either.
 */

export interface StreamChunk {
  type: 'write';
  data: Uint8Array;
  position: number;
}

export interface ScratchFile {
  /** Pass straight to mediabunny's `StreamTarget`. Closed by `Output.finalize()`. */
  writable: WritableStream<StreamChunk>;
  toFile(): Promise<File>;
  /** Abandon and delete — safe to call after a failure or a cancel. */
  abort(): Promise<void>;
}

const SCRATCH_DIR = 'exports';

async function scratchDir(name = SCRATCH_DIR): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

/** `dirName` lets capture reuse this writer for the recordings directory. */
export async function openScratchFile(name: string, dirName = SCRATCH_DIR): Promise<ScratchFile> {
  const dir = await scratchDir(dirName);
  const handle = await dir.getFileHandle(name, { create: true });
  const fileWritable = await handle.createWritable();
  let released = false;

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await fileWritable.abort();
    } catch {
      // Already closed or aborted — nothing to release.
    }
  };

  const writable = new WritableStream<StreamChunk>({
    write: async (chunk) => {
      await fileWritable.write({ type: 'write', position: chunk.position, data: chunk.data });
    },
    close: async () => {
      released = true;
      await fileWritable.close();
    },
    abort: release,
  });

  return {
    writable,
    toFile: () => handle.getFile(),
    abort: async () => {
      await release();
      try {
        await dir.removeEntry(name);
      } catch {
        // The entry may never have been created; deletion is best-effort.
      }
    },
  };
}

/** Removes leftovers from cancelled or crashed exports. */
export async function clearExportScratch(keep?: string): Promise<void> {
  try {
    const dir = await scratchDir();
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name === keep) continue;
      await dir.removeEntry(name).catch(() => undefined);
    }
  } catch {
    // OPFS unavailable — nothing to clean.
  }
}
