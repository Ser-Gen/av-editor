/**
 * One Record press, up to three files.
 *
 * Screen, microphone and system audio are separate recorders writing separate files,
 * because they become separate timeline tracks — a single muxed file could not be
 * re-levelled or re-timed per source. They are started from one `performance.now()`
 * anchor and each records how far after that anchor its media actually began, which is what
 * lets the three land frame-aligned on the timeline instead of merely adjacent.
 *
 * Nothing accumulates in memory: encoded bytes go straight to OPFS and are dropped, so a
 * thirty-minute capture has the same heap cost as a thirty-second one.
 *
 * How the bytes are produced is the engine's business — WebCodecs when the browser can,
 * MediaRecorder when it cannot. This class only cares when each source's media starts.
 */
import { chooseEngine } from './engine';
import type {
  EngineChoice,
  EngineName,
  EnginePreference,
  SourceEngine,
  StoppedSource,
} from './engine';
import { MediaRecorderSourceEngine, mediaRecorderExtension, mediaRecorderMime } from './mediaRecorderEngine';
import type { CaptureSourceKind, RecordingMeta } from './recordingStore';
import { deleteRecording, writeMeta } from './recordingStore';
import { acquireSources, browserSources, stopStream, trackFormat } from './sources';
import type { CaptureStepReporter, SourceProvider, SourceRequest, VideoFormat } from './sources';
import { captureVideoBitrate } from './bitrate';
import {
  AUDIO_BITRATE_DEFAULT,
  AUDIO_BITRATE_SYSTEM,
  WebCodecsSourceEngine,
} from './webcodecsEngine';

export interface SourceStatus {
  kind: CaptureSourceKind;
  bytes: number;
  /** Chunks handed to the writer but not yet confirmed on disk. */
  pending: number;
  /** 0–1 RMS, for the level meter. Video sources report 0. */
  level: number;
  error: string | null;
  /** Frames let go because the encoder was behind. WebCodecs engine only. */
  droppedFrames: number;
  framesEncoded: number;
  framesDelivered: number;
  /** What the track negotiated. Null for audio sources. */
  format: VideoFormat | null;
  /**
   * Frames per second actually arriving, over a short rolling window.
   *
   * Not the same number as `format.frameRate`, and the gap is the point: a camera in dim
   * light lengthens its exposure and halves its output rate without renegotiating the
   * track, so `getSettings()` goes on claiming 60 while 30 arrive. Nothing in a constraint
   * can fix that — but showing it tells the user to turn a light on.
   */
  deliveredFps: number;
  /** Set once this source stopped early, with the reason. */
  endedReason: string | null;
}

export interface CaptureStatus {
  elapsed: number;
  sources: SourceStatus[];
  bytesTotal: number;
  /** True while any chunk is still in flight to disk. */
  writing: boolean;
  engine: EngineName;
  droppedFrames: number;
  /** Set once the camera has been reduced to keep the screen intact — see `considerDegrading`. */
  degraded: string | null;
}

export interface CapturedFile {
  meta: RecordingMeta;
  /** Duration measured from the time anchor, independent of what the container claims. */
  measuredDuration: number;
  /** Where the offset came from — the alignment checks read this rather than assuming. */
  clock: {
    mediaStartMs: number;
    anchorMs: number;
    firstArrivalMs?: number;
    firstSampleLagMs?: number;
  };
}

/**
 * How far back the delivered-rate readout looks. Long enough not to flicker on one late
 * frame, short enough that a camera stalling is visible within a couple of seconds.
 */
const RATE_WINDOW_MS = 2000;

/**
 * When to decide the machine cannot keep up, and what to do about it.
 *
 * 1080p60 screen plus 720p60 camera is roughly 2.5× the encoding load phase 15 measured,
 * and it is the case most likely to drop frames. If it does not hold, something has to
 * give — and it should be the camera, because the screen is the content and the inset is
 * the face. Halving the camera's frame rate is a real reduction in load: fewer frames are
 * pulled off the track at all, so the encoder is asked for less rather than asked to drop
 * more. It happens once, and the panel says it happened.
 */
