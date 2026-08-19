import type { Track } from '../../types/editor';

export interface TrackRow {
  track: Track;
  top: number;
  height: number;
}

export function buildTrackLayout(tracks: Track[]): TrackRow[] {
  let top = 0;
  return tracks.map((track) => {
    const row = { track, top, height: track.height };
    top += track.height;
    return row;
  });
}

/** `y` is in content coordinates (scroll already added). */
export function trackAtY(rows: TrackRow[], y: number): Track | null {
  for (const row of rows) {
    if (y >= row.top && y < row.top + row.height) return row.track;
  }
  return rows.length > 0 && y >= 0 ? rows[rows.length - 1].track : null;
}
