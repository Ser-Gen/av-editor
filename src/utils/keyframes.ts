import type { Interp, Keyframe } from '../types/editor';

/**
 * Keyframe channels.
 *
 * A channel is a sorted list of control points in **clip-relative seconds**. Anchoring to
 * the clip rather than the timeline means moving a clip carries its animation along for
 * free, and splitting is the only operation that has to touch the key list at all.
 *
 * Evaluation is a binary search plus one interpolation — cheap enough to call per
 * parameter per frame without memoising.
 */

export function sortKeys(keys: Keyframe[]): Keyframe[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** Value of a channel at clip-relative time `t`; `fallback` when the channel is empty. */
export function evaluateChannel(keys: Keyframe[] | undefined, t: number, fallback: number): number {
  if (!keys || keys.length === 0) return fallback;
  if (keys.length === 1) return keys[0].value;
  if (t <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.value;

  // Binary search for the last key at or before t.
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }

  const a = keys[lo];
  const b = keys[lo + 1];
  // `hold` belongs to the key on its left: the value stays put until the next key.
  if (a.interp === 'hold') return a.value;
  const span = b.t - a.t;
  const u = span <= 0 ? 0 : (t - a.t) / span;
  // smoothstep: zero slope at both ends, and strictly between the two values, so an
  // eased parameter can never overshoot past a key the way a spline would.
  const w = a.interp === 'smooth' ? u * u * (3 - 2 * u) : u;
  return a.value + (b.value - a.value) * w;
}

/** Writes (or replaces) a key at `t`. Keys within half a frame of each other merge. */
export function upsertKey(
  keys: Keyframe[] | undefined,
  t: number,
  value: number,
  interp: Interp = 'linear',
  tolerance = 1e-4,
): Keyframe[] {
  const existing = keys ?? [];
  const index = existing.findIndex((k) => Math.abs(k.t - t) <= tolerance);
  if (index >= 0) {
    const next = [...existing];
    next[index] = { ...next[index], value };
    return next;
  }
  return sortKeys([...existing, { t, value, interp }]);
}

export function removeKeyAt(keys: Keyframe[] | undefined, t: number, tolerance = 1e-4): Keyframe[] {
  return (keys ?? []).filter((k) => Math.abs(k.t - t) > tolerance);
}

export function moveKey(
  keys: Keyframe[] | undefined,
  from: number,
  to: number,
  tolerance = 1e-4,
): Keyframe[] {
  const existing = keys ?? [];
  const key = existing.find((k) => Math.abs(k.t - from) <= tolerance);
  if (!key) return existing;
  // Dropping a key onto another replaces it, rather than leaving two at one time.
  const others = existing.filter((k) => k !== key && Math.abs(k.t - to) > tolerance);
  return sortKeys([...others, { ...key, t: to }]);
}

export function setKeyInterp(
  keys: Keyframe[] | undefined,
  t: number,
  interp: Interp,
  tolerance = 1e-4,
): Keyframe[] {
  return (keys ?? []).map((k) => (Math.abs(k.t - t) <= tolerance ? { ...k, interp } : k));
}

/**
 * Divides a channel at `cut` (clip-relative) for a clip split.
 *
 * Both halves get a key exactly at the cut holding the interpolated value, so the two
 * clips together render the same curve the single clip did.
 */
export function splitChannel(
  keys: Keyframe[],
  cut: number,
): { left: Keyframe[]; right: Keyframe[] } {
  if (keys.length === 0) return { left: [], right: [] };
  const atCut = evaluateChannel(keys, cut, keys[0].value);
  const interpAtCut = keys.reduce<Interp>(
    (acc, k) => (k.t <= cut ? k.interp : acc),
    keys[0].interp,
  );

  const left = sortKeys([
    ...keys.filter((k) => k.t < cut - 1e-6),
    { t: cut, value: atCut, interp: interpAtCut },
  ]);
  const right = sortKeys([
    { t: 0, value: atCut, interp: interpAtCut },
    ...keys.filter((k) => k.t > cut + 1e-6).map((k) => ({ ...k, t: k.t - cut })),
  ]);
  return { left, right };
}

export function splitChannelMap(
  channels: Record<string, Keyframe[]> | undefined,
  cut: number,
): { left: Record<string, Keyframe[]> | undefined; right: Record<string, Keyframe[]> | undefined } {
  if (!channels) return { left: undefined, right: undefined };
  const left: Record<string, Keyframe[]> = {};
  const right: Record<string, Keyframe[]> = {};
  for (const [name, keys] of Object.entries(channels)) {
    const parts = splitChannel(keys, cut);
    left[name] = parts.left;
    right[name] = parts.right;
  }
  return { left, right };
}

/** All key times on a clip, deduplicated and sorted — drives `[` / `]` navigation. */
export function channelTimes(channels: (Record<string, Keyframe[]> | undefined)[]): number[] {
  const times = new Set<number>();
  for (const map of channels) {
    if (!map) continue;
    for (const keys of Object.values(map)) {
      for (const key of keys) times.add(Number(key.t.toFixed(6)));
    }
  }
  return [...times].sort((a, b) => a - b);
}
