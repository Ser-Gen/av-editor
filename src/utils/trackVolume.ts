export const MIN_TRACK_VOLUME = 0;
export const MAX_TRACK_VOLUME = 1.5;
export const DEFAULT_TRACK_VOLUME = 1;

/**
 * A *clip* may be lifted further than a track may.
 *
 * +12 dB, which is what `clampNormalizeGain` in `utils/loudness.ts` already allows itself —
 * and it has to, because normalizing is the whole reason a clip needs more than a little
 * headroom: a take at −23 LUFS aimed at −16 needs +7.4 dB, and the 1.5× (+3.5 dB) ceiling the
 * mixer uses simply could not express it. Normalize wrote 2.34 and every reader clamped it
 * back to 1.5, so the clip got louder than it was and never reached the target, with nothing
 * saying why.
 *
 * A track fader stays at 1.5×: it is a balance control over material that has already been
 * levelled, not the place to make up 12 dB.
 */
export const MAX_CLIP_GAIN = 4;

/** Gains are resolved in `utils/compositeOrder.ts` — this only clamps user input. */
export function clampTrackVolume(volume: number): number {
  return Math.min(MAX_TRACK_VOLUME, Math.max(MIN_TRACK_VOLUME, volume));
}

export function clampClipGain(gain: number): number {
  return Math.min(MAX_CLIP_GAIN, Math.max(0, Number.isFinite(gain) ? gain : 1));
}
