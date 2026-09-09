/**
 * What a text clip looks like, and where its lines land.
 *
 * Templates used to be a `switch` returning hard-coded canvas settings, which meant "more
 * templates" was a code change every time and "more styling" was impossible — the FFmpeg
 * fallback drew text with `drawtext`, so the style set was frozen at whatever a filter string
 * could express. Now a template is a **named preset over one style record**, and every path
 * rasterizes that record on a canvas. Adding a template is a table entry.
 *
 * Sizes are fractions of the text frame, not pixels: the same clip has to look the same in a
 * 1080p preview, a 4K export and a 480p proxy, and only a proportion does that.
 *
 * The layout arithmetic here is pure — it takes a `measure` function rather than a canvas — so
 * `check:math` can hold line breaking and anchoring to their word without a DOM.
 */
import type { NormalizedRect, TextTemplate } from '../types/editor';

export type TextAlign = 'left' | 'center' | 'right';
export type TextVAlign = 'top' | 'middle' | 'bottom';

/**
 * A drop shadow, in fractions of the font size.
 *
 * Fractions for the same reason every other size here is one: a shadow authored in canvas
 * pixels is 8 px at any resolution, so it is a soft halo in a 480p proxy and a hairline in a
 * 4K export — the one thing this file exists to prevent. `shadowPixels` resolves them, and
 * converts the pixel values projects saved before this carried.
 */
export interface TextShadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
}

/**
 * The font size the old absolute-pixel shadows were authored against: a default-sized line in
 * a 1080-high frame. Nothing depends on it being exact — those shadows were only ever drawn
 * when a stroke was also set, which no template does, so in practice they were never seen at
 * all and this only has to be plausible rather than faithful.
 */
const LEGACY_SHADOW_FONT_PX = 240;

/** Shadow numbers in canvas pixels, for a resolved font size. */
export function shadowPixels(
  shadow: TextShadow,
  fontSize: number,
): { blur: number; offsetX: number; offsetY: number } {
  // A fraction of the font size is never ≥ 1 — that would be a blur the height of the type —
  // so anything that big is one of the old absolute-pixel records.
  const legacy =
    shadow.blur >= 1 || Math.abs(shadow.offsetX) >= 1 || Math.abs(shadow.offsetY) >= 1;
  const scale = legacy ? fontSize / LEGACY_SHADOW_FONT_PX : fontSize;
  return {
    blur: Math.max(0, shadow.blur * scale),
    offsetX: shadow.offsetX * scale,
    offsetY: shadow.offsetY * scale,
  };
}

export interface TextBox {
  color: string;
  /** Fractions of the font size, so padding scales with the type. */
  paddingX: number;
  paddingY: number;
  radius: number;
}

export interface TextStyle {
  fontFamily: string;
  /** Fraction of the text frame's height. */
  fontSize: number;
  weight: number;
  italic: boolean;
  color: string;
  /**
   * The outline, as a fraction of the font size — the part you can see. A canvas stroke
   * straddles the glyph outline, so the renderer draws twice this and the fill covers the
   * inner half.
   */
  strokeWidth: number;
  strokeColor: string;
  shadow: TextShadow | null;
  box: TextBox | null;
  align: TextAlign;
  vAlign: TextVAlign;
  /** Multiple of the font size. */
  lineHeight: number;
  /** Fraction of the font size. */
  letterSpacing: number;
  /** Fraction of the frame, inset from the edge the text is anchored to. */
  margin: number;
}

/**
 * Only fonts that are actually present can be used, because the fallback rasterizes with the
 * same canvas the preview does and a missing family silently becomes something else. DejaVu
 * is what `bootstrap` downloads; the rest are system stacks that resolve everywhere this app
 * runs.
 */
