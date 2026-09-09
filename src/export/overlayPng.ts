/**
 * Rasterizing text and annotation clips to PNGs, for the FFmpeg fallback.
 *
 * This is what retires `drawtext`. The fallback used to rebuild a text clip's look out of
 * filter arguments, which meant the style set was frozen at whatever a filter string could
 * express, effects on a text clip had to be refused outright, and the two paths could drift
 * apart with nothing to catch it. Now the fallback overlays the *same bitmap* the preview
 * draws, from the same module — so the three paths agree by construction.
 *
 * One PNG per overlay clip, at the export's own size. They are small: a title is mostly
 * transparent, and PNG is very good at transparent.
 */
import type { AnnotationClip, Clip, TextClip } from '../types/editor';
import { drawTextClip } from '../preview/textRenderer';
import { drawAnnotationClip } from '../render/annotationRaster';
import { textFrameForClip } from '../utils/overlayTransform';
import { annotationShapesAt } from '../utils/annotationAnim';
import { clipDuration } from '../utils/time';

export interface OverlayImage {
  clipId: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      blob.arrayBuffer().then(
        (buffer) => resolve(new Uint8Array(buffer)),
        () => resolve(null),
      );
    }, 'image/png');
  });
}

/**
 * The overlay clips in a project, drawn at `width` × `height`.
 *
 * A text clip is drawn at its *frame's* size and overlaid at the frame's origin, exactly as
 * the compositor does it — the style is derived from the box, so drawing into a frame-sized
 * canvas gives identical pixels to drawing the same box inside a full one.
 */
export async function rasterizeOverlays(
  clips: Clip[],
  width: number,
  height: number,
): Promise<OverlayImage[]> {
  const out: OverlayImage[] = [];

  for (const clip of clips) {
    if (clip.kind !== 'text' && clip.kind !== 'annotation') continue;

    const frame = clip.kind === 'text' ? textFrameForClip((clip as TextClip).textFrame) : null;
    const w = Math.max(2, Math.round((frame?.w ?? 1) * width));
    const h = Math.max(2, Math.round((frame?.h ?? 1) * height));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.clearRect(0, 0, w, h);

    if (clip.kind === 'text') {
      drawTextClip(ctx, clip, w, h);
    } else {
      // One bitmap per clip, so an animated mark is drawn where it stands at the clip's
      // midpoint — the same rule this path already applies to every other keyframed value,
      // and warned about in `buildFilterGraph`.
      const annotation = clip as AnnotationClip;
      const midpoint = annotation.timelineStart + clipDuration(annotation) / 2;
      drawAnnotationClip(ctx, { shapes: annotationShapesAt(annotation, midpoint) }, w, h);
    }

    const bytes = await canvasToPng(canvas);
    if (bytes) out.push({ clipId: clip.id, bytes, width: w, height: h });
  }

  return out;
}
