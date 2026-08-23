import type { Clip, EditorState, MediaAsset, VisualClip } from '../types/editor';
import { drawOverlaySource, normalizeOverlayTransform } from '../utils/overlayTransform';
import { textFrameForClip } from '../utils/overlayTransform';
import { audibleClips, compositeLayers, compositeOrderedClips } from '../utils/compositeOrder';
import {
  activeEffects,
  clipClock,
  enabledEffects,
  fadeGainAt,
  sourceTimeAt,
  timelineClock,
  transformAt,
} from '../utils/clipRender';
import { transitionStateAt } from '../utils/transitions';
import { clipDuration } from '../utils/time';
import { GLCompositor } from '../render/GLCompositor';
import { MediaElementPool } from './mediaElements';
import { drawTextClip } from './textRenderer';
import { offlineCard } from '../utils/offlineCard';

type StoreSlice = Pick<EditorState, 'clips' | 'mediaLibrary' | 'settings' | 'tracks' | 'trimPreview'>;

interface ClipAudioRoute {
  clipId: string;
  assetId: string;
  element: HTMLMediaElement;
  gain: GainNode;
  connectedToDest: boolean;
}

export class PlaybackEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private compositor: GLCompositor;
  private audioCtx: AudioContext | null = null;
  /** Owns every media element: which clip gets which, their volume, and what stays running. */
  private pool = new MediaElementPool();
  /** One MediaElementSource per element key — cannot be created twice on the same element. */
  private mediaSources = new Map<string, MediaElementAudioSourceNode>();
  private clipRoutes = new Map<string, ClipAudioRoute>();
  private raf = 0;
  private anchor = 0;
  private anchorTime = 0;
  private playing = false;
  private renderGeneration = 0;
  private warnedNoEffects2D = false;
  private onTime?: (t: number) => void;
  private onEnded?: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    // The compositor owns its own offscreen canvas, so this 2D context stays usable
    // as the fallback when WebGL2 is missing or its context is lost.
    this.compositor = new GLCompositor();
  }

  /** Live per-clip output gain — the fade envelope as the mixer currently sees it. */
  get audioGains(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [clipId, route] of this.clipRoutes) out[clipId] = route.gain.gain.value;
    return out;
  }

  setCallbacks(onTime: (t: number) => void, onEnded: () => void): void {
    this.onTime = onTime;
    this.onEnded = onEnded;
  }

  /**
   * Every clip route meets here before the speakers, so monitoring volume is one node rather
   * than a multiplier smeared through the per-clip envelope. That matters because the clip
   * gains are recomputed from fades and transitions on every frame: anything folded into them
   * would be overwritten a sixtieth of a second later, and monitoring is not part of the
   * project anyway — it must never reach an export.
   */
  private masterGain: GainNode | null = null;
  private monitorGain = 1;

  private ensureAudioCtx(): AudioContext {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }

  private ensureMaster(): GainNode {
    const ctx = this.ensureAudioCtx();
    if (!this.masterGain) {
      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.monitorGain;
      this.masterGain.connect(ctx.destination);
    }
    return this.masterGain;
  }

  /** Preview loudness, 0..1. Silent monitoring is still a full-volume export. */
  setMonitorGain(value: number): void {
    this.monitorGain = value;
    // Only touches the node if there is one: setting the volume must not be what starts an
    // AudioContext, or a stored preference would provoke an autoplay warning on every load.
    if (this.masterGain) this.masterGain.gain.value = value;
  }

  private elementKey(clip: Clip, state: StoreSlice): string {
    return this.pool.keyFor(clip, state.clips);
  }

  private getVideo(asset: MediaAsset, key: string = asset.id): HTMLVideoElement | null {
    return this.pool.video(asset, key);
  }

  private getAudio(asset: MediaAsset, key: string = asset.id): HTMLAudioElement | null {
    return this.pool.audio(asset, key);
  }

  private getImage(asset: MediaAsset): HTMLImageElement | null {
    return this.pool.image(asset);
  }

  /**
   * A clip whose file is missing, drawn where the file would have been.
   *
   * It goes through `withEffects` and `drawSource` like any other visual, so it inherits the
   * clip's transform, crop, fade and transition untouched. The effect chain still runs over
   * it, which looks odd for about a second and is correct: what is missing is the media, not
   * the edit, and pretending otherwise would hide that a graded PiP is still a graded PiP.
   */
  private drawOfflineGL(
    gl: GLCompositor,
    clip: VisualClip,
    asset: MediaAsset,
    t: number,
    effects: ReturnType<typeof activeEffects>,
    fade: number,
    transition: ReturnType<typeof transitionStateAt>,
    clock: ReturnType<typeof clipClock>,
    key: string,
  ): void {
    const card = offlineCard(asset.name, asset.width ?? 1280, asset.height ?? 720);
    gl.withEffects(
      effects,
      fade,
      (alpha, flip) =>
        gl.drawSource(`${key}:offline`, card, card.width, card.height, transformAt(clip, t), alpha, flip),
      transition.wipe,
      clock,
    );
  }

  private isActive(clip: Clip, t: number, state: StoreSlice): boolean {
    if (state.trimPreview?.clipId === clip.id) return true;
    const start = clip.timelineStart;
    const end = start + clipDuration(clip);
    return t >= start && t < end;
  }

  private sourceTime(clip: Clip, t: number, state: StoreSlice): number {
    if (state.trimPreview?.clipId === clip.id) {
      return state.trimPreview.sourceTime;
    }
    return sourceTimeAt(clip, t, 1 / 60);
  }

  private seekElement(el: HTMLMediaElement, time: number): Promise<void> {
    const clamped = Math.max(0, time);
    if (Math.abs(el.currentTime - clamped) < 0.03 && el.readyState >= 2) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        el.removeEventListener('seeked', done);
        el.removeEventListener('loadeddata', done);
        resolve();
      };
      el.addEventListener('seeked', done);
      el.addEventListener('loadeddata', done);
      el.currentTime = clamped;
      setTimeout(done, 120);
    });
  }

  /** Lightweight sync while playing — no await, avoids RAF pile-up. */
  private nudgeElement(el: HTMLMediaElement, time: number): void {
    const clamped = Math.max(0, time);
    if (Math.abs(el.currentTime - clamped) > 0.2) {
      el.currentTime = clamped;
    }
  }

  /** Paint order comes from the track stack — same function the exporter uses. */
  private sortedClips(state: StoreSlice): VisualClip[] {
    return compositeOrderedClips(state.clips, state.tracks);
  }

  private drawLetterbox(
    ctx: CanvasRenderingContext2D,
    source: CanvasImageSource,
    sw: number,
    sh: number,
    dw: number,
    dh: number,
  ): void {
    const scale = Math.min(dw / sw, dh / sh);
    const w = sw * scale;
    const h = sh * scale;
    const x = (dw - w) / 2;
    const y = (dh - h) / 2;
    ctx.drawImage(source, x, y, w, h);
  }

  private drawFrameContents(state: StoreSlice, t: number): void {
    const { width, height } = state.settings;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    if (this.compositor.available && this.drawFrameGL(state, t, width, height)) return;
    this.drawFrame2D(state, t, width, height);
  }

  /** GPU path. Returns false if the compositor bailed and the 2D path should run. */
  private drawFrameGL(state: StoreSlice, t: number, width: number, height: number): boolean {
    const gl = this.compositor;
    if (!gl.beginFrame(width, height)) return false;

    // Track by track, bottom-up: draw the track's clips, then run any grade attached to
    // that track over everything accumulated so far.
    for (const layer of compositeLayers(state.clips, state.tracks)) {
      this.drawTrackClipsGL(state, t, layer.clips);
      if (layer.track.effects?.length) {
        gl.applyToScene(enabledEffects(layer.track.effects), timelineClock(t, state.settings.fps));
      }
      for (const adjustment of layer.adjustments) {
        if (!this.isActive(adjustment, t, state)) continue;
        gl.applyToScene(activeEffects(adjustment, t), clipClock(adjustment, t, state.settings.fps));
      }
    }

    gl.endFrame();
    this.ctx.drawImage(gl.canvas, 0, 0);
    return true;
  }

  private drawTrackClipsGL(state: StoreSlice, t: number, clips: VisualClip[]): void {
    const gl = this.compositor;
    for (const clip of clips) {
      if (!this.isActive(clip, t, state)) continue;

      // While scrubbing a trim handle the clip is drawn outside its own time range,
      // where the fade curve is undefined — show it at full strength instead.
      const scrubbing = state.trimPreview?.clipId === clip.id;
      const transition = scrubbing
        ? { alpha: 1, gain: 1, wipe: null }
        : transitionStateAt(clip, state.clips, t);
      const fade = (scrubbing ? 1 : fadeGainAt(clip, t)) * transition.alpha;
      const effects = activeEffects(clip, t);
      const clock = clipClock(clip, t, state.settings.fps);

      if (clip.kind === 'text') {
        gl.withEffects(
          effects,
          fade,
          (alpha, flip) => gl.drawTextClip(clip, alpha, flip),
          transition.wipe,
          clock,
        );
        continue;
      }

      const asset = state.mediaLibrary[clip.assetId];
      if (!asset) continue;

      if (clip.kind === 'video') {
        if (clip.hideVideo) continue;
        const key = this.elementKey(clip, state);
        const video = this.getVideo(asset, key);
        if (!video) {
          this.drawOfflineGL(gl, clip, asset, t, effects, fade, transition, clock, key);
          continue;
        }
        if (video.readyState < 2 || video.videoWidth === 0) continue;
        gl.withEffects(
          effects,
          fade,
          (alpha, flip) =>
            gl.drawSource(
              key,
              video,
              video.videoWidth,
              video.videoHeight,
              transformAt(clip, t),
              alpha,
              flip,
            ),
          transition.wipe,
          clock,
        );
        continue;
      }

      const img = this.getImage(asset);
      if (!img) {
        this.drawOfflineGL(gl, clip, asset, t, effects, fade, transition, clock, asset.id);
        continue;
      }
      if (!img.complete || img.naturalWidth === 0) continue;
      gl.withEffects(
        effects,
        fade,
        (alpha, flip) =>
          gl.drawSource(
            asset.id,
            img,
            img.naturalWidth,
            img.naturalHeight,
            transformAt(clip, t),
            alpha,
            flip,
          ),
        transition.wipe,
        clock,
      );
    }
  }

  private drawFrame2D(state: StoreSlice, t: number, width: number, height: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    for (const clip of this.sortedClips(state)) {
      if (!this.isActive(clip, t, state)) continue;

      // Fades are cheap enough to honour here; shader effects are not, so the fallback
      // shows the unfiltered clip and says so once rather than silently lying.
      ctx.globalAlpha =
        state.trimPreview?.clipId === clip.id
          ? 1
          : fadeGainAt(clip, t) * transitionStateAt(clip, state.clips, t).alpha;
      if (activeEffects(clip).length > 0 && !this.warnedNoEffects2D) {
        this.warnedNoEffects2D = true;
        console.warn('[Preview] Canvas2D fallback cannot run shader effects — showing the source.');
      }

      if (clip.kind === 'video') {
        if (clip.hideVideo) continue;
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const video = this.getVideo(asset, this.elementKey(clip, state));
        if (!video) {
          const card = offlineCard(asset.name, asset.width ?? width, asset.height ?? height);
          this.drawVisual(ctx, card, card.width, card.height, clip, t, width, height);
          continue;
        }
        if (video.readyState < 2 || video.videoWidth === 0) continue;
        this.drawVisual(ctx, video, video.videoWidth, video.videoHeight, clip, t, width, height);
        continue;
      }

      if (clip.kind === 'image') {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const img = this.getImage(asset);
        if (!img) {
          const card = offlineCard(asset.name, asset.width ?? width, asset.height ?? height);
          this.drawVisual(ctx, card, card.width, card.height, clip, t, width, height);
          continue;
        }
        if (!img.complete || img.naturalWidth === 0) continue;
        this.drawVisual(ctx, img, img.naturalWidth, img.naturalHeight, clip, t, width, height);
        continue;
      }

      drawTextClip(ctx, clip.template, clip.text, width, height, textFrameForClip(clip.textFrame));
    }
    ctx.globalAlpha = 1;
  }

  /** No transform = fit the whole frame; a transform means crop + placement (PiP). */
  private drawVisual(
    ctx: CanvasRenderingContext2D,
    source: CanvasImageSource,
    sw: number,
    sh: number,
    clip: Extract<VisualClip, { kind: 'video' | 'image' }>,
    t: number,
    width: number,
    height: number,
  ): void {
    const transform = transformAt(clip, t);
    if (!transform) {
      this.drawLetterbox(ctx, source, sw, sh, width, height);
      return;
    }
    drawOverlaySource(ctx, source, sw, sh, normalizeOverlayTransform(transform), width, height);
  }

  /** The video elements a frame at `t` needs, paired with the source time each must show. */
  private activeVideos(state: StoreSlice, t: number): { video: HTMLVideoElement; at: number }[] {
    const out: { video: HTMLVideoElement; at: number }[] = [];
    for (const clip of this.sortedClips(state)) {
      if (!this.isActive(clip, t, state)) continue;
      if (clip.kind === 'video' && !clip.hideVideo) {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const video = this.getVideo(asset, this.elementKey(clip, state));
        if (!video) continue;
        out.push({ video, at: this.sourceTime(clip, t, state) });
      }
    }
    return out;
  }

  private primeVideoElements(state: StoreSlice, t: number): Promise<void>[] {
    return this.activeVideos(state, t).map(({ video, at }) => this.seekElement(video, at));
  }

  async renderFrameAsync(state: StoreSlice, t: number): Promise<void> {
    const gen = ++this.renderGeneration;
    await Promise.all(this.primeVideoElements(state, t));
    if (gen !== this.renderGeneration) return;
    this.drawFrameContents(state, t);
    this.repaintWhenReady(state, t, gen);
  }

  /**
   * A seek gives up after a short deadline so scrubbing stays responsive. That deadline
   * also expires on the very first frame after an import, before the file has decoded
   * anything — and nothing would repaint it, because no store change follows an import
   * that has already added the clip. So the preview sat black until the user touched
   * something. Repaint once the elements that missed the deadline become usable.
   */
  private repaintWhenReady(state: StoreSlice, t: number, gen: number): void {
    for (const { video } of this.activeVideos(state, t)) {
      if (video.readyState >= 2 && video.videoWidth > 0) continue;
      const retry = () => {
        video.removeEventListener('loadeddata', retry);
        video.removeEventListener('seeked', retry);
        // A newer frame has been requested since; it owns the canvas now.
        if (gen !== this.renderGeneration) return;
        void this.renderFrameAsync(state, t);
      };
      video.addEventListener('loadeddata', retry);
      video.addEventListener('seeked', retry);
    }
  }

  /** Fast path during playback — draw current frames without blocking on seek. */
  private renderPlayFrame(state: StoreSlice, t: number): void {
    for (const clip of this.sortedClips(state)) {
      if (!this.isActive(clip, t, state)) continue;
      if (clip.kind === 'video' && !clip.hideVideo) {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const video = this.getVideo(asset, this.elementKey(clip, state));
        if (!video) continue;
        const st = this.sourceTime(clip, t, state);
        this.nudgeElement(video, st);
        if (video.paused) void video.play().catch(() => undefined);
      }
    }
    this.drawFrameContents(state, t);
    this.syncAudio(state, t, true);
  }

  private getAudioElement(clip: Clip, state: StoreSlice): { el: HTMLMediaElement; key: string } | null {
    if (clip.kind === 'audio' || clip.kind === 'video') {
      const asset = state.mediaLibrary[clip.assetId];
      if (!asset) return null;
      const key = this.elementKey(clip, state);
      const el = clip.kind === 'video' ? this.getVideo(asset, key) : this.getAudio(asset, key);
      // Offline: there is no element, so there is no route and nothing to hear. The picture
      // still draws its placeholder; silence is the honest counterpart of that.
      return el ? { el, key } : null;
    }
    return null;
  }

  /** One source node per *element*; creating two on one element throws. */
  private getOrCreateMediaSource(key: string, el: HTMLMediaElement): MediaElementAudioSourceNode {
    let source = this.mediaSources.get(key);
    if (!source) {
      source = this.ensureAudioCtx().createMediaElementSource(el);
      this.mediaSources.set(key, source);
    }
    return source;
  }

  /**
   * Routes audio for the clips audible at `t`, then hands the pool the frame's demand:
   * which elements are being listened to, and which are being drawn from. Nothing here
   * pauses an element or sets a volume — that is the pool's single decision, made once it
   * knows both answers.
   */
  private syncAudio(state: StoreSlice, t: number, duringPlay: boolean): void {
    const ctx = this.ensureAudioCtx();
    const shouldBeActive = new Set<string>();
    const existingClipIds = new Set(state.clips.map((c) => c.id));
    const listening = new Set<HTMLMediaElement>();
    const drawing = new Set<HTMLMediaElement>(this.activeVideos(state, t).map((v) => v.video));

    for (const { clip, gain: clipGain } of audibleClips(state.clips, state.tracks)) {
      if (!this.isActive(clip, t, state)) continue;
      if (clip.kind !== 'audio' && clip.kind !== 'video') continue;

      shouldBeActive.add(clip.id);
      const routed = this.getAudioElement(clip, state);
      if (!routed) continue;
      const el = routed.el;
      listening.add(el);

      const st = this.sourceTime(clip, t, state);
      if (duringPlay) {
        this.nudgeElement(el, st);
      } else {
        void this.seekElement(el, st);
      }

      let route = this.clipRoutes.get(clip.id);
      if (route && route.element !== el) {
        // The clip's element key changed under us — dragging a clip into or out of an
        // overlap with another clip of the same asset does exactly that. The old route
        // still points at the old element, so rebuild rather than drive a stale one. The
        // abandoned element needs no attention here: it simply stops being claimed, and the
        // pool settles it below like anything else nothing wants.
        route.gain.disconnect();
        this.clipRoutes.delete(clip.id);
        route = undefined;
      }
      if (!route) {
        const source = this.getOrCreateMediaSource(routed.key, el);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(this.ensureMaster());
        route = {
          clipId: clip.id,
          assetId: clip.assetId,
          element: el,
          gain,
          connectedToDest: true,
        };
        this.clipRoutes.set(clip.id, route);
      } else if (!route.connectedToDest) {
        route.gain.connect(this.ensureMaster());
        route.connectedToDest = true;
      }

      // syncAudio runs every frame while playing, so sampling the envelope here gives a
      // smooth fade without scheduling ramps that would fight with scrubbing.
      route.gain.gain.value =
        clipGain * fadeGainAt(clip, t) * transitionStateAt(clip, state.clips, t).gain;

      if (this.playing && el.paused) {
        void el.play().catch(() => undefined);
      }
    }

    // Disconnect the routes that are not sounding, and drop the ones whose clip is gone.
    // This is about the audio graph only; the elements underneath are the pool's business.
    for (const [clipId, route] of this.clipRoutes) {
      const gone = !existingClipIds.has(clipId);
      if (!gone && shouldBeActive.has(clipId)) continue;

      if (route.connectedToDest) {
        route.gain.disconnect();
        route.connectedToDest = false;
      }
      if (gone) this.clipRoutes.delete(clipId);
    }

    this.pool.settle(listening, drawing);
  }

  private tick = (state: StoreSlice, duration: number): void => {
    const t = this.anchorTime + (performance.now() - this.anchor) / 1000;
    if (t >= duration) {
      this.pause();
      this.onTime?.(duration);
      this.onEnded?.();
      void this.renderFrameAsync(state, duration);
      return;
    }
    this.onTime?.(t);
    this.renderPlayFrame(state, t);
    this.raf = requestAnimationFrame(() => this.tick(state, duration));
  };

  play(state: StoreSlice, startTime: number, duration: number): void {
    this.pause();
    this.playing = true;
    this.anchor = performance.now();
    this.anchorTime = startTime;
    void this.ensureAudioCtx().resume();
    void (async () => {
      await Promise.all(this.primeVideoElements(state, startTime));
      this.syncAudio(state, startTime, false);
      for (const clip of this.sortedClips(state)) {
        if (!this.isActive(clip, startTime, state)) continue;
        if (clip.kind === 'video' && !clip.hideVideo) {
          const asset = state.mediaLibrary[clip.assetId];
          if (!asset) continue;
          const video = this.getVideo(asset, this.elementKey(clip, state));
          void video?.play().catch(() => undefined);
        }
      }
      this.renderPlayFrame(state, startTime);
      this.raf = requestAnimationFrame(() => this.tick(state, duration));
    })();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.pool.pauseAll();
  }

  seek(state: StoreSlice, t: number): Promise<void> {
    this.pause();
    this.retire(state, t);
    return this.renderFrameAsync(state, t);
  }

  /**
   * Let go of what the project no longer contains.
   *
   * `syncAudio` does this while playing, but it is the *play* path only — the stopped path
   * draws and returns. So deleting a clip with playback stopped left its gain node connected
   * to the destination and its element at full volume, paused. Nothing in the app could sound
   * it, which is why it went unnoticed; anything outside the app that resumed that element
   * could, and did.
   *
   * Nothing is audible while stopped, so the listening set is empty by definition and the
   * volumes go to zero. `play()` opens up what it needs on its way in.
   */
  private retire(state: StoreSlice, t: number): void {
    const existing = new Set(state.clips.map((c) => c.id));
    for (const [clipId, route] of this.clipRoutes) {
      if (existing.has(clipId)) continue;
      if (route.connectedToDest) {
        route.gain.disconnect();
        route.connectedToDest = false;
      }
      this.clipRoutes.delete(clipId);
    }
    const drawing = new Set<HTMLMediaElement>(this.activeVideos(state, t).map((v) => v.video));
    this.pool.settle(new Set(), drawing);
  }

  destroy(): void {
    this.pause();
    for (const route of this.clipRoutes.values()) {
      route.gain.disconnect();
    }
    this.clipRoutes.clear();
    this.mediaSources.clear();
    this.compositor.dispose();
    this.masterGain?.disconnect();
    this.masterGain = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.pool.clear();
  }
}
