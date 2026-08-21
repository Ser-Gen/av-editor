import type { EffectDescriptor, EffectParam } from './types';
import { MAX_EFFECT_PARAMS } from './types';

/**
 * User-supplied fragment shaders.
 *
 * A Shadertoy shader pastes in unedited: the prelude below supplies `iResolution`,
 * `iTime`, `iChannelN` and the rest, and a wrapper calls `mainImage`. What a shader
 * *cannot* express on its own is everything around it — which of its constants are worth
 * a slider, which of its `#define`s are worth a dropdown, what its extra channels hold,
 * and where its stages begin. Those come from annotation comments, which are ordinary
 * comments to any other GLSL compiler, so an annotated shader still runs on Shadertoy.
 *
 *   // @name   VHS glitch
 *   // @param  noiseSpeed 0.5 8 2 Noise speed     → a slider, and `noiseSpeed` in the body
 *   // @define VIDEO_STANDARD NTSC PAL            → a dropdown; replaces the source's own line
 *   // @toggle SUBDIVIDE on                       → a checkbox
 *   // @scale  0.5                                → default render scale for a costly shader
 *   // @stage  bufferA                            → starts a stage; the last one is the output
 *   // @channel1 bayer8 repeat nearest            → what iChannel1 holds, and how it is sampled
 *
 * Parameters become ordinary numeric effect params, which is the whole reason "define your
 * own shader" and "animate its parameters" are one feature: they keyframe, split, undo and
 * render through the machinery that was already there.
 *
 * One deliberate limit: no stage may sample its own previous frame. Every stage is a pure
 * function of the current input and the current time, so scrubbing to t=10 gives the same
 * pixels as playing to t=10, in the preview and in the export alike.
 */

export type PatternName = 'bayer8' | 'noise' | 'grey';

export type ChannelSource =
  | { kind: 'input' }
  | { kind: 'stage'; stage: string }
  | { kind: 'pattern'; pattern: PatternName };

export interface ChannelBinding {
  index: number;
  source: ChannelSource;
  /**
   * Shadertoy exposes both, and a shader can depend on either: the ordered-dither shader
   * tiles an 8×8 threshold texture across the frame, so `clamp`/`linear` — this
   * compositor's defaults for every other texture — would stretch one texel over the
   * whole picture and produce a flat grey instead of a dither.
   */
  wrap: 'clamp' | 'repeat';
  filter: 'linear' | 'nearest';
}

interface DefineSpec {
  name: string;
  /** Choices for a dropdown; null for an on/off `#define`. */
  values: string[] | null;
  defaultIndex: number;
}

interface ParsedStage {
  name: string;
  body: string;
  channels: ChannelBinding[];
}

export interface ParsedShader {
  name: string;
  /** Shared by every stage: helpers a later stage still needs. */
  preamble: string;
  stages: ParsedStage[];
  /** Annotated uniform parameters, in `uP` slot order. */
  params: EffectParam[];
  defines: DefineSpec[];
  defaultScale: number;
  usesMouse: boolean;
  /** Things the author should know about the annotations, shown in the editor. */
  problems: string[];
  /** Built variants, keyed by the compile-time choices that produced them. */
  built: Map<string, BuiltShader>;
}

export interface BuiltStage {
  name: string;
  /** A complete, compilable fragment shader. */
  source: string;
  /** Cache key for the linked program. */
  key: string;
  channels: ChannelBinding[];
}

export interface BuiltShader {
  stages: BuiltStage[];
}

/** Param name for a compile-time switch; kept numeric so it stores like any other. */
export function defineParamName(name: string): string {
  return `define.${name}`;
}

export const SCALE_PARAM = 'render.scale';
export const MOUSE_X_PARAM = 'mouse.x';
export const MOUSE_Y_PARAM = 'mouse.y';

const DIRECTIVE = /^\s*\/\/\s*@(\w+)\s*(.*)$/;
const PATTERNS: PatternName[] = ['bayer8', 'noise', 'grey'];

const SCALE_OPTIONS = [
  { value: 1, label: 'Full' },
  { value: 0.5, label: 'Half' },
  { value: 0.25, label: 'Quarter' },
];

/**
 * The Shadertoy compatibility prelude.
 *
 * `iFrame` is an `int` and is not optional: the extruded-video shader writes
 * `for (int i = min(iFrame, 0); ...)` precisely so the compiler cannot prove the loop
 * bound and unroll a 64-step raymarch. `iResolution` is a `vec3` for the same reason —
 * shaders write `vec2(iResolution)`, which does not compile against a `vec2`.
 */
