/**
 * Recording by encoding the stream ourselves.
 *
 * Frames come off the track through `MediaStreamTrackProcessor`, go into a WebCodecs
 * encoder, and are muxed into a **fragmented** MP4 written straight to disk. Three
 * properties fall out of that choice, and each one was measured before it was chosen:
 *
 * - The finished file already carries a duration and seeks. There is no repair pass.
 * - A tab killed mid-recording leaves a file that *plays as it is* — a fragmented MP4 is a
 *   sequence of self-contained fragments, so the last complete one is the end of a valid
 *   file. A plain MP4 keeps its index at the end and a crash loses the entire recording;
 *   that was measured too, and is why this is not a plain MP4.
 * - Nothing accumulates: the muxer writes through to the disk writer per fragment, so at
 *   most one fragment is ever in memory or at risk.
 */
import {
  AudioSample,
  AudioSampleSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
} from 'mediabunny';
import { ChunkSink } from './ChunkSink';
import type { ClockDetail, SourceEngine, SourceEngineStats, StoppedSource } from './engine';

/**
 * Seconds of media in a fragment — and so both the granularity a crash is rounded down to
 * and the amount held in memory while it is assembled. Keyframes are emitted at the same
 * interval, since a fragment can only begin on one.
 */
const FRAGMENT_SECONDS = 1;

/**
 * How many frames may be waiting on the encoder before we start dropping them.
 *
 * Dropping is the right failure: a screen recorder that lets its frame queue grow trades a
 * flat heap for a smooth-looking count that is a lie by the end of a long take. What
 * matters is that the drops are counted and shown.
 */
const MAX_QUEUED_FRAMES = 4;

/**
 * Turns one track's sample timestamps into two things: a timeline that starts at zero, and
 * an estimate of when its first sample really happened on `performance.now()`.
 *
 * Sample timestamps are not wall-clock — measured against a canvas stream they sat over a
 * second away from `performance.now()`, and audio arrives on a different epoch again — so
 * the offset has to be inferred. A sample covering `[ts, ts+duration]` cannot arrive before
 * its content has happened, so `arrival - (ts + duration)` is an upper bound on the offset,
 * and the smallest one seen is the tightest: the sample that got through with the least
 * delay. Leaving `duration` out of that is not a rounding error — audio arrives in chunks of
 * ~20ms, and every one of them would push the microphone that far late.
 */
class SampleClock {
  firstArrivalMs = 0;
  private firstSampleUs = -1;
  private offsetMs = Number.POSITIVE_INFINITY;

  /** Records a sample and returns its timestamp rebased so the track starts at zero. */
  observe(timestampUs: number, durationUs: number): number {
    const now = performance.now();
    if (this.firstSampleUs < 0) {
      this.firstSampleUs = timestampUs;
      this.firstArrivalMs = now;
    }
    this.offsetMs = Math.min(this.offsetMs, now - (timestampUs + durationUs) / 1000);
    return (timestampUs - this.firstSampleUs) / 1e6;
  }

  /** `performance.now()` at which the first sample's content happened; 0 if none has. */
  mediaStartMs(): number {
    if (this.firstSampleUs < 0) return 0;
    if (!Number.isFinite(this.offsetMs)) return this.firstArrivalMs;
    return this.firstSampleUs / 1000 + this.offsetMs;
  }
}

export interface WebCodecsEngineOptions {
  fileName: string;
  video: boolean;
  /** Frame rate hint for the muxer; the real timing comes from the frames themselves. */
  frameRate?: number;
  /**
   * AAC bitrate. Speech survives 128k; a soundtrack captured from the system does not, and
   * a recording encoded below what the exporter uses would cap the quality of everything
   * made from it.
   */
  audioBitrate?: number;
}

/** What the exporter encodes at. A capture has no business being worse than its own export. */
export const AUDIO_BITRATE_DEFAULT = 192_000;
/** System audio carries music and effects, not speech, and is worth the extra headroom. */
export const AUDIO_BITRATE_SYSTEM = 256_000;

export class WebCodecsSourceEngine implements SourceEngine {
  readonly engine = 'webcodecs' as const;
  /** Already seekable, with a real duration. That is the point of this engine. */
  readonly needsRepair = false;
  readonly mimeType: string;
  readonly fileName: string;

