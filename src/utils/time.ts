export const MIN_CLIP_DURATION = 0.1;
export const DEFAULT_FPS = 30;

/** All edits land on frame boundaries so preview and FFmpeg agree. */
export function quantizeToFrame(t: number, fps: number = DEFAULT_FPS): number {
  const rate = fps > 0 ? fps : DEFAULT_FPS;
  return Math.round(t * rate) / rate;
}

export function frameDuration(fps: number = DEFAULT_FPS): number {
  return 1 / (fps > 0 ? fps : DEFAULT_FPS);
}

/** MM:SS:FF — frames, not centiseconds. */
export function formatTimecode(seconds: number, fps: number = DEFAULT_FPS): string {
  const rate = fps > 0 ? fps : DEFAULT_FPS;
  const total = Math.max(0, Math.round(seconds * rate));
  const frames = total % rate;
  const totalSeconds = Math.floor(total / rate);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60);
  return `${pad(mins)}:${pad(secs)}:${pad(frames)}`;
}

/**
 * A watching clock: `M:SS`, or `H:MM:SS` once there is an hour of it.
 *
 * Deliberately not `formatTimecode`: frames are what you edit against, and a frame counter
 * ticking thirty times a second is exactly the sort of detail the expanded player exists to
 * get out of the way.
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const secs = total % 60;
  const mins = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

/** Compact duration label for the media library: MM:SS. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Accepts `MM:SS:FF`, `SS:FF`, `MM:SS.mmm` or a bare seconds count.
 * Returns null when unparseable so callers can leave the field alone.
 */
export function parseTimecode(input: string, fps: number = DEFAULT_FPS): number | null {
  const text = input.trim();
  if (text === '') return null;
  const rate = fps > 0 ? fps : DEFAULT_FPS;

  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;

  const nums = parts.map((p) => Number(p.trim()));
  if (nums.some((n) => !Number.isFinite(n))) return null;

  if (nums.length === 3) {
    const [mins, secs, frames] = nums;
    return mins * 60 + secs + frames / rate;
  }
  const [secs, frames] = nums;
  return secs + frames / rate;
}

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/**
 * A stored playback rate, clamped and defaulted.
 *
 * The one place `?? 1` is written. A speed of 0 or NaN — from a hand-edited project file, or
 * from a bug — would make a clip infinitely long rather than fail, so it is clamped here,
 * where every reader passes through, instead of at the edges where one path could miss it.
 *
 * Takes the number rather than the clip so `time.ts` stays free of the type graph, which is
 * what lets `check:math` and half the utils import it.
 */
export function speedOf(speed: number | undefined): number {
  const value = speed ?? 1;
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}

/**
 * How long a clip occupies the timeline.
 *
 * The source range divided by the speed. This is the single edit that carries retiming into
 * the ruler, snapping, collision, the minimap, the project duration, the export length and
 * the audio mixdown's window loop — none of which knows what speed is, because they all ask
 * this function how long a clip is.
 */
export function clipDuration(clip: {
  sourceTrimIn: number;
  sourceTrimOut: number;
  speed?: number;
}): number {
  return Math.max(
    MIN_CLIP_DURATION,
    (clip.sourceTrimOut - clip.sourceTrimIn) / speedOf(clip.speed),
  );
}

export function clipEnd(clip: {
  timelineStart: number;
  sourceTrimIn: number;
  sourceTrimOut: number;
  speed?: number;
}): number {
  return clip.timelineStart + clipDuration(clip);
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd - 1e-6 && bStart < aEnd - 1e-6;
}
