import type { NormalizedRect } from '../types/editor';
import { clamp01, clampRect } from './overlayTransform';

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

const STAGE_MAX_W = 196;
const STAGE_MAX_H = 176;

/** 16:9 fits its long edge and comes out 196 × 110, exactly the size this stage always was. */
export function stageSize(width: number, height: number): StageSize {
  const scale = Math.min(STAGE_MAX_W / width, STAGE_MAX_H / height);
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
