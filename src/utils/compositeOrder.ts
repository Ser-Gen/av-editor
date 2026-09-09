import type { AdjustmentClip, Clip, Track, VisualClip } from '../types/editor';
import { MAX_CLIP_GAIN, MAX_TRACK_VOLUME } from './trackVolume';

/**
 * Single source of truth for layering, shared by the canvas preview and the FFmpeg
 * export so the two can never drift. Tracks are stored top-to-bottom; video clips
 * composite bottom-up, so the topmost track is drawn last and wins.
 */

/**
 * Every clip kind that draws something.
 *
 * This is the list that decides what the preview, the WebCodecs export and the FFmpeg
 * fallback all iterate over, so a drawing clip kind missing from it is invisible in all
 * three at once — with no error anywhere, because a type predicate is not checked for
 * exhaustiveness. Adding a visual clip kind means adding it here, first.
 */
export function isVisualClip(clip: Clip): clip is VisualClip {
  return (
    clip.kind === 'video' ||
    clip.kind === 'image' ||
    clip.kind === 'text' ||
    clip.kind === 'annotation'
  );
}

export function videoTracks(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.kind === 'video');
}

export function audioTracks(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.kind === 'audio');
}

/** Higher value = drawn later = closer to the viewer. */
function videoDepthMap(tracks: Track[]): Map<string, number> {
  const vids = videoTracks(tracks);
  const map = new Map<string, number>();
  vids.forEach((track, i) => map.set(track.id, vids.length - 1 - i));
  return map;
}

/** Video tracks that actually render: hidden excluded. */
export function visibleVideoTrackIds(tracks: Track[]): Set<string> {
  return new Set(videoTracks(tracks).filter((t) => !t.hidden).map((t) => t.id));
}

/** Audio tracks that actually sound: solo wins over mute. */
export function audibleAudioTrackIds(tracks: Track[]): Set<string> {
  const auds = audioTracks(tracks);
  const soloed = auds.filter((t) => t.solo);
  const active = soloed.length > 0 ? soloed : auds.filter((t) => !t.muted);
  return new Set(active.map((t) => t.id));
}

/** A soloed audio track silences video-clip audio too — solo means "only this". */
export function hasAudioSolo(tracks: Track[]): boolean {
  return audioTracks(tracks).some((t) => t.solo);
}

/** Visual clips in back-to-front paint order. */
export function compositeOrderedClips(clips: Clip[], tracks: Track[]): VisualClip[] {
  const depth = videoDepthMap(tracks);
  const visible = visibleVideoTrackIds(tracks);

  return clips
    .filter(isVisualClip)
    .filter((c) => visible.has(c.trackId))
    .sort((a, b) => {
      const da = depth.get(a.trackId) ?? -1;
      const db = depth.get(b.trackId) ?? -1;
      if (da !== db) return da - db;
      if (a.timelineStart !== b.timelineStart) return a.timelineStart - b.timelineStart;
      return a.id < b.id ? -1 : 1;
    });
}

/**
 * The same paint order, grouped by track.
 *
 * Grades attach to a *track*, not to a clip, so the renderer has to know where one
 * track's contribution ends. Order is bottom-up: draw the track's clips, then run its
 * grade over everything accumulated so far, then move up.
 */
export interface TrackLayer {
  track: Track;
  /** Drawn in order. */
  clips: VisualClip[];
  /** Ranged grades on this track, applied after its clips. */
  adjustments: AdjustmentClip[];
}

export function compositeLayers(clips: Clip[], tracks: Track[]): TrackLayer[] {
  const visible = visibleVideoTrackIds(tracks);
  const ordered = compositeOrderedClips(clips, tracks);
  // Bottom-up, matching compositeOrderedClips.
  const lanes = videoTracks(tracks).filter((t) => visible.has(t.id)).reverse();

  return lanes.map((track) => ({
    track,
    clips: ordered.filter((c) => c.trackId === track.id),
    adjustments: clips
      .filter((c): c is AdjustmentClip => c.kind === 'adjustment' && c.trackId === track.id)
      .sort((a, b) => a.timelineStart - b.timelineStart),
  }));
}

/** Clips contributing audio, with their final gain already resolved. */
export function audibleClips(
  clips: Clip[],
  tracks: Track[],
): { clip: Clip; gain: number }[] {
  const audible = audibleAudioTrackIds(tracks);
  const soloActive = hasAudioSolo(tracks);
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const out: { clip: Clip; gain: number }[] = [];

  for (const clip of clips) {
    if (clip.kind === 'audio') {
      if (!audible.has(clip.trackId)) continue;
      const track = trackById.get(clip.trackId);
      out.push({ clip, gain: clampClip(clip.gain) * clampTrack(track?.volume ?? 1) });
      continue;
    }
    if (clip.kind === 'video') {
      // Video-clip audio lives on a video track, so no track volume applies —
      // but an active audio solo silences it.
      if (!clip.hasAudio || !clip.audioEnabled || soloActive) continue;
      out.push({ clip, gain: clampClip(clip.gain) });
    }
  }
  return out;
}

/*
 * Two ceilings, because they answer different questions. A clip's gain is where levelling
 * happens and reaches +12 dB, which is what normalizing a quiet take needs; a track fader is a
 * balance control over already-levelled material and stays at +3.5 dB. Sharing one number is
 * what made Normalize write a gain nothing would play.
 */
function clampClip(v: number): number {
  return Math.min(MAX_CLIP_GAIN, Math.max(0, Number.isFinite(v) ? v : 1));
}

function clampTrack(v: number): number {
  return Math.min(MAX_TRACK_VOLUME, Math.max(0, Number.isFinite(v) ? v : 1));
}
