import type {
  EffectInstance,
  EffectType,
  NormalizedRect,
  OverlayTransform,
  TextClip,
} from '../types/editor';
import { clampRect, normalizeOverlayTransform, textFrameForClip } from '../utils/overlayTransform';
import { drawTextClip as paintTextClip } from '../preview/textRenderer';
import type { ResolvedRegion } from './effects/registry';
import {
  EFFECTS,
  EFFECT_PRELUDE,
  descriptorFor,
  flipFromEffects,
  packParams,
  regionOf,
  shaderEffects,
} from './effects/registry';
import type { EffectClock } from './effects/types';
import type { BuiltStage, ChannelBinding, PatternName } from './effects/customShader';
import {
  MOUSE_X_PARAM,
  MOUSE_Y_PARAM,
  SCALE_PARAM,
  buildShader,
  parseShader,
} from './effects/customShader';
import { disableShader, isShaderDisabled, recordShaderTime } from './effects/shaderStats';
import {
  BLIT_FRAG,
  CUSTOM_INPUT_FRAG,
  CUSTOM_RESOLVE_FRAG,
  MASK_FRAG,
  QUAD_VERT,
} from './shaders';

/**
 * Forces the Canvas2D fallback. Set from `?renderer=2d`, and switchable at runtime so
 * the two renderers can be compared frame-for-frame in one session.
 */
let forced2D =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('renderer') === '2d';

export type { EffectClock } from './effects/types';

export function setForceCanvas2D(force: boolean): void {
  forced2D = force;
}

export function isCanvas2DForced(): boolean {
  return forced2D;
}

interface TexEntry {
  texture: WebGLTexture;
  /** Allocated storage size, so unchanged sources can use texSubImage2D. */
  width: number;
  height: number;
  /** Cache key of the content currently uploaded; undefined for per-frame sources. */
  contentKey?: string;
}

/** A linked program with its uniform locations resolved once. */
interface ProgramEntry {
  program: WebGLProgram;
  uDest: WebGLUniformLocation | null;
  uSrc: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uAlpha: WebGLUniformLocation | null;
  uTexel: WebGLUniformLocation | null;
  uPass: WebGLUniformLocation | null;
  uParams: WebGLUniformLocation | null;
  /** Mask and custom-resolve passes: the second sampler, bound to unit 1. */
  uOriginal: WebGLUniformLocation | null;
  uMaskRect: WebGLUniformLocation | null;
  uMaskShape: WebGLUniformLocation | null;
  uMaskFeather: WebGLUniformLocation | null;
  uMaskInvert: WebGLUniformLocation | null;
  /** Shadertoy compatibility uniforms; all null for a built-in effect. */
  iResolution: WebGLUniformLocation | null;
  iTime: WebGLUniformLocation | null;
  iTimeDelta: WebGLUniformLocation | null;
  iFrameRate: WebGLUniformLocation | null;
  iFrame: WebGLUniformLocation | null;
  iMouse: WebGLUniformLocation | null;
  iDate: WebGLUniformLocation | null;
  iChannelResolution: WebGLUniformLocation | null;
  iChannel: (WebGLUniformLocation | null)[];
}

const ZERO_CLOCK: EffectClock = { time: 0, frame: 0, fps: 30 };

/**
 * The source rectangle every custom pass draws with — and, despite how it reads, the
 * *identity* one.
 *
 * The vertex shader takes its destination in y-down pixels, so the quad's first corner
 * lands at the top of the frame, which is the last row of framebuffer storage. Flipping v
 * here cancels that, mapping each source texel to the destination texel with the same
 * coordinate. Every effect pass in the compositor uses it for that reason.
 *
 * What it buys the custom path is a second thing for free. Layers store the picture
 * bottom-up — a clip drawn at the top of the frame lands at v = 1 — so this identity
 * coordinate already has its origin at the bottom left, which is where Shadertoy puts
 * `fragCoord`. `fragCoord = vUv * iResolution` therefore needs no correction anywhere.
 */
const SHADERTOY_UV: NormalizedRect = { x: 0, y: 1, w: 1, h: -1 };

/** One custom effect, resolved and ready to draw. */
interface PreparedCustom {
  stages: BuiltStage[];
  /** Linked programs, one per stage, in the same order. */
  programs: ProgramEntry[];
  params: Float32Array;
  /** Stage buffer size — the frame size scaled by the effect's render scale. */
  width: number;
  height: number;
  mouse: { x: number; y: number };
}

/** A framebuffer kept between frames for one stage of one custom effect. */
interface StageTarget {
  target: RenderTarget;
  width: number;
  height: number;
  /** Frame counter at last use, so abandoned stages can be swept. */
  used: number;
}

