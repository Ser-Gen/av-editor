/**
 * Integrated loudness, to EBU R128 / ITU-R BS.1770.
 *
 * Pure arithmetic over sample arrays, which is what makes it the most testable thing in the
 * audio work: a signal of known level has a known loudness, and `check:math` says so.
 *
 * The shape of the measurement, and why each part is there:
 *
 * - **K-weighting** — two biquads, a high-shelf standing in for the head's effect on incoming
 *   sound and a high-pass rolling off rumble the ear barely registers. Without it a track with
 *   a lot of bass measures far louder than it sounds.
 * - **400 ms blocks at 75% overlap** — loudness is a running impression, not an instant. The
 *   overlap is what stops a block boundary landing on a transient and losing it.
 * - **Two gates** — an absolute one at −70 LUFS throws away digital silence, and a relative
 *   one at −10 LU below the ungated mean throws away the quiet parts, so a voice with pauses
 *   in it measures as the voice rather than as the average of voice and room tone. This is the
 *   whole reason peak normalization gets it wrong and this does not.
 */

/** What R128 calls the target for broadcast. Streaming platforms mostly sit at −14. */
export const DEFAULT_LOUDNESS_TARGET = -16;

const ABSOLUTE_GATE = -70;
const RELATIVE_GATE_OFFSET = -10;
const BLOCK_SECONDS = 0.4;
const OVERLAP = 0.75;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages, from BS.1770-4.
 *
 * The published coefficients are for 48 kHz. Rather than carry a table, both stages are
 * rebuilt from their analogue prototypes at the actual rate — the same numbers come out at
 * 48 kHz, and a 44.1 kHz file gets a correct filter instead of a slightly wrong one.
 */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf, +4 dB above ~1.5 kHz.
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;

  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;

  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };

  // Stage 2: high pass at ~38 Hz.
  const f0b = 38.13547087602444;
  const Qb = 0.5003270373238773;
  const Kb = Math.tan((Math.PI * f0b) / sampleRate);
  const a0b = 1 + Kb / Qb + Kb * Kb;

  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (Kb * Kb - 1)) / a0b,
    a2: (1 - Kb / Qb + Kb * Kb) / a0b,
  };
  // The high-pass numerator is normalized by the same a0.
  highpass.b0 /= a0b;
  highpass.b1 /= a0b;
  highpass.b2 /= a0b;

  return [shelf, highpass];
}

function runBiquad(input: Float32Array, f: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * Channel weights from BS.1770. Left and right count for themselves; the surround channels
 * count for more, because sound arriving from behind is heard as louder than it measures.
 * Anything past 5 channels is weighted 1.0 — this editor mixes stereo, so it never comes up.
 */
function channelWeight(index: number, channelCount: number): number {
  if (channelCount <= 2) return 1;
  return index === 3 || index === 4 ? 1.41 : 1;
}

/**
 * Integrated loudness in LUFS, or `null` when there is nothing above the absolute gate —
 * silence has no loudness, and reporting −70 for it would let normalize amplify a silent clip
 * by 54 dB.
 */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number | null {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) return null;

  const [shelf, highpass] = kWeighting(sampleRate);
  const weighted = channels.map((ch) => runBiquad(runBiquad(ch, shelf), highpass));

  const blockSize = Math.max(1, Math.round(BLOCK_SECONDS * sampleRate));
  const step = Math.max(1, Math.round(blockSize * (1 - OVERLAP)));
  if (weighted[0].length < blockSize) return null;

  /** Mean square per block, already channel-weighted and summed. */
  const blockPower: number[] = [];
  for (let start = 0; start + blockSize <= weighted[0].length; start += step) {
    let power = 0;
    for (let c = 0; c < weighted.length; c++) {
      const data = weighted[c];
      let sum = 0;
      for (let i = start; i < start + blockSize; i++) sum += data[i] * data[i];
      power += channelWeight(c, weighted.length) * (sum / blockSize);
    }
    blockPower.push(power);
  }
  if (blockPower.length === 0) return null;

  const toLufs = (power: number) => -0.691 + 10 * Math.log10(power);

  // First gate: absolute.
  const aboveAbsolute = blockPower.filter((p) => p > 0 && toLufs(p) > ABSOLUTE_GATE);
  if (aboveAbsolute.length === 0) return null;

  // Second gate: relative to the mean of what survived the first.
  const ungatedMean = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length;
  const relativeGate = toLufs(ungatedMean) + RELATIVE_GATE_OFFSET;
  const kept = aboveAbsolute.filter((p) => toLufs(p) > relativeGate);
  if (kept.length === 0) return null;

  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return toLufs(mean);
}

/** The linear gain that moves `measured` LUFS onto `target` LUFS. */
export function gainForTarget(measured: number, target: number): number {
  return Math.pow(10, (target - measured) / 20);
}

/**
 * Clamped so normalizing never turns a whisper into clipping, nor a clip into silence.
 *
 * 12 dB of lift is roughly the most that helps; past it the noise floor arrives with the
 * signal and the result is worse than leaving it alone.
 */
export const MAX_NORMALIZE_GAIN = Math.pow(10, 12 / 20);
export const MIN_NORMALIZE_GAIN = Math.pow(10, -24 / 20);

export function clampNormalizeGain(gain: number): number {
  return Math.min(MAX_NORMALIZE_GAIN, Math.max(MIN_NORMALIZE_GAIN, gain));
}

/** dBFS of the loudest sample — for the peak readout beside the loudness one. */
export function truePeakDb(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}