const CUSTOM_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int iFrame;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform vec3 iChannelResolution[4];
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform float uP[${MAX_EFFECT_PARAMS}];
`;

/**
 * `fragCoord` has its origin at the bottom left, as on Shadertoy.
 *
 * That costs nothing here. Layers store the picture bottom-up, and every effect pass
 * already draws with the source rectangle that maps a texel to the destination texel of
 * the same coordinate — so `vUv` arrives with its origin at the bottom left, and scaling
 * it by the resolution is the whole conversion.
 */
const CUSTOM_MAIN = `
void main() {
  vec4 fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(fragColor, vUv * iResolution.xy);
  outColor = fragColor;
}
`;

const parseCache = new Map<string, ParsedShader>();

/** Parsed form of a shader source. Memoised: the source is re-read on every frame. */
export function parseShader(source: string): ParsedShader {
  const cached = parseCache.get(source);
  if (cached) return cached;
  const parsed = parseUncached(source);
  // A project cannot hold many distinct shader sources, but an editor typing into the
  // shader box produces one entry per keystroke; cap it rather than grow forever.
  if (parseCache.size > 64) parseCache.clear();
  parseCache.set(source, parsed);
  return parsed;
}

function parseUncached(source: string): ParsedShader {
  const problems: string[] = [];
  const params: EffectParam[] = [];
  const defines: DefineSpec[] = [];
  let name = 'Custom shader';
  let defaultScale = 1;

  const inherited: ChannelBinding[] = [];
  const stages: ParsedStage[] = [];
  let preambleLines: string[] = [];
  let current: { name: string; lines: string[]; channels: ChannelBinding[] } | null = null;

  for (const raw of source.split('\n')) {
    const match = DIRECTIVE.exec(raw);
    if (!match) {
      // `#version` belongs to the prelude; a pasted one would land mid-file and fail.
      if (/^\s*#version\b/.test(raw)) continue;
      if (current) current.lines.push(raw);
      else preambleLines.push(raw);
      continue;
    }

    const [, keyword, rest] = match;
    const args = rest.trim().split(/\s+/).filter(Boolean);

    switch (keyword.toLowerCase()) {
      case 'name':
        if (rest.trim()) name = rest.trim();
        break;

      case 'param': {
        const param = parseParam(args, problems);
        if (param) params.push(param);
        break;
      }

      case 'define': {
        if (args.length < 2) {
          problems.push(`@define needs a name and at least one value: "${rest.trim()}"`);
          break;
        }
        defines.push({ name: args[0], values: args.slice(1), defaultIndex: 0 });
        break;
      }

      case 'toggle': {
        if (args.length < 1) {
          problems.push('@toggle needs a name');
          break;
        }
        const on = (args[1] ?? 'off').toLowerCase();
        defines.push({ name: args[0], values: null, defaultIndex: on === 'on' || on === '1' ? 1 : 0 });
        break;
      }

      case 'scale': {
        const value = Number(args[0]);
        if (SCALE_OPTIONS.some((o) => o.value === value)) defaultScale = value;
        else problems.push(`@scale must be one of 1, 0.5, 0.25 — got "${args[0] ?? ''}"`);
        break;
      }

      case 'stage': {
        if (current) stages.push({ name: current.name, body: current.lines.join('\n'), channels: current.channels });
        current = { name: args[0] ?? `stage${stages.length + 1}`, lines: [], channels: [] };
        break;
      }

      default: {
        const channel = /^channel([0-3])$/i.exec(keyword);
        if (channel) {
          const binding = parseChannel(Number(channel[1]), args, problems);
          if (binding) (current ? current.channels : inherited).push(binding);
          break;
        }
        problems.push(`Unknown directive @${keyword}`);
      }
    }
  }

  if (current) {
    stages.push({ name: current.name, body: current.lines.join('\n'), channels: current.channels });
  } else {
    // No @stage at all: the whole file is one Image stage, which is the common case.
    stages.push({ name: 'image', body: preambleLines.join('\n'), channels: [] });
    preambleLines = [];
  }

  const names = new Set<string>();
  for (const stage of stages) {
    if (names.has(stage.name)) problems.push(`Two stages are called "${stage.name}"`);
    names.add(stage.name);
  }

  // Channels are resolved once every stage name is known, so `@channel1 bufferA` can
  // name a stage declared further down the file.
  for (const [index, stage] of stages.entries()) {
    const merged = new Map<number, ChannelBinding>();
    for (const binding of [...inherited, ...stage.channels]) merged.set(binding.index, binding);
    if (!merged.has(0)) merged.set(0, { index: 0, source: { kind: 'input' }, wrap: 'clamp', filter: 'linear' });
    stage.channels = [...merged.values()].map((binding) =>
      resolveChannel(binding, stages, index, problems),
    );
  }

  if (params.length > MAX_EFFECT_PARAMS) {
    problems.push(
      `Only ${MAX_EFFECT_PARAMS} parameters fit; the ones after "${params[MAX_EFFECT_PARAMS - 1].label}" are ignored.`,
    );
    params.length = MAX_EFFECT_PARAMS;
  }

  const body = preambleLines.join('\n') + stages.map((s) => s.body).join('\n');
  if (!/\bmainImage\s*\(/.test(body)) {
    problems.push('No mainImage() found — a Shadertoy shader defines one per stage.');
  }

  return {
    name,
    preamble: preambleLines.join('\n'),
    stages,
    params,
    defines,
    defaultScale,
    // Tested against the source with its comments removed: the extruded-video shader
    // leaves a commented-out mouse block in place, and two sliders that drive nothing
    // would be worse than none.
    usesMouse: /\biMouse\b/.test(stripComments(source)),
    problems,
    built: new Map(),
  };
}

