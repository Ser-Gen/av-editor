import type { Clip, EffectInstance, OverlayTransform, VisualClip } from '../types/editor';
import type { EffectClock } from '../render/effects/types';
import { evaluateChannel } from './keyframes';
import { clipDuration } from './time';

/**
 * How a clip looks and sounds at a given time: its fade envelope, its effect chain with
 * animated parameters resolved, and its animated placement.
 *
 * The preview and both export paths call the same functions here, which is what keeps
 * "what you see is what you get" true by construction rather than by discipline.
 *
 * Fades are stored as two durations on the clip and evaluated on the fly, so trimming
 * or moving a clip carries them along without any fix-up pass.
 *
 * A video fade multiplies the layer's alpha rather than darkening its colour. With
 * nothing underneath that is exactly a fade to/from black, and with a clip underneath
 * it is a cross-fade — which is what an editor expects from a layer.
 */

/** Longest fade a clip of this length can hold, leaving room for the other side. */
export function maxFade(clip: Clip, edge: 'in' | 'out'): number {
  const duration = clipDuration(clip);
  const other = edge === 'in' ? (clip.fadeOut ?? 0) : (clip.fadeIn ?? 0);
  return Math.max(0, duration - other);
}

export function clampFade(clip: Clip, edge: 'in' | 'out', seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(maxFade(clip, edge), seconds);
}

/** Gain multiplier in 0..1 at timeline time `t`. Used for both picture and sound. */
export function fadeGainAt(clip: Clip, t: number): number {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  if (fadeIn <= 0 && fadeOut <= 0) return 1;

  const duration = clipDuration(clip);
  const rel = t - clip.timelineStart;
  let gain = 1;
  if (fadeIn > 0 && rel < fadeIn) gain *= Math.max(0, rel / fadeIn);
  if (fadeOut > 0 && rel > duration - fadeOut) {
    gain *= Math.max(0, (duration - rel) / fadeOut);
  }
  return Math.min(1, Math.max(0, gain));
}

export function hasFade(clip: Clip): boolean {
  return (clip.fadeIn ?? 0) > 0 || (clip.fadeOut ?? 0) > 0;
}

/** Enabled effects of a plain chain — used for track grades, which have no time base. */
export function enabledEffects(effects: EffectInstance[] | undefined): EffectInstance[] {
  return (effects ?? []).filter((e) => e.enabled);
}

/**
 * Effects that actually render, in order, with animated parameters resolved for the
 * timeline time `t`. Omitting `t` returns the stored scalars, which is what the UI wants.
 */
export function activeEffects(clip: Clip, t?: number): EffectInstance[] {
  const enabled = (clip.effects ?? []).filter((e) => e.enabled);
  if (t === undefined) return enabled;

  const rel = t - clip.timelineStart;
  return enabled.map((effect) => {
    if (!effect.keyframes) return effect;
    const params = { ...effect.params };
    let animated = false;
    for (const [name, keys] of Object.entries(effect.keyframes)) {
      if (!keys || keys.length === 0) continue;
      params[name] = evaluateChannel(keys, rel, params[name]);
      animated = true;
    }
    return animated ? { ...effect, params } : effect;
  });
}

/**
 * The clock a clip's custom shaders run on: seconds since the clip began.
 *
 * Clip-relative, so a shader's animation moves with the clip the way its keyframes do,
 * and a copy of the clip elsewhere on the timeline looks the same rather than sampling a
 * different moment of the effect.
 */
export function clipClock(clip: Clip, t: number, fps: number): EffectClock {
  const time = Math.max(0, t - clip.timelineStart);
  return { time, frame: Math.round(time * fps), fps };
}

/**
 * Where in the source file a clip is at timeline time `t`.
 *
 * The clip clock, shared rather than restated: preview, export and the placement editor all
 * have to agree about which frame a clip is showing, or the picture someone positions an
 * overlay against is not the picture that gets encoded.
 *
 * `epsilon` is how far to stay clear of the out point — the two engines want different
 * amounts, because one is seeking a `<video>` element and the other is decoding.
 */
export function sourceTimeAt(clip: Clip, t: number, epsilon: number): number {
  const raw = clip.sourceTrimIn + (t - clip.timelineStart);
  return Math.min(clip.sourceTrimOut - epsilon, Math.max(clip.sourceTrimIn, raw));
}

/** A track grade has no clip to belong to, so its clock is the timeline's. */
export function timelineClock(t: number, fps: number): EffectClock {
  return { time: Math.max(0, t), frame: Math.round(Math.max(0, t) * fps), fps };
}

/** True when any effect parameter or the placement is animated. */
export function isAnimated(clip: Clip): boolean {
  if (clip.transformKeyframes && Object.values(clip.transformKeyframes).some((k) => k.length > 0)) {
    return true;
  }
  return (clip.effects ?? []).some(
    (e) => e.keyframes && Object.values(e.keyframes).some((k) => k.length > 0),
  );
}

/** The channel names a placement animation can drive. */
export const TRANSFORM_CHANNELS = [
  'crop.x',
  'crop.y',
  'crop.w',
  'crop.h',
  'frame.x',
  'frame.y',
  'frame.w',
  'frame.h',
  'rotate',
] as const;

function transformField(transform: OverlayTransform, channel: string): number {
  // `rotate` is the one channel that is not part of a rect, so it has no group to index.
  if (channel === 'rotate') return transform.rotate ?? 0;
  const [group, axis] = channel.split('.') as ['crop' | 'frame', 'x' | 'y' | 'w' | 'h'];
  return transform[group][axis];
}

/**
 * The clip's placement at timeline time `t`. Animated channels override the stored
 * transform; unanimated ones pass through, so a partly-animated placement still works.
 */
export function transformAt(
  clip: VisualClip,
  t: number,
): OverlayTransform | undefined {
  if (clip.kind === 'text') return undefined;
  const base = clip.transform;
  if (!base) return undefined;
  const channels = clip.transformKeyframes;
  if (!channels) return base;

  const rel = t - clip.timelineStart;
  const next: OverlayTransform = {
    crop: { ...base.crop },
    frame: { ...base.frame },
    ...(base.rotate === undefined ? {} : { rotate: base.rotate }),
  };
  let animated = false;
  for (const channel of TRANSFORM_CHANNELS) {
    const keys = channels[channel];
    if (!keys || keys.length === 0) continue;
    const value = evaluateChannel(keys, rel, transformField(base, channel));
    if (channel === 'rotate') {
      next.rotate = value;
    } else {
      const [group, axis] = channel.split('.') as ['crop' | 'frame', 'x' | 'y' | 'w' | 'h'];
      next[group][axis] = value;
    }
    animated = true;
  }
  return animated ? next : base;
}
