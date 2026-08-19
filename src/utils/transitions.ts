import type { Clip, TransitionType } from '../types/editor';
import { clipDuration, clipEnd } from './time';

/**
 * Transitions.
 *
 * A transition is not a stored entity — it *is* the overlap between two adjacent clips on
 * one track. That choice removes a whole class of bugs by construction: a transition
 * cannot outlive its clips, splitting or deleting either side cleans it up with no extra
 * code, dragging a clip is dragging the transition's duration, and undo works because
 * there is nothing to undo but the clip positions.
 *
 * Only the *type* is stored, on the incoming clip, because the overlap cannot express it.
 */

export interface TransitionWindow {
  /** The other clip involved. */
  other: Clip;
  start: number;
  end: number;
  type: TransitionType;
}

const MIN_OVERLAP = 1e-4;

function overlapsOnTrack(a: Clip, b: Clip): boolean {
  return (
    a.trackId === b.trackId &&
    a.id !== b.id &&
    a.timelineStart < clipEnd(b) - MIN_OVERLAP &&
    b.timelineStart < clipEnd(a) - MIN_OVERLAP
  );
}

/** The clip this one dissolves *from*: the one it overlaps that starts earlier. */
export function incomingTransition(clip: Clip, clips: Clip[]): TransitionWindow | null {
  for (const other of clips) {
    if (!overlapsOnTrack(clip, other)) continue;
    if (other.timelineStart >= clip.timelineStart) continue;
    return {
      other,
      start: clip.timelineStart,
      end: clipEnd(other),
      type: clip.transitionIn ?? 'dissolve',
    };
  }
  return null;
}

/** The clip this one dissolves *into*: the one it overlaps that starts later. */
export function outgoingTransition(clip: Clip, clips: Clip[]): TransitionWindow | null {
  for (const other of clips) {
    if (!overlapsOnTrack(clip, other)) continue;
    if (other.timelineStart <= clip.timelineStart) continue;
    return {
      other,
      start: other.timelineStart,
      end: clipEnd(clip),
      type: other.transitionIn ?? 'dissolve',
    };
  }
  return null;
}

/** Every transition on the timeline, for drawing and for the fallback export. */
export function allTransitions(clips: Clip[]): { clip: Clip; window: TransitionWindow }[] {
  const out: { clip: Clip; window: TransitionWindow }[] = [];
  for (const clip of clips) {
    const incoming = incomingTransition(clip, clips);
    if (incoming) out.push({ clip, window: incoming });
  }
  return out;
}

function progress(window: TransitionWindow, t: number): number {
  const span = window.end - window.start;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (t - window.start) / span));
}

/** Reveal rectangle for a wipe, in 0–1 of the frame. Null means "draw the whole clip". */
export interface WipeRect {
  x: number;
  w: number;
}

export interface TransitionState {
  /** Multiplies the clip's opacity. */
  alpha: number;
  /** Multiplies the clip's audio gain. */
  gain: number;
  wipe: WipeRect | null;
}

const NEUTRAL: TransitionState = { alpha: 1, gain: 1, wipe: null };

/**
 * How a clip should be drawn and heard at `t`, given any transition it takes part in.
 *
 * The incoming clip is drawn *over* the outgoing one — that is already the paint order —
 * so a dissolve is just an alpha ramp on the incoming side, and the outgoing side is left
 * alone. Dip-to-black instead fades the outgoing out over the first half and the incoming
 * in over the second, so the frame passes through black.
 */
export function transitionStateAt(clip: Clip, clips: Clip[], t: number): TransitionState {
  const incoming = incomingTransition(clip, clips);
  if (incoming && t >= incoming.start && t < incoming.end) {
    const p = progress(incoming, t);
    switch (incoming.type) {
      case 'dipToBlack':
        return { alpha: Math.max(0, 2 * p - 1), gain: p, wipe: null };
      case 'wipeL':
        return { alpha: 1, gain: p, wipe: { x: 0, w: p } };
      case 'wipeR':
        return { alpha: 1, gain: p, wipe: { x: 1 - p, w: p } };
      default:
        return { alpha: p, gain: p, wipe: null };
    }
  }

  const outgoing = outgoingTransition(clip, clips);
  if (outgoing && t >= outgoing.start && t < outgoing.end) {
    const p = progress(outgoing, t);
    // Only dip-to-black touches the outgoing picture; the others are covered from above.
    const alpha = outgoing.type === 'dipToBlack' ? Math.max(0, 1 - 2 * p) : 1;
    return { alpha, gain: 1 - p, wipe: null };
  }

  return NEUTRAL;
}

/** True when the two clips may legally overlap: adjacent, and neither is swallowed. */
export function overlapIsTransition(a: Clip, b: Clip): boolean {
  if (a.trackId !== b.trackId) return false;
  const start = Math.max(a.timelineStart, b.timelineStart);
  const end = Math.min(clipEnd(a), clipEnd(b));
  const overlap = end - start;
  if (overlap <= MIN_OVERLAP) return false;
  // At most half of either clip. "Shorter than both" would still let one clip sit almost
  // entirely inside the other, which is a clip being swallowed, not a transition.
  return (
    overlap <= clipDuration(a) / 2 + MIN_OVERLAP && overlap <= clipDuration(b) / 2 + MIN_OVERLAP
  );
}

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  dissolve: 'Cross-dissolve',
  dipToBlack: 'Dip to black',
  wipeL: 'Wipe from left',
  wipeR: 'Wipe from right',
};
