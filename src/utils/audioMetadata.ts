/**
 * Descriptive metadata: what the file says it is, as opposed to what it contains.
 *
 * Mediabunny normalizes these across containers, so one set of fields lands as ID3v2 frames in
 * an MP3, `ilst` atoms in an M4A, Vorbis comments in FLAC and Ogg, and RIFF chunks in a WAV.
 * That is why this is a flat form and not a per-format one.
 *
 * Deliberately *not* part of the undo document yet. Tags are session state: they survive
 * closing the dialog and exporting twice, and are gone when the tab reloads. Promoting them
 * into the project is a matter of moving the field into `EditorDoc` and routing
 * `setAudioMetadata` through `commit` — everything else here already serializes.
 *
 * Pure: `check:math` imports this. The one mediabunny type is imported as a type only.
 */
import type { MetadataTags } from 'mediabunny';

export interface AudioMetadata {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  comment: string;
  lyrics: string;
  trackNumber: number | null;
  tracksTotal: number | null;
  discNumber: number | null;
  discsTotal: number | null;
  /** ISO `yyyy-mm-dd`, which is what `<input type="date">` reads and writes. */
  date: string;
  /** An image asset in the media library, or null. Bytes are fetched at export time. */
  coverAssetId: string | null;
}

export const EMPTY_AUDIO_METADATA: AudioMetadata = {
  title: '',
  artist: '',
  album: '',
  albumArtist: '',
  genre: '',
  comment: '',
  lyrics: '',
  trackNumber: null,
  tracksTotal: null,
  discNumber: null,
  discsTotal: null,
  date: '',
  coverAssetId: null,
};

/** The text fields, in the order the form shows them. */
export const METADATA_TEXT_FIELDS: {
  key: 'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'comment' | 'lyrics';
  label: string;
  multiline?: boolean;
}[] = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'albumArtist', label: 'Album artist' },
  { key: 'genre', label: 'Genre' },
  { key: 'comment', label: 'Comment', multiline: true },
  { key: 'lyrics', label: 'Lyrics', multiline: true },
];

export function metadataIsEmpty(meta: AudioMetadata): boolean {
  return (
    METADATA_TEXT_FIELDS.every(({ key }) => meta[key].trim().length === 0) &&
    meta.trackNumber === null &&
    meta.tracksTotal === null &&
    meta.discNumber === null &&
    meta.discsTotal === null &&
    meta.date === '' &&
    meta.coverAssetId === null
  );
}

/** How many fields are filled in — the count next to the disclosure. */
export function metadataFieldCount(meta: AudioMetadata): number {
  let count = METADATA_TEXT_FIELDS.filter(({ key }) => meta[key].trim().length > 0).length;
  for (const n of [meta.trackNumber, meta.tracksTotal, meta.discNumber, meta.discsTotal]) {
    if (n !== null) count++;
  }
  if (meta.date !== '') count++;
  if (meta.coverAssetId !== null) count++;
  return count;
}

/**
 * A date typed as `yyyy-mm-dd` is a calendar date, not an instant.
 *
 * `new Date('2026-08-25')` parses as UTC midnight, which in any timezone west of Greenwich is
 * the day before — the tag would read 2026-08-24 for anyone in the Americas. Building it from
 * the parts keeps the date the one that was typed.
 */
export function parseTagDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface CoverImage {
  data: Uint8Array;
  mimeType: string;
  name?: string;
}

/**
 * Turns the form into mediabunny's tags.
 *
 * Blank fields are *absent*, never written empty: an empty ID3 frame is not the same as no
 * frame — players show it as a title of one space, and taggers preserve it. Whatever the user
 * did not fill in should leave no trace in the file.
 */
export function toMetadataTags(meta: AudioMetadata, cover?: CoverImage | null): MetadataTags {
  const tags: MetadataTags = {};
  const text = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const assign = <K extends keyof MetadataTags>(key: K, value: MetadataTags[K] | undefined) => {
    if (value !== undefined) tags[key] = value;
  };

  assign('title', text(meta.title));
  assign('artist', text(meta.artist));
  assign('album', text(meta.album));
  assign('albumArtist', text(meta.albumArtist));
  assign('genre', text(meta.genre));
  assign('comment', text(meta.comment));
  assign('lyrics', text(meta.lyrics));
  assign('trackNumber', meta.trackNumber ?? undefined);
  assign('tracksTotal', meta.tracksTotal ?? undefined);
  assign('discNumber', meta.discNumber ?? undefined);
  assign('discsTotal', meta.discsTotal ?? undefined);

  const date = parseTagDate(meta.date);
  if (date) tags.date = date;

  if (cover) {
    tags.images = [
      {
        data: cover.data,
        mimeType: cover.mimeType,
        kind: 'coverFront',
        ...(cover.name ? { name: cover.name } : {}),
      },
    ];
  }

  return tags;
}

/**
 * The same tags as `-metadata` arguments, for the FFmpeg fallback.
 *
 * FFmpeg's key names are its own, not mediabunny's, and the two differ in exactly the places
 * that matter (`album_artist`, `track`, `disc`). Cover art is not here: attaching an image
 * through FFmpeg means a second input and a second `-map`, which is a different shape of
 * change than adding a flag — the fast path is where artwork gets written.
 */
export function ffmpegMetadataArgs(meta: AudioMetadata): string[] {
  const args: string[] = [];
  const push = (key: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 0) args.push('-metadata', `${key}=${trimmed}`);
  };

  push('title', meta.title);
  push('artist', meta.artist);
  push('album', meta.album);
  push('album_artist', meta.albumArtist);
  push('genre', meta.genre);
  push('comment', meta.comment);
  push('lyrics', meta.lyrics);
  // "3/12" is the conventional form, and the total is only meaningful beside the number.
  if (meta.trackNumber !== null) {
    push('track', meta.tracksTotal !== null ? `${meta.trackNumber}/${meta.tracksTotal}` : String(meta.trackNumber));
  }
  if (meta.discNumber !== null) {
    push('disc', meta.discsTotal !== null ? `${meta.discNumber}/${meta.discsTotal}` : String(meta.discNumber));
  }
  if (parseTagDate(meta.date)) push('date', meta.date.trim());

  return args;
}

/**
 * Which of WAVE's two metadata homes to use.
 *
 * A RIFF INFO LIST is the default and the one other editors read, but it holds only short
 * text — no cover art and no lyrics. Rather than silently dropping those, the file switches to
 * an ID3 chunk when they are present: less conventional inside a WAV, but understood by most
 * taggers, and it keeps what was typed.
 */
export function wavMetadataFormat(meta: AudioMetadata): 'info' | 'id3' {
  const rich = meta.coverAssetId !== null || meta.lyrics.trim().length > 0;
  return rich ? 'id3' : 'info';
}
