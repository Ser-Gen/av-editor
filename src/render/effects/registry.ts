import type { BuiltinEffectType, EffectInstance, EffectType } from '../../types/editor';
import type { EffectDescriptor, EffectParam, LayerSize } from './types';
import { customDescriptor } from './customShader';

export type { EffectDescriptor, EffectParam, LayerSize } from './types';
export { customDescriptor, parseShader } from './customShader';
export { EFFECT_PRELUDE, MAX_EFFECT_PARAMS, packParams } from './types';

/**
 * The effect library.
 *
 * One entry per effect, holding everything about it: the parameters (which drive the
 * Inspector UI with no per-effect React code), the fragment shader that renders it, and
 * the FFmpeg filter used by the fallback export. Adding an effect means adding one
 * object here.
 *
 * Shaders receive the shared prelude below, so a `frag` body is just `main()`.
 */

function num(v: number): string {
  return Number(v.toFixed(4)).toString();
}

const percent = (v: number) => `${Math.round(v * 100)}%`;
const pixels = (v: number) => `${Math.round(v)} px`;

export const EFFECTS: Record<BuiltinEffectType, EffectDescriptor> = {
  // ---------------------------------------------------------------- eq / enhance
  eq: {
    type: 'eq',
    label: 'Brightness / Contrast / Saturation',
    params: [
      { name: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01, defaultValue: 0 },
      { name: 'contrast', label: 'Contrast', min: 0, max: 3, step: 0.01, defaultValue: 1 },
      { name: 'saturation', label: 'Saturation', min: 0, max: 3, step: 0.01, defaultValue: 1 },
    ],
    frag: `
void main() {
  vec4 c = fetch(vUv);
  vec3 rgb = (c.rgb - 0.5) * uP[1] + 0.5 + uP[0];
  rgb = mix(vec3(luma(rgb)), rgb, uP[2]);
  outColor = store(rgb, c.a);
}`,
    ffmpeg: (p) =>
      `eq=brightness=${num(p.brightness)}:contrast=${num(p.contrast)}:saturation=${num(p.saturation)}`,
  },

  // ------------------------------------------------------- cinematic-grade-letterbox
  cinematic: {
    type: 'cinematic',
    label: 'Cinematic grade',
    note: 'The grade from the preset. Its 2.35:1 letterbox is a resize, not a look — crop the clip instead.',
    params: [
      { name: 'contrast', label: 'Contrast', min: 0.5, max: 2, step: 0.01, defaultValue: 1.1 },
      { name: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, defaultValue: 1.2 },
      { name: 'warmth', label: 'Warmth', min: -0.3, max: 0.3, step: 0.01, defaultValue: 0.05 },
    ],
    frag: `
void main() {
  vec4 c = fetch(vUv);
  vec3 rgb = (c.rgb - 0.5) * uP[0] + 0.5 + 0.02;
  rgb = mix(vec3(luma(rgb)), rgb, uP[1]);
  rgb += vec3(uP[2], 0.0, -uP[2]);
  outColor = store(rgb, c.a);
}`,
    ffmpeg: (p) =>
      `eq=contrast=${num(p.contrast)}:brightness=0.02:saturation=${num(p.saturation)},` +
      `colorbalance=rs=${num(p.warmth)}:bs=${num(-p.warmth)}`,
  },

  // ------------------------------------------------------------------- hue=s=0
  blackWhite: {
    type: 'blackWhite',
    label: 'Black & white',
    params: [
      {
        name: 'mix',
        label: 'Amount',
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 1,
        format: percent,
      },
    ],
    frag: `
void main() {
  vec4 c = fetch(vUv);
  outColor = store(mix(c.rgb, vec3(luma(c.rgb)), uP[0]), c.a);
}`,
    ffmpeg: (p) => `hue=s=${num(1 - p.mix)}`,
  },

  // ------------------------------------------------------------------- unsharp
  sharpen: {
    type: 'sharpen',
    label: 'Sharpen',
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 3, step: 0.05, defaultValue: 1 },
      { name: 'radius', label: 'Radius', min: 0.5, max: 4, step: 0.1, defaultValue: 1 },
    ],
    frag: `
void main() {
  vec4 c = fetch(vUv);
  vec2 r = uTexel * uP[1];
  vec3 sum = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += fetch(vUv + vec2(float(x), float(y)) * r).rgb;
    }
  }
  vec3 blurred = sum / 9.0;
  outColor = store(c.rgb + (c.rgb - blurred) * uP[0], c.a);
}`,
    ffmpeg: (p) => `unsharp=5:5:${num(p.amount)}:5:5:0`,
  },

  // ------------------------------------------------------------------- hqdn3d
  denoise: {
    type: 'denoise',
    label: 'Denoise',
    note: 'Spatial only. FFmpeg’s hqdn3d also averages across time, which a per-frame shader cannot do.',
    params: [
      {
        name: 'strength',
        label: 'Strength',
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.5,
        format: percent,
      },
    ],
    frag: `
void main() {
  vec4 c = fetch(vUv);
  // Edge-aware mean: neighbours far from the centre colour barely contribute, so
  // grain is averaged away without smearing detail across edges.
  vec2 r = uTexel * (1.0 + uP[0] * 2.0);
  float sigma = 0.03 + uP[0] * 0.25;
  vec3 sum = c.rgb;
  float wsum = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec3 s = fetch(vUv + vec2(float(x), float(y)) * r).rgb;
      vec3 d = s - c.rgb;
      float w = exp(-dot(d, d) / (sigma * sigma));
      sum += s * w;
      wsum += w;
    }
  }
  outColor = store(mix(c.rgb, sum / wsum, uP[0]), c.a);
}`,
    ffmpeg: (p) =>
      `hqdn3d=${num(8 * p.strength)}:${num(6 * p.strength)}:${num(12 * p.strength)}:${num(8 * p.strength)}`,
  },

  // ----------------------------------------------------------------- pixelate
  pixelate: {
    type: 'pixelate',
    label: 'Pixelate',
    params: [
      {
        name: 'block',
        label: 'Block size',
        min: 2,
        max: 128,
        step: 1,
        defaultValue: 16,
        format: pixels,
      },
    ],
    frag: `
void main() {
  float b = max(1.0, uP[0]);
  vec2 px = floor(vUv * uResolution / b) * b + b * 0.5;
  vec4 c = fetch(px * uTexel);
  outColor = store(c.rgb, c.a);
}`,
    // Scaling back to explicit dimensions, not `iw*block`: rounding on the way down
    // would otherwise change the layer size and shift the overlay.
    ffmpeg: (p, layer) => {
      const block = Math.max(1, Math.round(p.block));
      const w = Math.max(1, Math.round(layer.width / block));
      const h = Math.max(1, Math.round(layer.height / block));
      return `scale=${w}:${h}:flags=neighbor,scale=${layer.width}:${layer.height}:flags=neighbor`;
    },
  },

  // -------------------------------------------------------- edgedetect,negate
  edgeDetect: {
    type: 'edgeDetect',
    label: 'Edge detect / sketch',
    params: [
      { name: 'low', label: 'Low', min: 0, max: 1, step: 0.01, defaultValue: 0.1 },
      { name: 'high', label: 'High', min: 0, max: 1, step: 0.01, defaultValue: 0.3 },
    ],
    frag: `
float lumaAt(vec2 uv) { return luma(fetch(uv).rgb); }

void main() {
  vec4 c = fetch(vUv);
  vec2 t = uTexel;
  float tl = lumaAt(vUv + vec2(-t.x, -t.y));
  float tc = lumaAt(vUv + vec2(0.0, -t.y));
  float tr = lumaAt(vUv + vec2(t.x, -t.y));
  float ml = lumaAt(vUv + vec2(-t.x, 0.0));
  float mr = lumaAt(vUv + vec2(t.x, 0.0));
  float bl = lumaAt(vUv + vec2(-t.x, t.y));
  float bc = lumaAt(vUv + vec2(0.0, t.y));
  float br = lumaAt(vUv + vec2(t.x, t.y));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  float g = length(vec2(gx, gy));
  float edge = smoothstep(uP[0], max(uP[0] + 0.001, uP[1]), g);
  // negate: dark lines on white, the "Take On Me" look of the preset.
  outColor = store(vec3(1.0 - edge), c.a);
}`,
    ffmpeg: (p) => `edgedetect=low=${num(p.low)}:high=${num(p.high)},negate`,
  },

  // ------------------------------------------------------------------ boxblur
  blur: {
    type: 'blur',
    label: 'Gaussian blur',
    params: [
      { name: 'radius', label: 'Radius', min: 0, max: 40, step: 0.5, defaultValue: 8, format: pixels },
    ],
    // Separable: two 1-D passes cost a fraction of one 2-D kernel and look the same.
    passes: 2,
    frag: `
void main() {
  float r = uP[0];
  if (r <= 0.0) { outColor = texture(uTex, vUv); return; }
  vec2 dir = uPass < 0.5 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);

  // The tap count follows the radius. A fixed count would spread the taps several
  // texels apart at large radii, which leaves the detail *between* the taps untouched:
  // the picture stops getting blurrier however far the slider goes.
  int n = int(clamp(ceil(r * 0.8), 1.0, 20.0));
  float spacing = r / float(n);
  float sigma = max(0.5, r * 0.5);
  vec2 stepUv = dir * uTexel * spacing;

  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -20; i <= 20; i++) {
    if (i < -n || i > n) continue;
    float offset = float(i) * spacing;
    float w = exp(-(offset * offset) / (2.0 * sigma * sigma));
    // Averaging premultiplied values directly is correct for a weighted mean.
    sum += texture(uTex, vUv + stepUv * float(i)) * w;
    wsum += w;
  }
  outColor = sum / wsum;
}`,
    ffmpeg: (p, layer) => {
      // boxblur rejects a radius at or above half the smaller dimension.
      const limit = Math.max(1, Math.floor(Math.min(layer.width, layer.height) / 2) - 1);
      return `boxblur=${num(Math.min(limit, Math.max(0, p.radius / 2)))}:1`;
    },
  },

  // ------------------------------------------------------------ hflip / vflip
  flip: {
    type: 'flip',
    label: 'Flip',
    // Folded into the draw call's source rectangle: no pass, no cost, and a
    // picture-in-picture keeps its position instead of jumping to the mirrored one.
    geometric: true,
    params: [
      {
        name: 'horizontal',
        label: 'Horizontal',
        min: 0,
        max: 1,
        step: 1,
        defaultValue: 1,
        control: 'toggle',
      },
      {
        name: 'vertical',
        label: 'Vertical',
        min: 0,
        max: 1,
        step: 1,
        defaultValue: 0,
        control: 'toggle',
      },
    ],
    ffmpeg: (p) =>
      [p.horizontal > 0.5 ? 'hflip' : '', p.vertical > 0.5 ? 'vflip' : '']
        .filter(Boolean)
        .join(','),
  },

  // ------------------------------------------------------------------ drawbox
  fill: {
    type: 'fill',
    label: 'Solid fill',
    note: 'On its own it covers the frame. Its point is with a region: the black box over a licence plate.',
    params: [
      { name: 'level', label: 'Brightness', min: 0, max: 1, step: 0.01, defaultValue: 0 },
      {
        name: 'opacity',
        label: 'Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 1,
        format: percent,
      },
    ],
    frag: `
void main() {
  vec4 c = fetch(vUv);
  outColor = store(mix(c.rgb, vec3(uP[0]), uP[1]), c.a);
}`,
    ffmpeg: (p, layer) => {
      const grey = Math.round(Math.min(1, Math.max(0, p.level)) * 255)
        .toString(16)
        .padStart(2, '0');
      return (
        `drawbox=x=0:y=0:w=${layer.width}:h=${layer.height}:` +
        `color=0x${grey}${grey}${grey}@${num(p.opacity)}:t=fill`
      );
    },
  },

  // ------------------------------------------------------------- colorbalance
  colorBalance: {
    type: 'colorBalance',
    label: 'Colour balance',
    params: [
      { name: 'r', label: 'Red', min: -0.5, max: 0.5, step: 0.01, defaultValue: 0 },
      { name: 'g', label: 'Green', min: -0.5, max: 0.5, step: 0.01, defaultValue: 0 },
      { name: 'b', label: 'Blue', min: -0.5, max: 0.5, step: 0.01, defaultValue: 0 },
    ],
    frag: `
void main() {
  vec4 c = fetch(vUv);
  outColor = store(c.rgb + vec3(uP[0], uP[1], uP[2]), c.a);
}`,
    ffmpeg: (p) => `colorbalance=rm=${num(p.r)}:gm=${num(p.g)}:bm=${num(p.b)}`,
  },
};

