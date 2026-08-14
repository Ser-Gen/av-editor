import type { NormalizedRect, TextTemplate } from '../types/editor';
import { clampRect, DEFAULT_FULL_FRAME } from '../utils/overlayTransform';

export interface TextStyle {
  font: string;
  fillStyle: string;
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
  bar?: { x: number; y: number; w: number; h: number; fill: string };
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  x: number;
  y: number;
  maxWidth?: number;
  fontSize: number;
}

export function getTextStyle(
  template: TextTemplate,
  width: number,
  height: number,
  text: string,
): TextStyle {
  const fontFamily = 'DejaVu Sans, sans-serif';
  switch (template) {
    case 'lowerThird': {
      const fontSize = Math.round(height * 0.22);
      const pad = fontSize * 0.35;
      const barH = fontSize * 1.6;
      const barW = Math.min(width * 0.95, text.length * fontSize * 0.55 + pad * 2);
      return {
        font: `600 ${fontSize}px ${fontFamily}`,
        fillStyle: '#ffffff',
        bar: {
          x: pad,
          y: height - barH - pad,
          w: barW,
          h: barH,
          fill: 'rgba(0,0,0,0.65)',
        },
        textAlign: 'left',
        textBaseline: 'middle',
        x: pad * 2,
        y: height - barH / 2 - pad,
        maxWidth: barW - pad * 2,
        fontSize,
      };
    }
    case 'centerTitle': {
      const fontSize = Math.round(height * 0.35);
      return {
        font: `700 ${fontSize}px ${fontFamily}`,
        fillStyle: '#ffffff',
        shadow: { color: 'rgba(0,0,0,0.8)', blur: 8, offsetX: 2, offsetY: 2 },
        textAlign: 'center',
        textBaseline: 'middle',
        x: width / 2,
        y: height / 2,
        maxWidth: width * 0.92,
        fontSize,
      };
    }
    case 'subtitle': {
      const fontSize = Math.round(height * 0.42);
      return {
        font: `400 ${fontSize}px ${fontFamily}`,
        fillStyle: '#ffffff',
        shadow: { color: 'rgba(0,0,0,0.9)', blur: 4, offsetX: 1, offsetY: 1 },
        textAlign: 'center',
        textBaseline: 'bottom',
        x: width / 2,
        y: height - fontSize * 0.35,
        maxWidth: width * 0.95,
        fontSize,
      };
    }
  }
}

export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  template: TextTemplate,
  text: string,
  canvasW: number,
  canvasH: number,
  textFrame: NormalizedRect = DEFAULT_FULL_FRAME,
): void {
  const frame = clampRect(textFrame);
  const fx = frame.x * canvasW;
  const fy = frame.y * canvasH;
  const fw = frame.w * canvasW;
  const fh = frame.h * canvasH;

  const style = getTextStyle(template, fw, fh, text);

  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, fw, fh);
  ctx.clip();

  if (style.bar) {
    const { x, y, w, h, fill } = style.bar;
    ctx.fillStyle = fill;
    ctx.fillRect(fx + x, fy + y, w, h);
  }
  ctx.font = style.font;
  ctx.fillStyle = style.fillStyle;
  ctx.textAlign = style.textAlign;
  ctx.textBaseline = style.textBaseline;
  if (style.shadow) {
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur;
    ctx.shadowOffsetX = style.shadow.offsetX;
    ctx.shadowOffsetY = style.shadow.offsetY;
  }
  ctx.fillText(text, fx + style.x, fy + style.y, style.maxWidth);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.restore();
}
