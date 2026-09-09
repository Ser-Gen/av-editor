/**
 * How the library list is arranged: grouped, sorted, filtered.
 *
 * All three are a *view*, not an edit. `libraryOrder` lives inside `docSnapshot()` and is
 * undoable, because dragging a file up the list is something you did to the project. Choosing
 * to look at things by date is not, and pressing undo after changing the sort must undo your
 * last edit — so nothing in this file touches the document. The chosen view is session state,
 * persisted to `localStorage` beside the library tab.
 *
 * Pure, so `check:math` can hold it to its word.
 */
import type { AssetOrigin, AssetType, MediaAsset } from '../types/editor';

export type LibraryGroup = 'none' | 'type' | 'origin' | 'date';
export type LibrarySort = 'custom' | 'name' | 'duration' | 'size' | 'added';
export type SortDirection = 'asc' | 'desc';

export interface LibraryView {
  group: LibraryGroup;
  sort: LibrarySort;
  direction: SortDirection;
  query: string;
}

export const DEFAULT_LIBRARY_VIEW: LibraryView = {
  group: 'none',
  sort: 'custom',
  direction: 'asc',
  query: '',
};

export const GROUP_LABELS: Record<LibraryGroup, string> = {
  none: 'Flat',
  type: 'Type',
  origin: 'Where from',
  date: 'Date added',
};

export const SORT_LABELS: Record<LibrarySort, string> = {
  custom: 'My order',
  name: 'Name',
  duration: 'Duration',
  size: 'Size',
  added: 'Date added',
};

const TYPE_GROUP: Record<AssetType, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Images',
};

/**
 * Origin is the grouping that pays for itself immediately: it is also the split that says
 * which files are taking up the quota, since imported media is never copied.
 */
const ORIGIN_GROUP: Record<AssetOrigin, string> = {
  recorded: 'Recorded here',
  derived: 'Made by a preset',
  pasted: 'Pasted in',
  imported: 'Imported',
};

const ORIGIN_ORDER: AssetOrigin[] = ['recorded', 'derived', 'pasted', 'imported'];
const TYPE_ORDER: AssetType[] = ['video', 'audio', 'image'];

export interface LibrarySection {
  label: string;
  assets: MediaAsset[];
}

/** Bytes we can actually account for. An imported file is never copied, so its size is its own. */
export function assetSize(asset: MediaAsset): number {
  return asset.file?.size ?? 0;
}

export function filterAssets(assets: MediaAsset[], query: string): MediaAsset[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return assets;
  return assets.filter(
    (a) =>
      a.name.toLowerCase().includes(needle) ||
      // The preset that made a file is often the only thing you remember about it.
      (a.derivedFrom?.presetLabel ?? '').toLowerCase().includes(needle),
  );
}

/**
 * `custom` returns the list exactly as given — which is `libraryOrder`, the document's own
 * order — and is the only sort that ignores `direction`.
 */
export function sortAssets(
  assets: MediaAsset[],
  sort: LibrarySort,
  direction: SortDirection = 'asc',
): MediaAsset[] {
  if (sort === 'custom') return assets;

  const sign = direction === 'desc' ? -1 : 1;
  const out = [...assets];
  out.sort((a, b) => {
    switch (sort) {
      case 'name':
        return sign * a.name.localeCompare(b.name, undefined, { numeric: true });
      case 'duration':
        return sign * (a.duration - b.duration);
      case 'size':
        return sign * (assetSize(a) - assetSize(b));
      case 'added': {
        // An asset from before `addedAt` existed sorts last in either direction rather than
        // claiming a date it does not have.
        if (a.addedAt === undefined && b.addedAt === undefined) return 0;
        if (a.addedAt === undefined) return 1;
        if (b.addedAt === undefined) return -1;
        return sign * (a.addedAt - b.addedAt);
      }
    }
  });
  return out;
}

/** Midnight local, so "today" means the day you are having, not 24 hours ago. */
function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateGroupLabel(addedAt: number | undefined, now: number): string {
  if (addedAt === undefined) return 'Earlier';
  const today = startOfDay(now);
  const day = 86_400_000;
  if (addedAt >= today) return 'Today';
  if (addedAt >= today - day) return 'Yesterday';
  if (addedAt >= today - 7 * day) return 'This week';
  if (addedAt >= today - 30 * day) return 'This month';
  return 'Earlier';
}

const DATE_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier'];

export function groupAssets(
  assets: MediaAsset[],
  group: LibraryGroup,
  now: number = Date.now(),
): LibrarySection[] {
  if (group === 'none') return [{ label: '', assets }];

  const buckets = new Map<string, MediaAsset[]>();
  const push = (label: string, asset: MediaAsset) => {
    const list = buckets.get(label);
    if (list) list.push(asset);
    else buckets.set(label, [asset]);
  };

  for (const asset of assets) {
    if (group === 'type') push(TYPE_GROUP[asset.type], asset);
    else if (group === 'origin') push(ORIGIN_GROUP[asset.origin] ?? ORIGIN_GROUP.imported, asset);
    else push(dateGroupLabel(asset.addedAt, now), asset);
  }

  // A fixed order, so a section does not jump around as files arrive.
  const order =
    group === 'type'
      ? TYPE_ORDER.map((t) => TYPE_GROUP[t])
      : group === 'origin'
        ? ORIGIN_ORDER.map((o) => ORIGIN_GROUP[o])
        : DATE_ORDER;

  return order
    .filter((label) => buckets.has(label))
    .map((label) => ({ label, assets: buckets.get(label) as MediaAsset[] }));
}

/** Filter, then sort, then group — the order that makes each step see the whole list. */
export function arrangeLibrary(
  assets: MediaAsset[],
  view: LibraryView,
  now: number = Date.now(),
): LibrarySection[] {
  return groupAssets(sortAssets(filterAssets(assets, view.query), view.sort, view.direction), view.group, now);
}