/**
 * Masked regions.
 *
 * A region is stored as ordinary numeric parameters on the effect rather than as its own
 * structure. That is not a shortcut: it means a region animates through the phase 10
 * keyframe engine, shows up on the same timeline strip, splits with the clip and undoes
 * one step at a time — all without a second implementation of any of it.
 */
export const REGION_MODE = 'region.mode';
export const REGION_FEATHER = 'region.feather';
export const REGION_INVERT = 'region.invert';
/** Animatable channels: position and size. */
export const REGION_CHANNELS = ['region.x', 'region.y', 'region.w', 'region.h'] as const;

export interface ResolvedRegion {
  /** 1 = rectangle, 2 = ellipse. */
  shape: 1 | 2;
  rect: { x: number; y: number; w: number; h: number };
  /** Fraction of the shorter frame edge. */
  feather: number;
  invert: boolean;
}

export const DEFAULT_REGION: Record<string, number> = {
  [REGION_MODE]: 1,
  'region.x': 0.35,
  'region.y': 0.35,
  'region.w': 0.3,
  'region.h': 0.3,
  [REGION_FEATHER]: 0.02,
  [REGION_INVERT]: 0,
};

/** The region an effect should be masked to, or null for the whole frame. */
export function regionOf(params: Record<string, number>): ResolvedRegion | null {
  const mode = params[REGION_MODE] ?? 0;
  if (mode < 0.5) return null;
  return {
    shape: mode >= 1.5 ? 2 : 1,
    rect: {
      x: params['region.x'] ?? 0,
      y: params['region.y'] ?? 0,
      w: Math.max(0.001, params['region.w'] ?? 1),
      h: Math.max(0.001, params['region.h'] ?? 1),
    },
    feather: Math.max(0, params[REGION_FEATHER] ?? 0),
    invert: (params[REGION_INVERT] ?? 0) > 0.5,
  };
}

