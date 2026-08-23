/**
 * How big the panels around the timeline are allowed to be, and which tab is showing.
 *
 * Pure on purpose: a panel that can be dragged to zero width, or a tab that stays selected
 * after the thing it edits is deselected, are both bugs you only notice by hitting them.
 * The rules live here so they can be asserted instead.
 */

/** Narrow enough to be a strip, wide enough for the overlay stage to still be usable. */
export const PANEL_MIN_WIDTH = 180;
/** Neither sidebar may eat the preview: at most this much of the window each. */
export const PANEL_MAX_FRACTION = 0.42;
export const TIMELINE_MIN_HEIGHT = 140;
/** Room the preview and toolbar need above the timeline, whatever the window height. */
export const TIMELINE_TOP_RESERVE = 220;

export function clampPanelWidth(px: number, viewportWidth: number): number {
  if (!Number.isFinite(px)) return PANEL_MIN_WIDTH;
  const max = Math.max(PANEL_MIN_WIDTH, Math.round(viewportWidth * PANEL_MAX_FRACTION));
  return Math.min(max, Math.max(PANEL_MIN_WIDTH, Math.round(px)));
}

export function clampTimelineHeight(px: number, viewportHeight: number): number {
  if (!Number.isFinite(px)) return TIMELINE_MIN_HEIGHT;
  const max = Math.max(TIMELINE_MIN_HEIGHT, Math.round(viewportHeight - TIMELINE_TOP_RESERVE));
  return Math.min(max, Math.max(TIMELINE_MIN_HEIGHT, Math.round(px)));
}

/**
 * Which tab to show, given what this selection actually offers.
 *
 * Tabs come and go with the selection — an audio clip has no placement to edit — so the
 * remembered choice is a preference, not a guarantee. Honour it when it is still on offer,
 * otherwise fall to the first tab there is, and say so plainly when there are none.
 */
export function resolveTab<T extends string>(
  available: readonly T[],
  wanted: T | null | undefined,
): T | null {
  if (wanted && available.includes(wanted)) return wanted;
  return available[0] ?? null;
}
