/**
 * Turning what a demuxer knows into what a person reads.
 *
 * Kept apart from the probe itself so `check:math` can assert the arithmetic — an aspect ratio
 * reduced wrongly or a frame rate rounded to the wrong side of 29.97 is the kind of mistake
 * that looks perfectly plausible in a screenshot.
 *
 * Pure: no DOM, no mediabunny values. The two mediabunny types used are imported as types,
 * which esbuild erases.
 */
import type { MediaCodec } from 'mediabunny';

/** What `inspectAsset` produces per track, and what these functions format. */
export interface TrackInfoBase {
  id: number;
  codec: MediaCodec | null;
  /** The full parameter string, e.g. `avc1.640028`. Null when the codec is unknown. */
  codecString: string | null;
  language: string | null;
  /** Whether this browser has a decoder for it — the question the window exists to answer. */
  canDecode: boolean;
  /** Bits per second the container claims, or null when it does not say. */
  bitrate: number | null;
}

export interface VideoTrackInfo extends TrackInfoBase {
  kind: 'video';
  codedWidth: number;
  codedHeight: number;
  /** After pixel-aspect correction and rotation — the size it actually appears at. */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  /** Mediabunny's reduced rational; `{ num: 1, den: 1 }` for ordinary square pixels. */
  pixelAspect: { num: number; den: number };
  colorSpace: {
    primaries?: string | null;
    transfer?: string | null;
    matrix?: string | null;
    fullRange?: boolean | null;
  };
  hdr: boolean;
  mayHaveAlpha: boolean;
  /** True for an all-intra file: every frame is a key frame, so it scrubs perfectly. */
  keyFramesOnly: boolean;
}

export interface AudioTrackInfo extends TrackInfoBase {
  kind: 'audio';
  channels: number;
  sampleRate: number;
}

export type TrackInfo = VideoTrackInfo | AudioTrackInfo;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * `h:mm:ss.mmm`, with the hour dropped when there isn't one.
 *
 * Milliseconds are shown because this is the window someone opens when a file's length is in
 * question, and "1:03" versus "1:03" hides exactly the discrepancy they came to find.
 */
export function formatPreciseDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  const ms = Math.round((seconds - whole) * 1000);
  // A value like 59.9996 rounds to 1000 ms, which would print as :59.1000.
  const carry = ms === 1000 ? 1 : 0;
  const total = whole + carry;
  const millis = carry ? 0 : ms;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const tail = `${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  return h > 0 ? `${h}:${tail}` : tail;
}

/**
 * Frame rates come out of a measurement, so they arrive as 29.969999999.
 *
 * Two decimals is what the broadcast rates need (29.97, 23.98, 59.94) and a whole number is
 * what everything else is, so a rate that is a whole number to within a thousandth prints as
 * one. Printing "30.00 fps" for a 30 fps file suggests a precision that was never measured.
 */
export function formatFrameRate(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '—';
  const rounded = Math.round(fps);
  if (Math.abs(fps - rounded) < 0.001) return `${rounded} fps`;
  return `${fps.toFixed(2)} fps`;
}

export function formatSampleRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** The names people use, and a plain count for the layouts that have no common name. */
export function formatChannels(count: number): string {
  if (count === 1) return 'mono';
  if (count === 2) return 'stereo';
  if (count === 6) return '5.1';
  if (count === 8) return '7.1';
  return `${count} channels`;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * `16:9` and friends, reduced.
 *
 * Rounded to the nearest thousandth before reducing, because a display size derived from a
 * pixel aspect ratio is not exactly integral — 1918×1080 reduces to 959:540, which is true and
 * useless. Snapping to a common ratio when it is within half a percent is what makes this
 * readable, and the exact pixel sizes are printed beside it anyway.
 */
const COMMON_RATIOS: [number, number][] = [
  [16, 9], [4, 3], [21, 9], [1, 1], [9, 16], [3, 4], [3, 2], [2, 3], [5, 4], [16, 10],
];

export function aspectRatio(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '—';
  const value = width / height;
  for (const [w, h] of COMMON_RATIOS) {
    if (Math.abs(value - w / h) / (w / h) < 0.005) return `${w}:${h}`;
  }
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

/**
 * The colour space, in the order that matters and without the parts the file did not say.
 *
 * A container is allowed to describe none, some or all of this, and an absent field is not the
 * same as a default — it means nobody wrote it down. Listing only what is there says that.
 */
export function describeColorSpace(space: {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}): string {
  const parts: string[] = [];
  if (space.primaries) parts.push(space.primaries);
  if (space.transfer) parts.push(space.transfer);
  if (space.matrix) parts.push(space.matrix);
  if (space.fullRange === true) parts.push('full range');
  if (space.fullRange === false) parts.push('limited range');
  return parts.length > 0 ? parts.join(' · ') : 'not stated';
}

export function describeRotation(degrees: number): string {
  const normalized = ((Math.round(degrees) % 360) + 360) % 360;
  return normalized === 0 ? 'none' : `${normalized}°`;
}

export function formatBitrateValue(bits: number | null): string {
  if (bits === null || !Number.isFinite(bits) || bits <= 0) return '—';
  return bits >= 1_000_000 ? `${(bits / 1_000_000).toFixed(2)} Mbps` : `${Math.round(bits / 1000)} kbps`;
}

/**
 * The headline: can this browser play the file, and if not, which part of it cannot.
 *
 * This is the sentence the window exists for. An export that declines the fast path names the
 * file but not the reason, and the reason is always one of these three answers.
 */
export function decodeSummary(tracks: TrackInfo[]): string {
  if (tracks.length === 0) return 'No video or audio tracks in this file.';
  const bad = tracks.filter((t) => !t.canDecode);
  if (bad.length === 0) {
    return tracks.length === 1
      ? 'This browser can decode this track.'
      : 'This browser can decode every track in this file.';
  }
  if (bad.length === tracks.length) {
    return 'This browser cannot decode this file. Export will fall back to FFmpeg.';
  }
  const kinds = [...new Set(bad.map((t) => t.kind))].join(' and ');
  return `This browser cannot decode the ${kinds} track. Export will fall back to FFmpeg.`;
}

/** `H.264` reads better than `avc` in a list a person is scanning. */
const CODEC_LABELS: Partial<Record<string, string>> = {
  avc: 'H.264 / AVC',
  hevc: 'H.265 / HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
};

export function codecLabel(codec: MediaCodec | null): string {
  if (!codec) return 'unknown';
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}
