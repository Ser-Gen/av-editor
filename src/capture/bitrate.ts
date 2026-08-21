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

export function captureVideoBitrate(width: number, height: number, fps: number): number {
  const pixels = Math.max(1, width * height);
  const rate = Math.min(240, Math.max(1, Number.isFinite(fps) ? fps : REFERENCE_FPS));
  const spatial = Math.pow(pixels / REFERENCE_PIXELS, SPATIAL_EXPONENT);
  const temporal = Math.sqrt(rate / REFERENCE_FPS);
  return Math.round((REFERENCE_BITRATE * spatial * temporal) / 1000) * 1000;
}

/**
 * Bytes a capture of this shape is likely to write per second — for the panel's estimate.
 *
 * Video plus one AAC stream, which is what almost every session records. It is an estimate
 * of a variable-bitrate encode and is presented as one.
 */
export function estimatedBytesPerSecond(
  sources: { width: number; height: number; fps: number }[],
  audioStreams: number,
  audioBitrate = 192_000,
): number {
  const video = sources.reduce((sum, s) => sum + captureVideoBitrate(s.width, s.height, s.fps), 0);
  return (video + audioStreams * audioBitrate) / 8;
}