interface RenderTarget {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/** Horizontal reveal band for a wipe transition, in 0–1 of the frame width. */
export interface WipeBand {
  x: number;
  w: number;
}

/** Mirror flags folded into a draw call's source rectangle. */
export interface SourceFlip {
  x: boolean;
  y: boolean;
}

function mirrorRect(rect: NormalizedRect, flip: SourceFlip | undefined): NormalizedRect {
  if (!flip || (!flip.x && !flip.y)) return rect;
  return {
    x: flip.x ? rect.x + rect.w : rect.x,
    y: flip.y ? rect.y + rect.h : rect.y,
    w: flip.x ? -rect.w : rect.w,
    h: flip.y ? -rect.h : rect.h,
  };
}

/**
 * WebGL2 compositor.
 *
 * Renders into an internal offscreen canvas rather than the visible one. That keeps
 * the Canvas2D fallback available on the visible canvas (a canvas can only ever have
 * one context type), makes `toBlob` capture work unchanged, and lets the export path
 * reuse the compositor without a DOM canvas of its own.
 *
 * Compositing goes into a scene framebuffer at project resolution and is blitted out
 * at the end of the frame — later phases run effect passes against that buffer.
 */
export class GLCompositor {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private blit: ProgramEntry | null = null;
  private maskProgram: ProgramEntry | null = null;
  /**
   * One program per shader, compiled on first use. `null` = failed to compile.
   *
   * Keyed by a string rather than by effect type because a custom effect's program
   * belongs to its *source*, not to its type: two clips with the same pasted shader share
   * one program, and editing one of them compiles a new one without disturbing the other.
   */
  private effectPrograms = new Map<string, ProgramEntry | null>();
  private customInput: ProgramEntry | null = null;
  private customResolve: ProgramEntry | null = null;
  /** Persistent buffers for custom stages, keyed by effect id and stage name. */
  private stageTargets = new Map<string, StageTarget>();
  private patterns = new Map<PatternName, TexEntry>();
  private samplers = new Map<string, WebGLSampler>();
  private frameCounter = 0;
  /** Set while a custom shader is on the GPU, so a context loss can name the culprit. */
  private runningCustom: string | null = null;
  private timerExt: unknown = null;
  private timerQueries: { query: WebGLQuery; effectId: string }[] = [];
  private timerBusy = false;
  private vao: WebGLVertexArrayObject | null = null;
  private textures = new Map<string, TexEntry>();
  private sceneTex: WebGLTexture | null = null;
  private sceneFbo: WebGLFramebuffer | null = null;
  private sceneW = 0;
  private sceneH = 0;
  /**
   * Effect-chain buffers: two for ping-ponging passes, and a third holding the layer as
   * it was before a masked effect ran, so the mask pass can mix the two.
   */
  private layers: [RenderTarget, RenderTarget, RenderTarget] | null = null;
  private layerW = 0;
  private layerH = 0;
  private layerIndex = 0;
  private inLayer = false;
  private width = 0;
  private height = 0;
  private contextLost = false;
  private textCanvas: HTMLCanvasElement | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.init();
    if (import.meta.env.DEV) {
      // Dev handle: the compositor canvas is offscreen, so this is the only way to
      // reach WEBGL_lose_context and exercise the recovery path.
      (window as unknown as { __glCanvas?: HTMLCanvasElement }).__glCanvas = this.canvas;
    }
  }

