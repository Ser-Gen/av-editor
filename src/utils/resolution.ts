import type { LegacyProjectSettings, ProjectSettings, ResolutionPreset } from '../types/editor';

export function resolutionToSize(preset: ResolutionPreset): { width: number; height: number } {
  switch (preset) {
    case '480p':
      return { width: 854, height: 480 };
    case '720p':
      return { width: 1280, height: 720 };
    case '1080p':
      return { width: 1920, height: 1080 };
    case '4K':
      return { width: 3840, height: 2160 };
  }
}

export interface CanvasPreset {
  label: string;
  /** Groups the dropdown; also the honest name for the shape. */
  group: string;
  width: number;
  height: number;
}

export const CANVAS_PRESETS: CanvasPreset[] = [
  { group: 'Landscape 16:9', label: '480p — 854 × 480', width: 854, height: 480 },
  { group: 'Landscape 16:9', label: '720p — 1280 × 720', width: 1280, height: 720 },
  { group: 'Landscape 16:9', label: '1080p — 1920 × 1080', width: 1920, height: 1080 },
  { group: 'Landscape 16:9', label: '4K — 3840 × 2160', width: 3840, height: 2160 },
  { group: 'Vertical 9:16', label: '720 × 1280', width: 720, height: 1280 },
  { group: 'Vertical 9:16', label: '1080 × 1920', width: 1080, height: 1920 },
  { group: 'Square 1:1', label: '1080 × 1080', width: 1080, height: 1080 },
  { group: 'Portrait 4:5', label: '1080 × 1350', width: 1080, height: 1350 },
];

export const FPS_CHOICES = [24, 25, 30, 50, 60] as const;

export const MIN_CANVAS_DIMENSION = 16;
/** Beyond this no browser encoder has ever said yes, and the probe is slow enough to skip. */
export const MAX_CANVAS_DIMENSION = 7680;
export const MIN_FPS = 1;
export const MAX_FPS = 240;

export const DEFAULT_SETTINGS: ProjectSettings = { width: 1920, height: 1080, fps: 30 };

/** H.264 encodes in 16×16 macroblocks and refuses an odd dimension outright. */
export function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_CANVAS_DIMENSION;
  return toEven(Math.min(MAX_CANVAS_DIMENSION, Math.max(MIN_CANVAS_DIMENSION, value)));
}

export function clampFps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.fps;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(value)));
}

/**
 * Reads either shape of the settings object.
 *
 * There is no project persistence yet, so nothing on disk uses the old shape today. This
 * exists because the moment persistence lands, every project written before this phase would
 * otherwise open as a zero-sized canvas — a failure that would appear long after the change
 * that caused it.
 */
export function normalizeSettings(raw: unknown): ProjectSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const value = raw as Partial<ProjectSettings> & Partial<LegacyProjectSettings>;
  const fps = clampFps(value.fps ?? DEFAULT_SETTINGS.fps);
  if (typeof value.width === 'number' && typeof value.height === 'number') {
    return { width: clampDimension(value.width), height: clampDimension(value.height), fps };
  }
  if (typeof value.resolution === 'string') {
    const size = resolutionToSize(value.resolution);
    return { width: size.width, height: size.height, fps };
  }
  return { ...DEFAULT_SETTINGS, fps };
}

/** 1.7777… → "16:9". Falls back to the raw ratio for sizes with no tidy name. */
export function aspectLabel(width: number, height: number): string {
  const divisor = gcd(width, height);
  const w = width / divisor;
  const h = height / divisor;
  if (w <= 32 && h <= 32) return `${w}:${h}`;
  return `${(width / height).toFixed(2)}:1`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Whether two canvases are the same shape.
 *
 * The tolerance matters: 854×480 is not exactly 16:9 (1.7792 against 1.7778), and treating
 * 480p → 1080p as an aspect change would refit every clip in the project for what is really
 * a resolution bump. Half a percent covers the rounding in the standard sizes without
 * admitting anything a viewer would notice.
 */
export function sameAspect(
  from: { width: number; height: number },
  to: { width: number; height: number },
): boolean {
  const a = from.width / from.height;
  const b = to.width / to.height;
  return Math.abs(a - b) / Math.max(a, b) < 0.005;
}

/**
 * Asks the encoder whether it would accept this frame, so an impossible size is refused in
 * the dialog rather than at the end of an export. A browser without WebCodecs answers null:
 * the FFmpeg path has no such limit, so there is nothing to refuse.
 */
export async function encoderRejection(
  width: number,
  height: number,
  fps: number,
): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.640034',
      width,
      height,
      framerate: fps,
    });
    if (support.supported) return null;
    return `This browser's H.264 encoder will not accept ${width} × ${height}. Exports would fall back to FFmpeg.`;
  } catch {
    return `This browser's H.264 encoder will not accept ${width} × ${height}. Exports would fall back to FFmpeg.`;
  }
}