const DROP_WINDOW_MS = 5000;
/** Frames lost inside that window before the camera gives way. ~2.5% of one 60 fps source. */
const DROP_BUDGET = 15;

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Ties an engine to the stream it is recording, the meter on it, and its sidecar. */
class CaptureSource {
  meta: RecordingMeta;
  /** Non-null once the source stopped ahead of the session — see `watchForEnd`. */
  endedReason: string | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuffer: Float32Array | null = null;
  /** Rolling window of (timestamp, frames delivered) for the live rate readout. */
  private rateWindow: { atMs: number; frames: number }[] = [];

  constructor(
    readonly kind: CaptureSourceKind,
    readonly stream: MediaStream,
    readonly engine: SourceEngine,
    meta: RecordingMeta,
  ) {
    this.meta = meta;
  }

  attachMeter(ctx: AudioContext): void {
    if (this.stream.getAudioTracks().length === 0) return;
    const source = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    this.analyser = analyser;
    this.levelBuffer = new Float32Array(analyser.fftSize);
  }

  /**
   * Delivered frames per second over the last `RATE_WINDOW_MS`, sampled as the panel polls.
   *
   * A cumulative counter divided by elapsed time would average across the whole take and
   * hide exactly the thing worth seeing: a camera that started at 60 and dropped to 30 five
   * minutes in reads as 45 for the rest of the session and never recovers on screen.
   */
  deliveredFps(frames: number): number {
    const now = performance.now();
    this.rateWindow.push({ atMs: now, frames });
    while (this.rateWindow.length > 2 && now - this.rateWindow[0].atMs > RATE_WINDOW_MS) {
      this.rateWindow.shift();
    }
    const oldest = this.rateWindow[0];
    const span = (now - oldest.atMs) / 1000;
    if (span < 0.5) return 0;
    return (frames - oldest.frames) / span;
  }

  level(): number {
    if (!this.analyser || !this.levelBuffer) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const v of this.levelBuffer) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length) * 3);
  }
}

export class CaptureSession {
  private sources: CaptureSource[] = [];
  private audioCtx: AudioContext | null = null;
  private anchorMs = 0;
  private stopped = false;
  private streams: MediaStream[] = [];
  /** Sources that ended before the session did, kept so `stop()` still returns their files. */
  private finished: { source: CaptureSource; result: StoppedSource }[] = [];
  /** Rolling window of total dropped frames, for `considerDegrading`. */
  private dropWatch: { atMs: number; dropped: number }[] = [];
  /** Set once the camera has been reduced, so it only ever happens once. */
  private degraded: string | null = null;

  readonly sessionId = uid('session');
  /** Non-null when system audio was requested and the platform did not provide it. */
  systemAudioMissing: string | null = null;
  /** Non-null when the microphone was requested and refused, and the rest still recorded. */
  micMissing: string | null = null;
  /** Non-null when the camera was requested and could not be opened. */
  cameraMissing: string | null = null;
  /**
   * Called when one source stops before the session does — an unplugged webcam, Chrome's
   * "Stop sharing" bar. The others go on recording; this is how the panel learns to say so.
   */
  onSourceEnded: ((kind: CaptureSourceKind, reason: string) => void) | null = null;
  /** Called when the last live source ends by itself, so the session can be wound up. */
  onAllEnded: (() => void) | null = null;
  /** Non-null when the browser processed system audio despite being asked not to. */
  systemAudioProcessed: string | null = null;
  /** Which engine is recording, and why — surfaced in the UI. */
  engineChoice: EngineChoice = { engine: 'mediarecorder', reason: '' };

