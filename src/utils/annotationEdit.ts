/**
 * Editing a mark after it has been drawn: hit-testing, handles, moving, reshaping.
 *
 * Pure, so `check:math` can hold it to account — which matters more here than usual, because
 * every function is geometry the user experiences as "the thing I clicked is the thing that
 * moved", and there is no other way to find out that it is not.
 *
 * **Everything measures in scaled space.** Shape coordinates are normalized against the
 * composition, so on a 16:9 frame one unit of x is nearly twice the distance of one unit of y
 * and a circular grab radius in normalized units is an ellipse on screen. Distances are
 * therefore taken with x multiplied by the stage's aspect, and `tolerance` is in units of
 * normalized *height* — one number, the same everywhere on screen.
 */
import type {
  AnnotationShape,
  AnnotationShapeType,
  NormalizedRect,
  OverlayTransform,
} from '../types/editor';

/**
 * What each kind of mark is called, wherever one has to be named — the tool strip, the
 * Inspector, the timeline's pose rows. One table, so a mark is not a "Callout" in one place
 * and a "Label" in another, which it was.
 */
export const SHAPE_LABELS: Record<AnnotationShapeType, string> = {
  arrow: 'Arrow',
  box: 'Box',
  ellipse: 'Ellipse',
  freehand: 'Draw',
  callout: 'Label',
};

export interface Point {
  x: number;
  y: number;
}

/** Grab radius, as a fraction of the stage's height. About 12 px on a 720-tall preview. */
export const HIT_TOLERANCE = 0.017;

