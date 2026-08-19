/**
 * The two ways this editor can record, behind one interface.
 *
 * Phase 14 recorded with `MediaRecorder`, which writes a *live* container that has to be
 * rebuilt afterwards before anything will scrub it. Phase 15 encodes the stream itself —
 * `MediaStreamTrackProcessor` into a WebCodecs encoder into a muxer — which produces a
 * finished, seekable file as it goes. `CaptureSession` drives whichever is available; the
 * MediaRecorder path stays as the fallback for browsers without the pipeline.
 */
import { canEncodeAudio, canEncodeVideo } from 'mediabunny';

export type EngineName = 'webcodecs' | 'mediarecorder';
export type EnginePreference = EngineName | 'auto';

export interface SourceEngineStats {
  bytesWritten: number;
  /** Chunks handed to the disk writer but not yet confirmed. */
  pending: number;
  error: string | null;
  /** Frames the capture pipeline handed us. Zero for audio sources. */
  framesDelivered: number;
  framesEncoded: number;
  /** Delivered minus encoded: frames let go because the encoder was behind. */
  framesDropped: number;
}

export interface StoppedSource {
  bytes: number;
  stoppedAtMs: number;
}

export interface SourceEngine {
  readonly engine: EngineName;
  /** What the finished file is, as a browser mime type. */
  readonly mimeType: string;
  readonly fileName: string;
  /** True when the container still has to be rebuilt after the recording stops. */
  readonly needsRepair: boolean;
  /** Synchronous by contract: this call is where the source's media timeline begins. */
  start(): void;
  stats(): SourceEngineStats;
  /**
   * `performance.now()` at which this source's media actually starts — what the timeline
   * offset is measured from. It is not the same as the moment `start()` was called, and
   * the difference is the whole reason recorded sources can drift apart.
   */
  mediaStartMs(): number;
  /** How `mediaStartMs` was arrived at, so an alignment check can question it. */
  clockDetail?(): ClockDetail;
  stop(): Promise<StoppedSource>;
  cancel(): Promise<void>;
}

export interface ClockDetail {
  /** When the first sample reached us — start-up cost and all. */
  firstArrivalMs: number;
  /** How late that first sample was, against where its content is reckoned to have been. */
  firstSampleLagMs: number;
}

export interface EngineChoice {
  engine: EngineName;
  /** Why this engine, in words a user can act on. */
  reason: string;
  /** Set when WebCodecs was wanted but cannot be used here. */
  fallbackFrom?: string;
}

const WEBCODECS_REASON = 'Encoding directly to MP4 — the file is finished as it records.';
const RECORDER_REASON = 'Recording with MediaRecorder — the container is rebuilt when you stop.';

/** Everything the WebCodecs engine needs, checked rather than assumed. */
export async function webCodecsCaptureSupport(): Promise<string | null> {
  if (typeof window === 'undefined') return 'not a browser';
  if (!('MediaStreamTrackProcessor' in window)) {
    return 'this browser cannot read raw frames from a stream (no MediaStreamTrackProcessor)';
  }
  if (!('VideoEncoder' in window) || !('AudioEncoder' in window)) {
    return 'this browser has no WebCodecs encoders';
  }
  try {
    if (!(await canEncodeVideo('avc'))) return 'this browser cannot encode H.264';
    if (!(await canEncodeAudio('aac'))) return 'this browser cannot encode AAC';
  } catch {
    return 'this browser could not report its encoder support';
  }
  return null;
}

export async function chooseEngine(preference: EnginePreference = 'auto'): Promise<EngineChoice> {
  if (preference === 'mediarecorder') {
    return { engine: 'mediarecorder', reason: RECORDER_REASON };
  }
  const missing = await webCodecsCaptureSupport();
  if (!missing) return { engine: 'webcodecs', reason: WEBCODECS_REASON };
  if (preference === 'webcodecs') {
    // Asked for explicitly and impossible: say so rather than silently doing something else.
    throw new Error(`WebCodecs recording is unavailable: ${missing}.`);
  }
  return {
    engine: 'mediarecorder',
    reason: RECORDER_REASON,
    fallbackFrom: `Direct MP4 encoding is off because ${missing}.`,
  };
}
