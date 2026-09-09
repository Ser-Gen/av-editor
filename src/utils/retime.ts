/**
 * Retiming a clip: the arithmetic of changing its speed.
 *
 * Pure, so `check:math` can hold it to account. The relationship itself lives in
 * `utils/time.ts` and `utils/clipRender.ts` — `duration = (out - in) / speed` and
 * `sourceTime = in + elapsed × speed`. What is here is everything that has to *solve* those
 * two: for a new out point, for a speed, for the room a clip has to grow into.
 *
 * **Frame quantization is preserved by moving the out point, not by rounding the speed.**
 * `(out - in) / speed` will not generally land on a frame boundary, and a clip whose duration
 * is not a whole number of frames is precisely what `quantizeToFrame` exists to prevent — it
 * is what keeps the preview and the export agreeing about where a cut is. So the *duration*
 * is quantized and the source range absorbs the difference, which is sub-frame and which
 * nothing can observe. The speed the user asked for stays the number they see.
 */
import type { Clip } from '../types/editor';
import {
  MIN_CLIP_DURATION,
  SPEED_MAX,
  SPEED_MIN,
  clipDuration,
  quantizeToFrame,
  speedOf,
} from './time';

/** The rates offered as buttons. Anything between them is reachable with the slider. */
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

export interface Retimed {
  speed: number;
  sourceTrimOut: number;
  duration: number;
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}

/**
 * The clip at a new speed: same source in-point, a duration that lands on a frame, and an
 * out-point moved to make that true.
 */
export function retimeToSpeed(
  clip: Pick<Clip, 'sourceTrimIn' | 'sourceTrimOut'> & { speed?: number },
  speed: number,
  fps: number,
): Retimed {
  const next = clampSpeed(speed);
  const source = Math.max(0, clip.sourceTrimOut - clip.sourceTrimIn);
  const duration = Math.max(MIN_CLIP_DURATION, quantizeToFrame(source / next, fps));
  return {
    speed: next,
    sourceTrimOut: clip.sourceTrimIn + duration * next,
    duration,
  };
}

/**
 * The speed that makes a clip last exactly `duration`.
 *
 * The inverse of the above, and what a rate trim needs: ⌥-dragging a trim handle holds the
 * source range and asks where the edge landed, rather than throwing frames away.
 */
export function speedForDuration(
  clip: Pick<Clip, 'sourceTrimIn' | 'sourceTrimOut'>,
  duration: number,
): number {
  const source = Math.max(0, clip.sourceTrimOut - clip.sourceTrimIn);
  if (source <= 0 || duration <= 0) return 1;
  return clampSpeed(source / duration);
}

/**
 * How long a clip may become before it runs into the next one on its track.
 *
 * `Infinity` when nothing follows it. Used only when ripple is off — with ripple on the
 * neighbour is about to move out of the way, which is the same reasoning `trimClipTo`
 * already applies to its bounds.
 */
export function roomAfter(clips: Clip[], clip: Clip): number {
  let nearest = Infinity;
  for (const other of clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    if (other.timelineStart < clip.timelineStart + 1e-6) continue;
    nearest = Math.min(nearest, other.timelineStart);
  }
  return nearest === Infinity ? Infinity : Math.max(MIN_CLIP_DURATION, nearest - clip.timelineStart);
}

/**
 * The slowest a clip may go without overlapping its neighbour.
 *
 * Slower is longer, so the room available is a *lower* bound on the speed. Returns
 * `SPEED_MIN` when there is nothing in the way.
 */
export function slowestSpeedThatFits(clips: Clip[], clip: Clip): number {
  const room = roomAfter(clips, clip);
  if (!Number.isFinite(room)) return SPEED_MIN;
  const source = Math.max(0, clip.sourceTrimOut - clip.sourceTrimIn);
  if (source <= 0) return SPEED_MIN;
  return clampSpeed(source / room);
}

/**
 * How much the clips after this one must move when it changes length.
 *
 * Positive when the clip grew. The caller decides whether to apply it (ripple on) or to
 * refuse the growth that caused it (ripple off).
 */
export function rippleDelta(before: Clip, after: Clip): number {
  return clipDuration(after) - clipDuration(before);
}

/** Is this a kind that can be retimed at all? */
export function canRetime(clip: Clip): clip is Extract<Clip, { kind: 'video' | 'audio' }> {
  return clip.kind === 'video' || clip.kind === 'audio';
}

/** True when the clip is not playing at its recorded rate. */
export function isRetimed(clip: Clip): boolean {
  return speedOf('speed' in clip ? clip.speed : undefined) !== 1;
}

/** `2×`, `0.5×` — the badge on the timeline block and in the Inspector. */
export function formatSpeed(speed: number): string {
  const value = clampSpeed(speed);
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
  return `${text.replace(/\.$/, '')}×`;
}

/**
 * `atempo` filters whose product is `speed`.
 *
 * FFmpeg's `atempo` accepts 0.5–2.0 per instance, so the ends of this app's range need two of
 * them: 0.25× is `atempo=0.5,atempo=0.5` and 4× is `atempo=2,atempo=2`. It is a proper
 * time-stretcher — the pitch is held and the quality is better than anything this app can do
 * in a `OfflineAudioContext`, which is why the FFmpeg fallback is the *cleaner* of the two
 * engines for a heavily retimed clip.
 *
 * An empty list for 1×: nothing to do, and an `atempo=1` in the chain is a resample for no
 * reason.
 */
export function atempoChain(speed: number): string[] {
  let remaining = clampSpeed(speed);
  const out: string[] = [];
  while (remaining < 0.5 - 1e-9) {
    out.push('atempo=0.5');
    remaining /= 0.5;
  }
  while (remaining > 2 + 1e-9) {
    out.push('atempo=2');
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 1e-9) out.push(`atempo=${round(remaining)}`);
  return out;
}

/**
 * The sample rate the tape-speed path resamples through.
 *
 * `asetrate` takes a number, and a filter graph is built before anything is decoded, so the
 * source's own rate is not known here. Forcing a known one first is what makes the
 * multiplication expressible at all; `amix` unifies rates downstream regardless.
 */
export const RETIME_PITCH_RATE = 48000;

/**
 * The filters that retime a clip's audio.
 *
 * Two different operations, not two settings of one: holding the pitch is a time-stretch
 * (`atempo`), and letting it follow is a resample (`asetrate`) — the difference between a
 * transcript read faster and a tape played faster.
 */
export function retimeAudioFilters(clip: Clip): string[] {
  const speed = speedOf('speed' in clip ? clip.speed : undefined);
  if (speed === 1) return [];
  if ('pitchFollowsSpeed' in clip && clip.pitchFollowsSpeed) {
    return [
      `aresample=${RETIME_PITCH_RATE}`,
      `asetrate=${round(RETIME_PITCH_RATE * speed)}`,
      `aresample=${RETIME_PITCH_RATE}`,
      'asetpts=N/SR/TB',
    ];
  }
  return atempoChain(speed);
}

/** Six places is enough for any speed this app allows, and keeps the graph readable. */
function round(value: number): number {
  return Number(value.toFixed(6));
}
