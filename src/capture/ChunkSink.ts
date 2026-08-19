/**
 * Main-thread half of the OPFS writer.
 *
 * `write()` never blocks the recorder: chunks are queued and drained in order by the
 * worker. `pending` is what the UI shows as "writing to disk" — if it grows, the disk is
 * not keeping up with the encoder, and that is worth seeing rather than discovering as a
 * dropped recording.
 */

const RECORDINGS_DIR = 'recordings';
/** Opening an OPFS file takes milliseconds. Anything near this is a failure, not slowness. */
const OPEN_TIMEOUT_MS = 10_000;

export class ChunkSink {
  private worker: Worker;
  private queue: Promise<void> = Promise.resolve();
  private seq = 0;
  private acked = 0;
  private bytes = 0;
  private failure: string | null = null;
  private closed = false;
  private waiters = new Map<number, () => void>();
  private closeResolve: ((bytes: number) => void) | null = null;

  private constructor(worker: Worker, readonly fileName: string) {
    this.worker = worker;
    this.worker.onmessage = (event) => this.onMessage(event.data);
  }

  /**
   * Every way this can fail has to end in a rejection.
   *
   * The worker answers `open` with `opened` or `error`, but only once it is running. A
   * module that never loads — a bad build, a blocked worker URL — installs no message
   * handler at all, so the `open` we posted is simply dropped and waiting for a reply waits
   * forever. That surfaced as a Record button that locked and said nothing. `onerror` covers
   * the load failures the browser reports; the deadline covers the ones it does not.
   */
  static async open(fileName: string): Promise<ChunkSink> {
    const worker = new Worker(new URL('./chunkSink.worker.ts', import.meta.url), {
      type: 'module',
    });
    const sink = new ChunkSink(worker, fileName);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(() => reject(new Error(`the recording writer did not start within ${OPEN_TIMEOUT_MS / 1000}s`))),
          OPEN_TIMEOUT_MS,
        );
        const finish = (settle: () => void) => {
          clearTimeout(timer);
          worker.removeEventListener('message', onFirst);
          worker.removeEventListener('error', onError);
          settle();
        };
        const onFirst = (event: MessageEvent) => {
          if (event.data?.type === 'opened') finish(resolve);
          else if (event.data?.type === 'error') {
            finish(() => reject(new Error(event.data.message)));
          }
        };
        const onError = (event: ErrorEvent) => {
          finish(() =>
            reject(new Error(event.message || 'the recording writer failed to load')),
          );
        };
        worker.addEventListener('message', onFirst);
        worker.addEventListener('error', onError);
        worker.postMessage({ type: 'open', dir: RECORDINGS_DIR, file: fileName });
      });
    } catch (e) {
      worker.terminate();
      throw e;
    }
    return sink;
  }

  private onMessage(msg: { type: string; seq?: number; bytes?: number; message?: string }): void {
    if (msg.type === 'wrote') {
      this.acked = msg.seq ?? this.acked;
      this.bytes = msg.bytes ?? this.bytes;
      this.waiters.get(msg.seq ?? -1)?.();
      this.waiters.delete(msg.seq ?? -1);
      return;
    }
    if (msg.type === 'closed') {
      this.bytes = msg.bytes ?? this.bytes;
      this.closeResolve?.(this.bytes);
      this.closeResolve = null;
      return;
    }
    if (msg.type === 'error') {
      this.failure = msg.message ?? 'write failed';
      for (const resolve of this.waiters.values()) resolve();
      this.waiters.clear();
      this.closeResolve?.(this.bytes);
      this.closeResolve = null;
    }
  }

  /** Bytes the worker has confirmed on disk. */
  get bytesWritten(): number {
    return this.bytes;
  }

  /** Chunks handed over but not yet confirmed written. */
  get pending(): number {
    return this.seq - this.acked;
  }

  /** Total chunks handed over — how chatty the muxer is with the disk. */
  get writes(): number {
    return this.seq;
  }

  get error(): string | null {
    return this.failure;
  }

  /** Queues a chunk. Returns once the worker has it on disk. */
  write(blob: Blob, at?: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    const seq = ++this.seq;
    this.queue = this.queue.then(async () => {
      if (this.closed || this.failure) return;
      const buffer = await blob.arrayBuffer();
      await new Promise<void>((resolve) => {
        this.waiters.set(seq, resolve);
        // Transferred, not copied — the chunk leaves this heap entirely.
        this.worker.postMessage({ type: 'write', data: buffer, seq, at }, [buffer]);
      });
    });
    return this.queue;
  }

  /**
   * The same file as a `WritableStream`, for muxers that write positioned chunks.
   *
   * The positions matter: a muxer revisits its header at the end to record the duration,
   * and an appending writer would tack that onto the tail where no player will look for it.
   */
  positionedStream(): WritableStream<{ data: Uint8Array; position: number }> {
    return new WritableStream({
      write: async (chunk) => {
        await this.write(new Blob([chunk.data as BufferSource]), chunk.position);
        if (this.failure) throw new Error(this.failure);
      },
    });
  }

  /** Drains the queue, closes the file and terminates the worker. Returns bytes written. */
  async close(): Promise<number> {
    if (this.closed) return this.bytes;
    await this.queue.catch(() => undefined);
    this.closed = true;
    const bytes = await new Promise<number>((resolve) => {
      this.closeResolve = resolve;
      this.worker.postMessage({ type: 'close' });
      // The bytes are already flushed per chunk; never hang the UI on the close ack.
      setTimeout(() => resolve(this.bytes), 3000);
    });
    this.worker.terminate();
    return bytes;
  }
}
