import type { NormalizedRect, OverlayTransform } from '../types/editor';

export const DEFAULT_OVERLAY_TRANSFORM: OverlayTransform = {
  crop: { x: 0, y: 0, w: 1, h: 1 },
  frame: { x: 0.62, y: 0.05, w: 0.34, h: 0.34 },
};

export const DEFAULT_FULL_FRAME: NormalizedRect = { x: 0, y: 0, w: 1, h: 1 };

/** Letterbox frame for 16:9 canvas (resolution-independent normalized coords). */
export function defaultLetterboxFrame(assetW: number, assetH: number): NormalizedRect {
  const cw = 16;
  const ch = 9;
  const aw = Math.max(1, assetW);
  const ah = Math.max(1, assetH);
  const scale = Math.min(cw / aw, ch / ah);
  const w = (aw * scale) / cw;
  const h = (ah * scale) / ch;
  return clampRect({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

export function defaultImageTransform(assetW: number, assetH: number): OverlayTransform {
  return {
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: defaultLetterboxFrame(assetW, assetH),
  };
}

export function imageTransformForClip(
  transform: OverlayTransform | undefined,
  assetW: number,
  assetH: number,
): OverlayTransform {
  if (transform) return normalizeOverlayTransform(transform);
  return defaultImageTransform(assetW, assetH);
}

export function textFrameForClip(frame?: NormalizedRect): NormalizedRect {
  return clampRect(frame ?? DEFAULT_FULL_FRAME);
}

const MIN_SIZE = 0.05;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampRect(rect: NormalizedRect): NormalizedRect {
  const w = Math.min(1, Math.max(MIN_SIZE, rect.w));
  const h = Math.min(1, Math.max(MIN_SIZE, rect.h));
  const x = clamp01(Math.min(rect.x, 1 - w));
  const y = clamp01(Math.min(rect.y, 1 - h));
  return { x, y, w, h };
}

export function normalizeOverlayTransform(transform?: OverlayTransform): OverlayTransform {
  if (!transform) return DEFAULT_OVERLAY_TRANSFORM;
  return {
    crop: clampRect(transform.crop),
    frame: clampRect(transform.frame),
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
  const frame = clampRect(transform.frame);
  const sx = crop.x * sw;
  const sy = crop.y * sh;
  const sWidth = crop.w * sw;
  const sHeight = crop.h * sh;
  const dx = frame.x * cw;
  const dy = frame.y * ch;
  const dWidth = frame.w * cw;
  const dHeight = frame.h * ch;
  ctx.drawImage(source, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
}

function evenPx(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
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
    cropX: evenPx(t.crop.x * sw),
    cropY: evenPx(t.crop.y * sh),
    cropW: evenPx(t.crop.w * sw),
    cropH: evenPx(t.crop.h * sh),
    frameX: evenPx(t.frame.x * canvasWidth),
    frameY: evenPx(t.frame.y * canvasHeight),
    frameW: evenPx(t.frame.w * canvasWidth),
    frameH: evenPx(t.frame.h * canvasHeight),
  };
}
