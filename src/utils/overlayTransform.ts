import type { NormalizedRect, OverlayTransform } from '../types/editor';

export const DEFAULT_OVERLAY_TRANSFORM: OverlayTransform = {
  crop: { x: 0, y: 0, w: 1, h: 1 },
  frame: { x: 0.62, y: 0.05, w: 0.34, h: 0.34 },
};

export const DEFAULT_FULL_FRAME: NormalizedRect = { x: 0, y: 0, w: 1, h: 1 };

// Clips with no transform are fit-and-letterboxed by the renderer, so there is no
// need to bake a default frame into the clip itself.

export function textFrameForClip(frame?: NormalizedRect): NormalizedRect {
  return clampRect(frame ?? DEFAULT_FULL_FRAME);
}

const MIN_SIZE = 0.05;

/**
 * How much of an overlay has to stay on the canvas, as a fraction of its own size.
 *
 * A frame may hang off any edge — that is how a picture-in-picture slides in from the side,
 * or sits half out of shot — but not walk off entirely. Something with no pixels on the
 * canvas is invisible in the preview *and* in the editor, which leaves nothing to drag back;
 * the clip would look empty with no way to find out why.
 */
export const MIN_ON_SCREEN = 0.1;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A rect confined to the thing it indexes into. This is the rule for a **crop**, which
 * addresses pixels of a source file — outside it there is no image to sample — and for a
 * text box, which is laid out inside the frame.
 *
 * It is *not* the rule for an overlay's frame: see `clampFrame`.
 */
export function clampRect(rect: NormalizedRect): NormalizedRect {
  const w = Math.min(1, Math.max(MIN_SIZE, rect.w));
  const h = Math.min(1, Math.max(MIN_SIZE, rect.h));
  const x = clamp01(Math.min(rect.x, 1 - w));
  const y = clamp01(Math.min(rect.y, 1 - h));
  return { x, y, w, h };
}

/**
 * Where an overlay's picture is drawn on the canvas.
 *
 * Its size is bounded like any rect, but its position is not confined to the canvas: the
 * frame may hang off any edge, down to the last `MIN_ON_SCREEN` of itself. Every path that
 * draws it clips at the canvas edge on its own — Canvas2D's `drawImage`, the rasterizer for
 * the GL quad, and FFmpeg's `overlay` all accept a negative origin — so the off-canvas part
 * simply is not drawn, which is what going off the edge means.
 */
export function clampFrame(rect: NormalizedRect): NormalizedRect {
  const w = Math.min(1, Math.max(MIN_SIZE, rect.w));
  const h = Math.min(1, Math.max(MIN_SIZE, rect.h));
  const keepX = w * MIN_ON_SCREEN;
  const keepY = h * MIN_ON_SCREEN;
  const x = Math.min(1 - keepX, Math.max(keepX - w, rect.x));
  const y = Math.min(1 - keepY, Math.max(keepY - h, rect.y));
  return { x, y, w, h };
}

/**
 * A transform's rotation, in degrees, with anything unusable read as none.
 *
 * Deliberately not wrapped into 0..360: an animated channel travelling 0 → 720 is two
 * turns, and wrapping it would make the second one disappear.
 */
