import { clipEnd } from './time';
import type { Clip, Track } from '../types/editor';

/**
 * The minimap's geometry, kept here rather than in the component because all of it is
 * arithmetic that has to agree with the lanes exactly — a viewport window that disagrees
 * with the scroll position by two pixels is a control that lies about where you are.
 *
 * Every function takes the *drawn* span (content plus tail), the same range the lanes are
 * scrollable over, so "past the end" means the same thing in both places.
 */

export interface Bar {
  x: number;
  w: number;
}

/**
 * A clip thinner than this would be invisible, and a project of hundreds of short cuts
 * would draw as empty. Widening to a pixel and then merging is what makes such a project
 * read as densely occupied instead — which is the truth about it.
 */
export const MIN_BAR_PX = 1;

/** The window must stay grabbable however far the timeline is zoomed in. */
export const MIN_WINDOW_PX = 14;

/** Widen every span to at least a pixel, then merge whatever now touches. */
export function packBars(items: { start: number; end: number }[], span: number, width: number): Bar[] {
  if (!(span > 0) || !(width > 0) || items.length === 0) return [];
  const scale = width / span;

  const raw = items
    .map((item) => {
      const x = Math.max(0, Math.min(width, item.start * scale));
      const w = Math.max(MIN_BAR_PX, (item.end - item.start) * scale);
      return { x, w: Math.min(w, width - x) };
    })
    .filter((bar) => bar.w > 0)
    .sort((a, b) => a.x - b.x);

  const merged: Bar[] = [];
  for (const bar of raw) {
    const last = merged[merged.length - 1];
    if (last && bar.x <= last.x + last.w) {
      last.w = Math.max(last.w, bar.x + bar.w - last.x);
    } else {
      merged.push({ ...bar });
    }
  }
  return merged;
}

/**
 * Two rows, video over audio, collapsed across tracks. This is for recognizing the shape of
 * a project at a glance, not for editing it, so which track a clip sits on does not matter.
 */
export function minimapRows(
  clips: Clip[],
  tracks: Track[],
  span: number,
  width: number,
): { video: Bar[]; audio: Bar[] } {
  const kinds = new Map(tracks.map((t) => [t.id, t.kind]));
  const video: { start: number; end: number }[] = [];
  const audio: { start: number; end: number }[] = [];
  for (const clip of clips) {
    const item = { start: clip.timelineStart, end: clipEnd(clip) };
    (kinds.get(clip.trackId) === 'audio' ? audio : video).push(item);
  }
  return { video: packBars(video, span, width), audio: packBars(audio, span, width) };
}

/** Where the lanes' viewport falls on the strip. */
export function viewportWindow(
  scrollX: number,
  pxPerSec: number,
  viewportWidth: number,
  span: number,
  width: number,
): Bar {
  const contentWidth = span * pxPerSec;
  if (!(contentWidth > 0) || !(width > 0)) return { x: 0, w: Math.max(0, width) };
  const visible = Math.min(1, viewportWidth / contentWidth);
  const w = Math.min(width, Math.max(MIN_WINDOW_PX, width * visible));
  const x = Math.max(0, Math.min(width - w, (scrollX / contentWidth) * width));
  return { x, w };
}

/** Strip pixels → seconds. */
export function timeAtMinimapX(x: number, width: number, span: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(span, (x / width) * span));
}

/** Where the window's left edge was dragged to → the scroll position that puts it there. */
export function scrollForWindowX(
  x: number,
  width: number,
  span: number,
  pxPerSec: number,
): number {
  if (!(width > 0)) return 0;
  return Math.max(0, (x / width) * span * pxPerSec);
}

/**
 * Seeking on the minimap has to move the lanes as well, otherwise the one control that works
 * independently of zoom lands the playhead somewhere the lanes are not looking.
 */
export function centeredScroll(time: number, pxPerSec: number, viewportWidth: number): number {
  return Math.max(0, time * pxPerSec - viewportWidth / 2);
}
