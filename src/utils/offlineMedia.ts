/**
 * Offline media, and putting it back.
 *
 * Imported files are never copied into OPFS — a 4 GB import stays where the user put it and
 * only its identity is stored. So every reopened project starts with its imported assets
 * *offline*: they know their duration, size and whether they have sound, and have no bytes.
 * That is the normal path here, not an error path, which is why the timeline can still be
 * laid out, scrubbed and edited around it.
 *
 * Relinking is deliberately one picker for the whole project rather than one per file. The
 * matching below is what makes that possible: the user hands back a pile of files and each
 * one finds its own asset.
 *
 * Pure, and written against a structural `FileIdentity` rather than `File`, so `check:math`
 * can assert the matching without a DOM.
 */
import type { AssetFingerprint, Clip, MediaAsset } from '../types/editor';

export interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

/** How confidently a file was matched to the asset it is being offered for. */
export type MatchQuality = 'exact' | 'resized' | 'renamed';

export interface RelinkPair<F extends FileIdentity> {
  assetId: string;
  file: F;
  quality: MatchQuality;
}

export interface RelinkPlan<F extends FileIdentity> {
  pairs: RelinkPair<F>[];
  /** Files the user offered that no offline asset wanted. */
  unmatched: F[];
  /** Assets still without bytes afterwards. */
  stillOffline: string[];
}

export function isOffline(asset: MediaAsset | undefined): boolean {
  return !!asset && !asset.file;
}

export function fingerprintOf(file: FileIdentity): AssetFingerprint {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

/** Every asset in the library with no bytes behind it. */
export function offlineAssetIds(mediaLibrary: Record<string, MediaAsset>): string[] {
  return Object.keys(mediaLibrary)
    .filter((id) => isOffline(mediaLibrary[id]))
    .sort();
}

/** Clips that cannot render, because the file they point at is not here. */
export function offlineClipIds(
  clips: readonly Clip[],
  mediaLibrary: Record<string, MediaAsset>,
): string[] {
  return clips
    .filter((c) => 'assetId' in c && isOffline(mediaLibrary[c.assetId]))
    .map((c) => c.id);
}

/**
 * Which offered file belongs to which offline asset.
 *
 * Three passes, strongest first, so a folder containing both `holiday.mp4` and an older
 * `holiday.mp4` of a different size cannot have them swapped by luck of iteration order.
 * Each file is spent once and each asset filled once.
 */
export function planRelink<F extends FileIdentity>(
  files: readonly F[],
  assets: readonly Pick<MediaAsset, 'id' | 'name' | 'fingerprint'>[],
): RelinkPlan<F> {
  const pairs: RelinkPair<F>[] = [];
  const takenFiles = new Set<number>();
  const filled = new Set<string>();

  const sweep = (quality: MatchQuality, fits: (asset: (typeof assets)[number], file: F) => boolean) => {
    for (const asset of assets) {
      if (filled.has(asset.id)) continue;
      const index = files.findIndex((file, i) => !takenFiles.has(i) && fits(asset, file));
      if (index < 0) continue;
      takenFiles.add(index);
      filled.add(asset.id);
      pairs.push({ assetId: asset.id, file: files[index], quality });
    }
  };

  sweep(
    'exact',
    (asset, file) =>
      !!asset.fingerprint &&
      asset.fingerprint.name === file.name &&
      asset.fingerprint.size === file.size &&
      asset.fingerprint.lastModified === file.lastModified,
  );
  // Same file, re-saved or copied: a copy loses `lastModified` on some filesystems.
  sweep(
    'resized',
    (asset, file) =>
      !!asset.fingerprint && asset.fingerprint.name === file.name && asset.fingerprint.size === file.size,
  );
  // Name alone. Accepted, because refusing would strand the user, but reported as a guess.
  sweep('renamed', (asset, file) => (asset.fingerprint?.name ?? asset.name) === file.name);

  return {
    pairs,
    unmatched: files.filter((_, i) => !takenFiles.has(i)),
    stillOffline: assets.filter((a) => !filled.has(a.id)).map((a) => a.id),
  };
}

/**
 * What to tell the user afterwards. A `renamed` match is the one worth naming: it is the
 * only tier that can bind the wrong file, and the size difference is the evidence.
 */
export function relinkSummary<F extends FileIdentity>(plan: RelinkPlan<F>): string {
  if (plan.pairs.length === 0) {
    return plan.unmatched.length > 0
      ? `None of those ${plan.unmatched.length} file(s) matched anything that is offline.`
      : 'Nothing was relinked.';
  }
  const guessed = plan.pairs.filter((p) => p.quality === 'renamed').length;
  const parts = [`Relinked ${plan.pairs.length} file(s).`];
  if (guessed > 0) {
    parts.push(
      `${guessed} matched on name alone and may be a different cut — check those clips before exporting.`,
    );
  }
  if (plan.stillOffline.length > 0) parts.push(`${plan.stillOffline.length} still offline.`);
  if (plan.unmatched.length > 0) parts.push(`${plan.unmatched.length} unused.`);
  return parts.join(' ');
}

/**
 * Why an export must not start.
 *
 * A missing file renders as a placeholder card in the preview, which is honest on screen and
 * would be a silent black rectangle in a finished file. Blocking is the whole point: the
 * failure this prevents is discovering it after the upload.
 */
export function exportBlockedBy(
  clips: readonly Clip[],
  mediaLibrary: Record<string, MediaAsset>,
): string | null {
  const names = new Set<string>();
  for (const clip of clips) {
    if (!('assetId' in clip)) continue;
    const asset = mediaLibrary[clip.assetId];
    if (isOffline(asset)) names.add(asset?.name ?? clip.assetId);
  }
  if (names.size === 0) return null;
  const list = [...names].sort();
  const shown = list.slice(0, 3).join(', ');
  const rest = list.length > 3 ? ` and ${list.length - 3} more` : '';
  return `Cannot export: ${list.length} file(s) are offline — ${shown}${rest}. Relink them in the media library first.`;
}
