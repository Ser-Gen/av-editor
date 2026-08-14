export function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

export function clipDuration(clip: { sourceTrimIn: number; sourceTrimOut: number }): number {
  return Math.max(0.1, clip.sourceTrimOut - clip.sourceTrimIn);
}

export function clipEnd(clip: { timelineStart: number; sourceTrimIn: number; sourceTrimOut: number }): number {
  return clip.timelineStart + clipDuration(clip);
}

export const MIN_CLIP_DURATION = 0.1;
export const SNAP_GRID = 0.1;

export function snapTime(t: number, enabled = true): number {
  if (!enabled) return t;
  return Math.round(t / SNAP_GRID) * SNAP_GRID;
}
