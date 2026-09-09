/**
 * Where a mark is at a given moment.
 *
 * An arrow that points at something moving has to move with it, and the clip's placement
 * transform cannot do that — it moves every mark together. So a mark carries its own poses,
 * and this is the one function that turns them back into points. The preview, the WebCodecs
 * export and the FFmpeg fallback all resolve through here, which is what keeps them drawing
 * the same arrow in the same place.
 *
 * Pure, and deliberately not built on `utils/keyframes.ts`: that engine interpolates one
 * scalar channel with three interpolation modes, and a mark is a *list of points* whose length
 * can change between keys. Splitting it into `2n` channels would make the length change
 * inexpressible and the data unreadable.
 */
import type { AnnotationClip, AnnotationShape, ShapePointKey } from '../types/editor';

export interface Point {
  x: number;
  y: number;
}

function lerpPoints(a: Point[], b: Point[], amount: number): Point[] {
  return a.map((point, index) => {
    const other = b[index] ?? point;
    return {
      x: point.x + (other.x - point.x) * amount,
      y: point.y + (other.y - point.y) * amount,
    };
  });
}

/** Keys in order, with the ones that cannot be read at all dropped. */
export function sortedKeys(keys: ShapePointKey[] | undefined): ShapePointKey[] {
  if (!keys || keys.length === 0) return [];
  return [...keys].filter((k) => Number.isFinite(k.t) && k.points.length > 0).sort((a, b) => a.t - b.t);
}

/**
 * The mark's points at `localTime` (seconds since the clip began).
 *
 * Holds before the first key and after the last, which is what makes a single key mean "put
 * it here for the whole clip" rather than "start from nothing".
 */
export function shapePointsAt(shape: AnnotationShape, localTime: number): Point[] {
  const keys = sortedKeys(shape.pointKeys);
  if (keys.length === 0) return shape.points;
  if (localTime <= keys[0].t) return keys[0].points;
  const last = keys[keys.length - 1];
  if (localTime >= last.t) return last.points;

  for (let i = 0; i < keys.length - 1; i++) {
    const from = keys[i];
    const to = keys[i + 1];
    if (localTime < from.t || localTime > to.t) continue;
    // A path that was redrawn between two keys has a different number of points at each end
    // and cannot be blended. Holding the earlier one is the only honest answer.
    if (from.points.length !== to.points.length) return from.points;
    const span = to.t - from.t;
    return span <= 0 ? to.points : lerpPoints(from.points, to.points, (localTime - from.t) / span);
  }
  return last.points;
}

/** True when anything in the clip moves on its own. */
export function hasShapeAnimation(clip: Pick<AnnotationClip, 'shapes'>): boolean {
  return clip.shapes.some((shape) => sortedKeys(shape.pointKeys).length > 0);
}

/**
 * The clip's marks as they stand at timeline time `t`.
 *
 * Returns the clip's own array when nothing is animated — not a copy. The compositor caches
 * its raster against `JSON.stringify(shapes)`, so handing back an equal-but-new array every
 * frame would be correct and would also redraw and re-upload a full-frame texture thirty
 * times a second for a clip that never moves.
 */
export function annotationShapesAt(clip: AnnotationClip, t: number): AnnotationShape[] {
  if (!hasShapeAnimation(clip)) return clip.shapes;
  const local = t - clip.timelineStart;
  return clip.shapes.map((shape) =>
    sortedKeys(shape.pointKeys).length === 0
      ? shape
      : { ...shape, points: shapePointsAt(shape, local) },
  );
}

/** Add or replace the key at `t`, to within half a frame. */
export function upsertShapeKey(
  keys: ShapePointKey[] | undefined,
  t: number,
  points: Point[],
  epsilon = 1e-4,
): ShapePointKey[] {
  const next = sortedKeys(keys).filter((key) => Math.abs(key.t - t) > epsilon);
  next.push({ t, points: points.map((p) => ({ ...p })) });
  return next.sort((a, b) => a.t - b.t);
}

/** Drop the key at `t`. Removing the last one leaves the mark static again. */
export function removeShapeKeyAt(
  keys: ShapePointKey[] | undefined,
  t: number,
  epsilon = 1e-4,
): ShapePointKey[] | undefined {
  const next = sortedKeys(keys).filter((key) => Math.abs(key.t - t) > epsilon);
  return next.length > 0 ? next : undefined;
}