  static async start(
    request: SourceRequest,
    provider: SourceProvider = browserSources,
    enginePreference: EnginePreference = 'auto',
    onStep: CaptureStepReporter = () => undefined,
  ): Promise<CaptureSession> {
    const session = new CaptureSession();
    onStep('choosing-engine');
    session.engineChoice = await chooseEngine(enginePreference);
    const sources = await acquireSources(request, provider, onStep);
    session.systemAudioMissing = sources.systemAudioMissing;
    session.micMissing = sources.micMissing;
    session.cameraMissing = sources.cameraMissing;
    session.systemAudioProcessed = sources.systemAudioProcessed;

    // Screen before camera, so the screen takes the base video lane and the camera the one
    // above it. Placement reads the order back from `SOURCE_LANE`, but a busy-lane fallback
    // resolves in the order the clips are created, and this is the order that means "the
    // camera composites over the screen".
    const plan: { kind: CaptureSourceKind; stream: MediaStream | null; video: boolean }[] = [
      { kind: 'screen', stream: sources.screen, video: true },
      { kind: 'camera', stream: sources.camera, video: true },
      { kind: 'mic', stream: sources.mic, video: false },
      { kind: 'system', stream: sources.systemAudio, video: false },
    ];

    try {
      onStep('opening-files');
      for (const entry of plan) {
        if (!entry.stream) continue;
        session.streams.push(entry.stream);
        session.sources.push(await session.buildSource(entry.kind, entry.stream, entry.video));
      }
      if (session.sources.length === 0) throw new Error('No capture sources were granted.');
      onStep('starting-encoders');

      session.audioCtx = new AudioContext();
      for (const source of session.sources) source.attachMeter(session.audioCtx);

      // One anchor for every source, and one synchronous loop so nothing can be scheduled
      // in between: each source's media timeline starts at its own `start()` call.
      session.anchorMs = performance.now();
      for (const source of session.sources) source.engine.start();
      for (const source of session.sources) session.watchForEnd(source);
      return session;
    } catch (e) {
      await session.cancel();
      throw e;
    }
  }

  private async buildSource(
    kind: CaptureSourceKind,
    stream: MediaStream,
    video: boolean,
  ): Promise<CaptureSource> {
    const id = uid('rec');
    const engine = await this.buildEngine(id, stream, video, kind);

    const meta: RecordingMeta = {
      id,
      sessionId: this.sessionId,
      kind,
      mimeType: engine.mimeType,
      startOffset: 0,
      startedAt: Date.now(),
      state: 'recording',
      rawFile: engine.fileName,
      engine: engine.engine,
      ...(video ? { format: trackFormat(stream) ?? undefined } : {}),
    };
    // Written before any media: a tab that dies one second in still leaves a described file.
    await writeMeta(meta);
    return new CaptureSource(kind, stream, engine, meta);
  }

  private async buildEngine(
    id: string,
    stream: MediaStream,
    video: boolean,
    kind: CaptureSourceKind,
  ): Promise<SourceEngine> {
    if (this.engineChoice.engine === 'webcodecs') {
      const format = video ? trackFormat(stream) : null;
      const frameRate = format?.frameRate || 30;
      // Audio-only sources get an audio extension: an `.mp4` holding nothing but sound would
      // be imported as a video clip with no picture.
      return WebCodecsSourceEngine.open(stream, {
        fileName: `${id}.raw.${video ? 'mp4' : 'm4a'}`,
        video,
        frameRate,
        // Sized from what the track actually negotiated, so a 60 fps capture is not encoded
        // at a 30 fps budget. `QUALITY_HIGH` does not know the frame rate exists.
        videoBitrate: format
          ? captureVideoBitrate(format.width, format.height, format.frameRate)
          : undefined,
        // System audio is whatever the machine is playing — music, a game, a call — and is
        // the one source where the encoder, not the microphone, is the weak link.
        audioBitrate: kind === 'system' ? AUDIO_BITRATE_SYSTEM : AUDIO_BITRATE_DEFAULT,
      });
    }
    const mimeType = mediaRecorderMime(video);
    return MediaRecorderSourceEngine.open(stream, {
      fileName: `${id}.raw.${mediaRecorderExtension(mimeType)}`,
      mimeType,
    });
  }

