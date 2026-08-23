import type { Clip, MediaAsset } from '../types/editor';

function extFromName(name: string): string {
  const m = name.match(/\.(\w+)$/);
  return m ? m[1].toLowerCase() : 'dat';
}

/** Unique MEMFS paths for all assets referenced by clips (stable sort by asset id). */
export function collectAssetMemPaths(
  clips: Clip[],
  mediaLibrary: Record<string, MediaAsset>,
): { assetId: string; path: string; file: File }[] {
  const ids = new Set<string>();
  for (const clip of clips) {
    if ('assetId' in clip) ids.add(clip.assetId);
  }
  return [...ids]
    .sort()
    .flatMap((assetId) => {
      const asset = mediaLibrary[assetId];
      // An offline asset has no bytes to write into MEMFS. Export refuses to start when any
      // clip is offline (`exportBlockedBy`), so this is unreachable in practice — and
      // silently skipping is the only sane thing to do if it ever is reached.
      if (!asset?.file) return [];
      return [
        {
          assetId,
          path: `input_${assetId}.${extFromName(asset.name)}`,
          file: asset.file,
        },
      ];
    });
}
