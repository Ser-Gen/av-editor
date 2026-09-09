/**
 * Drawing a text clip onto a 2D canvas.
 *
 * One function, three callers: the preview compositor, the WebCodecs export (through the same
 * compositor) and — since the overlay work — the FFmpeg fallback, which rasterizes this to a
 * PNG and overlays it rather than rebuilding the look out of `drawtext` arguments. That third
 * caller is the point. `drawtext` could express a font, a size, a colour and one box; anything
 * past that was either impossible or had to be implemented twice and checked for drift.
 *
 * Everything about *what* it looks like lives in `utils/textStyle.ts`, which is pure. This file
 * is only the part that needs a canvas.
 */
import type { NormalizedRect, TextClip } from '../types/editor';
import { clampRect } from '../utils/overlayTransform';
import { fontString, layoutText, resolveTextStyle, shadowPixels } from '../utils/textStyle';
import type { TextStyle } from '../utils/textStyle';

/** Letter spacing is not in every canvas implementation yet, so it is applied by hand. */
function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  align: 'left' | 'center' | 'right',
  paint: (ch: string, cx: number, cy: number) => void,
): void {
  if (spacing === 0) {
    paint(text, x, y);
    return;
  }
  const chars = [...text];
  const total = chars.reduce((sum, ch) => sum + ctx.measureText(ch).width + spacing, 0) - spacing;
  let cursor = align === 'left' ? x : align === 'right' ? x - total : x - total / 2;
  const previous = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of chars) {
    paint(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
  ctx.textAlign = previous;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function drawStyledText(
  ctx: CanvasRenderingContext2D,
  style: TextStyle,
  text: string,
  canvasW: number,
  canvasH: number,
  textFrame: NormalizedRect = { x: 0, y: 0, w: 1, h: 1 },
): void {
  const frame = clampRect(textFrame);
  const fx = frame.x * canvasW;
  const fy = frame.y * canvasH;
  const fw = frame.w * canvasW;
  const fh = frame.h * canvasH;
  if (fw <= 0 || fh <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, fw, fh);
  ctx.clip();

  const layout = layoutText(style, text, fw, fh, (line, size) => {
    ctx.font = fontString(style, size);
    const width = ctx.measureText(line).width;
    // Tracking widens the line, and the wrap has to know about it or a tracked kicker runs
    // past the frame it was measured into.
    return width + Math.max(0, [...line].length - 1) * style.letterSpacing * size;
  });

  ctx.font = fontString(style, layout.fontSize);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = layout.align;

  /**
   * The shadow is cast by the *outermost* thing drawn — the box if there is one, otherwise the
   * stroke, otherwise the fill — and by exactly one of them. That is what a drop shadow is: a
   * silhouette of the mark, offset. Casting it from an inner layer as well would darken the
   * glyph's own edge instead of the ground behind the mark.
   *
   * This is also where the shadow went missing. It used to be set before the stroke and
   * cleared before the fill, so a style with a shadow and no stroke drew no shadow at all —
   * and no template pairs the two, so switching Shadow on did nothing visible, ever.
   */
  const shadow = style.shadow ? shadowPixels(style.shadow, layout.fontSize) : null;
  const castShadow = () => {
    if (!shadow || !style.shadow) return;
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = shadow.blur;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
  };
  const clearShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  };

  if (layout.box && style.box) {
    castShadow();
    ctx.fillStyle = style.box.color;
    roundedRect(ctx, fx + layout.box.x, fy + layout.box.y, layout.box.w, layout.box.h, layout.box.radius);
    ctx.fill();
    clearShadow();
  }

  const spacing = style.letterSpacing * layout.fontSize;

  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    if (line === '') continue;
    const x = fx + layout.anchors[i];
    const y = fy + layout.baselines[i];

    const paint = (chunk: string, cx: number, cy: number) => {
      // A box already cast it; the type is inside the box.
      if (!layout.box) castShadow();
      // Stroke first, so the fill sits inside it rather than being eaten by half its width.
      if (style.strokeWidth > 0) {
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeStyle = style.strokeColor;
        // A canvas stroke straddles the path, so half of it lands under the fill: the width
        // is doubled to make the number mean the outline you can actually see.
        ctx.lineWidth = style.strokeWidth * 2 * layout.fontSize;
        ctx.strokeText(chunk, cx, cy);
        clearShadow();
      }
      ctx.fillStyle = style.color;
      ctx.fillText(chunk, cx, cy);
      clearShadow();
    };

    drawSpacedText(ctx, line, x, y, spacing, layout.align, paint);
  }

  ctx.restore();
}

/** The clip's own overrides on top of its template. */
export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Pick<TextClip, 'template' | 'text' | 'style'>,
  canvasW: number,
  canvasH: number,
  textFrame?: NormalizedRect,
): void {
  drawStyledText(
    ctx,
    resolveTextStyle(clip.template, clip.style),
    clip.text,
    canvasW,
    canvasH,
    textFrame,
  );
}
