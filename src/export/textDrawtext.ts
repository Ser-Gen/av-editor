import type { NormalizedRect, TextTemplate } from '../types/editor';
import { clampRect, DEFAULT_FULL_FRAME } from '../utils/overlayTransform';

export function drawtextFilter(
  template: TextTemplate,
  text: string,
  width: number,
  height: number,
  fontfile: string,
  enable: string,
  inputLabel: string,
  textFrame: NormalizedRect = DEFAULT_FULL_FRAME,
  /** Optional drawtext `alpha` expression (already comma-escaped) for clip fades. */
  alphaExpr?: string,
): { filter: string; outLabel: string } {
  const escaped = text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const outLabel = `vtxt_${Math.random().toString(36).slice(2, 8)}`;
  const frame = clampRect(textFrame);

  const frameX = Math.round(frame.x * width);
  const frameY = Math.round(frame.y * height);
  const frameW = Math.max(16, Math.round(frame.w * width));
  const frameH = Math.max(16, Math.round(frame.h * height));

  let fontSize: number;
  let x: string;
  let y: string;
  let box = '';
  const fontColor = 'white';
  let shadow = '';

  switch (template) {
    case 'lowerThird':
      fontSize = Math.round(frameH * 0.22);
      x = String(frameX + Math.round(fontSize * 0.7));
      y = String(frameY + frameH - Math.round(fontSize * 0.8));
      box = ':box=1:boxcolor=black@0.65:boxborderw=12';
      break;
    case 'centerTitle':
      fontSize = Math.round(frameH * 0.35);
      x = `${frameX}+(${frameW}-text_w)/2`;
      y = `${frameY}+(${frameH}-text_h)/2`;
      shadow = ':shadowcolor=black@0.8:shadowx=2:shadowy=2';
      break;
    case 'subtitle':
      fontSize = Math.round(frameH * 0.42);
      x = `${frameX}+(${frameW}-text_w)/2`;
      y = `${frameY + frameH}-${Math.round(fontSize * 0.6)}`;
      shadow = ':shadowcolor=black@0.9:shadowx=1:shadowy=1';
      break;
  }

  const alpha = alphaExpr ? `:alpha='${alphaExpr}'` : '';
  const filter = `[${inputLabel}]drawtext=fontfile=${fontfile}:text='${escaped}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${x}:y=${y}${box}${shadow}${alpha}:enable='${enable}'[${outLabel}]`;
  return { filter, outLabel };
}