export const FONT_STACKS: { id: string; label: string; stack: string }[] = [
  { id: 'dejavu', label: 'DejaVu Sans', stack: 'DejaVu Sans, sans-serif' },
  { id: 'system', label: 'System', stack: 'system-ui, -apple-system, Segoe UI, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'Georgia, Times New Roman, serif' },
  { id: 'mono', label: 'Monospace', stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
];

export function fontStack(id: string): string {
  return FONT_STACKS.find((f) => f.id === id)?.stack ?? FONT_STACKS[0].stack;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'dejavu',
  fontSize: 0.22,
  weight: 600,
  italic: false,
  color: '#ffffff',
  strokeWidth: 0,
  strokeColor: '#000000',
  shadow: null,
  box: null,
  align: 'center',
  vAlign: 'middle',
  lineHeight: 1.2,
  letterSpacing: 0,
  margin: 0.04,
};

const BLACK_BAR: TextBox = { color: 'rgba(0,0,0,0.65)', paddingX: 0.5, paddingY: 0.3, radius: 0.12 };
export const SOFT_SHADOW: TextShadow = { color: 'rgba(0,0,0,0.8)', blur: 0.09, offsetX: 0.03, offsetY: 0.03 };
const HARD_SHADOW: TextShadow = { color: 'rgba(0,0,0,0.9)', blur: 0.035, offsetX: 0.02, offsetY: 0.02 };

export interface TemplateDescriptor {
  id: TextTemplate;
  label: string;
  hint: string;
  style: TextStyle;
}

/**
 * The three original templates keep their ids and their look: a project saved before this
 * existed must open unchanged, and the only way to promise that is to reproduce the numbers
 * the old `switch` used rather than to approximate them.
 */
export const TEXT_TEMPLATES: TemplateDescriptor[] = [
  {
    id: 'lowerThird',
    label: 'Lower third',
    hint: 'A name over a bar, bottom left.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontSize: 0.22,
      weight: 600,
      align: 'left',
      vAlign: 'bottom',
      box: BLACK_BAR,
      margin: 0.077,
    },
  },
  {
    id: 'centerTitle',
    label: 'Centre title',
    hint: 'Large, centred, with a shadow to lift it off the picture.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontSize: 0.35,
      weight: 700,
      align: 'center',
      vAlign: 'middle',
      shadow: SOFT_SHADOW,
    },
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    hint: 'Bottom centre, the size dialogue is usually set at.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontSize: 0.42,
      weight: 400,
      align: 'center',
      vAlign: 'bottom',
      shadow: HARD_SHADOW,
      margin: 0.035,
    },
  },
  {
    id: 'caption',
    label: 'Caption box',
    hint: 'Boxed dialogue, the way a player draws burned-in subtitles.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontSize: 0.34,
      weight: 500,
      align: 'center',
      vAlign: 'bottom',
      box: { color: 'rgba(0,0,0,0.75)', paddingX: 0.45, paddingY: 0.25, radius: 0.15 },
      margin: 0.05,
    },
  },
  {
    id: 'kicker',
    label: 'Kicker',
    hint: 'Small, wide-tracked capitals — a label over a title.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontSize: 0.14,
      weight: 700,
      align: 'left',
      vAlign: 'top',
      letterSpacing: 0.18,
      shadow: HARD_SHADOW,
      margin: 0.06,
    },
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: 'Italic serif, centred, for a pull quote.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontFamily: 'serif',
      fontSize: 0.26,
      weight: 400,
      italic: true,
      align: 'center',
      vAlign: 'middle',
      lineHeight: 1.35,
      shadow: SOFT_SHADOW,
    },
  },
  {
    id: 'outline',
    label: 'Outlined',
    hint: 'A heavy stroke instead of a shadow — legible over anything.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontSize: 0.34,
      weight: 800,
      align: 'center',
      vAlign: 'middle',
      // Halved when `strokeWidth` started meaning the outline you can see rather than the
      // canvas line width, half of which is hidden under the fill. Same picture, honest number.
      strokeWidth: 0.045,
      strokeColor: '#000000',
    },
  },
  {
    id: 'ticker',
    label: 'Ticker',
    hint: 'A full-width band across the bottom.',
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontSize: 0.2,
      weight: 600,
      align: 'left',
      vAlign: 'bottom',
      box: { color: 'rgba(190,30,45,0.9)', paddingX: 0.6, paddingY: 0.35, radius: 0 },
      margin: 0.02,
    },
  },
];

export function templateStyle(template: TextTemplate): TextStyle {
  return (TEXT_TEMPLATES.find((t) => t.id === template) ?? TEXT_TEMPLATES[0]).style;
}

