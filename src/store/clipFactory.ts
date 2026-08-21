import type { Clip, MediaAsset, OverlayTransform, Track, TrackKind } from '../types/editor';
import { uid } from '../utils/id';
import { audioTracks, videoTracks } from '../utils/compositeOrder';
import { clipEnd, quantizeToFrame, rangesOverlap } from '../utils/time';

export const DEFAULT_VIDEO_TRACK_HEIGHT = 76;
export const DEFAULT_AUDIO_TRACK_HEIGHT = 70;
export const MIN_TRACK_HEIGHT = 40;
export const MAX_TRACK_HEIGHT = 220;
export const IMAGE_CLIP_DURATION = 5;
export const TEXT_CLIP_DURATION = 3;
export const ADJUSTMENT_CLIP_DURATION = 5;

export interface ClipPlacementResult {
  tracks: Track[];
  clips: Clip[];
  selectedClipId: string;
}

export function createTrack(kind: TrackKind, label: string): Track {
  return {
    id: uid('track'),
    kind,
    label,
    height: kind === 'video' ? DEFAULT_VIDEO_TRACK_HEIGHT : DEFAULT_AUDIO_TRACK_HEIGHT,
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    volume: 1,
  };
}

export function nextTrackLabel(tracks: Track[], kind: TrackKind): string {
  const prefix = kind === 'video' ? 'V' : 'A';
  const used = new Set(tracks.filter((t) => t.kind === kind).map((t) => t.label));
  let n = tracks.filter((t) => t.kind === kind).length + 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/**
 * Video tracks stack upward (a new one goes on top of the video group);
 * audio tracks stack downward. Tracks are stored top-to-bottom, video group first.
 */
export function insertTrack(tracks: Track[], track: Track): Track[] {
  if (track.kind === 'video') return [track, ...tracks];
  return [...tracks, track];
}

export function defaultTracks(): Track[] {
  return [createTrack('video', 'V1'), createTrack('audio', 'A1')];
}

function addTrack(tracks: Track[], kind: TrackKind): { tracks: Track[]; trackId: string } {
  const track = createTrack(kind, nextTrackLabel(tracks, kind));
  return { tracks: insertTrack(tracks, track), trackId: track.id };
}

export function trackHasOverlap(
  clips: Clip[],
  trackId: string,
  start: number,
  duration: number,
  ignoreIds?: Set<string>,
): boolean {
  const end = start + duration;
  for (const clip of clips) {
    if (clip.trackId !== trackId) continue;
    if (ignoreIds?.has(clip.id)) continue;
    if (rangesOverlap(start, end, clip.timelineStart, clipEnd(clip))) return true;
  }
  return false;
}

export function trackEnd(clips: Clip[], trackId: string): number {
  return clips.reduce((max, c) => (c.trackId === trackId ? Math.max(max, clipEnd(c)) : max), 0);
}

/**
 * First lane of this kind with room at `start`, otherwise a freshly created one.
 * Video lanes are searched bottom-up so the base layer fills before new layers appear;
 * `topDown` flips that for content that belongs on top (text).
 */
export function findLaneForPlacement(
  tracks: Track[],
  clips: Clip[],
  kind: TrackKind,
  start: number,
  duration: number,
  fps: number,
  topDown = false,
): { tracks: Track[]; trackId: string; start: number } {
  const snapped = quantizeToFrame(Math.max(0, start), fps);
  const videoLanes = topDown ? videoTracks(tracks) : [...videoTracks(tracks)].reverse();
  const lanes = kind === 'video' ? videoLanes : audioTracks(tracks);

  for (const lane of lanes) {
    if (lane.locked) continue;
    if (!trackHasOverlap(clips, lane.id, snapped, duration)) {
      return { tracks, trackId: lane.id, start: snapped };
    }
  }

  const created = addTrack(tracks, kind);
  return { tracks: created.tracks, trackId: created.trackId, start: snapped };
}

/**
 * Video imports build a sequence: drop at the playhead when the base lane is free,
 * otherwise append after the last clip on it. Never silently creates a layer.
 */
function placeOnBaseVideoLane(
  tracks: Track[],
  clips: Clip[],
  playhead: number,
  duration: number,
  fps: number,
): { tracks: Track[]; trackId: string; start: number } {
  const lanes = [...videoTracks(tracks)].reverse().filter((t) => !t.locked);
  if (lanes.length === 0) {
    const created = addTrack(tracks, 'video');
    return { tracks: created.tracks, trackId: created.trackId, start: quantizeToFrame(Math.max(0, playhead), fps) };
  }

  const base = lanes[0];
  const at = quantizeToFrame(Math.max(0, playhead), fps);
  if (!trackHasOverlap(clips, base.id, at, duration)) {
    return { tracks, trackId: base.id, start: at };
  }
  return {
    tracks,
    trackId: base.id,
    start: quantizeToFrame(trackEnd(clips, base.id), fps),
  };
}

export function buildClipsForAsset(
  asset: MediaAsset,
  assetId: string,
  tracks: Track[],
  existingClips: Clip[],
  playhead: number,
  fps: number,
): ClipPlacementResult {
  if (asset.type === 'video') {
    const duration = asset.duration;
    const lane = placeOnBaseVideoLane(tracks, existingClips, playhead, duration, fps);
    const clip: Clip = {
      id: uid('clip'),
      trackId: lane.trackId,
      timelineStart: lane.start,
      sourceTrimIn: 0,
      sourceTrimOut: quantizeToFrame(duration, fps),
      kind: 'video',
      assetId,
      hasAudio: asset.hasAudio !== false,
      audioEnabled: asset.hasAudio !== false,
      gain: 1,
      hideVideo: false,
    };
    return { tracks: lane.tracks, clips: [clip], selectedClipId: clip.id };
  }

  if (asset.type === 'audio') {
    const duration = asset.duration;
    const lane = findLaneForPlacement(tracks, existingClips, 'audio', playhead, duration, fps);
    const clip: Clip = {
      id: uid('clip'),
      trackId: lane.trackId,
      timelineStart: lane.start,
      sourceTrimIn: 0,
      sourceTrimOut: quantizeToFrame(duration, fps),
      kind: 'audio',
      assetId,
      gain: 1,
    };
    return { tracks: lane.tracks, clips: [clip], selectedClipId: clip.id };
  }

  const lane = findLaneForPlacement(
    tracks,
    existingClips,
    'video',
    playhead,
    IMAGE_CLIP_DURATION,
    fps,
  );
  const clip: Clip = {
    id: uid('clip'),
    trackId: lane.trackId,
    timelineStart: lane.start,
    sourceTrimIn: 0,
    sourceTrimOut: IMAGE_CLIP_DURATION,
    kind: 'image',
    assetId,
  };
  return { tracks: lane.tracks, clips: [clip], selectedClipId: clip.id };
}

export function isAssetInUse(assetId: string, clips: Clip[]): boolean {
  return clips.some((c) => 'assetId' in c && c.assetId === assetId);
}

export interface RecordingPlacement {
  assetId: string;
  asset: MediaAsset;
  /** Seconds after the session anchor at which this source began capturing. */
  startOffset: number;
  /** Preferred lane within its own kind, counting from the base: 0 = V1/A1, 1 = A2. */
  lane: number;
  /**
   * Placement to arrive with — the camera's picture-in-picture frame. Ordinary clip data:
   * editable, movable and removable afterwards like any transform dragged out by hand.
   */
  transform?: OverlayTransform;
}

/**
 * Lays a finished capture session onto the timeline.
 *
 * Two things separate this from an ordinary import. Each source keeps its own measured
 * start offset, so the group stays aligned as recorded instead of merely starting
 * together — and only the group's anchor is snapped to the frame grid, because rounding
 * each source independently would throw away the sub-frame alignment the session went to
 * the trouble of measuring. And placement never slides a clip along its track to dodge a
 * collision: a recording that moved in time would be silently wrong, so a busy lane sends
 * it to the next lane down, or to a new one.
 */
export function buildRecordingClips(
  placements: RecordingPlacement[],
  tracks: Track[],
  clips: Clip[],
  playhead: number,
  fps: number,
): ClipPlacementResult {
  let nextTracks = tracks;
  const created: Clip[] = [];
  const anchor = quantizeToFrame(Math.max(0, playhead), fps);

  for (const placement of placements) {
    const { asset } = placement;
    const kind: TrackKind = asset.type === 'audio' ? 'audio' : 'video';
    const start = anchor + placement.startOffset;
    const duration = asset.duration;

    const lanes =
      kind === 'video' ? [...videoTracks(nextTracks)].reverse() : audioTracks(nextTracks);
    const candidates = [...lanes.slice(placement.lane), ...lanes.slice(0, placement.lane)];
    let trackId: string | null = null;
    for (const lane of candidates) {
      if (lane.locked) continue;
      const busy = [...clips, ...created].some(
        (c) => c.trackId === lane.id && rangesOverlap(c.timelineStart, clipEnd(c), start, start + duration),
      );
      if (!busy) {
        trackId = lane.id;
        break;
      }
    }
    if (!trackId) {
      const addition = addTrack(nextTracks, kind);
      nextTracks = addition.tracks;
      trackId = addition.trackId;
    }

    const base = {
      id: uid('clip'),
      trackId,
      timelineStart: start,
      sourceTrimIn: 0,
      sourceTrimOut: duration,
    };
    created.push(
      asset.type === 'audio'
        ? { ...base, kind: 'audio', assetId: placement.assetId, gain: 1 }
        : {
            ...base,
            kind: 'video',
            assetId: placement.assetId,
            hasAudio: asset.hasAudio !== false,
            audioEnabled: asset.hasAudio !== false,
            gain: 1,
            hideVideo: false,
            ...(placement.transform ? { transform: placement.transform } : {}),
          },
    );
  }

  return {
    tracks: nextTracks,
    clips: created,
    selectedClipId: created[0]?.id ?? '',
  };
}