/** The built-in descriptor for a type, or null for a custom shader. */
export function builtin(type: EffectType): EffectDescriptor | null {
  return type === 'custom' ? null : (EFFECTS[type] ?? null);
}

/**
 * Everything about one effect *instance*.
 *
 * For a built-in this is the registry entry; for a custom shader it is built from the
 * pasted source. Callers that only need to know what an effect looks like — the Inspector,
 * the keyframe strip, the fallback exporter — go through here and never learn which it is.
 */
export function descriptorFor(effect: EffectInstance): EffectDescriptor | null {
  if (effect.type !== 'custom') return EFFECTS[effect.type] ?? null;
  return effect.shader ? customDescriptor(effect.shader) : null;
}

/** Geometric effects reposition the whole layer, so masking them means nothing. */
export function supportsRegion(type: EffectType): boolean {
  return !builtin(type)?.geometric;
}

export const EFFECT_ORDER: BuiltinEffectType[] = [
  'eq',
  'cinematic',
  'blackWhite',
  'colorBalance',
  'sharpen',
  'blur',
  'denoise',
  'pixelate',
  'edgeDetect',
  'fill',
  'flip',
];

export function defaultParams(type: BuiltinEffectType): Record<string, number> {
  return paramDefaults(EFFECTS[type].params);
}