  /** False when WebGL2 is unavailable or the context is currently lost — caller falls back. */
  get available(): boolean {
    return !forced2D && this.gl !== null && !this.contextLost;
  }

  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      console.warn('[GL] WebGL2 unavailable — falling back to Canvas2D preview');
      return;
    }
    this.gl = gl;

    const blit = buildProgram(gl, BLIT_FRAG);
    if (!blit) {
      this.gl = null;
      return;
    }
    this.blit = blit;

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    // Every program shares QUAD_VERT, so `aPos` is at the same location in all of them
    // and one VAO serves the whole pipeline.
    const aPos = gl.getAttribLocation(blit.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;

    // No UNPACK_FLIP_Y: the default upload puts the source's top row at v=0, which is
    // exactly what the vertex shader's y-down UV maths expects. Flipping here would
    // invert every layer — invisible on symmetric footage, obvious on text.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private onContextLost = (e: Event): void => {
    // Default behaviour is to never fire `restored`; preventing it asks for recovery.
    e.preventDefault();
    this.contextLost = true;
    // A shader heavy enough to trip the GPU watchdog will trip it again on the next
    // frame; the only way out of that loop is to stop running it and say so.
    if (this.runningCustom) {
      disableShader(
        this.runningCustom,
        'The GPU dropped the context while this shader was running. It has been switched off — lower its render scale before turning it back on.',
      );
      this.runningCustom = null;
    }
    this.textures.clear();
    this.effectPrograms.clear();
    this.stageTargets.clear();
    this.patterns.clear();
    this.samplers.clear();
    this.timerQueries = [];
    this.timerBusy = false;
    this.timerExt = null;
    this.customInput = null;
    this.customResolve = null;
    this.maskProgram = null;
    this.sceneTex = null;
    this.sceneFbo = null;
    this.sceneW = 0;
    this.sceneH = 0;
    this.layers = null;
    this.layerW = 0;
    this.layerH = 0;
    this.inLayer = false;
    console.warn('[GL] context lost — preview falls back to Canvas2D until restored');
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    this.gl = null;
    this.init();
    console.info('[GL] context restored');
  };

  private ensureScene(width: number, height: number): boolean {
    const gl = this.gl;
    if (!gl) return false;
    if (this.sceneFbo && this.sceneW === width && this.sceneH === height) return true;

    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);

    const target = createTarget(gl, width, height);
    if (!target) {
      console.warn('[GL] scene framebuffer incomplete');
      this.gl = null;
      return false;
    }

    this.sceneTex = target.texture;
    this.sceneFbo = target.fbo;
    this.sceneW = width;
    this.sceneH = height;
    return true;
  }

  /**
   * Ping-pong buffers for the effect chain. Allocated on first use, so a project with
   * no effects never pays for them.
   */
  private ensureLayers(width: number, height: number): boolean {
    const gl = this.gl;
    if (!gl) return false;
    if (this.layers && this.layerW === width && this.layerH === height) return true;

    this.releaseLayers(gl);
    const a = createTarget(gl, width, height);
    const b = createTarget(gl, width, height);
    const c = createTarget(gl, width, height);
    if (!a || !b || !c) {
      console.warn('[GL] effect framebuffer incomplete — effects will not render');
      for (const target of [a, b, c]) if (target) deleteTarget(gl, target);
      return false;
    }
    this.layers = [a, b, c];
    this.layerW = width;
    this.layerH = height;
    return true;
  }

  private releaseLayers(gl: WebGL2RenderingContext): void {
    if (!this.layers) return;
    for (const target of this.layers) deleteTarget(gl, target);
    this.layers = null;
    this.layerW = 0;
    this.layerH = 0;
  }

  /** Compiled on first masked effect, so an unmasked project never links it. */
  private maskPass(): ProgramEntry | null {
    if (this.maskProgram) return this.maskProgram;
    const gl = this.gl;
    if (!gl) return null;
    const entry = buildProgram(gl, MASK_FRAG);
    if (entry) {
      gl.useProgram(entry.program);
      // The mask pass is the only one with two samplers; bind unit 1 once.
      if (entry.uOriginal) gl.uniform1i(entry.uOriginal, 1);
    }
    this.maskProgram = entry;
    return entry;
  }

  private effectProgram(type: EffectType): ProgramEntry | null {
    if (this.effectPrograms.has(type)) return this.effectPrograms.get(type) ?? null;
    const gl = this.gl;
    const frag = type === 'custom' ? undefined : EFFECTS[type]?.frag;
    if (!gl || !frag) {
      this.effectPrograms.set(type, null);
      return null;
    }
    const entry = buildProgram(gl, EFFECT_PRELUDE + frag);
    this.effectPrograms.set(type, entry);
    return entry;
  }

  /** A custom stage's program, cached by the hash of the source that produced it. */
  private stageProgram(stage: BuiltStage): ProgramEntry | null {
    if (this.effectPrograms.has(stage.key)) return this.effectPrograms.get(stage.key) ?? null;
    const gl = this.gl;
    if (!gl) return null;
    const entry = buildProgram(gl, stage.source);
    this.effectPrograms.set(stage.key, entry);
    return entry;
  }

  /** Clear to black and bind the scene buffer. Returns false if the caller must fall back. */
  beginFrame(width: number, height: number): boolean {
    const gl = this.gl;
    if (!gl || this.contextLost) return false;
    if (!this.ensureScene(width, height)) return false;

    this.width = width;
    this.height = height;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }

  /**
   * Redirect subsequent draws into an offscreen layer so an effect chain can run over
   * them. Returns false when the layer could not be allocated — the caller should draw
   * straight to the scene instead, unfiltered, rather than dropping the clip.
   */
  beginLayer(): boolean {
    const gl = this.gl;
    if (!gl || this.contextLost || this.inLayer) return false;
    if (!this.ensureLayers(this.width, this.height)) return false;

    this.layerIndex = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layers![0].fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.inLayer = true;
    return true;
  }

  /** Run the chain over the layer, composite the result into the scene, and close it. */
  endLayer(
    effects: EffectInstance[],
    alpha = 1,
    wipe?: WipeBand | null,
    clock: EffectClock = ZERO_CLOCK,
  ): void {
    const gl = this.gl;
    if (!gl || !this.inLayer || !this.layers) return;
    this.inLayer = false;

    const full: NormalizedRect = { x: 0, y: 0, w: this.width, h: this.height };
    // Framebuffer textures are bottom-up, so a v-flipped source rect makes each pass
    // orientation-preserving instead of mirroring the layer once per pass.
    const flipped: NormalizedRect = { x: 0, y: 1, w: 1, h: -1 };

    // Effect passes replace their target rather than blending into it.
    gl.disable(gl.BLEND);
    this.runChain(effects, full, flipped, clock);
    gl.enable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.width, this.height);
    this.beginWipe(wipe);
    this.drawQuad(this.layers[this.layerIndex].texture, full, flipped, alpha);
    this.endWipe(wipe);
  }

  /**
   * Runs an effect chain over the whole composited scene — a track's always-on grade, or
   * an adjustment clip's ranged one. Everything drawn so far is affected; everything
   * drawn afterwards is not, which is exactly what "affects the layers below" means.
   */
  applyToScene(effects: EffectInstance[], clock: EffectClock = ZERO_CLOCK): void {
    const gl = this.gl;
    if (!gl || this.contextLost || !this.sceneTex) return;
    if (shaderEffects(effects).length === 0) return;
    if (!this.ensureLayers(this.width, this.height)) return;

    const full: NormalizedRect = { x: 0, y: 0, w: this.width, h: this.height };
    const flipped: NormalizedRect = { x: 0, y: 1, w: 1, h: -1 };

    gl.disable(gl.BLEND);
    // Scene into the chain, chain back into the scene.
    this.layerIndex = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layers![0].fbo);
    gl.viewport(0, 0, this.width, this.height);
    this.drawQuad(this.sceneTex, full, flipped, 1);

    this.runChain(effects, full, flipped, clock);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.width, this.height);
    this.drawQuad(this.layers![this.layerIndex].texture, full, flipped, 1);
    gl.enable(gl.BLEND);
  }

  /** Ping-pongs the chain over the current layer. Assumes blending is already off. */
  private runChain(
    effects: EffectInstance[],
    full: NormalizedRect,
    flipped: NormalizedRect,
    clock: EffectClock,
  ): void {
    const gl = this.gl;
    if (!gl || !this.layers) return;
    for (const effect of shaderEffects(effects)) {
      const desc = descriptorFor(effect);
      if (!desc) continue;

      // Everything a custom effect needs is resolved before anything is drawn: a shader
      // that will not compile has to leave the picture exactly as it found it, not half
      // filtered.
      const custom = effect.type === 'custom' ? this.prepareCustom(effect) : null;
      if (effect.type === 'custom' && !custom) continue;

      const entry = custom ? null : this.effectProgram(effect.type);
      if (!custom && !entry) continue;

      const region = regionOf(effect.params);
      const mask = region ? this.maskPass() : null;

      // Keep the pre-effect layer aside so the mask pass can mix the two. A dedicated
      // third buffer is needed because a multi-pass effect overwrites both ping-pong
      // buffers before the mix happens.
      if (region && mask) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.layers[2].fbo);
        gl.viewport(0, 0, this.width, this.height);
        this.drawQuad(this.layers[this.layerIndex].texture, full, flipped, 1);
      }

      if (custom) {
        this.runCustom(effect, custom, clock);
      } else if (entry) {
        const params = packParams(desc.params, effect.params);
        const passes = desc.passes ?? 1;
        for (let pass = 0; pass < passes; pass++) {
          const source = this.layers[this.layerIndex];
          const target = this.layers[1 - this.layerIndex];
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
          gl.viewport(0, 0, this.width, this.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          this.drawQuad(source.texture, full, flipped, 1, entry, params, pass);
          this.layerIndex = 1 - this.layerIndex;
        }
      }

      if (region && mask) {
        const effected = this.layers[this.layerIndex];
        const target = this.layers[1 - this.layerIndex];
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.layers[2].texture);
        this.drawQuad(effected.texture, full, flipped, 1, mask, undefined, 0, region);
        this.layerIndex = 1 - this.layerIndex;
      }
    }
  }

  // -------------------------------------------------------------- custom shaders

  /**
   * Everything a custom effect needs, or null if it cannot run this frame.
   *
   * Returning null is the pass-through case: an uncompilable shader, or one the GPU
   * already died on. The picture goes through untouched rather than black, because a
   * black frame in the middle of a timeline reads as lost footage.
   */
  private prepareCustom(effect: EffectInstance): PreparedCustom | null {
    const gl = this.gl;
    if (!gl || !effect.shader || isShaderDisabled(effect.id)) return null;
    const parsed = parseShader(effect.shader);
    const built = buildShader(parsed, effect.params);
    if (built.stages.length === 0) return null;

    const programs: ProgramEntry[] = [];
    for (const stage of built.stages) {
      const program = this.stageProgram(stage);
      if (!program) return null;
      programs.push(program);
    }
    if (!this.customInput) this.customInput = buildProgram(gl, CUSTOM_INPUT_FRAG);
    if (!this.customResolve) {
      this.customResolve = buildProgram(gl, CUSTOM_RESOLVE_FRAG);
      // The resolve pass is the only custom one with two samplers; bind unit 1 once.
      if (this.customResolve?.uOriginal) {
        gl.useProgram(this.customResolve.program);
        gl.uniform1i(this.customResolve.uOriginal, 1);
      }
    }
    if (!this.customInput || !this.customResolve) return null;

    const requested = effect.params[SCALE_PARAM] ?? parsed.defaultScale;
    const scale = Math.min(1, Math.max(0.25, Number.isFinite(requested) ? requested : 1));
    return {
      stages: built.stages,
      programs,
      params: packParams(parsed.params, effect.params),
      width: Math.max(1, Math.round(this.width * scale)),
      height: Math.max(1, Math.round(this.height * scale)),
      mouse: {
        x: effect.params[MOUSE_X_PARAM] ?? 0.5,
        y: effect.params[MOUSE_Y_PARAM] ?? 0.5,
      },
    };
  }

  /**
   * Runs one custom effect: input copy, each stage into its own buffer, then resolve.
   *
   * The two extra blits are what make a pasted shader behave. The input copy hands it
   * straight (unpremultiplied) colour at the render scale it asked for, and the resolve
   * puts the result back into the premultiplied full-size layer the rest of the chain
   * speaks. Stages write into persistent buffers so a later stage can read an earlier
   * one — strictly forward, never its own previous frame.
   *
   * Every pass here draws with `SHADERTOY_UV`, the same identity rectangle the built-in
   * effects use. Anything else flips the picture once per pass, which an odd number of
   * passes then hands to the encoder upside down.
   */
  private runCustom(effect: EffectInstance, prepared: PreparedCustom, clock: EffectClock): void {
    const gl = this.gl;
    if (!gl || !this.layers) return;

    const { width: sw, height: sh } = prepared;
    const source = this.layers[this.layerIndex];

    const input = this.stageTarget(`${effect.id}\u0000input`, sw, sh);
    if (!input) return;

    const query = this.beginTiming(effect.id);
    this.runningCustom = effect.id;

    gl.bindFramebuffer(gl.FRAMEBUFFER, input.fbo);
    gl.viewport(0, 0, sw, sh);
    this.drawQuad(
      source.texture,
      { x: 0, y: 0, w: sw, h: sh },
      SHADERTOY_UV,
      1,
      this.customInput,
      undefined,
      0,
      undefined,
      { width: sw, height: sh },
    );

    const outputs = new Map<string, RenderTarget>();
    for (const [index, stage] of prepared.stages.entries()) {
      const target = this.stageTarget(`${effect.id}\u0000${stage.name}`, sw, sh);
      if (!target) {
        this.runningCustom = null;
        this.endTiming(query);
        return;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, sw, sh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawStage(prepared.programs[index], stage, prepared, clock, input, outputs, sw, sh);
      outputs.set(stage.name, target);
    }

    const last = outputs.get(prepared.stages[prepared.stages.length - 1].name);
    if (last) {
      const target = this.layers[1 - this.layerIndex];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.activeTexture(gl.TEXTURE1);
      // The *layer's* alpha, at full resolution: the render scale must not soften the
      // edge of the clip, only the effect inside it.
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      this.drawQuad(
        last.texture,
        { x: 0, y: 0, w: this.width, h: this.height },
        SHADERTOY_UV,
        1,
        this.customResolve,
      );
      this.layerIndex = 1 - this.layerIndex;
    }

    this.runningCustom = null;
    this.endTiming(query);
  }

  private drawStage(
    entry: ProgramEntry,
    stage: BuiltStage,
    prepared: PreparedCustom,
    clock: EffectClock,
    input: RenderTarget,
    outputs: Map<string, RenderTarget>,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    if (!gl) return;

    gl.useProgram(entry.program);
    gl.bindVertexArray(this.vao);

    const resolutions = new Float32Array(12);
    for (const binding of stage.channels) {
      const bound = this.bindChannel(binding, input, outputs, { width, height });
      if (!bound) continue;
      // Samplers default to unit 0, so without this every channel past the first would
      // silently read whatever iChannel0 holds.
      const location = entry.iChannel[binding.index];
      if (location) gl.uniform1i(location, binding.index);
      resolutions[binding.index * 3] = bound.width;
      resolutions[binding.index * 3 + 1] = bound.height;
      resolutions[binding.index * 3 + 2] = 1;
    }

    gl.uniform4f(entry.uDest, 0, 0, width, height);
    gl.uniform4f(entry.uSrc, SHADERTOY_UV.x, SHADERTOY_UV.y, SHADERTOY_UV.w, SHADERTOY_UV.h);
    gl.uniform2f(entry.uResolution, width, height);
    if (entry.iResolution) gl.uniform3f(entry.iResolution, width, height, width / Math.max(1, height));
    if (entry.iTime) gl.uniform1f(entry.iTime, clock.time);
    if (entry.iTimeDelta) gl.uniform1f(entry.iTimeDelta, 1 / Math.max(1, clock.fps));
    if (entry.iFrameRate) gl.uniform1f(entry.iFrameRate, clock.fps);
    if (entry.iFrame) gl.uniform1i(entry.iFrame, clock.frame);
    if (entry.iMouse) {
      // z and w report the last click on Shadertoy; a positive pair is what shaders test
      // for before using the cursor at all, so the two sliders are always "held down".
      const mx = prepared.mouse.x * width;
      const my = prepared.mouse.y * height;
      gl.uniform4f(entry.iMouse, mx, my, mx, my);
    }
    if (entry.iDate) {
      const now = new Date();
      const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      gl.uniform4f(entry.iDate, now.getFullYear(), now.getMonth(), now.getDate(), seconds);
    }
    if (entry.iChannelResolution) gl.uniform3fv(entry.iChannelResolution, resolutions);
    if (entry.uParams) gl.uniform1fv(entry.uParams, prepared.params);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Sampler objects and units 1–3 are custom-only; leave the state as the rest of the
    // compositor expects to find it.
    for (let unit = 0; unit < 4; unit++) {
      gl.bindSampler(unit, null);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  private bindChannel(
    binding: ChannelBinding,
    input: RenderTarget,
    outputs: Map<string, RenderTarget>,
    stageSize: { width: number; height: number },
  ): { width: number; height: number } | null {
    const gl = this.gl;
    if (!gl) return null;

    let texture: WebGLTexture | null = null;
    // Stage and input buffers are at the effect's render scale, not the frame size;
    // `textureSize()` and `iChannelResolution` have to agree with that or a shader that
    // works out its own pixel grid — the NTSC preset does — samples between texels.
    let size = stageSize;
    if (binding.source.kind === 'input') {
      texture = input.texture;
    } else if (binding.source.kind === 'stage') {
      const target = outputs.get(binding.source.stage);
      if (target) texture = target.texture;
    } else {
      const pattern = this.pattern(binding.source.pattern);
      if (pattern) {
        texture = pattern.texture;
        size = { width: pattern.width, height: pattern.height };
      }
    }
    if (!texture) return null;

    const unit = binding.index;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Sampler objects rather than texture parameters: wrap and filter belong to this
    // shader's use of the texture, not to the texture, which other passes also read.
    gl.bindSampler(unit, this.sampler(binding.wrap, binding.filter));
    return size;
  }

  private sampler(wrap: ChannelBinding['wrap'], filter: ChannelBinding['filter']): WebGLSampler | null {
    const gl = this.gl;
    if (!gl) return null;
    const key = `${wrap}:${filter}`;
    const cached = this.samplers.get(key);
    if (cached) return cached;
    const sampler = gl.createSampler();
    if (!sampler) return null;
    const mode = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    const mag = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, mode);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, mode);
    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, mag);
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, mag);
    this.samplers.set(key, sampler);
    return sampler;
  }

  /** A generated channel texture. Cheaper and steadier than asking for an asset. */
  private pattern(name: PatternName): TexEntry | null {
    const gl = this.gl;
    if (!gl) return null;
    const cached = this.patterns.get(name);
    if (cached) return cached;

    const { data, size } = patternData(name);
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    setTextureParams(gl);
    const entry: TexEntry = { texture, width: size, height: size };
    this.patterns.set(name, entry);
    return entry;
  }

  private stageTarget(key: string, width: number, height: number): RenderTarget | null {
    const gl = this.gl;
    if (!gl) return null;
    const existing = this.stageTargets.get(key);
    if (existing && existing.width === width && existing.height === height) {
      existing.used = this.frameCounter;
      return existing.target;
    }
    if (existing) deleteTarget(gl, existing.target);
    const target = createTarget(gl, width, height, true);
    if (!target) {
      this.stageTargets.delete(key);
      return null;
    }
    this.stageTargets.set(key, { target, width, height, used: this.frameCounter });
    return target;
  }

  /** Drops buffers for effects that stopped rendering — a deleted clip, a disabled effect. */
  private sweepStageTargets(): void {
    const gl = this.gl;
    if (!gl || this.stageTargets.size === 0) return;
    for (const [key, entry] of this.stageTargets) {
      if (this.frameCounter - entry.used < 120) continue;
      deleteTarget(gl, entry.target);
      this.stageTargets.delete(key);
    }
  }

  /**
   * GPU time for one custom effect, when the driver exposes it.
   *
   * Best-effort by design: only one timer query may be in flight, results arrive several
   * frames later, and a disjoint (a context switch on the GPU) invalidates them. The
   * point is only to make an expensive shader visibly expensive before it is exported.
   */
  private beginTiming(effectId: string): WebGLQuery | null {
    const gl = this.gl;
    if (!gl || this.timerBusy) return null;
    if (this.timerExt === null) this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') ?? false;
    if (!this.timerExt) return null;
    const ext = this.timerExt as { TIME_ELAPSED_EXT: number };
    const query = gl.createQuery();
    if (!query) return null;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.timerBusy = true;
    this.timerQueries.push({ query, effectId });
    return query;
  }

  private endTiming(query: WebGLQuery | null): void {
    const gl = this.gl;
    if (!gl || !query || !this.timerExt) return;
    gl.endQuery((this.timerExt as { TIME_ELAPSED_EXT: number }).TIME_ELAPSED_EXT);
    this.timerBusy = false;
  }

  private drainTimings(): void {
    const gl = this.gl;
    if (!gl || this.timerQueries.length === 0 || !this.timerExt) return;
    const ext = this.timerExt as { GPU_DISJOINT_EXT: number };
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const remaining: typeof this.timerQueries = [];
    for (const pending of this.timerQueries) {
      if (!gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE)) {
        remaining.push(pending);
        continue;
      }
      if (!disjoint) {
        recordShaderTime(pending.effectId, gl.getQueryParameter(pending.query, gl.QUERY_RESULT) / 1e6);
      }
      gl.deleteQuery(pending.query);
    }
    this.timerQueries = remaining;
  }

  /**
   * Draw one clip through its effect chain. `draw` receives the alpha and mirroring it
   * should use: with a chain the fade is applied when the finished layer is composited,
   * without one it goes straight onto the draw call and no layer is allocated at all.
   *
   * Both the preview and the exporter go through here, so a clip cannot look different
   * in the two.
   */
  withEffects(
    effects: EffectInstance[],
    alpha: number,
    draw: (drawAlpha: number, flip: SourceFlip) => void,
    wipe?: WipeBand | null,
    clock: EffectClock = ZERO_CLOCK,
  ): void {
    const flip = flipFromEffects(effects);
    const layered = shaderEffects(effects).length > 0 && this.beginLayer();
    if (layered) {
      // The chain runs over the whole frame; only the composite into the scene is
      // clipped, so a wipe reveals filtered pixels rather than a filtered sliver.
      draw(1, flip);
      this.endLayer(effects, alpha, wipe, clock);
    } else {
      this.beginWipe(wipe);
      draw(alpha, flip);
      this.endWipe(wipe);
    }
  }

  /**
   * A wipe is a scissor rectangle, not a shader: the incoming clip is simply drawn into a
   * growing slice of the frame, over the outgoing one that is already there.
   */
  private beginWipe(wipe: WipeBand | null | undefined): void {
    const gl = this.gl;
    if (!gl || !wipe) return;
    const x = Math.round(wipe.x * this.width);
    const w = Math.max(0, Math.round(wipe.w * this.width));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, 0, w, this.height);
  }

  private endWipe(wipe: WipeBand | null | undefined): void {
    // Left enabled it would also clip the next frame's clear.
    if (this.gl && wipe) this.gl.disable(this.gl.SCISSOR_TEST);
  }

  /**
   * Draw one visual source. `transform` undefined means fit-and-letterbox, matching
   * the renderer's full-frame default; set means crop the source and place the result.
   */
  drawSource(
    key: string,
    source: TexImageSource,
    sourceWidth: number,
    sourceHeight: number,
    transform: OverlayTransform | undefined,
    alpha = 1,
    flip?: SourceFlip,
  ): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    const entry = this.uploadTexture(key, source, sourceWidth, sourceHeight);
    if (!entry) return;

    let dest: NormalizedRect;
    let src: NormalizedRect;

    if (!transform) {
      const scale = Math.min(this.width / sourceWidth, this.height / sourceHeight);
      const w = sourceWidth * scale;
      const h = sourceHeight * scale;
      dest = { x: (this.width - w) / 2, y: (this.height - h) / 2, w, h };
      src = { x: 0, y: 0, w: 1, h: 1 };
    } else {
      const t = normalizeOverlayTransform(transform);
      const crop = clampRect(t.crop);
      const frame = clampRect(t.frame);
      src = crop;
      dest = {
        x: frame.x * this.width,
        y: frame.y * this.height,
        w: frame.w * this.width,
        h: frame.h * this.height,
      };
    }

    this.drawQuad(entry.texture, dest, mirrorRect(src, flip), alpha);
  }

  /**
   * Text keeps its Canvas2D layout — reimplementing text metrics in GLSL would buy
   * nothing. The rendered box is cached per clip and only redrawn when it changes.
   */
  drawTextClip(clip: TextClip, alpha = 1, flip?: SourceFlip): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    const frame = clampRect(textFrameForClip(clip.textFrame));
    const fw = Math.max(2, Math.round(frame.w * this.width));
    const fh = Math.max(2, Math.round(frame.h * this.height));
    const contentKey = `${clip.text}|${clip.template}|${fw}x${fh}`;

    const entry = this.textures.get(`text:${clip.id}`);
    if (!entry || entry.contentKey !== contentKey) {
      const canvas = this.textCanvas ?? (this.textCanvas = document.createElement('canvas'));
      canvas.width = fw;
      canvas.height = fh;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, fw, fh);
      // Draw into a frame-sized canvas at the origin: identical pixels to drawing the
      // same box inside the full canvas, because the style is derived from the box size.
      paintTextClip(ctx, clip.template, clip.text, fw, fh);
      const uploaded = this.uploadTexture(`text:${clip.id}`, canvas, fw, fh, true);
      if (!uploaded) return;
      uploaded.contentKey = contentKey;
    }

    const tex = this.textures.get(`text:${clip.id}`);
    if (!tex) return;

    this.drawQuad(
      tex.texture,
      { x: frame.x * this.width, y: frame.y * this.height, w: fw, h: fh },
      mirrorRect({ x: 0, y: 0, w: 1, h: 1 }, flip),
      alpha,
    );
  }

  /** Resolve the frame and blit it out to the compositor's own canvas. */
  endFrame(): void {
    const gl = this.gl;
    if (!gl || this.contextLost || !this.sceneTex) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Framebuffer textures are bottom-up; flip v so the canvas comes out upright.
    this.drawQuad(
      this.sceneTex,
      { x: 0, y: 0, w: this.width, h: this.height },
      { x: 0, y: 1, w: 1, h: -1 },
      1,
    );
    gl.flush();

    this.frameCounter++;
    this.drainTimings();
    this.sweepStageTargets();
  }

  private drawQuad(
    texture: WebGLTexture,
    dest: NormalizedRect,
    src: NormalizedRect,
    alpha: number,
    entry: ProgramEntry | null = this.blit,
    params?: Float32Array,
    pass = 0,
    region?: ResolvedRegion,
    /** Destination size, when it is not the frame — a custom effect's scaled buffers. */
    size?: { width: number; height: number },
  ): void {
    const gl = this.gl;
    if (!gl || !entry) return;
    gl.useProgram(entry.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform4f(entry.uDest, dest.x, dest.y, dest.w, dest.h);
    gl.uniform4f(entry.uSrc, src.x, src.y, src.w, src.h);
    const dw = size?.width ?? this.width;
    const dh = size?.height ?? this.height;
    gl.uniform2f(entry.uResolution, dw, dh);
    if (entry.uAlpha) gl.uniform1f(entry.uAlpha, alpha);
    if (entry.uTexel) gl.uniform2f(entry.uTexel, 1 / dw, 1 / dh);
    if (entry.uPass) gl.uniform1f(entry.uPass, pass);
    if (entry.uParams && params) gl.uniform1fv(entry.uParams, params);
    if (region) {
      gl.uniform4f(entry.uMaskRect, region.rect.x, region.rect.y, region.rect.w, region.rect.h);
      gl.uniform1f(entry.uMaskShape, region.shape);
      gl.uniform1f(entry.uMaskFeather, region.feather);
      gl.uniform1f(entry.uMaskInvert, region.invert ? 1 : 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Leave unit 0 current so the next ordinary draw is unaffected by the mask pass.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  private uploadTexture(
    key: string,
    source: TexImageSource,
    width: number,
    height: number,
    skipIfCached = false,
  ): TexEntry | null {
    const gl = this.gl;
    if (!gl) return null;

    let entry = this.textures.get(key);
    if (!entry) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      setTextureParams(gl);
      entry = { texture, width: 0, height: 0 };
      this.textures.set(key, entry);
    } else {
      if (skipIfCached) return entry;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    }

    try {
      if (entry.width === width && entry.height === height) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        entry.width = width;
        entry.height = height;
      }
    } catch (e) {
      // A not-yet-decodable frame throws rather than returning an error code.
      console.warn('[GL] texture upload failed for', key, e);
      return null;
    }
    return entry;
  }

  /** Drop a cached texture — call when an asset or text clip goes away. */
  releaseTexture(key: string): void {
    const entry = this.textures.get(key);
    if (!entry) return;
    this.gl?.deleteTexture(entry.texture);
    this.textures.delete(key);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    const gl = this.gl;
    if (!gl) return;
    for (const entry of this.textures.values()) gl.deleteTexture(entry.texture);
    this.textures.clear();
    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    this.releaseLayers(gl);
    for (const entry of this.stageTargets.values()) deleteTarget(gl, entry.target);
    this.stageTargets.clear();
    for (const entry of this.patterns.values()) gl.deleteTexture(entry.texture);
    this.patterns.clear();
    for (const sampler of this.samplers.values()) gl.deleteSampler(sampler);
    this.samplers.clear();
    for (const pending of this.timerQueries) gl.deleteQuery(pending.query);
    this.timerQueries = [];
    if (this.blit) gl.deleteProgram(this.blit.program);
    if (this.maskProgram) gl.deleteProgram(this.maskProgram.program);
    for (const entry of this.effectPrograms.values()) {
      if (entry) gl.deleteProgram(entry.program);
    }
    this.effectPrograms.clear();
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.gl = null;
  }
}

/**
 * `float` asks for a half-float buffer, which custom shader stages need.
 *
 * Shadertoy's buffers are floating point, and shaders rely on it: the NTSC preset writes
 * YIQ, whose chroma is signed, so an 8-bit target would clamp every negative component to
 * zero and the colour would come back wrong rather than merely coarse. Falls back to 8-bit
 * where the extension is missing.
 */
function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  float = false,
): RenderTarget | null {
  const useFloat = float && gl.getExtension('EXT_color_buffer_float') !== null;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (useFloat) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  setTextureParams(gl);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  return { texture, fbo };
}