/** A handle is drawn at each end of a two-point shape; a freehand path has none. */
export interface ShapeHandle {
  /** Index into `shape.points`. */
  index: number;
  point: Point;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function scaled(p: Point, aspect: number): Point {
  return { x: p.x * aspect, y: p.y };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSq = vx * vx + vy * vy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** The two corners a box or ellipse was dragged between, as a rectangle. */
function cornerRect(shape: AnnotationShape): NormalizedRect {
  const a = shape.points[0] ?? { x: 0, y: 0 };
  const b = shape.points[shape.points.length - 1] ?? a;
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function distanceToRectEdge(p: Point, rect: NormalizedRect, aspect: number): number {
  const x0 = rect.x * aspect;
  const x1 = (rect.x + rect.w) * aspect;
  const y0 = rect.y;
  const y1 = rect.y + rect.h;
  const corners: Point[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    best = Math.min(best, distanceToSegment(p, corners[i], corners[(i + 1) % 4]));
  }
  return best;
}

function insideRect(p: Point, rect: NormalizedRect, aspect: number): boolean {
  return (
    p.x >= rect.x * aspect &&
    p.x <= (rect.x + rect.w) * aspect &&
    p.y >= rect.y &&
    p.y <= rect.y + rect.h
  );
}

/**
 * Distance to an ellipse's outline, near enough.
 *
 * The exact answer needs a quartic root; this scales the radial error by the smaller radius,
 * which is exact on a circle and errs on the generous side for a flat ellipse. Being slightly
 * easy to grab is the right way for a grab radius to be wrong.
 */
function distanceToEllipse(p: Point, rect: NormalizedRect, aspect: number): number {
  const rx = (rect.w * aspect) / 2;
  const ry = rect.h / 2;
  const cx = rect.x * aspect + rx;
  const cy = rect.y + ry;
  if (rx <= 0 || ry <= 0) {
    return distanceToSegment(p, { x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry });
  }
  const nx = (p.x - cx) / rx;
  const ny = (p.y - cy) / ry;
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
}

/*
  A label's box.

  The rasterizer derives it from the text's measured width on a canvas, which is the right way
  to draw it and no use at all to hit-testing or to the outline — both of which have to say
  *where the label is* without a canvas in hand. So the box is estimated here from the glyph
  count, and the estimate is used for both, which is the property that matters: what you can
  click is exactly what is outlined. It is deliberately a little larger than the artwork, so
  the outline reads as a selection around the label rather than a border drawn on it.

  Sizes come from `render/annotationRaster.ts`: the font is four stroke widths, padding is
  0.4 of the font, and the box is centred on the anchor and kept inside the frame.
*/
const LABEL_FONT = 4;
const LABEL_PAD = 0.4;
/** Mean advance of the label's 600-weight sans, as a fraction of the font size. */
const LABEL_ADVANCE = 0.58;
const LABEL_SLACK = 1.08;

/** The rectangle a label occupies, in normalized coordinates. */
export function labelRect(shape: AnnotationShape, aspect = 1): NormalizedRect {
  // Stroke width is a fraction of the frame's *short* side, as it is everywhere else here.
  const short = Math.min(aspect, 1);
  const font = Math.max(0.0005, shape.width) * LABEL_FONT * short;
  const glyphs = [...(shape.text ?? '')].length;

  const h = font * (1 + LABEL_PAD * 1.4) * LABEL_SLACK;
  const w = (font * (LABEL_ADVANCE * glyphs + LABEL_PAD * 2) * LABEL_SLACK) / Math.max(0.01, aspect);

  const anchor = shape.points[0] ?? { x: 0.5, y: 0.5 };
  const cx = Math.min(1 - w / 2, Math.max(w / 2, anchor.x));
  const cy = Math.min(1 - h / 2, Math.max(h / 2, anchor.y));
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Is `point` (normalized) close enough to `shape` to have meant it? */
export function hitShape(
  shape: AnnotationShape,
  point: Point,
  tolerance = HIT_TOLERANCE,
  aspect = 1,
): boolean {
  const p = scaled(point, aspect);
  const grab = Math.max(tolerance, shape.width);

  if (shape.type === 'box') {
    const rect = cornerRect(shape);
    if (shape.fill && insideRect(p, rect, aspect)) return true;
    return distanceToRectEdge(p, rect, aspect) <= grab;
  }

  if (shape.type === 'ellipse') {
    const rect = cornerRect(shape);
    const distance = distanceToEllipse(p, rect, aspect);
    if (shape.fill && distance <= grab) return true;
    return distance <= grab;
  }

  if (shape.type === 'freehand') {
    for (let i = 0; i < shape.points.length - 1; i++) {
      const a = scaled(shape.points[i], aspect);
      const b = scaled(shape.points[i + 1], aspect);
      if (distanceToSegment(p, a, b) <= grab) return true;
    }
    // A single-sample path is a dot, not a line.
    if (shape.points.length === 1) {
      return Math.hypot(p.x - shape.points[0].x * aspect, p.y - shape.points[0].y) <= grab;
    }
    return false;
  }

  const tail = scaled(shape.points[0] ?? { x: 0, y: 0 }, aspect);
  const head = scaled(shape.points[shape.points.length - 1] ?? { x: 0, y: 0 }, aspect);

  // A label is a box at a point — no shaft to grab, and anywhere on the box counts. It used to
  // be a disc around the anchor, which is the middle of the label: the near end of a long
  // label was outside it, and the outline drawn for it was a ring floating in the label's
  // centre with no relation to anything visible.
  if (shape.type === 'callout') {
    const rect = labelRect(shape, aspect);
    return insideRect(p, rect, aspect) || distanceToRectEdge(p, rect, aspect) <= grab;
  }

  return distanceToSegment(p, tail, head) <= grab;
}

/**
 * Which mark the user meant, or none.
 *
 * Last drawn wins, because that is the one on top — picking the first match would hand back
 * whatever is buried under everything else.
 */
export function pickShape(
  shapes: AnnotationShape[],
  point: Point,
  tolerance = HIT_TOLERANCE,
  aspect = 1,
): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitShape(shapes[i], point, tolerance, aspect)) return shapes[i].id;
  }
  return null;
}

/**
 * The draggable ends of a shape.
 *
 * Freehand has none: it is redrawn, not reshaped. Nor does a callout — it is a label at a
 * point, and its size comes from its text, so there is no second end to pull.
 */
export function shapeHandles(shape: AnnotationShape): ShapeHandle[] {
  if (shape.type === 'freehand' || shape.type === 'callout' || shape.points.length < 2) return [];
  return [
    { index: 0, point: shape.points[0] },
    { index: shape.points.length - 1, point: shape.points[shape.points.length - 1] },
  ];
}

/** The box a shape's points span. */
export function shapeBounds(shape: AnnotationShape): NormalizedRect | null {
  return boundsOfPoints(shape.points);
}

/** The box a whole clip's marks span — the sensible default frame for placing one. */
export function annotationBounds(shapes: AnnotationShape[]): NormalizedRect | null {
  return boundsOfPoints(shapes.flatMap((s) => s.points));
}

function boundsOfPoints(points: Point[]): NormalizedRect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Move every point by the same amount.
 *
 * The delta is clamped against the shape's own box rather than each point being clamped to
 * the frame, because clamping the points would deform the shape the moment it touched an
 * edge — an arrow dragged into the corner would flatten instead of stopping.
 */
export function moveShape(shape: AnnotationShape, dx: number, dy: number): AnnotationShape {
  const bounds = shapeBounds(shape);
  if (!bounds) return shape;
  const clampedX = Math.min(Math.max(dx, -bounds.x), 1 - (bounds.x + bounds.w));
  const clampedY = Math.min(Math.max(dy, -bounds.y), 1 - (bounds.y + bounds.h));
  if (clampedX === 0 && clampedY === 0) return shape;
  return {
    ...shape,
    points: shape.points.map((p) => ({ x: p.x + clampedX, y: p.y + clampedY })),
  };
}

/** Drag one end. The other stays exactly where it was. */
export function setShapePoint(
  shape: AnnotationShape,
  index: number,
  point: Point,
): AnnotationShape {
  if (index < 0 || index >= shape.points.length) return shape;
  const next = shape.points.slice();
  next[index] = { x: clamp01(point.x), y: clamp01(point.y) };
  return { ...shape, points: next };
}

/**
 * The placement a set of marks should start from: their own box, as both the crop and the
 * frame.
 *
 * Identical rectangles mean an identity mapping, so ticking "place the marks" moves nothing —
 * which is the only acceptable behaviour for a checkbox. What it changes is what the frame
 * then *means*: dragging or scaling it moves and scales the marked region, rather than the
 * whole composition-sized raster with the marks somewhere inside it.
 *
 * Returns null when there is nothing to place or the box has no area — a full frame is the
 * honest answer there, and the caller has one.
 */
export function placementForShapes(
  shapes: AnnotationShape[],
  padding = 0.02,
): OverlayTransform | null {
  const bounds = annotationBounds(shapes);
  if (!bounds) return null;

  const x = Math.max(0, bounds.x - padding);
  const y = Math.max(0, bounds.y - padding);
  const box: NormalizedRect = {
    x,
    y,
    w: Math.min(1 - x, bounds.w + padding * 2),
    h: Math.min(1 - y, bounds.h + padding * 2),
  };
  if (box.w <= 0 || box.h <= 0) return null;
  return { crop: box, frame: box };
}