  private output: Output;
  private sink: ChunkSink;
  private videoSource: VideoSampleSource | null = null;
  private audioSource: AudioSampleSource | null = null;
  private tracks: MediaStreamTrack[];
  private readers: ReadableStreamDefaultReader<VideoFrame | AudioData>[] = [];
  private pumps: Promise<void>[] = [];

  private running = false;
  private stopping = false;
  private failure: string | null = null;
  private frameQueue: VideoFrame[] = [];
  private queueWaiter: (() => void) | null = null;
  private readerDone = false;

  private delivered = 0;
  private encoded = 0;
  private dropped = 0;

  /**
   * One clock per kind of track. Video and audio timestamps come from different subsystems
   * on different epochs, so a single base would rebase one of them against the other's zero
   * and put the two tracks wildly out of step.
   */
  private clocks = { video: new SampleClock(), audio: new SampleClock() };

  private constructor(
    output: Output,
    sink: ChunkSink,
    tracks: MediaStreamTrack[],
    mimeType: string,
    fileName: string,
    private readonly frameRate: number,
  ) {
    this.output = output;
    this.sink = sink;
    this.tracks = tracks;
    this.mimeType = mimeType;
    this.fileName = fileName;
  }

  static async open(
    stream: MediaStream,
    options: WebCodecsEngineOptions,
  ): Promise<WebCodecsSourceEngine> {
    const videoTracks = options.video ? stream.getVideoTracks() : [];
    const audioTracks = stream.getAudioTracks();
    if (videoTracks.length === 0 && audioTracks.length === 0) {
      throw new Error('nothing to record on this stream');
    }

    const sink = await ChunkSink.open(options.fileName);
    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: FRAGMENT_SECONDS,
      }),
      // Write-through, not accumulated: mediabunny's chunked mode holds up to 16 MiB before
      // it writes anything, and a crash would take all of it with it.
      target: new StreamTarget(sink.positionedStream(), { chunked: false }),
    });

    const engine = new WebCodecsSourceEngine(
      output,
      sink,
      [...videoTracks, ...audioTracks],
      videoTracks.length > 0 ? 'video/mp4' : 'audio/mp4',
      options.fileName,
      options.frameRate ?? 30,
    );

    if (videoTracks.length > 0) {
      engine.videoSource = new VideoSampleSource({
        codec: 'avc',
        bitrate: QUALITY_HIGH,
        keyFrameInterval: FRAGMENT_SECONDS,
      });
      output.addVideoTrack(engine.videoSource, { frameRate: options.frameRate ?? 30 });
    }
    if (audioTracks.length > 0) {
      engine.audioSource = new AudioSampleSource({
        codec: 'aac',
        bitrate: options.audioBitrate ?? AUDIO_BITRATE_DEFAULT,
      });
      output.addAudioTrack(engine.audioSource);
    }

    // Started here rather than in `start()` so that the synchronous start really is
    // synchronous: by the time the user's clock is anchored, the muxer is ready for bytes.
    await output.start();
    return engine;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const track of this.tracks) {
      if (track.kind === 'video' && this.videoSource) {
        this.pumps.push(this.readVideo(track), this.encodeVideo());
      } else if (track.kind === 'audio' && this.audioSource) {
        this.pumps.push(this.pumpAudio(track));
      }
    }
  }


  /**
   * Reading and encoding are separate loops on purpose.
   *
   * Read a frame, encode it, read the next, and the reader sits idle for as long as the
   * encoder takes — so when the encoder falls behind, it is the *platform* that quietly
   * discards frames from its own buffer, and nothing in the page ever learns how many. With
   * the reader always draining, the choice of what to lose is ours and the count is exact.
   */
  private async readVideo(track: MediaStreamTrack): Promise<void> {
    const reader = new MediaStreamTrackProcessor({
      track: track as MediaStreamVideoTrack,
    }).readable.getReader();
    this.readers.push(reader as ReadableStreamDefaultReader<VideoFrame | AudioData>);
    try {
      while (!this.stopping) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        this.delivered++;
        if (this.frameQueue.length >= MAX_QUEUED_FRAMES) {
          // Drop the oldest rather than the newest: a recorder that cannot keep up should
          // skip, not lag, and the frames worth keeping are the recent ones.
          this.frameQueue.shift()!.close();
          this.dropped++;
        }
        this.frameQueue.push(value);
        this.wake();
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.readerDone = true;
      this.wake();
    }
  }

  private async encodeVideo(): Promise<void> {
    try {
      for (;;) {
        const frame = this.frameQueue.shift();
        if (!frame) {
          if (this.readerDone) break;
          await new Promise<void>((resolve) => {
            this.queueWaiter = resolve;
          });
          continue;
        }
        // A capture frame's timestamp is the instant it was grabbed, and it is handed over
        // immediately — so unlike audio there is no coverage window to account for.
        const timestamp = this.clocks.video.observe(frame.timestamp, 0);
        // Capture frames often carry no duration of their own; without one the muxer has
        // nothing to give the final frame, and the file ends a frame short of the media.
        const duration = frame.duration ? frame.duration / 1e6 : 1 / this.frameRate;
        const sample = new VideoSample(frame, { timestamp, duration });
        try {
          await this.videoSource!.add(sample);
          this.encoded++;
        } finally {
          sample.close();
          frame.close();
        }
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private wake(): void {
    const waiter = this.queueWaiter;
    this.queueWaiter = null;
    waiter?.();
  }

  private async pumpAudio(track: MediaStreamTrack): Promise<void> {
    const reader = new MediaStreamTrackProcessor({
      track: track as MediaStreamAudioTrack,
    }).readable.getReader();
    this.readers.push(reader as ReadableStreamDefaultReader<VideoFrame | AudioData>);
    try {
      while (!this.stopping) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        const timestamp = this.clocks.audio.observe(value.timestamp, value.duration);
        const sample = new AudioSample(value);
        sample.setTimestamp(timestamp);
        try {
          await this.audioSource!.add(sample);
        } finally {
          sample.close();
          value.close();
        }
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    if (this.stopping) return;
    this.failure = e instanceof Error ? e.message : String(e);
  }

  stats(): SourceEngineStats {
    return {
      bytesWritten: this.sink.bytesWritten,
      pending: this.sink.pending,
      error: this.failure ?? this.sink.error,
      framesDelivered: this.delivered,
      framesEncoded: this.encoded,
      framesDropped: this.dropped,
    };
  }

  /**
   * Where this source's media starts: the earliest of its tracks. Both begin at the same
   * moment, so this only matters when one of them has yet to deliver a sample.
   */
  mediaStartMs(): number {
    const starts = [this.clocks.video.mediaStartMs(), this.clocks.audio.mediaStartMs()].filter(
      (ms) => ms > 0,
    );
    return starts.length > 0 ? Math.min(...starts) : 0;
  }

  clockDetail(): ClockDetail {
    const arrivals = [this.clocks.video.firstArrivalMs, this.clocks.audio.firstArrivalMs].filter(
      (ms) => ms > 0,
    );
    const firstArrivalMs = arrivals.length > 0 ? Math.min(...arrivals) : 0;
    return {
      firstArrivalMs,
      // How late the first sample was against where its content is reckoned to have been —
      // the gap the naive "use the arrival time" rule would have swallowed whole.
      firstSampleLagMs: firstArrivalMs > 0 ? firstArrivalMs - this.mediaStartMs() : 0,
    };
  }

  async stop(): Promise<StoppedSource> {
    if (this.stopping) return { bytes: this.sink.bytesWritten, stoppedAtMs: performance.now() };
    this.stopping = true;
    const stoppedAtMs = performance.now();

    for (const reader of this.readers) await reader.cancel().catch(() => undefined);
    this.wake();
    // The encode loop drains whatever is still queued before it exits, so stopping does not
    // throw away the last few frames.
    await Promise.all(this.pumps).catch(() => undefined);
    // Writes the last fragment and the header's duration. After this the file is complete.
    await this.output.finalize();
    const bytes = await this.sink.close();
    return { bytes, stoppedAtMs };
  }

  async cancel(): Promise<void> {
    this.stopping = true;
    for (const reader of this.readers) await reader.cancel().catch(() => undefined);
    this.wake();
    await Promise.all(this.pumps).catch(() => undefined);
    for (const frame of this.frameQueue.splice(0)) frame.close();
    await this.output.cancel().catch(() => undefined);
    await this.sink.close();
  }
}
