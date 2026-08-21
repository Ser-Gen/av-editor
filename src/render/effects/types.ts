/**
 * The vocabulary an effect is described in.
 *
 * Split out of the registry so the custom-shader parser can build descriptors of its own
 * without the two modules importing each other in a circle: a pasted shader produces
 * exactly the same `EffectDescriptor` shape a built-in effect is written as, which is why
 * the Inspector, the keyframe strip and the exporter need no idea the two are different.
 */

export const MAX_EFFECT_PARAMS = 8;

export interface EffectParam {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /** Toggles are stored as 0 / 1; selects as the option's value. */
  control?: 'slider' | 'toggle' | 'select';
  /** Choices for a `select`. */
  options?: { value: number; label: string }[];
  /**
   * True for controls that change the program rather than a uniform — a compile-time
   * `#define`, or the render scale that resizes the buffers. They take effect between
   * frames, not within one, so they cannot be keyframed and the UI hides the stopwatch.
   */
  fixed?: boolean;
  /** Label for the current value; defaults to the raw number. */
  format?: (v: number) => string;
}

export interface EffectDescriptor {
  /** Effect type, or `custom` for a user-supplied shader. */
  type: string;
  label: string;
  /** Shown under the effect header — used to be honest about approximations. */
  note?: string;
  params: EffectParam[];
  /**
   * Geometric effects change *where* pixels are sampled, not their colour, so they are
   * folded into the draw call instead of costing a full-frame pass.
   */
  geometric?: boolean;
  /** Fragment shader body. Absent for geometric effects and for custom shaders. */
  frag?: string;
  /** Full-frame passes; the shader gets `uPass` as the 0-based index. */
  passes?: number;
  /**
   * FFmpeg filter for the fallback export, given the layer's pixel size. `null` means
   * there is no equivalent and the fallback must warn; `''` means this particular
   * configuration is a no-op.
   */
  ffmpeg: ((p: Record<string, number>, layer: LayerSize) => string) | null;
}

/**
 * The clock a custom shader sees.
 *
 * Timeline-derived, never wall-clock: `iTime` at a given playhead position has to be the
 * same number in the preview and in the export, or the first exported frame of an
 * animated shader would not be the frame that was on screen.
 */
export interface EffectClock {
  /** Seconds since the effect's owner began — clip-relative for a clip, timeline for a grade. */
  time: number;
  /** Whole frames since the same origin. */
  frame: number;
  fps: number;
}

/** Size in pixels of the layer an FFmpeg filter chain will run on. */
export interface LayerSize {
  width: number;
  height: number;
}

/** Shared prelude prepended to every built-in effect shader. */
export const EFFECT_PRELUDE = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uResolution;  // layer size in pixels
uniform vec2 uTexel;       // 1.0 / uResolution
uniform float uPass;       // 0-based pass index
uniform float uP[${MAX_EFFECT_PARAMS}];
out vec4 outColor;

// The layer is premultiplied. Colour maths has to run unpremultiplied or the operation
// leaks into soft alpha edges — invisible on video, obvious on text.
vec4 fetch(vec2 uv) {
  vec4 c = texture(uTex, uv);
  return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}
vec4 store(vec3 rgb, float a) { return vec4(clamp(rgb, 0.0, 1.0) * a, a); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

/** Params in descriptor order, padded to the shader's fixed-size array. */
export function packParams(
  params: EffectParam[],
  values: Record<string, number>,
): Float32Array {
  const out = new Float32Array(MAX_EFFECT_PARAMS);
  params.forEach((p, i) => {
    if (i >= MAX_EFFECT_PARAMS) return;
    const v = values[p.name];
    out[i] = Number.isFinite(v) ? v : p.defaultValue;
  });
  return out;
}
