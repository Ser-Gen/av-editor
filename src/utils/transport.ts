/**
 * The transport's own arithmetic: monitoring volume, the scrub bar, and when floating
 * controls have been idle long enough to get out of the way.
 */

/** How long the pointer must sit still before the floating controls fade out. */
export const CONTROLS_IDLE_MS = 2200;

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * What the master node should actually be set to.
 *
 * Muting is remembered separately from the slider so unmuting returns to the volume you had
 * rather than to full — and a slider dragged to zero is not "muted", it is quiet, so it does
 * not silently clear the mute button when you drag it back up.
 */
export function monitorGain(volume: number, muted: boolean): number {
  return muted ? 0 : clampVolume(volume);
}

/**
 * Whether the mute flag survives a move of the slider.
 *
 * Dragging up is how most people unmute, so any volume above zero clears the flag. Dragging
 * *down* to zero is not muting — it is quiet — and clearing the flag there would mean sliding
 * to zero and back left the mute button un-pressed with no sound to show for it.
 */
export function mutedAfterVolumeChange(volume: number, wasMuted: boolean): boolean {
  return clampVolume(volume) > 0 ? false : wasMuted;
}

/** Where the playhead sits along the scrub bar, 0..1. An empty project reads as the start. */
export function progressFraction(playhead: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.min(1, Math.max(0, playhead / duration));
}

/** Where a click at `fraction` along the bar lands. */
export function seekTimeAt(fraction: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.min(duration, Math.max(0, fraction * duration));
}

/**
 * The bar reads a pointer position against its own box, which is the one measurement a
 * scrub bar always gets wrong at the edges: a click on the last pixel must mean the end,
 * not slightly past it.
 */
export function fractionAcross(clientX: number, box: { left: number; width: number }): number {
  if (!(box.width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
}