export function paramDefaults(params: EffectParam[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of params) out[p.name] = p.defaultValue;
  return out;
}

/** The defaults for one instance — the custom-shader-aware counterpart of `defaultParams`. */
export function defaultParamsFor(effect: EffectInstance): Record<string, number> {
  const desc = descriptorFor(effect);
  return desc ? paramDefaults(desc.params) : {};
}

/** Source-rectangle mirroring requested by geometric effects. */
export function flipFromEffects(effects: EffectInstance[]): { x: boolean; y: boolean } {
  let x = false;
  let y = false;
  for (const e of effects) {
    if (e.type !== 'flip') continue;
    if ((e.params.horizontal ?? 0) > 0.5) x = !x;
    if ((e.params.vertical ?? 0) > 0.5) y = !y;
  }
  return { x, y };
}

/** Effects that need a full-frame pass, in order. */
export function shaderEffects(effects: EffectInstance[]): EffectInstance[] {
  return effects.filter((e) => {
    const desc = descriptorFor(e);
    return desc !== null && !desc.geometric;
  });
}

/**
 * Filter chain for the FFmpeg fallback, plus the effects it could not express.
 * Callers surface `unsupported` to the user instead of exporting a silently wrong file.
 */
/**
 * One step of the fallback graph: given an input and output label, produce the filter
 * lines that get from one to the other. A masked effect needs `split` and `overlay`,
 * which cannot live inside a comma-joined chain, so every step is a labelled segment.
 */