function deleteTarget(gl: WebGL2RenderingContext, target: RenderTarget): void {
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.fbo);
}

function buildProgram(gl: WebGL2RenderingContext, fragSource: string): ProgramEntry | null {
  const program = linkProgram(gl, QUAD_VERT, fragSource);
  if (!program) return null;
  return {
    program,
    uDest: gl.getUniformLocation(program, 'uDest'),
    uSrc: gl.getUniformLocation(program, 'uSrc'),
    uResolution: gl.getUniformLocation(program, 'uResolution'),
    uAlpha: gl.getUniformLocation(program, 'uAlpha'),
    uTexel: gl.getUniformLocation(program, 'uTexel'),
    uPass: gl.getUniformLocation(program, 'uPass'),
    uParams: gl.getUniformLocation(program, 'uP'),
    uOriginal: gl.getUniformLocation(program, 'uOriginal'),
    uMaskRect: gl.getUniformLocation(program, 'uMaskRect'),
    uMaskShape: gl.getUniformLocation(program, 'uMaskShape'),
    uMaskFeather: gl.getUniformLocation(program, 'uMaskFeather'),
    uMaskInvert: gl.getUniformLocation(program, 'uMaskInvert'),
    iResolution: gl.getUniformLocation(program, 'iResolution'),
    iTime: gl.getUniformLocation(program, 'iTime'),
    iTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
    iFrameRate: gl.getUniformLocation(program, 'iFrameRate'),
    iFrame: gl.getUniformLocation(program, 'iFrame'),
    iMouse: gl.getUniformLocation(program, 'iMouse'),
    iDate: gl.getUniformLocation(program, 'iDate'),
    iChannelResolution: gl.getUniformLocation(program, 'iChannelResolution[0]'),
    iChannel: [0, 1, 2, 3].map((i) => gl.getUniformLocation(program, `iChannel${i}`)),
  };
}