  /**
   * A source can stop before the session does, and until now nothing noticed.
   *
   * Unplug a webcam, or press Chrome's "Stop sharing" bar, and the track fires `ended`
   * while the session goes on looking alive — producing a file that stops early with no
   * explanation, and an elapsed time that keeps counting against media that is not
   * arriving. Each track is watched, and the source it belongs to is finished cleanly on
   * its own: the file is closed and playable, the reason is on its sidecar, and every other
   * source records on undisturbed.
   */
  private watchForEnd(source: CaptureSource): void {
    for (const track of source.stream.getTracks()) {
      track.addEventListener(
        'ended',
        () => {
          void this.endSource(
            source,
            track.kind === 'video'
              ? 'the video source stopped — the device was disconnected or sharing was stopped'
              : 'the audio source stopped — the device was disconnected',
          );
        },
        { once: true },
      );
    }
  }

  /** Finishes one source mid-session, leaving the others recording. */
  private async endSource(source: CaptureSource, reason: string): Promise<void> {
    if (this.stopped) return;
    const index = this.sources.indexOf(source);
    if (index < 0) return;
    this.sources.splice(index, 1);
    source.endedReason = reason;

    const result = await source.engine.stop().catch(() => ({ bytes: 0, stoppedAtMs: performance.now() }));
    source.meta = { ...source.meta, endedReason: reason };
    await writeMeta(source.meta).catch(() => undefined);
    this.finished.push({ source, result });
    stopStream(source.stream);

    this.onSourceEnded?.(source.kind, reason);
    // Nothing left to record: the session is over whether or not anyone pressed Stop.
    if (this.sources.length === 0) this.onAllEnded?.();
  }

  /**
   * The live camera stream, so the panel can go on showing the face during the take.
   *
   * Deliberately the session's own stream rather than a second `getUserMedia`: a camera can
   * only be opened once, and a preview that fought the recorder for the device would fail
   * exactly when it mattered.
   */
  cameraStream(): MediaStream | null {
    return this.sources.find((s) => s.kind === 'camera')?.stream ?? null;
  }

  get active(): boolean {
    return !this.stopped && this.sources.length > 0;
  }

  get elapsed(): number {
    if (!this.anchorMs) return 0;
    return (performance.now() - this.anchorMs) / 1000;
  }

  status(): CaptureStatus {
    // Ended sources stay in the list rather than vanishing from the panel: a camera that was
    // unplugged still wrote a file, and its bytes are still part of what this take produced.
    const all = [...this.sources, ...this.finished.map((f) => f.source)];
    const sources = all.map((source) => {
      const stats = source.engine.stats();
      return {
        kind: source.kind,
        bytes: stats.bytesWritten,
        pending: stats.pending,
        level: source.level(),
        error: stats.error,
        droppedFrames: stats.framesDropped,
        framesEncoded: stats.framesEncoded,
        framesDelivered: stats.framesDelivered,
        format: trackFormat(source.stream),
        deliveredFps: source.endedReason ? 0 : source.deliveredFps(stats.framesDelivered),
        endedReason: source.endedReason,
      };
    });
    this.considerDegrading(sources);
    return {
      elapsed: this.elapsed,
      sources,
      bytesTotal: sources.reduce((sum, s) => sum + s.bytes, 0),
      writing: sources.some((s) => s.pending > 0),
      engine: this.engineChoice.engine,
      droppedFrames: sources.reduce((sum, s) => sum + s.droppedFrames, 0),
      degraded: this.degraded,
    };
  }

