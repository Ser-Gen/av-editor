import type { Track } from '../types/editor';

export const MIN_TRACK_VOLUME = 0;
export const MAX_TRACK_VOLUME = 1.5;
export const DEFAULT_TRACK_VOLUME = 1;

export function getAudioTrackVolume(track: Track | undefined): number {
  if (!track || track.kind !== 'audio') return DEFAULT_TRACK_VOLUME;
  const v = track.volume ?? DEFAULT_TRACK_VOLUME;
  return Math.min(MAX_TRACK_VOLUME, Math.max(MIN_TRACK_VOLUME, v));
}

export function clampTrackVolume(volume: number): number {
  return Math.min(MAX_TRACK_VOLUME, Math.max(MIN_TRACK_VOLUME, volume));
}
