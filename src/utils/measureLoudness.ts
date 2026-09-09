/**
 * Measuring how loud a clip actually is.
 *
 * Decodes the clip's own excerpt — not the whole file — through mediabunny, exactly as the
 * export mixdown does, and hands the samples to `loudness.ts`. Deliberately not
 * `decodeAudioData`: that goes through the browser's media stack and fails outright on
 * containers this project already trips over, which is why the timeline waveform has a
 * flat-ribbon fallback. Demuxing here keeps normalize working on files whose waveform cannot
 * even be drawn.
 *
 * Long clips are sampled rather than decoded whole: loudness is a gated mean, and a minute
 * taken from across a twenty-minute interview lands within a fraction of a dB of the full
 * measurement for a small fraction of the wait.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import type { MediaAsset } from '../types/editor';
import { integratedLoudness, truePeakDb } from './loudness';

export interface LoudnessMeasurement {
  lufs: number;
  peakDb: number;
}

/** Past this, the excerpt is sampled in windows instead of decoded end to end. */
const FULL_DECODE_SECONDS = 120;
const SAMPLE_WINDOW_SECONDS = 10;
const SAMPLE_WINDOWS = 6;

function windowsFor(from: number, to: number): [number, number][] {
  const span = to - from;
  if (span <= FULL_DECODE_SECONDS) return [[from, to]];

  const out: [number, number][] = [];
  const stride = span / SAMPLE_WINDOWS;
  for (let i = 0; i < SAMPLE_WINDOWS; i++) {
    const start = from + i * stride;
    out.push([start, Math.min(to, start + SAMPLE_WINDOW_SECONDS)]);
  }
  return out;
}

/**
 * Null when there is nothing to measure: an offline asset, a file with no audio, or an
 * excerpt that is silent. Silence deliberately has no loudness — reporting a number for it
 * would let normalize amplify nothing by 50 dB.
 */
export async function measureClipLoudness(
  asset: MediaAsset,
  trimIn: number,
  trimOut: number,
  signal?: AbortSignal,
): Promise<LoudnessMeasurement | null> {
  const file = asset.file;
  if (!file || trimOut <= trimIn) return null;

  let input: Input | null = null;
  try {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const track = (await input.getAudioTracks())[0];
    if (!track || !(await track.canDecode())) return null;

    const sink = new AudioBufferSink(track);
    const collected: Float32Array[][] = [];
    let sampleRate = 0;
    let channelCount = 0;

    for (const [from, to] of windowsFor(trimIn, trimOut)) {
      signal?.throwIfAborted();
      for await (const wrapped of sink.buffers(from, to)) {
        const buffer = wrapped.buffer;
        sampleRate = buffer.sampleRate;
        channelCount = Math.max(channelCount, buffer.numberOfChannels);
        const chunk: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) chunk.push(buffer.getChannelData(c).slice());
        collected.push(chunk);
      }
    }

    if (collected.length === 0 || sampleRate === 0) return null;

    // Concatenate per channel. The windows are not contiguous when sampling, which is fine:
    // the measurement is a mean over blocks, and a block boundary at a join costs one block.
    const total = collected.reduce((sum, chunk) => sum + chunk[0].length, 0);
    const channels: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
      const out = new Float32Array(total);
      let offset = 0;
      for (const chunk of collected) {
        const data = chunk[Math.min(c, chunk.length - 1)];
        out.set(data, offset);
        offset += data.length;
      }
      channels.push(out);
    }

    const lufs = integratedLoudness(channels, sampleRate);
    if (lufs === null) return null;
    return { lufs, peakDb: truePeakDb(channels) };
  } catch {
    return null;
  } finally {
    try {
      input?.dispose();
    } catch {
      // Best-effort, as everywhere else that opens an Input.
    }
  }
}