/**
 * Channel textures a shader can have without an asset to manage.
 *
 * The ordered-dither shader needs an 8×8 threshold matrix and nothing else; generating it
 * is both exact and free, where an imported image would be neither.
 */
function patternData(name: PatternName): { data: Uint8Array; size: number } {
  if (name === 'bayer8') {
    const size = 8;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Bayer index by bit interleaving: the standard recursive matrix, without a table.
        let value = 0;
        for (let bit = 0; bit < 3; bit++) {
          const xb = (x >> bit) & 1;
          const yb = (y >> bit) & 1;
          value = (value << 2) | ((xb ^ yb) << 1) | yb;
        }
        const level = Math.round((value / 64) * 255);
        const at = (y * size + x) * 4;
        data[at] = level;
        data[at + 1] = level;
        data[at + 2] = level;
        data[at + 3] = 255;
      }
    }
    return { data, size };
  }
  if (name === 'noise') {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    // Seeded rather than Math.random: the same project has to export the same pixels.
    let seed = 0x2545f491;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        data[i + c] = (seed >>> 24) & 255;
      }
      data[i + 3] = 255;
    }
    return { data, size };
  }
  return { data: new Uint8Array([128, 128, 128, 255]), size: 1 };
}

function setTextureParams(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[GL] shader compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function linkProgram(
  gl: WebGL2RenderingContext,
  vertSource: string,
  fragSource: string,
): WebGLProgram | null {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSource);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  if (!vert || !frag) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  // Pin the quad attribute so every program agrees and one VAO can drive them all.
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[GL] program link failed:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}
