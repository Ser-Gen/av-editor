import type { NormalizedRect } from '../types/editor';
import { clamp01, clampRect } from './overlayTransform';

export const OVERLAY_PREVIEW_W = 196;
export const OVERLAY_PREVIEW_H = 110;
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
): { x: number; y: number } {
  return {
    x: ((e.clientX - box.left) / box.width) * OVERLAY_PREVIEW_W,
    y: ((e.clientY - box.top) / box.height) * OVERLAY_PREVIEW_H,
  };
}

export function pointerCanvasNorm(
  e: React.PointerEvent<HTMLElement>,
  box: DOMRect,
): { x: number; y: number } {
  const px = pointerCanvasPx(e, box);
  return { x: px.x / OVERLAY_PREVIEW_W, y: px.y / OVERLAY_PREVIEW_H };
}

export function getCropLayout(sourceWidth: number, sourceHeight: number): CropCanvasLayout {
  const scale = Math.min(OVERLAY_PREVIEW_W / sourceWidth, OVERLAY_PREVIEW_H / sourceHeight);
  const dw = sourceWidth * scale;
  const dh = sourceHeight * scale;
  return { ox: (OVERLAY_PREVIEW_W - dw) / 2, oy: (OVERLAY_PREVIEW_H - dh) / 2, dw, dh };
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

export function frameRectHandlePx(rect: NormalizedRect): { x: number; y: number } {
  const frame = clampRect(rect);
  return {
    x: (frame.x + frame.w) * OVERLAY_PREVIEW_W,
    y: (frame.y + frame.h) * OVERLAY_PREVIEW_H,
  };
}

export function pct(value: number): number {
  return Math.round(value * 100);
}

export function fromPct(value: number): number {
  return Math.min(1, Math.max(0, value / 100));
}
