import type { NormalizedRect } from '../types/editor';
import { clamp01, clampFrame, clampRect } from './overlayTransform';

/**
 * The little stage in the Inspector that stands in for the frame.
 *
 * It has to be the *project's* shape, not a fixed 16:9 box: an overlay dragged on a landscape
 * stage and rendered into a vertical frame would land somewhere else, and the picture the
 * editor shows would be the one thing in the app that was not honest about the canvas.
 */
export interface StageSize {
  w: number;
  h: number;
}

export const STAGE_MAX_W = 196;
const STAGE_MAX_H = 176;
/** The stage stays this much taller than wide at most, however wide the panel is dragged. */
const STAGE_ASPECT_CAP = STAGE_MAX_H / STAGE_MAX_W;

/**
 * The stage, fitted to the room it has.
 *
 * It used to be a hard 196 × 176 box, which was fine until the panel around it stopped being
 * a fixed 240px and the placement stage grew a bleed margin — at which point the one control
 * that most needs room was the one guaranteed not to get any. `maxW` comes from measuring
 * the panel, so dragging the sidebar wider now makes the stage bigger.
 *
 * 16:9 at the default width still comes out 196 × 110, exactly the size this stage always was.
 */
export function stageSize(width: number, height: number, maxW = STAGE_MAX_W): StageSize {
  const capW = Math.max(80, maxW);
  const capH = Math.max(72, Math.round(capW * STAGE_ASPECT_CAP));
  const scale = Math.min(capW / width, capH / height);
  return { w: Math.round(width * scale), h: Math.round(height * scale) };
}

export const HANDLE_RADIUS_PX = 12;

export interface CropCanvasLayout {
  ox: number;
  oy: number;
  dw: number;
  dh: number;
}

export function pointerCanvasPx(
  e: React.PointerEvent<HTMLElement>,
  box: DOMRect,
  stage: StageSize,
): { x: number; y: number } {
  return {
    x: ((e.clientX - box.left) / box.width) * stage.w,
    y: ((e.clientY - box.top) / box.height) * stage.h,
  };
}

export function pointerCanvasNorm(
  e: React.PointerEvent<HTMLElement>,
  box: DOMRect,
  stage: StageSize,
): { x: number; y: number } {
  const px = pointerCanvasPx(e, box, stage);
  return { x: px.x / stage.w, y: px.y / stage.h };
}

export function getCropLayout(
  sourceWidth: number,
  sourceHeight: number,
  stage: StageSize,
): CropCanvasLayout {
  const scale = Math.min(stage.w / sourceWidth, stage.h / sourceHeight);
  const dw = sourceWidth * scale;
  const dh = sourceHeight * scale;
  return { ox: (stage.w - dw) / 2, oy: (stage.h - dh) / 2, dw, dh };
}

export function canvasPxToCropNorm(
  px: { x: number; y: number },
  layout: CropCanvasLayout,
): { x: number; y: number } {
  return {
    x: clamp01((px.x - layout.ox) / layout.dw),
    y: clamp01((px.y - layout.oy) / layout.dh),
  };
}

export function cropRectHandlePx(rect: NormalizedRect, layout: CropCanvasLayout): { x: number; y: number } {
  const crop = clampRect(rect);
  return {
    x: layout.ox + (crop.x + crop.w) * layout.dw,
    y: layout.oy + (crop.y + crop.h) * layout.dh,
  };
}

/**
 * Slack drawn around the frame on the placement stage, as a fraction of the stage.
 *
 * An overlay may now hang off the canvas, and a stage cropped exactly to the canvas would
 * hide the part that hangs — including, when it hangs off the right, the resize handle. The
 * bleed keeps the whole rectangle reachable. What falls in it is dimmed rather than hidden,
 * because it is real geometry that will not be in the picture.
 */
export const STAGE_BLEED = 0.18;

export interface FrameStage {
  /** The canvas element's own size. */
  w: number;
  h: number;
  /** Where the project frame sits inside it. */
  ox: number;
  oy: number;
  fw: number;
  fh: number;
}

