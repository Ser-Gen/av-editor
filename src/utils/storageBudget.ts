/**
 * How much room is left, in the unit the answer is actually needed in.
 *
 * Storage is the one resource this app can exhaust silently, and it fails at the worst
 * possible moment — forty minutes into a take. A byte count alone does not help: "3.2 GB of
 * 48 GB" does not answer the question anyone is asking, which is *how long can I record?*
 *
 * The Record panel already knows what a take costs per second (`capture/bitrate.ts`), so
 * dividing the free space by it turns the readout into something a person can act on. That
 * same conversion is what makes a threshold meaningful: a warning measured in minutes of
 * recording means something, a warning measured in percent does not.
 *
 * Pure on purpose — `check:math` asserts the arithmetic and both sides of every threshold.
 */

export type BudgetLevel = 'ok' | 'low' | 'critical';

/** Below this much recording headroom, say so. */
export const WARN_HEADROOM_SECONDS = 15 * 60;
/**
 * Below this, refuse to start a new take. Refusing is the kinder failure: a recording that
 * dies at minute 38 has already cost the thing it was recording.
 */
export const REFUSE_HEADROOM_SECONDS = 5 * 60;

/** Fractions of the quota left, for the library readout, which has no per-second rate. */
export const LOW_FREE_FRACTION = 0.1;
export const CRITICAL_FREE_FRACTION = 0.02;

export interface StorageBudget {
  usage: number;
  quota: number;
  free: number;
  /** What `navigator.storage.persisted()` said. Independent of how full it is. */
  persisted: boolean;
}

export function budgetOf(usage: number, quota: number, persisted = false): StorageBudget {
  const safeQuota = Math.max(0, quota);
  const safeUsage = Math.max(0, Math.min(usage, safeQuota || usage));
  return { usage: safeUsage, quota: safeQuota, free: Math.max(0, safeQuota - safeUsage), persisted };
}

/** Seconds of recording the free space holds. `Infinity` when nothing is being written. */
export function headroomSeconds(free: number, bytesPerSecond: number): number {
  if (!(bytesPerSecond > 0)) return Infinity;
  return Math.max(0, free) / bytesPerSecond;
}

/**
 * How alarmed to be. The headroom, where one is known, outranks the fraction: 400 MB left
 * is fine for editing an existing project and is four minutes of 4K screen capture.
 */
export function budgetLevel(budget: StorageBudget, headroom = Infinity): BudgetLevel {
  if (headroom <= REFUSE_HEADROOM_SECONDS) return 'critical';
  const fraction = budget.quota > 0 ? budget.free / budget.quota : 1;
  if (fraction <= CRITICAL_FREE_FRACTION) return 'critical';
  if (headroom <= WARN_HEADROOM_SECONDS || fraction <= LOW_FREE_FRACTION) return 'low';
  return 'ok';
}

/** Whether a new take may start at all. */
export function canStartRecording(free: number, bytesPerSecond: number): boolean {
  return headroomSeconds(free, bytesPerSecond) > REFUSE_HEADROOM_SECONDS;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Headroom as a phrase. Rounded down and hedged, because `quota` is a padded estimate and
 * a variable-bitrate encode is not a promise either — claiming "6 h 41 m" from two guesses
 * would be a precision the number does not have.
 */
export function formatHeadroom(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'plenty of room';
  if (seconds < 60) return 'under a minute';
  const total = Math.floor(seconds / 60);
  if (total < 60) return `about ${total} min`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `about ${hours} h` : `about ${hours} h ${minutes} m`;
}

/** The sentence beside the Record button. */
export function headroomNotice(free: number, bytesPerSecond: number): string {
  return `room for ${formatHeadroom(headroomSeconds(free, bytesPerSecond))}`;
}