  /**
   * Sheds load from the camera when frames are being lost, rather than from the screen.
   *
   * Read off the same poll the meters use, so there is no extra timer. It fires at most
   * once per session: a camera that has already been reduced to 30 and is still dropping
   * frames has a problem this cannot fix, and halving it again would only make the face
   * stutter for nothing.
   */
  private considerDegrading(sources: SourceStatus[]): void {
    if (this.degraded || this.stopped) return;
    const camera = this.sources.find((s) => s.kind === 'camera');
    if (!camera) return;

    const now = performance.now();
    const dropped = sources.reduce((sum, s) => sum + s.droppedFrames, 0);
    this.dropWatch.push({ atMs: now, dropped });
    while (this.dropWatch.length > 2 && now - this.dropWatch[0].atMs > DROP_WINDOW_MS) {
      this.dropWatch.shift();
    }
    const oldest = this.dropWatch[0];
    if (now - oldest.atMs < DROP_WINDOW_MS) return;
    if (dropped - oldest.dropped < DROP_BUDGET) return;

    const track = camera.stream.getVideoTracks()[0];
    const rate = track?.getSettings().frameRate ?? 0;
    if (!track || rate <= 30.5) return;

    this.degraded =
      `Frames were being dropped, so the camera was reduced from ${Math.round(rate)} to 30 fps. ` +
      `The screen recording is unchanged.`;
    void track.applyConstraints({ frameRate: { ideal: 30 } }).catch(() => undefined);
  }

  /**
   * Stops every source, drains the writers and returns one entry per source with its
   * measured start offset and duration.
   *
   * A WebCodecs file is finished here; a MediaRecorder file still has a live container and
   * needs the repair pass, which is a separate, resumable step.
   */
  async stop(): Promise<CapturedFile[]> {
    if (this.stopped) return [];
    this.stopped = true;

    // Whatever ended early is already stopped and drained; it still has a file, an offset
    // and a duration, so it belongs in the same list as the sources that ran to the end.
    const stops = [
      ...this.finished,
      ...(await Promise.all(
        this.sources.map(async (source) => ({ source, result: await source.engine.stop() })),
      )),
    ];

    for (const stream of this.streams) stopStream(stream);
    void this.audioCtx?.close();
    this.audioCtx = null;

    // Offsets are measured from the source that started first, not from the anchor. A live
    // stream can hand over a frame captured a moment *before* the anchor, and measuring
    // against the anchor would have to clamp that to zero — throwing away exactly the
    // sub-frame difference these offsets exist to preserve.
    const mediaStarts = stops.map(({ source }) => source.engine.mediaStartMs() || this.anchorMs);
    const earliest = Math.min(...mediaStarts);

    const out: CapturedFile[] = [];
    for (const [index, { source, result }] of stops.entries()) {
      const mediaStart = mediaStarts[index];
      const startOffset = (mediaStart - earliest) / 1000;
      const measuredDuration = Math.max(0, (result.stoppedAtMs - mediaStart) / 1000);
      const meta: RecordingMeta = {
        ...source.meta,
        startOffset,
        // A WebCodecs capture is already a finished, seekable file; nothing to rebuild.
        state: source.engine.needsRepair ? 'raw' : 'ready',
        readyFile: source.engine.needsRepair ? undefined : source.engine.fileName,
        durationSeconds: measuredDuration,
        bytes: result.bytes,
        ...(source.endedReason ? { endedReason: source.endedReason } : {}),
      };
      await writeMeta(meta);
      source.meta = meta;
      out.push({
        meta,
        measuredDuration,
        clock: { mediaStartMs: mediaStart, anchorMs: this.anchorMs, ...source.engine.clockDetail?.() },
      });
    }
    this.sources = [];
    this.finished = [];
    return out;
  }

  /** Abandons everything, leaving no files behind. */
  async cancel(): Promise<void> {
    this.stopped = true;
    for (const source of this.sources) {
      await source.engine.cancel();
      // Discard means discard: without this the abandoned file would be offered back as a
      // leftover on the next launch, which is not what the button says.
      await deleteRecording(source.meta);
    }
    // Anything that ended early is already closed, so it needs deleting rather than
    // cancelling — but discarding the take has to take it too, whole file and sidecar.
    for (const { source } of this.finished) await deleteRecording(source.meta);
    for (const stream of this.streams) stopStream(stream);
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.sources = [];
    this.finished = [];
  }
}
