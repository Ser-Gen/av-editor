/**
 * Moving the composition's geometry from one canvas shape to another.
 *
 * Most clips need nothing done to them: `transform` is optional, and a clip without one is
 * fit-and-letterboxed by the renderer, so it re-fits itself when the canvas changes. Only
 * explicit geometry has to be rewritten — a placed overlay, a text box, a masked region —
 * and only when the *shape* changes. A resolution bump at the same aspect leaves normalized
 * rects meaning exactly what they meant before.
 *
 * Two different rules apply, because two different things are being preserved:
 *
 *   - **Canvas-anchored** rects (`transform.frame`, `textFrame`) keep their distance from
 *     whichever edge they were nearest and keep their own proportions. A bottom-right inset
 *     stays a bottom-right inset; a full-frame placement becomes a centred band rather than
 *     a stretched picture.
 *   - **Content-anchored** rects (masked regions) are remapped through the picture they were
 *     covering. A blur over a licence plate is meaningless in canvas coordinates the moment
 *     the picture moves inside the frame, which is exactly what an aspect change does to an
 *     untransformed clip.
 *
 * Keyframed channels are transformed with the *same* map as the static rect, chosen once from
 * the base geometry. Deciding per key would let the anchor flip mid-animation and tear the
 * path in half; deciding once transforms the whole path rigidly.
 */
import type {
  Clip,
  EffectInstance,
  Keyframe,
  MediaAsset,
  NormalizedRect,
  OverlayTransform,
  Track,
} from '../types/editor';
import { REGION_CHANNELS, REGION_MODE } from '../render/effects/registry';
import { evaluateChannel } from './keyframes';
import { clampFrame, clampRect } from './overlayTransform';

export interface CanvasSize {
  width: number;
  height: number;
}

type Anchor = 'lead' | 'trail' | 'center';

interface AxisMap {
  anchor: Anchor;
  from: number;
  to: number;
  scale: number;
}

/**
 * Which edge this rect belongs to. Equal margins mean it was centred and should stay centred
 * — the case that makes a full-frame placement survive an aspect change as a centred band
 * instead of drifting to one side.
 */
function chooseAnchor(pos: number, size: number, extent: number): Anchor {
  const lead = pos * extent;
  const trail = extent - (pos + size) * extent;
  if (Math.abs(lead - trail) <= extent * 0.01) return 'center';
  return lead <= trail ? 'lead' : 'trail';
}

function mapSize(map: AxisMap, size: number): number {
  return (size * map.from * map.scale) / map.to;
}

function mapPos(map: AxisMap, pos: number, size: number): number {
  const newSize = size * map.from * map.scale;
  switch (map.anchor) {
    case 'lead':
      return (pos * map.from) / map.to;
    case 'trail': {
      const trail = map.from - (pos + size) * map.from;
      return (map.to - newSize - trail) / map.to;
    }
    case 'center':
      return (map.to - newSize) / 2 / map.to;
  }
}

function axisMaps(rect: NormalizedRect, from: CanvasSize, to: CanvasSize): [AxisMap, AxisMap] {
  // One scale for both axes: the rect keeps its own proportions, which is what stops a
  // 16:9 overlay from becoming a phone-shaped one.
  const scale = Math.min(to.width / from.width, to.height / from.height);
  return [
    { anchor: chooseAnchor(rect.x, rect.w, from.width), from: from.width, to: to.width, scale },
    { anchor: chooseAnchor(rect.y, rect.h, from.height), from: from.height, to: to.height, scale },
  ];
}

/**
 * Re-anchor a canvas-relative rect onto a differently shaped canvas.
 *
 * The clamp is a parameter because the two kinds of rect that come through here disagree
 * about the canvas edge: a text box is laid out inside it, an overlay's frame may hang off
 * it. Reshaping a project should not quietly haul a deliberately half-off PiP back into shot.
 */
export function refitRect(
  rect: NormalizedRect,
  from: CanvasSize,
  to: CanvasSize,
  clamp: (r: NormalizedRect) => NormalizedRect = clampRect,
): NormalizedRect {
  const [mx, my] = axisMaps(rect, from, to);
  return clamp({
    x: mapPos(mx, rect.x, rect.w),
    y: mapPos(my, rect.y, rect.h),
    w: mapSize(mx, rect.w),
    h: mapSize(my, rect.h),
  });
}