/** The clip's own style if it has one, otherwise its template's. */
export function resolveTextStyle(
  template: TextTemplate,
  style: Partial<TextStyle> | undefined,
): TextStyle {
  return { ...templateStyle(template), ...(style ?? {}) };
}

/** The CSS `font` shorthand for a style at a given pixel size. */
export function fontString(style: TextStyle, pixelSize: number): string {
  const italic = style.italic ? 'italic ' : '';
  return `${italic}${style.weight} ${Math.max(1, Math.round(pixelSize))}px ${fontStack(style.fontFamily)}`;
}

/* --------------------------------------------------------------------- layout */

export type Measure = (text: string) => number;

/**
 * Greedy word wrap, with the one case that matters for video: a single word longer than the
 * line is broken rather than allowed to run off the frame, because a title with a URL in it
 * would otherwise disappear off the side.
 *
 * Explicit newlines in the text are honoured and are never joined back together.
 */
export function wrapLines(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measure(candidate) <= maxWidth || line === '') {
        // A word that does not fit on a line of its own is broken by character.
        if (line === '' && measure(word) > maxWidth) {
          let chunk = '';
          for (const ch of word) {
            if (chunk !== '' && measure(chunk + ch) > maxWidth) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
          continue;
        }
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }

  return out;
}

export interface TextLayout {
  /** Pixel font size, resolved from the fraction. */
  fontSize: number;
  lineHeight: number;
  lines: string[];
  /** Baseline y for each line, in frame coordinates. */
  baselines: number[];
  /** Anchor x for each line, honouring the alignment. */
  anchors: number[];
  /** The background box, when the style has one. */
  box: { x: number; y: number; w: number; h: number; radius: number } | null;
  align: TextAlign;
}

/**
 * Where everything goes inside a text frame of `frameW` × `frameH` pixels.
 *
 * The vertical anchor is applied to the *block* of lines, not to each line, which is what
 * makes a two-line subtitle sit above the bottom margin rather than half off the frame.
 */
export function layoutText(
  style: TextStyle,
  text: string,
  frameW: number,
  frameH: number,
  measure: (line: string, fontSize: number) => number,
): TextLayout {
  const fontSize = Math.max(1, style.fontSize * frameH);
  const lineHeight = fontSize * style.lineHeight;
  const margin = style.margin * Math.min(frameW, frameH);
  const padX = style.box ? style.box.paddingX * fontSize : 0;
  const padY = style.box ? style.box.paddingY * fontSize : 0;

  const available = Math.max(1, frameW - margin * 2 - padX * 2);
  const lines = wrapLines(text, available, (line) => measure(line, fontSize));
  const widest = lines.reduce((max, line) => Math.max(max, measure(line, fontSize)), 0);

  const blockHeight = lines.length * lineHeight;
  const boxH = blockHeight + padY * 2;

  const boxTop =
    style.vAlign === 'top'
      ? margin
      : style.vAlign === 'bottom'
        ? frameH - margin - boxH
        : (frameH - boxH) / 2;

  const boxW = Math.min(frameW - margin * 2, widest + padX * 2);
  const boxLeft =
    style.align === 'left'
      ? margin
      : style.align === 'right'
        ? frameW - margin - boxW
        : (frameW - boxW) / 2;

  const textTop = boxTop + padY;
  const baselines: number[] = [];
  const anchors: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Baseline sits at roughly 0.78 of the line box — close enough to a real ascent for a
    // single-line-height metric, and identical in every path because it is arithmetic.
    baselines.push(textTop + i * lineHeight + fontSize * 0.78);
    anchors.push(
      style.align === 'left'
        ? boxLeft + padX
        : style.align === 'right'
          ? boxLeft + boxW - padX
          : boxLeft + boxW / 2,
    );
  }

  return {
    fontSize,
    lineHeight,
    lines,
    baselines,
    anchors,
    box: style.box
      ? { x: boxLeft, y: boxTop, w: boxW, h: boxH, radius: style.box.radius * fontSize }
      : null,
    align: style.align,
  };
}

/** The frame a text clip occupies, defaulting to the whole canvas. */
export const FULL_TEXT_FRAME: NormalizedRect = { x: 0, y: 0, w: 1, h: 1 };
