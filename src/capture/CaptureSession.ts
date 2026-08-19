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
import type { EngineChoice, EngineName, EnginePreference, SourceEngine } from './engine';
import { MediaRecorderSourceEngine, mediaRecorderExtension, mediaRecorderMime } from './mediaRecorderEngine';
import type { CaptureSourceKind, RecordingMeta } from './recordingStore';
import { deleteRecording, writeMeta } from './recordingStore';
import { acquireSources, browserSources, stopStream } from './sources';
import type { CaptureStepReporter, SourceProvider, SourceRequest } from './sources';
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
}

export interface CaptureStatus {
  elapsed: number;
  sources: SourceStatus[];
  bytesTotal: number;
  /** True while any chunk is still in flight to disk. */
  writing: boolean;
  engine: EngineName;
  droppedFrames: number;
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

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Ties an engine to the stream it is recording, the meter on it, and its sidecar. */
class CaptureSource {
  meta: RecordingMeta;
  private analyser: AnalyserNode | null = null;
  private levelBuffer: Float32Array | null = null;

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

  readonly sessionId = uid('session');
  /** Non-null when system audio was requested and the platform did not provide it. */
  systemAudioMissing: string | null = null;
  /** Non-null when the microphone was requested and refused, and the rest still recorded. */
  micMissing: string | null = null;
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
    session.systemAudioProcessed = sources.systemAudioProcessed;

    const plan: { kind: CaptureSourceKind; stream: MediaStream | null; video: boolean }[] = [
      { kind: 'screen', stream: sources.screen, video: true },
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
      const frameRate = video ? (stream.getVideoTracks()[0]?.getSettings().frameRate ?? 30) : 30;
      // Audio-only sources get an audio extension: an `.mp4` holding nothing but sound would
      // be imported as a video clip with no picture.
      return WebCodecsSourceEngine.open(stream, {
        fileName: `${id}.raw.${video ? 'mp4' : 'm4a'}`,
        video,
        frameRate,
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

  get active(): boolean {
    return !this.stopped && this.sources.length > 0;
  }

  get elapsed(): number {
    if (!this.anchorMs) return 0;
    return (performance.now() - this.anchorMs) / 1000;
  }

  status(): CaptureStatus {
    const sources = this.sources.map((source) => {
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
      };
    });
    return {
      elapsed: this.elapsed,
      sources,
      bytesTotal: sources.reduce((sum, s) => sum + s.bytes, 0),
      writing: sources.some((s) => s.pending > 0),
      engine: this.engineChoice.engine,
      droppedFrames: sources.reduce((sum, s) => sum + s.droppedFrames, 0),
    };
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

    const stops = await Promise.all(
      this.sources.map(async (source) => ({ source, result: await source.engine.stop() })),
    );

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
    for (const stream of this.streams) stopStream(stream);
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.sources = [];
  }
}
