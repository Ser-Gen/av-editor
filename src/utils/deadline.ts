/**
 * Waiting on something outside the page, with a way out.
 *
 * Starting a recording is a chain of awaits on things this app does not control: a picker,
 * two permission prompts, a track reconfiguration, a worker, the disk. Every one of them
 * can sit there forever without ever rejecting, and an await with no deadline turns that
 * into a Record button that is disabled, a status line that is stale, and no way out but
 * reloading the page and losing the project. `ChunkSink` already learned this the hard way
 * and grew its own timeout; these are the same lesson, factored out.
 *
 * The distinction that matters is between a wait that can be *given up on* and one that can
 * only be *escaped*:
 *
 * - Given up on: an optimisation whose failure has a defined fallback — asking a track to
 *   resize. `settleWithin` stops waiting and the caller carries on with what it already had.
 * - Escaped: a wait only the user can end, because only they know whether the picker is
 *   still on screen. There is no honest timeout for "how long should someone take to choose
 *   a window", so these get `stalledNote` and a Cancel button instead of a deadline.
 */

export type Settled<T> = { ok: true; value: T } | { ok: false };

/**
 * Waits for `promise`, but not past `ms`.
 *
 * `{ ok: false }` means the wait was abandoned, not that it failed — the promise may still
 * settle later, and the caller has to be able to live with that. A rejection is reported
 * the same way, because both mean the same thing to a caller with a fallback: it did not
 * happen, carry on without it.
 */
export function settleWithin<T>(promise: PromiseLike<T>, ms: number): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let done = false;
    const settle = (result: Settled<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false }), ms);
    promise.then(
      (value) => settle({ ok: true, value }),
      () => settle({ ok: false }),
    );
  });
}
