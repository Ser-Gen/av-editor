/**
 * Time-stretching audio: changing how long it lasts without changing its pitch.
 *
 * WSOLA — waveform-similarity overlap-add. The signal is cut into overlapping frames, and the
 * frames are laid back down at a different spacing than they were taken from: closer together
 * to speed up, further apart to slow down. Each frame is allowed to slide a few milliseconds
 * from where the arithmetic says it should start, to the offset where it best *continues* the
 * frame already written — which is what stops the overlaps cancelling each other into a
 * flanged mush.
 *
 * **Why this exists rather than the pitch worklet.** The mixdown used to retime by resampling
 * (which moves the pitch) and then shift the pitch back with `pitch-processor.js`. Retiming to
 * 2× asks that shifter for a whole octave, and it is a crossfaded delay line with its taps
 * 100 ms apart in a 200 ms ring: at an octave it re-reads a tenth of a second of the past
 * every fifth of a second. The result is not the "slight warble" its own comment promises at
 * small shifts — it is audibly chopped and out of order. A stretch does the job directly and
 * has no pitch to put back.
 *
 * Pure: Float32Array in, Float32Array out, no `AudioContext`, no worklet, no state between
 * calls. That is what lets `check:math` assert the thing that actually matters — that a sine
 * comes out at the frequency it went in at, and a *different* length.
 */

/** ~43 ms at 48 kHz. Long enough to hold a pitch period of a low voice, short enough to follow speech. */
const FRAME = 2048;
/** Half the frame: a Hann window at 50% overlap sums to a constant. */
const HOP = FRAME / 2;
/** How far a frame may slide to find the best continuation. ~5 ms. */
const SEARCH = 240;
/** Correlation is measured over this much of the frame, stepping by `SEARCH_STEP`. */
const CORRELATE = 512;
const SEARCH_STEP = 4;

/**
 * Below this there is nothing to overlap, so `timeStretch` returns what it was given.
 *
 * Callers that must not silently get an unstretched buffer back — the export mixdown, whose
 * timing depends on the length changing — check this first and take another route.
 */
export const MIN_STRETCH_SAMPLES = FRAME * 2;

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

/** Channel 0 stands in for the lot when looking for the best offset: they move together. */
function similarity(guide: Float32Array, a: number, b: number, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += SEARCH_STEP) sum += guide[a + i] * guide[b + i];
  return sum;
}

/**
 * `channels` stretched so that it lasts `1 / speed` as long: 2 makes it half the length, 0.5
 * makes it twice. The pitch is unchanged, which is the whole point.
 *
 * Returns the input untouched at speed 1, and for input too short to hold a single frame —
 * below about 43 ms there is nothing to overlap and the honest answer is the samples
 * themselves.
 */
export function timeStretch(channels: Float32Array[], speed: number): Float32Array[] {
  if (channels.length === 0) return channels;
  const inputLength = channels[0].length;
  if (!Number.isFinite(speed) || speed <= 0 || Math.abs(speed - 1) < 1e-9) return channels;
  if (inputLength < MIN_STRETCH_SAMPLES) return channels;

  const outputLength = Math.max(1, Math.round(inputLength / speed));
  const window = hann(FRAME);
  const analysisHop = HOP * speed;
  const guide = channels[0];

  const out = channels.map(() => new Float32Array(outputLength + FRAME));
  // The summed window, so the overlap can be divided back out. Doing it this way rather than
  // trusting the frames to sum to one is what keeps the first and last frame — where fewer
  // windows overlap — at the same level as the middle.
  const weight = new Float32Array(outputLength + FRAME);

  // Where the previous frame said the next one should carry on from.
  let continuation = 0;

  for (let frame = 0; ; frame++) {
    const synthesis = frame * HOP;
    if (synthesis >= outputLength) break;

    const nominal = Math.round(frame * analysisHop);
    let position = Math.min(Math.max(0, nominal), inputLength - FRAME);

    if (frame > 0) {
      // Slide to wherever the waveform best continues what has already been written. This is
      // the "waveform similarity" in WSOLA, and it is the difference between speech and a
      // robot.
      let bestScore = -Infinity;
      let best = position;
      const low = Math.max(0, Math.min(nominal - SEARCH, inputLength - FRAME));
      const high = Math.max(0, Math.min(nominal + SEARCH, inputLength - FRAME));
      const target = Math.max(0, Math.min(continuation, inputLength - CORRELATE - 1));
      for (let candidate = low; candidate <= high; candidate += SEARCH_STEP) {
        const score = similarity(guide, candidate, target, CORRELATE);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      position = best;
    }

    for (let ch = 0; ch < channels.length; ch++) {
      const input = channels[ch];
      const target = out[ch];
      for (let i = 0; i < FRAME; i++) target[synthesis + i] += input[position + i] * window[i];
    }
    for (let i = 0; i < FRAME; i++) weight[synthesis + i] += window[i];

    continuation = position + HOP;
  }

  return out.map((data) => {
    const trimmed = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const w = weight[i];
      trimmed[i] = w > 1e-6 ? data[i] / w : data[i];
    }
    return trimmed;
  });
}

/**
 * Reads `channels` at `rate` samples per output sample: a resample, which moves the pitch and
 * the duration together.
 *
 * Linear interpolation. A windowed-sinc kernel would be better on paper; at the shifts this
 * app allows, after the overlap-add above has already done the hard part, it is not what
 * anybody would hear.
 */
export function resampleByRate(channels: Float32Array[], rate: number): Float32Array[] {
  if (channels.length === 0 || !Number.isFinite(rate) || rate <= 0) return channels;
  if (Math.abs(rate - 1) < 1e-9) return channels;

  const inputLength = channels[0].length;
  const outputLength = Math.max(1, Math.floor(inputLength / rate));
  return channels.map((input) => {
    const out = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const position = i * rate;
      const index = Math.floor(position);
      const frac = position - index;
      const a = input[Math.min(index, inputLength - 1)];
      const b = input[Math.min(index + 1, inputLength - 1)];
      out[i] = a + (b - a) * frac;
    }
    return out;
  });
}

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/**
 * Pitch shifting, offline and exact: stretch, then resample by the same factor.
 *
 * Stretching to `ratio` times the length leaves the pitch alone; reading the result back at
 * `ratio` samples per sample restores the duration and multiplies every frequency by `ratio`.
 * Two operations that each have one job, rather than one that tries to do both.
 *
 * This is the export's shifter. The preview cannot use it — a live graph has no future
 * samples to overlap-add — so `public/worklets/pitch-processor.js` does the same thing
 * grain by grain, which costs it a few milliseconds of latency that this has none of.
 */
export function pitchShift(channels: Float32Array[], semitones: number): Float32Array[] {
  const ratio = semitonesToRatio(semitones);
  if (channels.length === 0 || Math.abs(ratio - 1) < 1e-9) return channels;
  return resampleByRate(timeStretch(channels, 1 / ratio), ratio);
}
