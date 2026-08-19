import type { Clip, MediaAsset } from '../types/editor';
import { clipDuration } from '../utils/time';

/**
 * Who owns which media element, and what for.
 *
 * Three preview bugs had the same shape: one element serving two purposes, retired on behalf
 * of one of them while the other still needed it. Two clips of a split share an element and
 * the outgoing half paused it; an overlay and its base shared one and fought over
 * `currentTime`; a clip with its audio switched off lost its audio route and was paused
 * while still being drawn. Each was fixed at the call site that happened to be wrong, which
 * is how the next one got in.
 *
 * The rule those fixes converged on is that an element answers two independent questions,
 * and no single call site knows both answers:
 *
 *   - **Is anything listening to it?** Decides the volume. An element handed to a
 *     `MediaElementAudioSourceNode` is fed *through* its own `volume`, not around it, so an
 *     element left at zero is silent no matter what the gain node downstream says.
 *   - **Is anything using it at all?** Decides whether it may be paused. Drawing counts:
 *     a muted video is still decoding every frame you can see.
 *
 * So the passes that build a frame declare what they need, and the pool settles it in one
 * place afterwards. Nothing outside pauses an element or sets its volume.
 */
export class MediaElementPool {
  private videos = new Map<string, HTMLVideoElement>();
  private audios = new Map<string, HTMLAudioElement>();
  private images = new Map<string, HTMLImageElement>();
  private keys: { clips: readonly Clip[]; byClip: Map<string, string> } | null = null;

  /**
   * Which element a clip should use.
   *
   * One element per asset is normally right and cheap. It stops being right the moment two
   * clips of the same asset are on screen together — as an overlay, or dissolving into each
   * other — because an element can only be at one `currentTime`, and two clips wanting
   * different ones drag it back and forth every frame until it decodes nothing at all. So a
   * clip overlapping another clip of the same asset gets an element of its own.
   *
   * Overlap, not adjacency: the two halves of a split still share, which is what makes a cut
   * seamless instead of a re-seek.
   *
   * Memoised on the clips array itself. The store replaces that array on every edit, so
   * reference equality is exactly the right invalidation signal, and the render loop asks
   * for these keys once per clip per frame.
   */
  keyFor(clip: Clip, clips: readonly Clip[]): string {
    if (!('assetId' in clip)) return '';
    if (this.keys?.clips !== clips) {
      this.keys = { clips, byClip: buildKeys(clips) };
    }
    return this.keys.byClip.get(clip.id) ?? clip.assetId;
  }

  video(asset: MediaAsset, key: string = asset.id): HTMLVideoElement {
    let v = this.videos.get(key);
    if (!v) {
      v = document.createElement('video');
      v.src = asset.blobUrl;
      v.muted = false;
      // Silent until something claims it as listened-to. Most video elements here are
      // texture sources — a clip with its audio detached or disabled still has to be
      // decoded and drawn — and an element that was never handed to the audio graph plays
      // straight to the speakers.
      v.volume = 0;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      this.videos.set(key, v);
    }
    return v;
  }

  audio(asset: MediaAsset, key: string = asset.id): HTMLAudioElement {
    let a = this.audios.get(key);
    if (!a) {
      a = document.createElement('audio');
      a.src = asset.blobUrl;
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      a.volume = 0;
      this.audios.set(key, a);
    }
    return a;
  }

  image(asset: MediaAsset): HTMLImageElement {
    let img = this.images.get(asset.id);
    if (!img) {
      img = new Image();
      img.src = asset.blobUrl;
      img.crossOrigin = 'anonymous';
      this.images.set(asset.id, img);
    }
    return img;
  }

  /**
   * Settle the frame: open up what is being listened to, silence what is not, and pause
   * whatever nothing needs at all.
   *
   * This walks every element the pool has ever handed out, not just the ones some caller
   * remembered to mention. That is the point — an element played for a clip that has since
   * scrolled out of the playhead's range, and never had an audio route to be retired
   * through, was previously left running to the end of the file: inaudible, invisible, and
   * still decoding.
   */
  settle(listening: ReadonlySet<HTMLMediaElement>, drawing: ReadonlySet<HTMLMediaElement>): void {
    for (const el of this.elements()) {
      el.volume = listening.has(el) ? 1 : 0;
      if (!listening.has(el) && !drawing.has(el) && !el.paused) el.pause();
    }
  }

  /** Stops everything. Used when playback stops and when the engine is torn down. */
  pauseAll(): void {
    for (const el of this.elements()) el.pause();
  }

  clear(): void {
    this.pauseAll();
    this.videos.clear();
    this.audios.clear();
    this.images.clear();
    this.keys = null;
  }

  private *elements(): Generator<HTMLMediaElement> {
    yield* this.videos.values();
    yield* this.audios.values();
  }
}

function buildKeys(clips: readonly Clip[]): Map<string, string> {
  const spans = clips
    .filter((c): c is Clip & { assetId: string } => 'assetId' in c)
    .map((c) => ({
      id: c.id,
      assetId: c.assetId,
      start: c.timelineStart,
      end: c.timelineStart + clipDuration(c),
    }));

  const keys = new Map<string, string>();
  for (const clip of spans) {
    const shared = spans.some(
      (other) =>
        other.id !== clip.id &&
        other.assetId === clip.assetId &&
        other.start < clip.end &&
        clip.start < other.end,
    );
    keys.set(clip.id, shared ? `${clip.assetId}:${clip.id}` : clip.assetId);
  }
  return keys;
}
