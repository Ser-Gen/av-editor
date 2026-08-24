import { AudioBufferSink } from 'mediabunny';
import type { InputAudioTrack } from 'mediabunny';
import type { Clip, MediaAsset } from '../../types/editor';
import { fadeGainAt } from '../../utils/clipRender';
import {
  incomingTransition,
  outgoingTransition,
  transitionStateAt,
} from '../../utils/transitions';
import { clipDuration } from '../../utils/time';
import type { MediaInputCache } from './mediaInputs';

export const MIX_SAMPLE_RATE = 48000;
export const MIX_CHANNELS = 2;
/**
 * The mix is rendered in windows rather than in one pass so peak memory stays bounded
 * by the window, not by project length. Windows are whole seconds so the resampler
 * restarts on a sample boundary.
 */
export const MIX_WINDOW_SECONDS = 10;

interface DecodedSegment {
  buffer: AudioBuffer;
  /** Timestamp of the first decoded sample — usually slightly before the requested start. */
  firstTimestamp: number;
}

/**
 * Decodes exactly the requested source range through WebCodecs.
 *
 * Deliberately not `decodeAudioData`: that goes through the browser's media stack and
 * fails outright on containers this project already trips over (it is why the timeline
 * waveform has a flat-ribbon fallback). Demuxing here keeps export audio working on
 * files whose waveform cannot be drawn.
 */
async function decodeSegment(
  track: InputAudioTrack,
  from: number,
  to: number,
): Promise<DecodedSegment | null> {
  const sink = new AudioBufferSink(track);
  const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];

  for await (const wrapped of sink.buffers(from, to)) {
    chunks.push({ buffer: wrapped.buffer, timestamp: wrapped.timestamp });
  }
  if (chunks.length === 0) return null;

  const sampleRate = chunks[0].buffer.sampleRate;
  const channels = Math.max(...chunks.map((c) => c.buffer.numberOfChannels));
  const firstTimestamp = chunks[0].timestamp;
  const last = chunks[chunks.length - 1];
  const totalSeconds = last.timestamp + last.buffer.duration - firstTimestamp;
  const length = Math.max(1, Math.ceil(totalSeconds * sampleRate));

  const out = new AudioBuffer({ length, sampleRate, numberOfChannels: channels });
  for (const chunk of chunks) {
    const offset = Math.round((chunk.timestamp - firstTimestamp) * sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      // Mono sources feed every output channel.
      const src = chunk.buffer.getChannelData(Math.min(ch, chunk.buffer.numberOfChannels - 1));
      const room = length - offset;
      if (room <= 0) continue;
      out.copyToChannel(room < src.length ? src.subarray(0, room) : src, ch, offset);
    }
  }
  return { buffer: out, firstTimestamp };
}

/**
 * Applies the clip's fade envelope to its gain for the part of it inside this window.
 *
 * The envelope is piecewise linear, so scheduling a ramp at each breakpoint reproduces
 * it exactly — and because breakpoints are clamped to the window, a fade that straddles
 * a window boundary still comes out continuous.
 */
function scheduleFade(
  param: AudioParam,
  clip: Clip,
  gain: number,
  windowStart: number,
  overlapStart: number,
  overlapEnd: number,
  allClips: Clip[],
): void {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  const incoming = incomingTransition(clip, allClips);
  const outgoing = outgoingTransition(clip, allClips);
  if (fadeIn <= 0 && fadeOut <= 0 && !incoming && !outgoing) {
    param.value = gain;
    return;
  }

  const envelope = (t: number) => gain * fadeGainAt(clip, t) * transitionStateAt(clip, allClips, t).gain;

  const clipStart = clip.timelineStart;
  const duration = clipDuration(clip);
  const points = new Set<number>([overlapStart, overlapEnd]);
  const breakpoints = [clipStart + fadeIn, clipStart + duration - fadeOut];
  // Transition edges are breakpoints too, or the ramp would be cut off at a window edge.
  for (const window of [incoming, outgoing]) {
    if (window) breakpoints.push(window.start, window.end);
  }
  for (const breakpoint of breakpoints) {
    if (breakpoint > overlapStart && breakpoint < overlapEnd) points.add(breakpoint);
  }

  const sorted = [...points].sort((a, b) => a - b);
  param.setValueAtTime(envelope(sorted[0]), sorted[0] - windowStart);
  for (let i = 1; i < sorted.length; i++) {
    param.linearRampToValueAtTime(envelope(sorted[i]), sorted[i] - windowStart);
  }
}

