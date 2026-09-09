/**
 * Pitch shifting, as an AudioWorklet.
 *
 * Plain JavaScript in `public/` rather than a module in `src/`: a worklet is loaded by URL into
 * a separate global scope with no imports and no bundler, so it is shipped as it is written and
 * fetched through `publicUrl()` like the FFmpeg core.
 *
 * **The method is overlap-add with waveform alignment (SOLA).** Short grains are read out of a
 * ring buffer at the shift ratio and laid back down at a fixed output hop, each one slid a few
 * milliseconds to where it best continues the grain already written. Consumption is one input
 * sample per output sample, so nothing drifts.
 *
 * It replaces a crossfaded delay line — two read pointers sweeping a 200 ms ring, half a ring
 * apart. That version's artefact was not a warble: at +2 semitones the sweep took most of a
 * second to cross, so it re-read a tenth of a second of the past on a slow cycle, which is
 * heard as an echo with the audio chopped and repeated. The grains here are 512 samples, so
 * whatever periodicity remains is up at ~180 Hz rather than down in echo territory, and the
 * similarity search removes most of that.
 *
 * The cost is latency — a grain cannot be laid down until the input it reads has arrived. That
 * is unavoidable in a live graph, and it is why the *export* does not use this file at all:
 * `utils/timeStretch.ts` has the whole segment in hand and shifts it exactly, with none.
 *
 * A ratio of exactly 1 is a straight copy, so an enabled-but-unshifted effect costs nothing.
 */

/** ~11 ms at 48 kHz: long enough to hold several periods of a low voice, short enough to follow speech. */
const FRAME = 512;
/** Half the grain. A Hann window at 50% overlap sums to a constant. */
const HOP = FRAME / 2;
/** How far a grain may slide to find the best continuation. ~2 ms. */
const SEARCH = 96;
const CORRELATE = 192;
const SEARCH_STEP = 3;
/**
 * How far behind the newest input a grain starts.
 *
 * A grain shifted up by `r` reads `FRAME × r` samples to produce `FRAME` of output, so the
 * read head has to stay that far behind the write head or it runs into audio that has not
 * arrived — where `sampleAt` holds the last sample and the shift quietly comes out flat. Sized
 * for the highest ratio the parameter allows, because the lag cannot be changed mid-stream
 * without the read position jumping.
 */
const READ_AHEAD = FRAME * 4 + SEARCH;
const IN_SIZE = 1 << 15;
const OUT_SIZE = 1 << 14;

function hann(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'ratio',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.window = hann(FRAME);
    /** One ring per channel, grown lazily — the channel count is not known until the first block. */
    this.input = [];
    this.output = [];
    /** Absolute counts. Input and output advance together: one sample in, one sample out. */
    this.written = 0;
    this.read = -READ_AHEAD;
    this.laid = 0;
    this.emitted = 0;
  }

  ensureChannels(count) {
    while (this.input.length < count) {
      this.input.push(new Float32Array(IN_SIZE));
      this.output.push(new Float32Array(OUT_SIZE));
    }
  }

  /** Linear interpolation at an absolute input position, held at the edges of what exists. */
  sampleAt(channel, position) {
    const oldest = this.written - IN_SIZE + 1;
    const newest = this.written - 1;
    const clamped = Math.min(newest, Math.max(oldest, position));
    const index = Math.floor(clamped);
    const frac = clamped - index;
    const buffer = this.input[channel];
    const a = buffer[((index % IN_SIZE) + IN_SIZE) % IN_SIZE];
    const b = buffer[(((index + 1) % IN_SIZE) + IN_SIZE) % IN_SIZE];
    return a + (b - a) * frac;
  }

  /**
   * Where this grain should start reading so that it continues what is already written.
   *
   * Correlated against the tail of the output, on channel 0 — every channel then slides
   * together, because sliding each to its own best offset walks a stereo image apart.
   */
  bestOffset(ratio) {
    if (this.laid === 0) return 0;
    let bestScore = -Infinity;
    let best = 0;
    for (let offset = -SEARCH; offset <= SEARCH; offset += SEARCH_STEP) {
      let score = 0;
      for (let i = 0; i < CORRELATE; i += 2) {
        const written = this.output[0][(((this.laid + i) % OUT_SIZE) + OUT_SIZE) % OUT_SIZE];
        score += written * this.sampleAt(0, this.read + offset + i * ratio);
      }
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }
    return best;
  }

  layGrain(channels, ratio) {
    const offset = this.bestOffset(ratio);
    for (let i = 0; i < FRAME; i++) {
      const gain = this.window[i];
      const slot = (((this.laid + i) % OUT_SIZE) + OUT_SIZE) % OUT_SIZE;
      for (let c = 0; c < channels; c++) {
        this.output[c][slot] += this.sampleAt(c, this.read + offset + i * ratio) * gain;
      }
    }
    // The nominal read position advances by the output hop, whatever the search chose, so
    // input and output stay locked at one sample for one and the offset cannot accumulate.
    this.read += HOP;
    this.laid += HOP;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const channels = Math.min(input.length, output.length);
    this.ensureChannels(channels);
    const frames = output[0].length;
    const ratio = parameters.ratio[0];

    if (Math.abs(ratio - 1) < 1e-4) {
      for (let c = 0; c < channels; c++) output[c].set(input[c]);
      // The ring still has to advance, or re-engaging the shift would read stale audio.
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
          this.input[c][(this.written + i) % IN_SIZE] = input[c][i];
        }
      }
      this.written += frames;
      this.read += frames;
      this.laid += frames;
      this.emitted += frames;
      return true;
    }

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        this.input[c][(this.written + i) % IN_SIZE] = input[c][i];
      }
    }
    this.written += frames;

    // Lay down grains until everything about to be emitted is fully overlapped. A sample is
    // finished once no later grain can still reach it, which is one whole frame past it.
    while (this.laid < this.emitted + frames + FRAME) this.layGrain(channels, ratio);

    for (let i = 0; i < frames; i++) {
      const slot = (((this.emitted + i) % OUT_SIZE) + OUT_SIZE) % OUT_SIZE;
      for (let c = 0; c < channels; c++) {
        output[c][i] = this.output[c][slot];
        // Cleared on the way out, so the ring is empty when the overlap-add comes round again.
        this.output[c][slot] = 0;
      }
    }
    this.emitted += frames;
    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
