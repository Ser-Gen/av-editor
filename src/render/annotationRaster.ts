/**
 * Drawing an annotation clip onto a 2D canvas.
 *
 * The counterpart of `textRenderer.ts`, and it exists for the same reason: one implementation,
 * fed to the preview compositor, the WebCodecs export and — as a PNG — the FFmpeg fallback.
 * An arrow drawn three ways is an arrow that ends up in three places.
 *
 * Coordinates are normalized against the composition, so a shape survives a change of frame
 * size and refits under a change of aspect the same way a mask does. Stroke width is a
 * fraction of the frame's smaller edge, so a 4K export gets a proportional line and not a
 * hairline.
 */
import type { AnnotationClip, AnnotationShape } from '../types/editor';

const ARROW_HEAD = 0.32;
const MIN_ARROW_HEAD = 8;

function px(shape: AnnotationShape, index: number, w: number, h: number) {
  const point = shape.points[index] ?? { x: 0, y: 0 };
  return { x: point.x * w, y: point.y * h };
}

function strokePx(shape: AnnotationShape, w: number, h: number): number {
  return Math.max(1, shape.width * Math.min(w, h));
}

function drawArrow(ctx: CanvasRenderingContext2D, shape: AnnotationShape, w: number, h: number): void {
  const tail = px(shape, 0, w, h);
  const head = px(shape, 1, w, h);
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return;

  const line = strokePx(shape, w, h);
  const headLength = Math.max(MIN_ARROW_HEAD, Math.min(length * 0.4, line * 4));
  const angle = Math.atan2(dy, dx);

  // The shaft stops short of the point so the head is a solid triangle rather than a shaft
  // with a triangle balanced on the end of it.
  const shaftEnd = {
    x: head.x - Math.cos(angle) * headLength * 0.85,
    y: head.y - Math.sin(angle) * headLength * 0.85,
  };

  ctx.strokeStyle = shape.color;
  ctx.lineWidth = line;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();

  ctx.fillStyle = shape.color;
  ctx.beginPath();
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(
    head.x - Math.cos(angle - ARROW_HEAD) * headLength,
    head.y - Math.sin(angle - ARROW_HEAD) * headLength,
  );
  ctx.lineTo(
    head.x - Math.cos(angle + ARROW_HEAD) * headLength,
    head.y - Math.sin(angle + ARROW_HEAD) * headLength,
  );
  ctx.closePath();
  ctx.fill();
}

function drawBoxOrEllipse(
  ctx: CanvasRenderingContext2D,
  shape: AnnotationShape,
  w: number,
  h: number,
): void {
  const a = px(shape, 0, w, h);
  const b = px(shape, 1, w, h);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const rw = Math.abs(b.x - a.x);
  const rh = Math.abs(b.y - a.y);
  if (rw < 1 || rh < 1) return;

  ctx.lineWidth = strokePx(shape, w, h);
  ctx.strokeStyle = shape.color;

  ctx.beginPath();
  if (shape.type === 'ellipse') {
    ctx.ellipse(x + rw / 2, y + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.rect(x, y, rw, rh);
  }
  if (shape.fill) {
    ctx.fillStyle = shape.fill;
    ctx.fill();
  }
  ctx.stroke();
}

function drawFreehand(
  ctx: CanvasRenderingContext2D,
  shape: AnnotationShape,
  w: number,
  h: number,
): void {
  if (shape.points.length < 2) return;
  ctx.strokeStyle = shape.color;
  ctx.lineWidth = strokePx(shape, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(shape.points[0].x * w, shape.points[0].y * h);
  // Quadratic through the midpoints: a polyline of raw pointer samples looks like a polyline,
  // and the one thing a drawn line has to look like is drawn.
  for (let i = 1; i < shape.points.length - 1; i++) {
    const current = shape.points[i];
    const next = shape.points[i + 1];
    ctx.quadraticCurveTo(
      current.x * w,
      current.y * h,
      ((current.x + next.x) / 2) * w,
      ((current.y + next.y) / 2) * h,
    );
  }
  const last = shape.points[shape.points.length - 1];
  ctx.lineTo(last.x * w, last.y * h);
  ctx.stroke();
}

/**
 * A callout is a label, not an arrow with a label on it.
 *
 * It used to draw an arrow as well, which made it an arrow you could not aim independently of
 * its text — two things in one mark, and the arrow tool already exists for the half that
 * points. Old callouts keep their two stored points; the label sits on the first, which is
 * where it was already drawn, so nothing moves.
 */
function drawCallout(
  ctx: CanvasRenderingContext2D,
  shape: AnnotationShape,
  w: number,
  h: number,
): void {
  if (!shape.text) return;

  const tail = px(shape, 0, w, h);
  const size = Math.max(10, strokePx(shape, w, h) * 4);
  ctx.font = `600 ${Math.round(size)}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const width = ctx.measureText(shape.text).width;
  const padding = size * 0.4;
  const boxW = width + padding * 2;
  const boxH = size + padding * 1.4;
  // The label sits on the tail end, away from whatever the arrow is pointing at.
  const cx = Math.min(w - boxW / 2, Math.max(boxW / 2, tail.x));
  const cy = Math.min(h - boxH / 2, Math.max(boxH / 2, tail.y));

  ctx.fillStyle = shape.fill ?? 'rgba(0,0,0,0.75)';
  ctx.beginPath();
  ctx.roundRect?.(cx - boxW / 2, cy - boxH / 2, boxW, boxH, size * 0.25);
  if (!ctx.roundRect) ctx.rect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
  ctx.fill();

  ctx.fillStyle = shape.color;
  ctx.fillText(shape.text, cx, cy);
}

export function drawAnnotationShape(
  ctx: CanvasRenderingContext2D,
  shape: AnnotationShape,
  canvasW: number,
  canvasH: number,
): void {
  ctx.save();
  switch (shape.type) {
    case 'arrow':
      drawArrow(ctx, shape, canvasW, canvasH);
      break;
    case 'box':
    case 'ellipse':
      drawBoxOrEllipse(ctx, shape, canvasW, canvasH);
      break;
    case 'freehand':
      drawFreehand(ctx, shape, canvasW, canvasH);
      break;
    case 'callout':
      drawCallout(ctx, shape, canvasW, canvasH);
      break;
  }
  ctx.restore();
}

export function drawAnnotationClip(
  ctx: CanvasRenderingContext2D,
  clip: Pick<AnnotationClip, 'shapes'>,
  canvasW: number,
  canvasH: number,
): void {
  for (const shape of clip.shapes) drawAnnotationShape(ctx, shape, canvasW, canvasH);
}
