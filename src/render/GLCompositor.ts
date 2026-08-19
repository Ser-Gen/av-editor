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
  flipFromEffects,
  packParams,
  regionOf,
  shaderEffects,
} from './effects/registry';
import { BLIT_FRAG, MASK_FRAG, QUAD_VERT } from './shaders';

/**
 * Forces the Canvas2D fallback. Set from `?renderer=2d`, and switchable at runtime so
 * the two renderers can be compared frame-for-frame in one session.
 */
let forced2D =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('renderer') === '2d';

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
  /** Mask pass only. */
  uOriginal: WebGLUniformLocation | null;
  uMaskRect: WebGLUniformLocation | null;
  uMaskShape: WebGLUniformLocation | null;
  uMaskFeather: WebGLUniformLocation | null;
  uMaskInvert: WebGLUniformLocation | null;
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
  /** One program per effect type, compiled on first use. `null` = failed to compile. */
  private effectPrograms = new Map<EffectType, ProgramEntry | null>();
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
    this.textures.clear();
    this.effectPrograms.clear();
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
    const frag = EFFECTS[type]?.frag;
    if (!gl || !frag) {
      this.effectPrograms.set(type, null);
      return null;
    }
    const entry = buildProgram(gl, EFFECT_PRELUDE + frag);
    this.effectPrograms.set(type, entry);
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
  endLayer(effects: EffectInstance[], alpha = 1, wipe?: WipeBand | null): void {
    const gl = this.gl;
    if (!gl || !this.inLayer || !this.layers) return;
    this.inLayer = false;

    const full: NormalizedRect = { x: 0, y: 0, w: this.width, h: this.height };
    // Framebuffer textures are bottom-up, so a v-flipped source rect makes each pass
    // orientation-preserving instead of mirroring the layer once per pass.
    const flipped: NormalizedRect = { x: 0, y: 1, w: 1, h: -1 };

    // Effect passes replace their target rather than blending into it.
    gl.disable(gl.BLEND);
    this.runChain(effects, full, flipped);
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
  applyToScene(effects: EffectInstance[]): void {
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

    this.runChain(effects, full, flipped);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.width, this.height);
    this.drawQuad(this.layers![this.layerIndex].texture, full, flipped, 1);
    gl.enable(gl.BLEND);
  }

  /** Ping-pongs the chain over the current layer. Assumes blending is already off. */
  private runChain(effects: EffectInstance[], full: NormalizedRect, flipped: NormalizedRect): void {
    const gl = this.gl;
    if (!gl || !this.layers) return;
    for (const effect of shaderEffects(effects)) {
      const entry = this.effectProgram(effect.type);
      if (!entry) continue;
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

      const params = packParams(effect.type, effect.params);
      const passes = EFFECTS[effect.type].passes ?? 1;
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
  ): void {
    const flip = flipFromEffects(effects);
    const layered = shaderEffects(effects).length > 0 && this.beginLayer();
    if (layered) {
      // The chain runs over the whole frame; only the composite into the scene is
      // clipped, so a wipe reveals filtered pixels rather than a filtered sliver.
      draw(1, flip);
      this.endLayer(effects, alpha, wipe);
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
  ): void {
    const gl = this.gl;
    if (!gl || !entry) return;
    gl.useProgram(entry.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform4f(entry.uDest, dest.x, dest.y, dest.w, dest.h);
    gl.uniform4f(entry.uSrc, src.x, src.y, src.w, src.h);
    gl.uniform2f(entry.uResolution, this.width, this.height);
    if (entry.uAlpha) gl.uniform1f(entry.uAlpha, alpha);
    if (entry.uTexel) gl.uniform2f(entry.uTexel, 1 / this.width, 1 / this.height);
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

function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): RenderTarget | null {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
  };
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