/**
 * The width to fit a *frame* stage into, given the room available.
 *
 * The bleed is drawn outside the frame, so the frame itself has to be smaller than the space
 * by exactly that much — sizing the frame to the full width and then adding the bleed is what
 * pushed the placement stage out of the panel in the first place.
 */
export function frameStageBudget(available: number): number {
  return Math.max(80, Math.floor(available / (1 + STAGE_BLEED * 2)));
}

export function frameStage(stage: StageSize): FrameStage {
  const ox = Math.round(stage.w * STAGE_BLEED);
  const oy = Math.round(stage.h * STAGE_BLEED);
  return { w: stage.w + ox * 2, h: stage.h + oy * 2, ox, oy, fw: stage.w, fh: stage.h };
}

/** Pointer to canvas-normalized coordinates, where 0..1 is the frame and outside it is bleed. */
export function pointerFrameNorm(
  e: React.PointerEvent<HTMLElement>,
  box: DOMRect,
  fs: FrameStage,
): { x: number; y: number } {
  const px = pointerCanvasPx(e, box, { w: fs.w, h: fs.h });
  return { x: (px.x - fs.ox) / fs.fw, y: (px.y - fs.oy) / fs.fh };
}

/**
 * A resize that keeps the rect's proportions *on screen*.
 *
 * The normalized numbers are not the proportions anyone sees: a frame of w = 0.3, h = 0.3 is
 * square only on a square canvas. So the ratio is taken in pixels, against the extent the
 * rect is normalized to — the canvas for a frame, the source for a crop — and the axis the
 * pointer moved further along in pixels is the one that drives.
 */
export function lockedResize(
  start: NormalizedRect,
  dx: number,
  dy: number,
  extent: { w: number; h: number },
): NormalizedRect {
  const ratio = (start.w * extent.w) / Math.max(1e-6, start.h * extent.h);
  const byWidth = Math.abs(dx * extent.w) >= Math.abs(dy * extent.h);
  const w = byWidth ? start.w + dx : ((start.h + dy) * extent.h * ratio) / extent.w;
  const h = byWidth ? ((start.w + dx) * extent.w) / (ratio * extent.h) : start.h + dy;
  return { x: start.x, y: start.y, w, h };
}

/** The partner value when one side of a locked rect is typed in. */
export function lockedPartner(
  rect: NormalizedRect,
  edited: 'w' | 'h',
  value: number,
  extent: { w: number; h: number },
): NormalizedRect {
  const ratio = (rect.w * extent.w) / Math.max(1e-6, rect.h * extent.h);
  return edited === 'w'
    ? { ...rect, w: value, h: (value * extent.w) / (ratio * extent.h) }
    : { ...rect, h: value, w: (value * extent.h * ratio) / extent.w };
}

/** The resize handle of an overlay frame, in stage pixels — bleed included. */
export function frameHandleOnStage(
  rect: NormalizedRect,
  fs: FrameStage,
  degrees = 0,
): { x: number; y: number } {
  const frame = clampFrame(rect);
  const cx = fs.ox + (frame.x + frame.w / 2) * fs.fw;
  const cy = fs.oy + (frame.y + frame.h / 2) * fs.fh;
  // The corner travels with the picture, so grabbing the handle means the same thing at
  // every angle instead of only at zero.
  const hx = (frame.w / 2) * fs.fw;
  const hy = (frame.h / 2) * fs.fh;
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  return { x: cx + hx * c - hy * sn, y: cy + hx * sn + hy * c };
}

/** Text boxes stay inside the frame, so their stage has no bleed and their handle no offset. */
export function frameRectHandlePx(rect: NormalizedRect, stage: StageSize): { x: number; y: number } {
  const frame = clampRect(rect);
  return {
    x: (frame.x + frame.w) * stage.w,
    y: (frame.y + frame.h) * stage.h,
  };
}

export function pct(value: number): number {
  return Math.round(value * 100);
}

export function fromPct(value: number): number {
  return Math.min(1, Math.max(0, value / 100));
}

/** A frame's position may be negative, so its field cannot clamp on the way in. */
export function fromPctSigned(value: number): number {
  return Number.isFinite(value) ? value / 100 : 0;
}
