import { VideoSampleSink } from 'mediabunny';
import type { InputVideoTrack, VideoSample } from 'mediabunny';

/**
 * Frame reader for one clip.
 *
 * The export walks timeline time strictly forward, so each clip's source time is also
 * monotonic — one sequential iterator per clip is therefore enough, and decodes every
 * packet at most once. `HTMLVideoElement.currentTime` seeking, which the preview uses,
 * is neither frame-accurate nor fast enough for this.
 */
export class ClipFrameReader {
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private current: VideoSample | null = null;
  private exhausted = false;
  /** Rotated sources are drawn through a 2D canvas so the export matches the preview. */
  private rotationCanvas: HTMLCanvasElement | null = null;

  constructor(
    private readonly track: InputVideoTrack,
    private readonly startSec: number,
    private readonly endSec: number,
  ) {}

  private ensureIterator(): AsyncGenerator<VideoSample, void, unknown> {
    if (!this.iterator) {
      const sink = new VideoSampleSink(this.track);
      // A small lead-in guards against a source whose first sample starts slightly late.
      this.iterator = sink.samples(Math.max(0, this.startSec), this.endSec + 1 / 1000);
    }
    return this.iterator;
  }

  /**
   * The frame that should be on screen at `sourceTime`, i.e. the last decoded sample
   * whose presentation window has started. Returns null before the first sample.
   */
  async frameAt(sourceTime: number): Promise<VideoSample | null> {
    const it = this.ensureIterator();

    while (!this.exhausted) {
      // The current sample still covers this timestamp — nothing to decode.
      if (this.current && this.current.timestamp + this.current.duration > sourceTime) break;

      const next = await it.next();
      if (next.done) {
        this.exhausted = true;
        break;
      }
      // Hold the newest sample only; anything older is unreachable now.
      this.current?.close();
      this.current = next.value;
    }

    return this.current;
  }

  /** A drawable for the compositor, with rotation metadata already applied. */
  toDrawable(sample: VideoSample): { source: TexImageSource; width: number; height: number } | null {
    if (sample.rotation === 0) {
      return {
        source: sample.toVideoFrame(),
        width: sample.displayWidth,
        height: sample.displayHeight,
      };
    }

    const canvas = this.rotationCanvas ?? (this.rotationCanvas = document.createElement('canvas'));
    canvas.width = sample.displayWidth;
    canvas.height = sample.displayHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    sample.draw(ctx, 0, 0);
    return { source: canvas, width: canvas.width, height: canvas.height };
  }

  async dispose(): Promise<void> {
    this.current?.close();
    this.current = null;
    await this.iterator?.return();
    this.iterator = null;
  }
}
