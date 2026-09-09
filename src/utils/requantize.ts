/**
 * Putting an existing project back on the frame grid after the frame rate changes.
 *
 * Every edit in the editor is quantized to the project's frame rate as it is made, so a
 * project that has only ever been 30 fps has every clip edge on a 30 fps boundary. Change the
 * rate and those edges are between frames: an export samples the nearest one, and a clip that
 * looked flush against its neighbour is a fraction of a frame short.
 *
 * Re-quantizing is the honest repair, and it *is* an edit — it moves things the user placed.
 * So it happens inside the same history entry as the rate change, and the dialog says how many
 * clips it will touch before it happens. `summarize` exists for that sentence: nothing can be
 * reported after the fact that the user would not rather have known first.
 */
import type { Clip, Keyframe } from '../types/editor';
import { clipDuration, quantizeToFrame, speedOf } from './time';

export interface RequantizeSummary {
  /** How many clips have at least one edge off the new grid. */
  clips: number;
  /** The largest single move, in seconds. Always under half a frame. */
  maxShift: number;
}

function speedOfClip(clip: Clip): number {
  return speedOf('speed' in clip ? clip.speed : undefined);
}

/*
 * What has to be on the grid.
 *
 * For a clip at its recorded rate the source out-point and the timeline end are the same
 * number offset, so snapping the out-point snaps both. A retimed clip breaks that: its
 * duration is `(out - in) / speed`, and it is the *duration* that has to land on a frame —
 * snapping its source out-point would put the clip itself between frames, which is the exact
 * failure this module exists to repair.
 */
function edgesOf(clip: Clip): number[] {
  return speedOfClip(clip) === 1
    ? [clip.timelineStart, clip.sourceTrimIn, clip.sourceTrimOut]
    : [clip.timelineStart, clip.sourceTrimIn, clip.timelineStart + clipDuration(clip)];
}

export function summarize(clips: Clip[], fps: number): RequantizeSummary {
  let touched = 0;
  let maxShift = 0;
  for (const clip of clips) {
    let moved = false;
    for (const edge of edgesOf(clip)) {
      const shift = Math.abs(quantizeToFrame(edge, fps) - edge);
      if (shift > 1e-9) {
        moved = true;
        maxShift = Math.max(maxShift, shift);
      }
    }
    if (moved) touched += 1;
  }
  return { clips: touched, maxShift };
}

function snapKeys(keys: Keyframe[] | undefined, fps: number): Keyframe[] | undefined {
  if (!keys || keys.length === 0) return keys;
  const snapped = keys.map((k) => ({ ...k, t: quantizeToFrame(k.t, fps) }));
  // Two keys can land on the same frame once the grid coarsens. The later one wins, which
  // matches what dragging one key onto another already does.
  const byTime = new Map<number, Keyframe>();
  for (const key of snapped) byTime.set(key.t, key);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function snapChannels(
  channels: Record<string, Keyframe[]> | undefined,
  fps: number,
): Record<string, Keyframe[]> | undefined {
  if (!channels) return channels;
  const next: Record<string, Keyframe[]> = {};
  for (const [channel, keys] of Object.entries(channels)) {
    const snapped = snapKeys(keys, fps);
    if (snapped) next[channel] = snapped;
  }
  return next;
}

export function requantizeClips(clips: Clip[], fps: number): Clip[] {
  const frame = 1 / fps;
  return clips.map((clip) => {
    const timelineStart = Math.max(0, quantizeToFrame(clip.timelineStart, fps));
    const sourceTrimIn = Math.max(0, quantizeToFrame(clip.sourceTrimIn, fps));
    // A clip shorter than one frame of the new grid would quantize to nothing and vanish,
    // so it keeps a single frame instead of being silently deleted.
    const speed = speedOfClip(clip);
    const sourceTrimOut =
      speed === 1
        ? Math.max(sourceTrimIn + frame, quantizeToFrame(clip.sourceTrimOut, fps))
        : // Retimed: quantize the duration and let the source range absorb the remainder,
          // which is what `retimeToSpeed` does when the speed is set in the first place.
          sourceTrimIn + Math.max(frame, quantizeToFrame(clipDuration(clip), fps)) * speed;
    const next: Clip = {
      ...clip,
      timelineStart,
      sourceTrimIn,
      sourceTrimOut,
      transformKeyframes: snapChannels(clip.transformKeyframes, fps),
    };
    if (clip.fadeIn !== undefined) next.fadeIn = quantizeToFrame(clip.fadeIn, fps);
    if (clip.fadeOut !== undefined) next.fadeOut = quantizeToFrame(clip.fadeOut, fps);
    if (clip.effects?.length) {
      next.effects = clip.effects.map((effect) =>
        effect.keyframes ? { ...effect, keyframes: snapChannels(effect.keyframes, fps) } : effect,
      );
    }
    return next;
  });
}