/**
 * Renders the project mix as a sequence of consecutive windows covering [0, duration).
 * Gains are already resolved by `audibleClips`, so this only places and sums.
 */
export async function* mixdownWindows(
  audible: { clip: Clip; gain: number }[],
  mediaLibrary: Record<string, MediaAsset>,
  inputs: MediaInputCache,
  duration: number,
  signal?: AbortSignal,
  /** Every clip on the timeline, so audio can cross-fade across a transition. */
  allClips: Clip[] = audible.map((a) => a.clip),
  /**
   * Rendering at the output's rate means an audio-only export resamples nothing: the
   * OfflineAudioContext converts each decoded segment once, on its way into the mix, instead
   * of the whole mix being converted again afterwards.
   */
  sampleRate: number = MIX_SAMPLE_RATE,
): AsyncGenerator<AudioBuffer> {
  const trackCache = new Map<string, InputAudioTrack | null>();

  const audioTrackFor = async (assetId: string): Promise<InputAudioTrack | null> => {
    if (!trackCache.has(assetId)) {
      const asset = mediaLibrary[assetId];
      trackCache.set(assetId, asset ? await inputs.audioTrack(asset) : null);
    }
    return trackCache.get(assetId) ?? null;
  };

  for (let windowStart = 0; windowStart < duration; windowStart += MIX_WINDOW_SECONDS) {
    signal?.throwIfAborted();
    const windowEnd = Math.min(duration, windowStart + MIX_WINDOW_SECONDS);
    const frames = Math.max(1, Math.round((windowEnd - windowStart) * sampleRate));
    const ctx = new OfflineAudioContext(MIX_CHANNELS, frames, sampleRate);

    for (const { clip, gain } of audible) {
      if (clip.kind !== 'audio' && clip.kind !== 'video') continue;
      const clipStart = clip.timelineStart;
      const clipEnd = clipStart + clipDuration(clip);
      const overlapStart = Math.max(windowStart, clipStart);
      const overlapEnd = Math.min(windowEnd, clipEnd);
      if (overlapEnd - overlapStart <= 1e-6) continue;

      const track = await audioTrackFor(clip.assetId);
      if (!track) continue;

      const from = clip.sourceTrimIn + (overlapStart - clipStart);
      const to = clip.sourceTrimIn + (overlapEnd - clipStart);
      const segment = await decodeSegment(track, from, to);
      if (!segment) continue;

      const source = ctx.createBufferSource();
      source.buffer = segment.buffer;
      const gainNode = ctx.createGain();
      scheduleFade(gainNode.gain, clip, gain, windowStart, overlapStart, overlapEnd, allClips);
      source.connect(gainNode).connect(ctx.destination);
      source.start(
        overlapStart - windowStart,
        Math.max(0, from - segment.firstTimestamp),
        overlapEnd - overlapStart,
      );
    }

    yield await ctx.startRendering();
  }
}

/**
 * Folds a stereo window down to one channel.
 *
 * The mixdown always runs in stereo because that is what the timeline mixes into; mono is an
 * output choice, applied at the last moment so nothing upstream has to know about it.
 */
export function downmixToMono(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer;
  const out = new AudioBuffer({
    length: buffer.length,
    sampleRate: buffer.sampleRate,
    numberOfChannels: 1,
  });
  const target = out.getChannelData(0);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const source = buffer.getChannelData(ch);
    for (let i = 0; i < source.length; i++) target[i] += source[i] / buffer.numberOfChannels;
  }
  return out;
}
