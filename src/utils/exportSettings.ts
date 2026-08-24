/**
 * What one exported file should be, as opposed to what the project is.
 *
 * The presets exist because the interesting choice is almost never "how many bits per second"
 * — it is "archive this", "put this on the web", or "send this to someone". Each preset sets
 * bitrate, keyframe interval and audio together, because they are not independent: a file with
 * a master's bitrate and a small file's keyframe spacing is neither.
 *
 * Bitrate is derived from the *pixel rate* rather than fixed, so "Web" means the same thing at
 * 720p and at 4K. A fixed number would be generous at one size and unusable at the other.
 */
import type {
  AudioFormat,
  ExportOutput,
  ExportQuality,
  ExportSettings,
  ProjectSettings,
} from '../types/editor';

/**
 * The enum values a project file is allowed to contain. Listed here rather than derived from
 * the format table, which lives in `audioExport.ts` and imports this module — the dependency
 * only runs one way.
 */
const QUALITIES: ExportQuality[] = ['master', 'web', 'small'];
const OUTPUTS: ExportOutput[] = ['video', 'audio'];
const AUDIO_FORMAT_NAMES: AudioFormat[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg'];

interface QualityPreset {
  label: string;
  description: string;
  /** Bits per pixel per frame. The whole quality ladder is this one number. */
  bitsPerPixel: number;
  keyframeInterval: number;
  audioBitrate: number;
}

export const QUALITY_PRESETS: Record<ExportQuality, QualityPreset> = {
  master: {
    label: 'Master',
    description: 'For archiving or re-editing. Large files, keyframes every second.',
    bitsPerPixel: 0.15,
    keyframeInterval: 1,
    audioBitrate: 256_000,
  },
  web: {
    label: 'Web',
    description: 'For uploading or embedding. The balance this editor has always shipped.',
    bitsPerPixel: 0.08,
    keyframeInterval: 2,
    audioBitrate: 192_000,
  },
  small: {
    label: 'Small',
    description: 'For messaging and review copies. Noticeably softer on detailed footage.',
    bitsPerPixel: 0.04,
    keyframeInterval: 4,
    audioBitrate: 128_000,
  },
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  output: 'video',
  quality: 'web',
  videoBitrate: null,
  keyframeInterval: QUALITY_PRESETS.web.keyframeInterval,
  audioBitrate: QUALITY_PRESETS.web.audioBitrate,
  audioChannels: 2,
  audioFormat: 'mp3',
  // The rate the whole app mixes at. 44.1 kHz is offered but not the default: matching the
  // mix means an export resamples nothing.
  audioSampleRate: 48_000,
  width: null,
  height: null,
  fps: null,
};

/**
 * An export settings object read from a project file, with anything missing filled in.
 *
 * Every field added to `ExportSettings` since the project format was frozen arrives as
 * `undefined` in a project written before it — the file is read back with a cast, not a
 * schema. Merging the defaults underneath means an older project opens with a working
 * setting instead of an empty control, and it covers the next field added as well as this one.
 */
export function repairExportSettings(raw: unknown): ExportSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_EXPORT_SETTINGS };
  }
  const stored = raw as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...DEFAULT_EXPORT_SETTINGS };
  for (const key of Object.keys(DEFAULT_EXPORT_SETTINGS)) {
    // `null` is meaningful for the override fields, so only `undefined` falls back.
    if (stored[key] !== undefined) merged[key] = stored[key];
  }
  // The three enum fields are used as lookup keys — by the quality table, the audio format
  // table and the export branch. An unrecognised one would not degrade, it would throw on a
  // property of undefined, so a value nobody knows is treated the same as no value at all.
  if (!QUALITIES.includes(merged.quality as ExportQuality)) {
    merged.quality = DEFAULT_EXPORT_SETTINGS.quality;
  }
  if (!OUTPUTS.includes(merged.output as ExportOutput)) {
    merged.output = DEFAULT_EXPORT_SETTINGS.output;
  }
  if (!AUDIO_FORMAT_NAMES.includes(merged.audioFormat as AudioFormat)) {
    merged.audioFormat = DEFAULT_EXPORT_SETTINGS.audioFormat;
  }
  return merged as unknown as ExportSettings;
}

/** Everything the encoders actually need, with presets and overrides already resolved. */
export interface ResolvedExport {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  keyframeInterval: number;
  audioBitrate: number;
  audioChannels: number;
  /** True when the output differs from the project's own frame size. */
  scaled: boolean;
}

export function derivedBitrate(quality: ExportQuality, width: number, height: number, fps: number): number {
  const bits = QUALITY_PRESETS[quality].bitsPerPixel * width * height * fps;
  // Floored so a tiny frame still gets a usable stream, and capped so a 4K master does not
  // ask for a bitrate no hardware encoder will honour anyway.
  return Math.round(Math.min(120_000_000, Math.max(200_000, bits)));
}

export function resolveExport(
  exportSettings: ExportSettings,
  project: ProjectSettings,
): ResolvedExport {
  const width = exportSettings.width ?? project.width;
  const height = exportSettings.height ?? project.height;
  const fps = exportSettings.fps ?? project.fps;
  return {
    width,
    height,
    fps,
    videoBitrate:
      exportSettings.videoBitrate ?? derivedBitrate(exportSettings.quality, width, height, fps),
    keyframeInterval: exportSettings.keyframeInterval,
    audioBitrate: exportSettings.audioBitrate,
    audioChannels: exportSettings.audioChannels,
    scaled: width !== project.width || height !== project.height,
  };
}

/** Applying a preset resets the fields it owns, leaving the size and rate overrides alone. */
export function applyQuality(settings: ExportSettings, quality: ExportQuality): ExportSettings {
  const preset = QUALITY_PRESETS[quality];
  return {
    ...settings,
    quality,
    videoBitrate: null,
    keyframeInterval: preset.keyframeInterval,
    audioBitrate: preset.audioBitrate,
  };
}

export function formatBitrate(bits: number): string {
  return bits >= 1_000_000 ? `${(bits / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bits / 1000)} kbps`;
}

/** Rough finished size, for the sentence that stops someone exporting a 40 GB file by accident. */
export function estimateBytes(resolved: ResolvedExport, durationSeconds: number): number {
  return ((resolved.videoBitrate + resolved.audioBitrate) / 8) * durationSeconds;
}
