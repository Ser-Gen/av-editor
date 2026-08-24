/**
 * Turning the tag form into tags an `Output` will accept, cover art included.
 *
 * Shared by both outputs: an MP4 carries the same descriptive fields as an MP3, and having
 * one place that assembles them is what stops the video export from quietly saying less about
 * a file than the audio export does.
 *
 * The cover is the only field that has to be *fetched*, and the only one that can fail — the
 * image it names is an ordinary library asset, which after a reopen is offline until relinked.
 * That is a notice, never an error: an export refused over artwork would be absurd.
 */
import type { MetadataTags } from 'mediabunny';
import type { MediaAsset } from '../types/editor';
import type { AudioMetadata } from '../utils/audioMetadata';
import { toMetadataTags } from '../utils/audioMetadata';

export interface BuiltTags {
  tags: MetadataTags;
  /** What could not be included, in a sentence, or null when everything was. */
  warning: string | null;
}

/** Browsers leave `File.type` empty for files dragged from some places; the name still knows. */
function imageMimeType(asset: MediaAsset): string {
  if (asset.file?.type) return asset.file.type;
  const ext = asset.name.slice(asset.name.lastIndexOf('.')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

export async function buildMetadataTags(
  meta: AudioMetadata,
  mediaLibrary: Record<string, MediaAsset>,
  /** Fields the app fills in itself. Anything typed into the form overrides them. */
  fallback: MetadataTags = {},
): Promise<BuiltTags> {
  let warning: string | null = null;
  let cover: { data: Uint8Array; mimeType: string; name: string } | null = null;

  if (meta.coverAssetId) {
    const asset = mediaLibrary[meta.coverAssetId];
    if (!asset) {
      warning = 'The cover image is no longer in the library, so it was left out.';
    } else if (!asset.file) {
      warning = `The cover image "${asset.name}" is offline, so it was left out. Relink it to include it.`;
    } else {
      try {
        cover = {
          data: new Uint8Array(await asset.file.arrayBuffer()),
          mimeType: imageMimeType(asset),
          name: asset.name,
        };
      } catch {
        // A File handle can go stale — the file moved or was deleted since it was picked, and
        // the read throws rather than returning nothing. Still not a reason to refuse an export.
        warning = `The cover image "${asset.name}" could not be read, so it was left out.`;
      }
    }
  }

  return { tags: { ...fallback, ...toMetadataTags(meta, cover) }, warning };
}
