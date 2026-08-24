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

/**
 * What to encode a captured picture at: either a preset that sizes itself to the picture,
 * or a rate in bits per second, said outright.
 *
 * The presets cannot go where an hour-long call needs to go. They are multipliers on a curve
 * that starts at 6 Mbps for 1080p, so the smallest of them is still 3.6 Mbps — about 1.6 GB
 * for an hour, for a shared screen that is a static slide for minutes at a time. Reaching
 * 500 kbps would need a multiplier of 0.08, at which point the number on the dial is a
 * fiction and the honest thing is to let someone name the rate.
 *
 * So both live in one setting rather than a preset plus an override: two controls where one
 * silently wins is worse than one control with eight entries.
 */
export type CaptureBitrate = CaptureQuality | number;

/**
 * Below this, H.264 stops encoding a picture and starts encoding an apology. It is a floor
 * on a hand-picked rate, not a suggestion — a typo of `30000` should record something.
 */
export const MIN_CAPTURE_BITRATE = 100_000;

/**
 * The dial. Presets first, because they are right for anything that will be edited; fixed
 * rates below, ordered the way someone hunting for a smaller file reads them.
 */
export const CAPTURE_BITRATE_CHOICES: CaptureBitrate[] = [
  'high',
  'normal',
  'draft',
  4_000_000,
  2_000_000,
  1_000_000,
  600_000,
  300_000,
];

export function isQualityPreset(bitrate: CaptureBitrate): bitrate is CaptureQuality {
  return typeof bitrate === 'string';
}

/** `Normal`, `2 Mbps`, `600 kbps` — whichever kind of answer this is. */
export function bitrateLabel(bitrate: CaptureBitrate): string {
  if (isQualityPreset(bitrate)) return QUALITY_LABEL[bitrate];
  const bits = Math.max(MIN_CAPTURE_BITRATE, Math.round(bitrate));
  if (bits >= 1_000_000) {
    const mbps = bits / 1_000_000;
    return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`;
  }
  return `${Math.round(bits / 1000)} kbps`;
}

export function captureVideoBitrate(
  width: number,
  height: number,
  fps: number,
  bitrate: CaptureBitrate = 'normal',
): number {
  // A rate said outright is used as said. It deliberately does not scale with the picture:
  // the whole reason for naming a number is that the curve's answer was the wrong one, and
  // a "fixed" rate that moved when the share picker chose a different window would not be.
  if (!isQualityPreset(bitrate)) {
    const bits = Number.isFinite(bitrate) ? bitrate : REFERENCE_BITRATE;
    return Math.round(Math.max(MIN_CAPTURE_BITRATE, bits) / 1000) * 1000;
  }
  const pixels = Math.max(1, width * height);
  const rate = Math.min(240, Math.max(1, Number.isFinite(fps) ? fps : REFERENCE_FPS));
  const spatial = Math.pow(pixels / REFERENCE_PIXELS, SPATIAL_EXPONENT);
  const temporal = Math.sqrt(rate / REFERENCE_FPS);
  const scale = QUALITY_SCALE[bitrate] ?? 1;
  return Math.round((REFERENCE_BITRATE * spatial * temporal * scale) / 1000) * 1000;
}

/**
 * How often to spend a key frame, given what the whole second is worth.
 *
 * One per second is what the recorder has always done, and at the preset rates it costs
 * little and buys a lot: a fragmented MP4 can only close a fragment on a key frame, so the
 * interval *is* the crash window and the seek granularity.
 *
 * At 500 kbps it is ruinous. A 1080p key frame is a picture encoded from nothing — call it
 * 100 KB at a watchable quality — and one second of a 500 kbps stream is 62 KB in total.
 * Asking for both means the encoder either wrecks the key frame or starves the 29 frames
 * after it, every single second, and the low rate that was supposed to make a small clean
 * file makes a small smeared one instead.
 *
 * So the interval widens as the budget narrows, and the cost is stated plainly: at the
 * bottom of the dial, a killed tab loses up to four seconds instead of one, and scrubbing
 * lands on a four-second grid. Anything at or above Draft keeps the one-second interval it
 * has always had, so this changes nothing for a recording that was already right.
 */
export const KEYFRAME_SECONDS_DEFAULT = 1;

export function captureKeyFrameSeconds(
  width: number,
  height: number,
  fps: number,
  bitrate: CaptureBitrate = 'normal',
): number {
  const chosen = captureVideoBitrate(width, height, fps, bitrate);
  const derived = captureVideoBitrate(width, height, fps, 'normal');
  const ratio = derived > 0 ? chosen / derived : 1;
  if (ratio >= 0.5) return KEYFRAME_SECONDS_DEFAULT;
  if (ratio >= 0.25) return 2;
  return 4;
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
  bitrate: CaptureBitrate = 'normal',
): number {
  const video = sources.reduce(
    (sum, s) => sum + captureVideoBitrate(s.width, s.height, s.fps, bitrate),
    0,
  );
  const audio = audioBitrates.reduce((sum, b) => sum + b, 0);
  return (video + audio) / 8;
}