export function rotationOf(transform?: OverlayTransform): number {
  const value = transform?.rotate;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function rotationRadians(transform?: OverlayTransform): number {
  return (rotationOf(transform) * Math.PI) / 180;
}

/**
 * The axis-aligned box a rotated rectangle needs.
 *
 * Only the FFmpeg fallback needs this: `rotate` renders into a fixed output size and would
 * otherwise cut the corners off, and the overlay offset has to be re-centred against the
 * larger box. The compositor and Canvas2D rotate the drawing itself and need no such box.
 */
export function rotatedBounds(w: number, h: number, degrees: number): { w: number; h: number } {
  const a = (degrees * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return { w: w * c + h * s, h: w * s + h * c };
}

/**
 * Where the FFmpeg fallback has to place a rotated layer, and how big to make it.
 *
 * `rotate` renders into a fixed output size, so the box is widened to the turned rectangle's
 * bounds — otherwise the corners are cut off — and the overlay offset is then pulled back by
 * half the growth on each axis. That keeps the *centre* fixed, which is the point the
 * compositor and Canvas2D both turn about; re-using the original corner would slide the
 * picture down and right by half the growth, and only in the exported file.
 *
 * Only the *size* is rounded to even, for the chroma planes. The offset is left exact — and
 * it already is: the frame's own x and width are even, so `x + w/2 - ow/2` comes out a whole
 * number with no rounding at all. Nudging it to even as well would move the centre by a pixel
 * and put the fallback's picture somewhere the preview never had it, which is the one error
 * this function exists to avoid.
 */
export function rotatedOverlayBox(
  frameX: number,
  frameY: number,
  frameW: number,
  frameH: number,
  degrees: number,
): { x: number; y: number; w: number; h: number } {
  const bounds = rotatedBounds(frameW, frameH, degrees);
  const w = Math.max(2, Math.round(bounds.w / 2) * 2);
  const h = Math.max(2, Math.round(bounds.h / 2) * 2);
  return {
    x: Math.round(frameX + frameW / 2 - w / 2),
    y: Math.round(frameY + frameH / 2 - h / 2),
    w,
    h,
  };
}

export function normalizeOverlayTransform(transform?: OverlayTransform): OverlayTransform {
  if (!transform) return DEFAULT_OVERLAY_TRANSFORM;
  const rotate = rotationOf(transform);
  return {
    crop: clampRect(transform.crop),
    frame: clampFrame(transform.frame),
    ...(rotate === 0 ? {} : { rotate }),
  };
}

export function drawOverlaySource(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  transform: OverlayTransform,
  cw: number,
  ch: number,
): void {
  const crop = clampRect(transform.crop);
  const frame = clampFrame(transform.frame);
  const sx = crop.x * sw;
  const sy = crop.y * sh;
  const sWidth = crop.w * sw;
  const sHeight = crop.h * sh;
  const dx = frame.x * cw;
  const dy = frame.y * ch;
  const dWidth = frame.w * cw;
  const dHeight = frame.h * ch;

  const angle = rotationRadians(transform);
  if (angle === 0) {
    ctx.drawImage(source, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
    return;
  }
  // About the frame's own centre, so rotating does not also move the picture.
  ctx.save();
  ctx.translate(dx + dWidth / 2, dy + dHeight / 2);
  ctx.rotate(angle);
  ctx.drawImage(source, sx, sy, sWidth, sHeight, -dWidth / 2, -dHeight / 2, dWidth, dHeight);
  ctx.restore();
}

/**
 * Sizes and offsets both round to even, because an odd value shifts chroma in a subsampled
 * (yuv420p) pipeline. Only sizes have a floor: an overlay's *position* is signed now, and
 * flooring it at 2 was what used to drag a frame hung off the left edge back onto the canvas
 * in the FFmpeg export alone, so the fallback disagreed with the preview about where the
 * picture was.
 */
function evenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function evenPos(value: number): number {
  return Math.round(value / 2) * 2;
}

export function overlayTransformToPixels(
  transform: OverlayTransform | undefined,
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  frameX: number;
  frameY: number;
  frameW: number;
  frameH: number;
} {
  const t = normalizeOverlayTransform(transform);
  const sw = Math.max(2, sourceWidth);
  const sh = Math.max(2, sourceHeight);
  return {
    // Offsets, not sizes: a crop is already clamped to the source, and the floor was
    // pushing a full-frame crop to `crop=W:H:2:2` — two pixels off what the preview drew.
    cropX: evenPos(t.crop.x * sw),
    cropY: evenPos(t.crop.y * sh),
    cropW: evenSize(t.crop.w * sw),
    cropH: evenSize(t.crop.h * sh),
    frameX: evenPos(t.frame.x * canvasWidth),
    frameY: evenPos(t.frame.y * canvasHeight),
    frameW: evenSize(t.frame.w * canvasWidth),
    frameH: evenSize(t.frame.h * canvasHeight),
  };
}