function parseParam(args: string[], problems: string[]): EffectParam | null {
  const [name, minRaw, maxRaw, defRaw, ...label] = args;
  if (!name || !/^[A-Za-z_]\w*$/.test(name)) {
    problems.push(`@param needs a GLSL identifier, got "${name ?? ''}"`);
    return null;
  }
  const min = Number(minRaw);
  const max = Number(maxRaw);
  const defaultValue = defRaw === undefined ? min : Number(defRaw);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(defaultValue) || max <= min) {
    problems.push(`@param ${name} needs "min max default" with max > min`);
    return null;
  }
  return {
    name,
    label: label.length > 0 ? label.join(' ') : name,
    min,
    max,
    step: niceStep(min, max),
    defaultValue: Math.min(max, Math.max(min, defaultValue)),
  };
}

/** A hundred steps across the range, rounded to something a slider reads nicely. */
function niceStep(min: number, max: number): number {
  const rough = (max - min) / 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const snapped = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return Number((snapped * magnitude).toPrecision(4));
}

function parseChannel(index: number, args: string[], problems: string[]): ChannelBinding | null {
  const token = args[0];
  if (!token) {
    problems.push(`@channel${index} needs a source`);
    return null;
  }
  let wrap: ChannelBinding['wrap'] = 'clamp';
  let filter: ChannelBinding['filter'] = 'linear';
  for (const modifier of args.slice(1)) {
    const lower = modifier.toLowerCase();
    if (lower === 'repeat' || lower === 'clamp') wrap = lower;
    else if (lower === 'nearest' || lower === 'linear') filter = lower;
    else problems.push(`@channel${index}: unknown option "${modifier}"`);
  }
  // Resolved against the stage list once parsing finishes.
  return { index, source: { kind: 'stage', stage: token }, wrap, filter };
}

function resolveChannel(
  binding: ChannelBinding,
  stages: ParsedStage[],
  stageIndex: number,
  problems: string[],
): ChannelBinding {
  if (binding.source.kind !== 'stage') return binding;
  const token = binding.source.stage;
  const bare = token.replace(/^stage:/i, '');

  if (bare.toLowerCase() === 'input') return { ...binding, source: { kind: 'input' } };
  if ((PATTERNS as string[]).includes(bare.toLowerCase())) {
    return { ...binding, source: { kind: 'pattern', pattern: bare.toLowerCase() as PatternName } };
  }

  const target = stages.findIndex((s) => s.name === bare);
  if (target < 0) {
    problems.push(`@channel${binding.index}: nothing called "${bare}" — expected input, a stage name, or a pattern`);
    return { ...binding, source: { kind: 'input' } };
  }
  if (target >= stageIndex) {
    // The one rule that keeps scrubbing honest: a stage may only read what an earlier
    // stage produced *this* frame. Reading itself would make the picture depend on how
    // the playhead got here.
    problems.push(
      `@channel${binding.index}: stage "${stages[stageIndex].name}" cannot read "${bare}" — a stage may only sample an earlier one.`,
    );
    return { ...binding, source: { kind: 'input' } };
  }
  return { ...binding, source: { kind: 'stage', stage: bare } };
}

