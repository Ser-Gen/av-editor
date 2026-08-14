import type { Clip, EditorState, MediaAsset } from '../types/editor';
import { resolutionToSize } from '../utils/resolution';
import {
  drawOverlaySource,
  imageTransformForClip,
  normalizeOverlayTransform,
} from '../utils/overlayTransform';
import { textFrameForClip } from '../utils/overlayTransform';
import { getAudioTrackVolume } from '../utils/trackVolume';
import { clipDuration } from '../utils/time';
import { drawTextClip } from './textRenderer';

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
  private audioCtx: AudioContext | null = null;
  private videoCache = new Map<string, HTMLVideoElement>();
  private imageCache = new Map<string, HTMLImageElement>();
  private audioCache = new Map<string, HTMLAudioElement>();
  /** One MediaElementSource per asset — cannot be created twice on the same element. */
  private mediaSources = new Map<string, MediaElementAudioSourceNode>();
  private clipRoutes = new Map<string, ClipAudioRoute>();
  private raf = 0;
  private anchor = 0;
  private anchorTime = 0;
  private playing = false;
  private renderGeneration = 0;
  private onTime?: (t: number) => void;
  private onEnded?: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
  }

  setCallbacks(onTime: (t: number) => void, onEnded: () => void): void {
    this.onTime = onTime;
    this.onEnded = onEnded;
  }

  private ensureAudioCtx(): AudioContext {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }

  private getVideo(asset: MediaAsset): HTMLVideoElement {
    let v = this.videoCache.get(asset.id);
    if (!v) {
      v = document.createElement('video');
      v.src = asset.blobUrl;
      v.muted = false;
      v.volume = 0;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      this.videoCache.set(asset.id, v);
    }
    return v;
  }

  private getAudio(asset: MediaAsset): HTMLAudioElement {
    let a = this.audioCache.get(asset.id);
    if (!a) {
      a = document.createElement('audio');
      a.src = asset.blobUrl;
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      this.audioCache.set(asset.id, a);
    }
    return a;
  }

  private getImage(asset: MediaAsset): HTMLImageElement {
    let img = this.imageCache.get(asset.id);
    if (!img) {
      img = new Image();
      img.src = asset.blobUrl;
      img.crossOrigin = 'anonymous';
      this.imageCache.set(asset.id, img);
    }
    return img;
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
    const raw = clip.sourceTrimIn + (t - clip.timelineStart);
    const max = clip.sourceTrimOut - 1 / 60;
    return Math.min(max, Math.max(clip.sourceTrimIn, raw));
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

  private sortedClips(state: StoreSlice): Clip[] {
    const layer = (clip: Clip): number => {
      if (clip.kind === 'video') return clip.overlayMode ? 2 : 0;
      if (clip.kind === 'image') return 1;
      if (clip.kind === 'text') return 3;
      return 4;
    };
    return [...state.clips].sort((a, b) => layer(a) - layer(b));
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
    const { width, height } = resolutionToSize(state.settings.resolution);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    for (const clip of this.sortedClips(state)) {
      if (!this.isActive(clip, t, state)) continue;

      if (clip.kind === 'video' && !clip.hideVideo && !clip.overlayMode) {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const video = this.getVideo(asset);
        if (video.readyState >= 2 && video.videoWidth > 0) {
          this.drawLetterbox(
            ctx,
            video,
            video.videoWidth,
            video.videoHeight,
            width,
            height,
          );
        }
      }

      if (clip.kind === 'image') {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const img = this.getImage(asset);
        if (img.complete && img.naturalWidth > 0) {
          drawOverlaySource(
            ctx,
            img,
            img.naturalWidth,
            img.naturalHeight,
            imageTransformForClip(clip.overlayTransform, img.naturalWidth, img.naturalHeight),
            width,
            height,
          );
        }
      }

      if (clip.kind === 'video' && !clip.hideVideo && clip.overlayMode) {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const video = this.getVideo(asset);
        if (video.readyState >= 2 && video.videoWidth > 0) {
          drawOverlaySource(
            ctx,
            video,
            video.videoWidth,
            video.videoHeight,
            normalizeOverlayTransform(clip.overlayTransform),
            width,
            height,
          );
        }
      }

      if (clip.kind === 'text') {
        drawTextClip(ctx, clip.template, clip.text, width, height, textFrameForClip(clip.textFrame));
      }
    }
  }

  private primeVideoElements(state: StoreSlice, t: number): Promise<void>[] {
    const seeks: Promise<void>[] = [];
    for (const clip of this.sortedClips(state)) {
      if (!this.isActive(clip, t, state)) continue;
      if (clip.kind === 'video' && !clip.hideVideo) {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const video = this.getVideo(asset);
        seeks.push(this.seekElement(video, this.sourceTime(clip, t, state)));
      }
    }
    return seeks;
  }

  async renderFrameAsync(state: StoreSlice, t: number): Promise<void> {
    const gen = ++this.renderGeneration;
    await Promise.all(this.primeVideoElements(state, t));
    if (gen !== this.renderGeneration) return;
    this.drawFrameContents(state, t);
  }

  /** Fast path during playback — draw current frames without blocking on seek. */
  private renderPlayFrame(state: StoreSlice, t: number): void {
    for (const clip of this.sortedClips(state)) {
      if (!this.isActive(clip, t, state)) continue;
      if (clip.kind === 'video' && !clip.hideVideo) {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const video = this.getVideo(asset);
        const st = this.sourceTime(clip, t, state);
        this.nudgeElement(video, st);
        if (video.paused) void video.play().catch(() => undefined);
      }
    }
    this.drawFrameContents(state, t);
    this.syncAudio(state, t, true);
  }

  private clipHasAudio(clip: Clip): boolean {
    if (clip.kind === 'audio') return true;
    if (clip.kind === 'video') return !clip.muteAudio;
    return false;
  }

  private getAudioElement(clip: Clip, state: StoreSlice): HTMLMediaElement | null {
    if (clip.kind === 'audio' || clip.kind === 'video') {
      const asset = state.mediaLibrary[clip.assetId];
      if (!asset) return null;
      return clip.kind === 'video' ? this.getVideo(asset) : this.getAudio(asset);
    }
    return null;
  }

  private getOrCreateMediaSource(assetId: string, el: HTMLMediaElement): MediaElementAudioSourceNode {
    let source = this.mediaSources.get(assetId);
    if (!source) {
      source = this.ensureAudioCtx().createMediaElementSource(el);
      this.mediaSources.set(assetId, source);
    }
    return source;
  }

  private syncAudio(state: StoreSlice, t: number, duringPlay: boolean): void {
    const ctx = this.ensureAudioCtx();
    const shouldBeActive = new Set<string>();
    const existingClipIds = new Set(state.clips.map((c) => c.id));

    for (const clipId of this.clipRoutes.keys()) {
      if (!existingClipIds.has(clipId)) {
        const route = this.clipRoutes.get(clipId)!;
        route.gain.disconnect();
        route.element.pause();
        this.clipRoutes.delete(clipId);
      }
    }

    for (const clip of state.clips) {
      if (!this.clipHasAudio(clip) || !this.isActive(clip, t, state)) continue;
      if (clip.kind !== 'audio' && clip.kind !== 'video') continue;

      shouldBeActive.add(clip.id);
      const el = this.getAudioElement(clip, state);
      if (!el) continue;

      const st = this.sourceTime(clip, t, state);
      if (duringPlay) {
        this.nudgeElement(el, st);
      } else {
        void this.seekElement(el, st);
      }

      let route = this.clipRoutes.get(clip.id);
      if (!route) {
        const source = this.getOrCreateMediaSource(clip.assetId, el);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(ctx.destination);
        route = {
          clipId: clip.id,
          assetId: clip.assetId,
          element: el,
          gain,
          connectedToDest: true,
        };
        this.clipRoutes.set(clip.id, route);
      } else if (!route.connectedToDest) {
        route.gain.connect(ctx.destination);
        route.connectedToDest = true;
      }

      const track = state.tracks.find((tr) => tr.id === clip.trackId);
      route.gain.gain.value = getAudioTrackVolume(track);

      if (this.playing && el.paused) {
        void el.play().catch(() => undefined);
      }
    }

    for (const [clipId, route] of this.clipRoutes) {
      if (!shouldBeActive.has(clipId)) {
        if (route.connectedToDest) {
          route.gain.disconnect();
          route.connectedToDest = false;
        }
        route.element.pause();
      }
    }
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
      for (const clip of state.clips) {
        if (!this.isActive(clip, startTime, state)) continue;
        if (clip.kind === 'video' && !clip.hideVideo) {
          const asset = state.mediaLibrary[clip.assetId];
          if (!asset) continue;
          const video = this.getVideo(asset);
          void video.play().catch(() => undefined);
        }
      }
      this.renderPlayFrame(state, startTime);
      this.raf = requestAnimationFrame(() => this.tick(state, duration));
    })();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const video of this.videoCache.values()) {
      video.pause();
    }
    for (const audio of this.audioCache.values()) {
      audio.pause();
    }
    for (const { element } of this.clipRoutes.values()) {
      element.pause();
    }
  }

  seek(state: StoreSlice, t: number): Promise<void> {
    this.pause();
    return this.renderFrameAsync(state, t);
  }

  destroy(): void {
    this.pause();
    for (const route of this.clipRoutes.values()) {
      route.gain.disconnect();
    }
    this.clipRoutes.clear();
    this.mediaSources.clear();
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.videoCache.clear();
    this.audioCache.clear();
    this.imageCache.clear();
  }
}
