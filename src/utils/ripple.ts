/**
 * Closing gaps, and the shift that ripple edits are made of.
 *
 * Two operations that look like one. Both move clips left or right along the timeline without
 * touching a trim, so both are pure arithmetic over positions — which is the only reason they
 * can be asserted rather than clicked.
 *
 * The trap that shapes everything here: **a transition is not a stored entity, it is the
 * overlap between two adjacent clips** (`utils/transitions.ts`). Pulling clips until they butt
 * against each other would delete every cross-dissolve on the track with no undo entry naming
 * it. So spacing is only ever *closed*, never *reduced past zero*: a pair that overlaps today
 * overlaps by exactly as much afterwards.
 */
import type { Clip } from '../types/editor';
import { clipDuration, clipEnd } from './time';

/** A clip that moved, and where to. */
export interface ClipShift {
  id: string;
  timelineStart: number;
}

const EPS = 1e-6;

function byStart(a: Clip, b: Clip): number {
  return a.timelineStart - b.timelineStart || clipEnd(a) - clipEnd(b);
}

/**
 * Closes the gaps on each of `trackIds`, one track at a time.
 *
 * The first clip on a track never moves: a deliberate head of black or silence is content, not
 * a gap. Every later clip is pulled left until it begins where the previous one ended — or, if
 * the two overlap today, until it overlaps by the same amount it does now.
 *
 * Tracks are closed independently, which is what makes this the wrong tool for a video clip
 * whose audio was detached onto another track. `closeGapsAcrossTracks` is that tool.
 */
export function closeGapsOnTracks(clips: Clip[], trackIds: string[]): ClipShift[] {
  const wanted = new Set(trackIds);
  const shifts: ClipShift[] = [];

  for (const trackId of wanted) {
    const onTrack = clips.filter((c) => c.trackId === trackId).sort(byStart);
    if (onTrack.length < 2) continue;

    let previousEnd = clipEnd(onTrack[0]);
    let previousOriginalEnd = clipEnd(onTrack[0]);

    for (let i = 1; i < onTrack.length; i++) {
      const clip = onTrack[i];
      // Measured against where the previous clip *was*, so an overlap survives the move at its
      // current length instead of being recomputed from where it has ended up.
      const spacing = clip.timelineStart - previousOriginalEnd;
      const start = Math.max(0, previousEnd + Math.min(0, spacing));

      if (Math.abs(start - clip.timelineStart) > EPS) shifts.push({ id: clip.id, timelineStart: start });

      previousOriginalEnd = clipEnd(clip);
      previousEnd = start + clipDuration(clip);
    }
  }

  return shifts;
}

/**
 * Closes the gaps in the timeline as a whole.
 *
 * A gap here is a stretch where *nothing at all* is playing on any track. Removing one shifts
 * everything after it by the same amount, so every relationship across tracks survives: a
 * picture and its detached audio move together because they move as part of the same block.
 *
 * Time before the first clip is left alone, for the same reason the first clip on a track is.
 */
export function closeGapsAcrossTracks(clips: Clip[]): ClipShift[] {
  if (clips.length < 2) return [];

  const spans = clips
    .map((c) => ({ start: c.timelineStart, end: clipEnd(c) }))
    .sort((a, b) => a.start - b.start);

  // Merge what is occupied; the holes between the merged blocks are the gaps.
  const merged: { start: number; end: number }[] = [{ ...spans[0] }];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (span.start <= last.end + EPS) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  if (merged.length < 2) return [];

  /** Cumulative gap length before each block, which is how far that block moves left. */
  const shiftForBlock: number[] = [0];
  for (let i = 1; i < merged.length; i++) {
    shiftForBlock.push(shiftForBlock[i - 1] + (merged[i].start - merged[i - 1].end));
  }

  const shifts: ClipShift[] = [];
  for (const clip of clips) {
    let block = 0;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (clip.timelineStart >= merged[i].start - EPS) {
        block = i;
        break;
      }
    }
    const delta = shiftForBlock[block];
    if (delta > EPS) shifts.push({ id: clip.id, timelineStart: Math.max(0, clip.timelineStart - delta) });
  }

  return shifts;
}

/**
 * The ripple itself: everything starting at or after `from` moves by `delta`.
 *
 * `trackId` null ripples every track, which is what keeps detached audio with its picture; a
 * track id ripples that one alone. Clips that start before `from` never move, whatever they
 * overlap — a clip already running when the edit happened is not part of what comes after it.
 */
export function rippleShift(
  clips: Clip[],
  from: number,
  delta: number,
  trackId: string | null,
  exclude: ReadonlySet<string> = new Set(),
): ClipShift[] {
  if (Math.abs(delta) < EPS) return [];

  return clips
    .filter(
      (c) =>
        !exclude.has(c.id) &&
        (trackId === null || c.trackId === trackId) &&
        c.timelineStart >= from - EPS,
    )
    .map((c) => ({ id: c.id, timelineStart: Math.max(0, c.timelineStart + delta) }));
}

/** Applies shifts to a clip list, leaving everything else identical. */
export function applyShifts(clips: Clip[], shifts: ClipShift[]): Clip[] {
  if (shifts.length === 0) return clips;
  const byId = new Map(shifts.map((s) => [s.id, s.timelineStart]));
  return clips.map((c) => {
    const start = byId.get(c.id);
    return start === undefined || Math.abs(start - c.timelineStart) < EPS
      ? c
      : { ...c, timelineStart: start };
  });
}