/** Every control the Inspector shows, in `uP` slot order followed by the fixed ones. */
export function shaderControls(parsed: ParsedShader): EffectParam[] {
  const controls: EffectParam[] = [...parsed.params];

  for (const define of parsed.defines) {
    controls.push(
      define.values
        ? {
            name: defineParamName(define.name),
            label: define.name,
            min: 0,
            max: define.values.length - 1,
            step: 1,
            defaultValue: define.defaultIndex,
            control: 'select',
            options: define.values.map((value, index) => ({ value: index, label: value })),
            fixed: true,
          }
        : {
            name: defineParamName(define.name),
            label: define.name,
            min: 0,
            max: 1,
            step: 1,
            defaultValue: define.defaultIndex,
            control: 'toggle',
            fixed: true,
          },
    );
  }

  if (parsed.usesMouse) {
    // Shadertoy's cursor is a live input; an effect has no cursor, so it becomes two
    // ordinary parameters — which is better than a cursor, because they keyframe.
    controls.push(mouseParam(MOUSE_X_PARAM, 'Mouse X'));
    controls.push(mouseParam(MOUSE_Y_PARAM, 'Mouse Y'));
  }

  controls.push({
    name: SCALE_PARAM,
    label: 'Render scale',
    min: 0.25,
    max: 1,
    step: 0.25,
    defaultValue: parsed.defaultScale,
    control: 'select',
    options: SCALE_OPTIONS,
    fixed: true,
  });

  return controls;
}

function mouseParam(name: string, label: string): EffectParam {
  return { name, label, min: 0, max: 1, step: 0.001, defaultValue: 0.5, format: (v) => `${Math.round(v * 100)}%` };
}

/** The descriptor a custom effect presents to the rest of the app. */
export function customDescriptor(source: string): EffectDescriptor {
  const parsed = parseShader(source);
  return {
    type: 'custom',
    label: parsed.name,
    params: shaderControls(parsed),
    // No filter equivalent exists, so the fallback export warns and names the clip
    // rather than quietly writing a file without the effect.
    ffmpeg: null,
  };
}

/**
 * Compilable sources for the current compile-time choices.
 *
 * Cached per set of `#define` values: changing a dropdown recompiles, changing a slider
 * does not, which is the difference the Inspector has to make visible.
 */
export function buildShader(parsed: ParsedShader, params: Record<string, number>): BuiltShader {
  const signature = parsed.defines
    .map((d) => `${d.name}=${Math.round(params[defineParamName(d.name)] ?? d.defaultIndex)}`)
    .join(';');
  const cached = parsed.built.get(signature);
  if (cached) return cached;

  const lines: string[] = [];
  parsed.params.forEach((param, index) => {
    // Named in the body, packed in the shared array: the shader reads `strength`, the
    // renderer sets uP[2], and the keyframe engine never learns the difference.
    lines.push(`#define ${param.name} uP[${index}]`);
  });
  for (const define of parsed.defines) {
    const choice = Math.round(params[defineParamName(define.name)] ?? define.defaultIndex);
    if (define.values) {
      lines.push(`#define ${define.name} ${define.values[clampIndex(choice, define.values.length)]}`);
    } else if (choice > 0) {
      lines.push(`#define ${define.name} 1`);
    }
  }

  const names = parsed.defines.map((d) => d.name);
  // The source usually still carries the line the annotation replaces — redefining a
  // macro to a different body is a compile error, so the original goes.
  const preamble = stripDefines(parsed.preamble, names);
  const header = `${CUSTOM_PRELUDE}\n${lines.join('\n')}\n`;

  const built: BuiltShader = {
    stages: parsed.stages.map((stage) => {
      const source = `${header}\n${preamble}\n${stripDefines(stage.body, names)}\n${CUSTOM_MAIN}`;
      return { name: stage.name, source, key: `custom:${hash(source)}`, channels: stage.channels };
    }),
  };
  parsed.built.set(signature, built);
  return built;
}

function clampIndex(index: number, length: number): number {
  return Math.min(length - 1, Math.max(0, index));
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function stripDefines(text: string, names: string[]): string {
  if (names.length === 0) return text;
  const pattern = new RegExp(`^[ \\t]*#define[ \\t]+(${names.join('|')})\\b.*$`, 'gm');
  return text.replace(pattern, '');
}

/** cyrb53 — short, stable, and good enough to key a program cache with. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
