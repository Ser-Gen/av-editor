import type { Clip, MediaAsset, Track, TrackKind } from '../types/editor';
import { uid } from '../utils/id';
import { defaultImageTransform } from '../utils/overlayTransform';
import { DEFAULT_TRACK_VOLUME } from '../utils/trackVolume';
import { clipEnd, snapTime } from '../utils/time';

export interface ClipPlacementResult {
  tracks: Track[];
  clips: Clip[];
  selectedClipId: string;
}

function nextTrackLabel(tracks: Track[], kind: TrackKind): string {
  const n = tracks.filter((t) => t.kind === kind).length + 1;
  if (kind === 'overlay') return `Overlay ${n}`;
  if (kind === 'video') return `Video ${n}`;
  return `Audio ${n}`;
}

function createTrack(tracks: Track[], kind: TrackKind): { tracks: Track[]; trackId: string } {
  const t: Track = {
    id: uid('track'),
    kind,
    label: nextTrackLabel(tracks, kind),
    ...(kind === 'audio' ? { volume: DEFAULT_TRACK_VOLUME } : {}),
  };
  return { tracks: [...tracks, t], trackId: t.id };
}

function ensureTrack(tracks: Track[], kind: TrackKind): { tracks: Track[]; trackId: string } {
  const existing = tracks.find((t) => t.kind === kind);
  if (existing) return { tracks, trackId: existing.id };
  return createTrack(tracks, kind);
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function trackHasOverlap(
  clips: Clip[],
  trackId: string,
  start: number,
  duration: number,
): boolean {
  const end = start + duration;
  for (const clip of clips) {
    if (clip.trackId !== trackId) continue;
    if (rangesOverlap(start, end, clip.timelineStart, clipEnd(clip))) return true;
  }
  return false;
}

/** Pick an existing lane without overlap, or create a new one. */
export function findLaneForPlacement(
  tracks: Track[],
  clips: Clip[],
  newClips: Clip[],
  kind: TrackKind,
  start: number,
  duration: number,
): { tracks: Track[]; trackId: string; start: number } {
  const combined = clips.concat(newClips);
  const snappedStart = snapTime(Math.max(0, start));

  for (const lane of tracks.filter((t) => t.kind === kind)) {
    if (!trackHasOverlap(combined, lane.id, snappedStart, duration)) {
      return { tracks, trackId: lane.id, start: snappedStart };
    }
  }

  const created = createTrack(tracks, kind);
  return { tracks: created.tracks, trackId: created.trackId, start: snappedStart };
}

/** Append after the last clip on the first lane of this kind (video / overlay). */
function placeSequentially(
  tracks: Track[],
  clips: Clip[],
  newClips: Clip[],
  kind: TrackKind,
  playhead: number,
): { tracks: Track[]; trackId: string; start: number } {
  const ensured = ensureTrack(tracks, kind);
  const laneClips = clips.concat(newClips).filter((c) => c.trackId === ensured.trackId);
  const lastEnd = laneClips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  return {
    tracks: ensured.tracks,
    trackId: ensured.trackId,
    start: snapTime(Math.max(playhead, lastEnd)),
  };
}

export function buildClipsForAsset(
  asset: MediaAsset,
  assetId: string,
  tracks: Track[],
  existingClips: Clip[],
  playhead: number,
): ClipPlacementResult {
  let nextTracks = tracks;
  const newClips: Clip[] = [];
  const duration = asset.type === 'image' ? 5 : asset.duration;
  const withAudio = asset.type === 'video' && asset.hasAudio !== false;

  if (asset.type === 'video') {
    const videoLane = placeSequentially(nextTracks, existingClips, newClips, 'video', playhead);
    nextTracks = videoLane.tracks;
    const videoClip: Clip = {
      id: uid('clip'),
      trackId: videoLane.trackId,
      timelineStart: videoLane.start,
      sourceTrimIn: 0,
      sourceTrimOut: duration,
      kind: 'video',
      assetId,
      muteAudio: withAudio,
      hideVideo: false,
    };
    newClips.push(videoClip);

    if (withAudio) {
      const audioLane = findLaneForPlacement(
        nextTracks,
        existingClips,
        newClips,
        'audio',
        videoLane.start,
        duration,
      );
      nextTracks = audioLane.tracks;
      newClips.push({
        id: uid('clip'),
        trackId: audioLane.trackId,
        timelineStart: audioLane.start,
        sourceTrimIn: 0,
        sourceTrimOut: duration,
        kind: 'audio',
        assetId,
      });
    }

    return { tracks: nextTracks, clips: newClips, selectedClipId: videoClip.id };
  }

  if (asset.type === 'audio') {
    const audioLane = findLaneForPlacement(
      nextTracks,
      existingClips,
      newClips,
      'audio',
      playhead,
      duration,
    );
    const audioClip: Clip = {
      id: uid('clip'),
      trackId: audioLane.trackId,
      timelineStart: audioLane.start,
      sourceTrimIn: 0,
      sourceTrimOut: duration,
      kind: 'audio',
      assetId,
    };
    newClips.push(audioClip);
    return { tracks: audioLane.tracks, clips: newClips, selectedClipId: audioClip.id };
  }

  const overlayLane = findLaneForPlacement(
    nextTracks,
    existingClips,
    newClips,
    'overlay',
    playhead,
    duration,
  );
  const imageClip: Clip = {
    id: uid('clip'),
    trackId: overlayLane.trackId,
    timelineStart: overlayLane.start,
    sourceTrimIn: 0,
    sourceTrimOut: duration,
    kind: 'image',
    assetId,
    overlayTransform: defaultImageTransform(asset.width ?? 1920, asset.height ?? 1080),
  };
  newClips.push(imageClip);
  return { tracks: overlayLane.tracks, clips: newClips, selectedClipId: imageClip.id };
}

export function isAssetInUse(assetId: string, clips: Clip[]): boolean {
  return clips.some((c) => 'assetId' in c && c.assetId === assetId);
}
