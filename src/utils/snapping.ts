import type { Clip } from '../types/editor';
import { clipEnd, quantizeToFrame } from './time';

/** Snap strength in pixels — converted through pxPerSec so it feels identical at every zoom. */
export const SNAP_PIXELS = 8;

export interface SnapResult {
  /** Adjusted value, frame-quantized. */
  value: number;
  /** Timeline position of the engaged target, or null when nothing snapped. */
  target: number | null;
}

export interface SnapOptions {
  enabled: boolean;
  pxPerSec: number;
  fps: number;
}

/**
 * Snap candidates: the playhead, project start, and the edges of every clip
 * except the ones being dragged.
 */
export function buildSnapTargets(
  clips: Clip[],
  excludeIds: Iterable<string>,
  playhead: number,
): number[] {
  const skip = new Set(excludeIds);
  const targets = [0, playhead];
  for (const clip of clips) {
    if (skip.has(clip.id)) continue;
    targets.push(clip.timelineStart, clipEnd(clip));
  }
  return targets;
}

function thresholdSeconds(pxPerSec: number): number {
  return SNAP_PIXELS / Math.max(1, pxPerSec);
}

/** Snap a single value (a trim edge, or the playhead) to the nearest target. */
export function snapValue(value: number, targets: number[], opts: SnapOptions): SnapResult {
  const quantized = quantizeToFrame(value, opts.fps);
  if (!opts.enabled) return { value: quantized, target: null };

  const threshold = thresholdSeconds(opts.pxPerSec);
  let best: number | null = null;
  let bestDistance = threshold;

  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = target;
    }
  }

  if (best === null) return { value: quantized, target: null };
  return { value: quantizeToFrame(best, opts.fps), target: best };
}

/**
 * Snap a clip drag by testing both edges and taking whichever pull is stronger,
 * so a clip can butt up against a neighbour from either side.
 */
export function snapClipStart(
  proposedStart: number,
  duration: number,
  targets: number[],
  opts: SnapOptions,
): SnapResult {
  const quantized = quantizeToFrame(proposedStart, opts.fps);
  if (!opts.enabled) return { value: Math.max(0, quantized), target: null };

  const threshold = thresholdSeconds(opts.pxPerSec);
  let bestStart: number | null = null;
  let bestTarget: number | null = null;
  let bestDistance = threshold;

  for (const target of targets) {
    const startDistance = Math.abs(target - proposedStart);
    if (startDistance <= bestDistance) {
      bestDistance = startDistance;
      bestStart = target;
      bestTarget = target;
    }
    const endDistance = Math.abs(target - (proposedStart + duration));
    if (endDistance <= bestDistance) {
      bestDistance = endDistance;
      bestStart = target - duration;
      bestTarget = target;
    }
  }

  if (bestStart === null) return { value: Math.max(0, quantized), target: null };
  const value = Math.max(0, quantizeToFrame(bestStart, opts.fps));
  return { value, target: value <= 0 && bestStart < 0 ? null : bestTarget };
}