/** Regions may legitimately be tiny — a licence plate — so `clampRect`'s 5% floor is wrong here. */
function clampRegion(rect: NormalizedRect): NormalizedRect {
  const w = Math.min(1, Math.max(0.001, rect.w));
  const h = Math.min(1, Math.max(0.001, rect.h));
  return {
    x: Math.min(1 - w, Math.max(0, rect.x)),
    y: Math.min(1 - h, Math.max(0, rect.y)),
    w,
    h,
  };
}

/**
 * Where a clip's picture actually lands on the canvas.
 *
 * With a transform the source is stretched into `frame`, so the frame *is* the content. With
 * no transform the renderer fits the source and letterboxes it, so the content is a centred
 * box of the source's own aspect — and that box is what moves when the canvas changes shape.
 */
export function contentRect(
  canvas: CanvasSize,
  transform: OverlayTransform | undefined,
  asset: MediaAsset | undefined,
): NormalizedRect {
  if (transform) return clampFrame(transform.frame);
  const sw = asset?.width;
  const sh = asset?.height;
  if (!sw || !sh) return { x: 0, y: 0, w: 1, h: 1 };
  const scale = Math.min(canvas.width / sw, canvas.height / sh);
  const w = (sw * scale) / canvas.width;
  const h = (sh * scale) / canvas.height;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Per-axis `value → a * value + b`, taking a rect from one content box into another. */
interface ContentMap {
  ax: number;
  bx: number;
  ay: number;
  by: number;
}

function contentMap(from: NormalizedRect, to: NormalizedRect): ContentMap {
  const ax = to.w / from.w;
  const ay = to.h / from.h;
  return { ax, bx: to.x - from.x * ax, ay, by: to.y - from.y * ay };
}

function mapKeys(keys: Keyframe[] | undefined, map: (value: number) => number): Keyframe[] | undefined {
  if (!keys || keys.length === 0) return keys;
  return keys.map((k) => ({ ...k, value: map(k.value) }));
}

function reframeEffects(
  effects: EffectInstance[] | undefined,
  rewrite: (rect: NormalizedRect) => NormalizedRect,
  axis: { x: (v: number) => number; y: (v: number) => number; w: (v: number) => number; h: (v: number) => number },
): EffectInstance[] | undefined {
  if (!effects || effects.length === 0) return effects;
  let changed = false;
  const next = effects.map((effect) => {
    if ((effect.params[REGION_MODE] ?? 0) < 0.5) return effect;
    const current: NormalizedRect = {
      x: effect.params['region.x'] ?? 0,
      y: effect.params['region.y'] ?? 0,
      w: effect.params['region.w'] ?? 1,
      h: effect.params['region.h'] ?? 1,
    };
    const moved = rewrite(current);
    const params = {
      ...effect.params,
      'region.x': moved.x,
      'region.y': moved.y,
      'region.w': moved.w,
      'region.h': moved.h,
    };
    let keyframes = effect.keyframes;
    if (keyframes && REGION_CHANNELS.some((c) => keyframes?.[c]?.length)) {
      keyframes = { ...keyframes };
      const byChannel = { 'region.x': axis.x, 'region.y': axis.y, 'region.w': axis.w, 'region.h': axis.h };
      for (const channel of REGION_CHANNELS) {
        const mapped = mapKeys(keyframes[channel], byChannel[channel]);
        if (mapped) keyframes[channel] = mapped;
      }
    }
    changed = true;
    return { ...effect, params, keyframes };
  });
  return changed ? next : effects;
}

/**
 * Rewrite every clip's canvas geometry for a new canvas shape.
 *
 * Returns the same array when nothing needed moving, so an aspect change on a project of
 * untransformed clips costs nothing and produces no history churn.
 */
export function reframeClips(
  clips: Clip[],
  mediaLibrary: Record<string, MediaAsset>,
  from: CanvasSize,
  to: CanvasSize,
): Clip[] {
  let changed = false;
  const next = clips.map((clip) => {
    let updated = clip;

    if ('transform' in clip && clip.transform) {
      const frame = refitRect(clip.transform.frame, from, to, clampFrame);
      const [mx, my] = axisMaps(clip.transform.frame, from, to);
      let transformKeyframes = clip.transformKeyframes;
      if (transformKeyframes) {
        const base = clip.transform.frame;
        // `frame.x` depends on the width at that instant, so the width channel is evaluated
        // at each key's own time rather than assumed constant.
        const widthAt = (t: number) => evaluateChannel(transformKeyframes?.['frame.w'] ?? [], t, base.w);
        const heightAt = (t: number) => evaluateChannel(transformKeyframes?.['frame.h'] ?? [], t, base.h);
        const rewritten = { ...transformKeyframes };
        if (rewritten['frame.x']?.length) {
          rewritten['frame.x'] = rewritten['frame.x'].map((k) => ({
            ...k,
            value: mapPos(mx, k.value, widthAt(k.t)),
          }));
        }
        if (rewritten['frame.y']?.length) {
          rewritten['frame.y'] = rewritten['frame.y'].map((k) => ({
            ...k,
            value: mapPos(my, k.value, heightAt(k.t)),
          }));
        }
        const w = mapKeys(rewritten['frame.w'], (v) => mapSize(mx, v));
        if (w) rewritten['frame.w'] = w;
        const h = mapKeys(rewritten['frame.h'], (v) => mapSize(my, v));
        if (h) rewritten['frame.h'] = h;
        transformKeyframes = rewritten;
      }
      // `crop` addresses the source media, not the canvas, so an aspect change means
      // nothing to it.
      // The cast is the union's fault, not the value's: `updated` is a `Clip`, and only the
      // two members that have a transform ever reach this branch.
      updated = {
        ...updated,
        // Rotation is an angle, so reshaping the canvas means nothing to it — but it has to
        // be carried across explicitly, or a reframe would quietly straighten every clip.
        transform: { crop: clip.transform.crop, frame, ...(clip.transform.rotate === undefined ? {} : { rotate: clip.transform.rotate }) },
        transformKeyframes,
      } as Clip;
      changed = true;
    }

    if (clip.kind === 'text' && clip.textFrame) {
      updated = { ...updated, textFrame: refitRect(clip.textFrame, from, to) } as Clip;
      changed = true;
    }

    if (clip.effects?.length) {
      const asset = 'assetId' in clip ? mediaLibrary[clip.assetId] : undefined;
      const transform = 'transform' in clip ? clip.transform : undefined;
      const before = contentRect(from, transform, asset);
      const after = contentRect(
        to,
        'transform' in updated ? updated.transform : undefined,
        asset,
      );
      const m = contentMap(before, after);
      const effects = reframeEffects(
        clip.effects,
        (rect) => clampRegion({
          x: rect.x * m.ax + m.bx,
          y: rect.y * m.ay + m.by,
          w: rect.w * m.ax,
          h: rect.h * m.ay,
        }),
        {
          x: (v) => v * m.ax + m.bx,
          y: (v) => v * m.ay + m.by,
          w: (v) => v * m.ax,
          h: (v) => v * m.ay,
        },
      );
      if (effects !== clip.effects) {
        updated = { ...updated, effects } as Clip;
        changed = true;
      }
    }

    return updated;
  });
  return changed ? next : clips;
}

/**
 * How many clips hold explicit canvas geometry, and would therefore be moved by an aspect
 * change. Everything else is fit-and-letterboxed and re-fits itself for free — which is what
 * the settings dialog needs to say before anyone commits to a reshape.
 */
export function countAnchored(clips: Clip[]): number {
  let count = 0;
  for (const clip of clips) {
    const placed = ('transform' in clip && clip.transform) || (clip.kind === 'text' && clip.textFrame);
    const masked = clip.effects?.some((e) => (e.params[REGION_MODE] ?? 0) >= 0.5);
    if (placed || masked) count += 1;
  }
  return count;
}

/**
 * Track grades have no clip and therefore no content to follow — they apply to everything
 * composited below them. Their regions are canvas-anchored, so they take the canvas rule.
 */
export function reframeTracks(tracks: Track[], from: CanvasSize, to: CanvasSize): Track[] {
  let changed = false;
  const next = tracks.map((track) => {
    if (!track.effects?.length) return track;
    const sample = { x: 0, y: 0, w: 1, h: 1 };
    const [mx, my] = axisMaps(sample, from, to);
    const effects = reframeEffects(
      track.effects,
      (rect) => clampRegion(refitRect(rect, from, to)),
      {
        x: (v) => mapPos(mx, v, 1),
        y: (v) => mapPos(my, v, 1),
        w: (v) => mapSize(mx, v),
        h: (v) => mapSize(my, v),
      },
    );
    if (effects === track.effects) return track;
    changed = true;
    return { ...track, effects };
  });
  return changed ? next : tracks;
}
