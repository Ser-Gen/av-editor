import type { OverlayTransform } from '../types/editor';
import { clampFrame } from '../utils/overlayTransform';

/**
 * Where a camera lands when there is a screen recording underneath it.
 *
 * The renderer stretches a clip's crop into its frame — there is no letterboxing inside a
 * transform (see `GLCompositor.drawSource`). So a frame whose shape does not match the
 * camera's would squash the face, and the height here is *derived* from the width rather
 * than chosen. That is the whole reason this is a function and not a constant: a 4:3
 * webcam and a 16:9 one cannot share one rectangle.
 *
 * The margin is in pixels of the project frame, because that is what "24px from the
 * corner" means to the eye; it is converted per axis, so a vertical project gets a square
 * margin rather than a taller one.
 */

/** A quarter of the frame wide: big enough to read a face, small enough to stay out of the way. */
export const PIP_WIDTH_FRACTION = 0.25;
export const PIP_MARGIN_PX = 24;

export interface Size {
  width: number;
  height: number;
}

export interface PipOptions {
  widthFraction?: number;
  marginPx?: number;
}

/** Falls back to 16:9 rather than to the project's shape — an unmeasured camera is not square. */
const FALLBACK_ASPECT = 16 / 9;

function aspectOf(size: Size | undefined): number {
  if (!size || !(size.width > 0) || !(size.height > 0)) return FALLBACK_ASPECT;
  return size.width / size.height;
}

/**
 * Bottom-right picture-in-picture, sized so the source keeps its own shape.
 *
 * Everything it produces is ordinary clip data: the result is editable, movable and
 * removable afterwards exactly like a transform dragged out by hand.
 */
export function pictureInPictureTransform(
  source: Size | undefined,
  project: Size,
  options: PipOptions = {},
): OverlayTransform {
  const widthFraction = options.widthFraction ?? PIP_WIDTH_FRACTION;
  const marginPx = options.marginPx ?? PIP_MARGIN_PX;

  const projectWidth = Math.max(2, project.width);
  const projectHeight = Math.max(2, project.height);
  const marginX = marginPx / projectWidth;
  const marginY = marginPx / projectHeight;

  // On-canvas pixels: w = fraction × W, and h follows from the source's aspect. Expressed
  // back as a fraction of the canvas height, that is fraction × (W/H) ÷ sourceAspect.
  const projectAspect = projectWidth / projectHeight;
  let w = widthFraction;
  let h = (widthFraction * projectAspect) / aspectOf(source);

  // A very tall source would otherwise run off the top of the frame. Shrink both together,
  // never one of them — the shape is the thing being preserved.
  const maxHeight = 1 - 2 * marginY;
  if (h > maxHeight) {
    const shrink = maxHeight / h;
    w *= shrink;
    h *= shrink;
  }

  return {
    crop: { x: 0, y: 0, w: 1, h: 1 },
    frame: clampFrame({ x: 1 - marginX - w, y: 1 - marginY - h, w, h }),
  };
}
