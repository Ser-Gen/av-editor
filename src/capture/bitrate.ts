/**
 * What a captured video stream is worth encoding at.
 *
 * The recorder used mediabunny's `QUALITY_HIGH`, which derives a bitrate from the pixel
 * count and nothing else. That was fine while everything recorded at 30 fps and is not
 * fine now: at 60 the same budget is spread over twice as many frames, so the picture gets
 * worse precisely when the capture gets smoother — the opposite of what asking for 60 was
 * meant to buy.
 *
 * So the frame rate enters explicitly. It enters as a square root rather than linearly,
 * because consecutive frames at 60 fps are more alike than at 30 and the encoder spends
 * less on each of them: doubling the rate costs about 40% more bits, not 100%. The spatial
 * half is deliberately mediabunny's own curve, so a 30 fps capture encodes at exactly the
 * bitrate it always did and this change moves nothing that was already right.
 */

/** 1080p H.264 at `QUALITY_HIGH`, which is what the recorder asked for before. */
const REFERENCE_BITRATE = 6_000_000;
const REFERENCE_PIXELS = 1920 * 1080;
const REFERENCE_FPS = 30;

/** mediabunny's exponent, kept so that nothing changes at 30 fps. */
const SPATIAL_EXPONENT = 0.95;

/**
 * Audio is not derived from anything — a voice costs what a voice costs, whatever the
 * picture is doing. System audio gets more because it is usually music rather than speech,
 * and because it is the one stream nobody can re-record.
 *
 * They live here rather than with the encoder that consumes them: the panel has to price a
 * take before any encoder exists, and two copies of these numbers is how an estimate starts
 * quietly disagreeing with the file it is estimating.
 */
export const AUDIO_BITRATE_DEFAULT = 192_000;
export const AUDIO_BITRATE_SYSTEM = 256_000;

export type CaptureQuality = 'draft' | 'normal' | 'high';

export const CAPTURE_QUALITIES: CaptureQuality[] = ['draft', 'normal', 'high'];

/**
 * What each setting multiplies the derived bitrate by.
 *
 * `normal` is exactly 1 on purpose: it is the bitrate every recording made before this
 * setting existed used, so adding the control changes nothing for anyone who ignores it.
 * Draft is for long screen captures, where roughly two-thirds the size is worth more than
 * the detail nobody will look at; high is for anything that will be graded or scaled.
 */
export const QUALITY_SCALE: Record<CaptureQuality, number> = {
  draft: 0.6,
  normal: 1,
  high: 1.6,
};

export const QUALITY_LABEL: Record<CaptureQuality, string> = {
  draft: 'Draft',
  normal: 'Normal',
  high: 'High',
};

export function captureVideoBitrate(
  width: number,
  height: number,
  fps: number,
  quality: CaptureQuality = 'normal',
): number {
  const pixels = Math.max(1, width * height);
  const rate = Math.min(240, Math.max(1, Number.isFinite(fps) ? fps : REFERENCE_FPS));
  const spatial = Math.pow(pixels / REFERENCE_PIXELS, SPATIAL_EXPONENT);
  const temporal = Math.sqrt(rate / REFERENCE_FPS);
  const scale = QUALITY_SCALE[quality] ?? 1;
  return Math.round((REFERENCE_BITRATE * spatial * temporal * scale) / 1000) * 1000;
}

/** `1080p60` — the shape of a capture in the four characters people actually recognise. */
export function qualityLabel(height: number, fps: number): string {
  if (!(height > 0)) return 'unknown format';
  const rate = fps > 0 ? Math.round(fps) : 0;
  return rate > 0 ? `${Math.round(height)}p${rate}` : `${Math.round(height)}p`;
}

/**
 * Bytes a capture of this shape is likely to write per second — for the panel's estimate.
 *
 * It is an estimate of a variable-bitrate encode and is presented as one.
 */
export function estimatedBytesPerSecond(
  sources: { width: number; height: number; fps: number }[],
  /**
   * One entry per audio stream, at what that stream will actually encode at. A count and a
   * single default was close enough until system audio started costing 256k — at which point
   * every estimate for the commonest setup of all was quietly 64 kbps light.
   */
  audioBitrates: number[],
  quality: CaptureQuality = 'normal',
): number {
  const video = sources.reduce(
    (sum, s) => sum + captureVideoBitrate(s.width, s.height, s.fps, quality),
    0,
  );
  const audio = audioBitrates.reduce((sum, b) => sum + b, 0);
  return (video + audio) / 8;
}
