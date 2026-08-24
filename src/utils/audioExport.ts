/**
 * What an audio-only export should be.
 *
 * The video side resolves a preset into a bitrate scaled by pixel rate, because "Web" has to
 * mean the same thing at 720p and at 4K. Audio has no equivalent problem: 192 kbps is 192 kbps
 * whatever the project is, so the choice here is the *format* — what you intend to do with the
 * file — and the bitrate is a plain number underneath it.
 *
 * Pure: no DOM, no mediabunny values (the codec names are compared as strings, and the one
 * mediabunny type used is imported as a type, which esbuild erases). `check:math` imports this.
 */
import type { AudioCodec } from 'mediabunny';
import type { AudioFormat, ExportSettings } from '../types/editor';

interface FormatSpec {
  label: string;
  /** Including the dot, and not always mediabunny's own: see `m4a` below. */
  extension: string;
  mimeType: string;
  codec: AudioCodec;
  /** Lossless formats ignore the bitrate control entirely. */
  lossless: boolean;
  /** Bitrates offered in the UI, or null when the format has no such choice. */
  bitrates: number[] | null;
  /** One sentence: what this format is for. */
  description: string;
}

export const AUDIO_BITRATE_CHOICES = [96_000, 128_000, 192_000, 256_000, 320_000];

/** 44.1 kHz is what an MP3 is conventionally delivered at; 48 kHz is what the app mixes at. */
export const AUDIO_SAMPLE_RATES = [48_000, 44_100];

export const AUDIO_FORMATS: Record<AudioFormat, FormatSpec> = {
  mp3: {
    label: 'MP3',
    extension: '.mp3',
    mimeType: 'audio/mpeg',
    codec: 'mp3',
    lossless: false,
    bitrates: AUDIO_BITRATE_CHOICES,
    description: 'Plays everywhere, including on things that play nothing else.',
  },
  m4a: {
    label: 'M4A (AAC)',
    // Mediabunny's Mp4OutputFormat reports '.mp4', which is wrong for a file with no picture:
    // players and phones treat a .mp4 with no video track as a broken video.
    extension: '.m4a',
    mimeType: 'audio/mp4',
    codec: 'aac',
    lossless: false,
    bitrates: AUDIO_BITRATE_CHOICES,
    description: 'Better than MP3 at the same size. The default on Apple devices.',
  },
  ogg: {
    label: 'Ogg (Opus)',
    extension: '.ogg',
    mimeType: 'audio/ogg',
    codec: 'opus',
    lossless: false,
    bitrates: AUDIO_BITRATE_CHOICES,
    description: 'The best of these at low bitrates — good for speech and long calls.',
  },
  wav: {
    label: 'WAV',
    extension: '.wav',
    mimeType: 'audio/wav',
    codec: 'pcm-s16',
    lossless: true,
    bitrates: null,
    description: 'Uncompressed, for handing to another editor. Large, and always works.',
  },
  flac: {
    label: 'FLAC',
    extension: '.flac',
    mimeType: 'audio/flac',
    codec: 'flac',
    lossless: true,
    bitrates: null,
    description: 'Lossless but compressed, for archiving. About half the size of WAV.',
  },
};

export const AUDIO_FORMAT_ORDER: AudioFormat[] = ['mp3', 'm4a', 'ogg', 'wav', 'flac'];

/** Everything the audio encoder and muxer need, with the format's own rules applied. */
export interface ResolvedAudioExport {
  format: AudioFormat;
  codec: AudioCodec;
  /** Bits per second. Zero for lossless formats, which have no such setting. */
  bitrate: number;
  sampleRate: number;
  channels: number;
  extension: string;
  mimeType: string;
  lossless: boolean;
}

export function resolveAudioExport(settings: ExportSettings): ResolvedAudioExport {
  const spec = AUDIO_FORMATS[settings.audioFormat] ?? AUDIO_FORMATS.mp3;
  return {
    format: settings.audioFormat,
    codec: spec.codec,
    // Lossless formats are given 0 rather than the leftover number from the last lossy choice,
    // so nothing downstream can pass a meaningless bitrate to an encoder that would honour it.
    bitrate: spec.lossless ? 0 : settings.audioBitrate,
    sampleRate: settings.audioSampleRate,
    channels: settings.audioChannels,
    extension: spec.extension,
    mimeType: spec.mimeType,
    lossless: spec.lossless,
  };
}

/** Bytes per second of uncompressed 16-bit PCM at this rate and channel count. */
export function pcmBytesPerSecond(sampleRate: number, channels: number): number {
  return sampleRate * channels * 2;
}

/**
 * Rough finished size — the sentence that stops someone exporting an hour of WAV by accident.
 *
 * FLAC is an estimate of an estimate: real ratios run from about 0.4 on speech to 0.7 on dense
 * music, and 0.6 is the middle of that. It is labelled "about" in the UI for this reason.
 */
export const FLAC_RATIO = 0.6;
/** The RIFF header ahead of the samples. Immaterial for anything long, wrong to omit. */
const WAV_HEADER_BYTES = 44;

export function estimateAudioBytes(resolved: ResolvedAudioExport, seconds: number): number {
  const pcm = pcmBytesPerSecond(resolved.sampleRate, resolved.channels) * seconds;
  if (resolved.format === 'wav') return Math.round(pcm + WAV_HEADER_BYTES);
  if (resolved.format === 'flac') return Math.round(pcm * FLAC_RATIO);
  return Math.round((resolved.bitrate / 8) * seconds);
}

/**
 * The name the file is downloaded as.
 *
 * A title that has been typed is a better name than a timestamp, so it wins — but only after
 * being stripped of everything a file system objects to. A title made entirely of such
 * characters leaves nothing behind, which is why the fallback is checked after cleaning
 * rather than before.
 */
export function audioFileName(title: string, resolved: ResolvedAudioExport, now: number): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const stem = cleaned.length > 0 ? cleaned : `export_${now}`;
  return `${stem}${resolved.extension}`;
}

/** `MP3 · 192 kbps` / `WAV · 48 kHz` — the toolbar button's label in audio mode. */
export function audioSummary(resolved: ResolvedAudioExport): string {
  const spec = AUDIO_FORMATS[resolved.format] ?? AUDIO_FORMATS.mp3;
  const rate = resolved.lossless
    ? `${(resolved.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`
    : `${Math.round(resolved.bitrate / 1000)} kbps`;
  return `${spec.label} · ${rate}`;
}
