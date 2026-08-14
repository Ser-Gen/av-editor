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
    .map((assetId) => {
      const asset = mediaLibrary[assetId];
      return {
        assetId,
        path: `input_${assetId}.${extFromName(asset.name)}`,
        file: asset.file,
      };
    });
}