export type GraphSegment = (inLabel: string, outLabel: string, tag: string) => string;

export function ffmpegChain(
  effects: EffectInstance[],
  layer: LayerSize,
): { segments: GraphSegment[]; unsupported: string[] } {
  const segments: GraphSegment[] = [];
  const unsupported: string[] = [];

  for (const effect of effects) {
    const desc = descriptorFor(effect);
    if (!desc) continue;
    if (!desc.ffmpeg) {
      unsupported.push(desc.label);
      continue;
    }

    const region = regionOf(effect.params);
    if (region) {
      const masked = ffmpegRegionSegment(desc, effect.params, region, layer);
      if (!masked) {
        unsupported.push(`the ${desc.label.toLowerCase()} region`);
        continue;
      }
      segments.push(masked);
      // The crop is a hard rectangle; say what got lost rather than shipping a
      // silently different picture.
      if (region.feather > 0.001) unsupported.push('a region’s soft edge');
      if (region.shape === 2) unsupported.push('an elliptical region (a rectangle is used)');
      continue;
    }

    const filter = desc.ffmpeg(effect.params, layer);
    if (filter) segments.push((i, o) => `[${i}]${filter}[${o}]`);
  }
  return { segments, unsupported };
}

/**
 * A masked effect for the fallback: cut the region out, filter it, and paste it back.
 *
 * `crop`/`overlay` take integer geometry per filter graph, so this is the region's pose
 * at the moment the caller resolved it — the caller freezes an animated region and warns.
 * Feathering and ellipses have no cheap equivalent here, so the fallback draws a hard
 * rectangle and says so.
 */
function ffmpegRegionSegment(
  desc: EffectDescriptor,
  params: Record<string, number>,
  region: ResolvedRegion,
  layer: LayerSize,
): GraphSegment | null {
  if (!desc.ffmpeg) return null;
  // Inverted regions would need the complement of the crop, which `crop` cannot express.
  if (region.invert) return null;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const w = even(Math.min(layer.width, region.rect.w * layer.width));
  const h = even(Math.min(layer.height, region.rect.h * layer.height));
  const x = even(Math.min(layer.width - w, Math.max(0, region.rect.x * layer.width)));
  const y = even(Math.min(layer.height - h, Math.max(0, region.rect.y * layer.height)));

  const inner = desc.ffmpeg(params, { width: w, height: h });
  if (!inner) return null;

  // `split` keeps the untouched layer; the cropped copy is filtered and overlaid back.
  return (i, o, tag) =>
    `[${i}]split[k${tag}][c${tag}];` +
    `[c${tag}]crop=${w}:${h}:${x}:${y},${inner}[f${tag}];` +
    `[k${tag}][f${tag}]overlay=${x}:${y}[${o}]`;
}
