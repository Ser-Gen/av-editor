import { AudioBufferSink } from 'mediabunny';
import type { InputAudioTrack } from 'mediabunny';
import type { Clip, MediaAsset } from '../../types/editor';
import { clipSpeedOf, fadeGainAt, sourceRangeFor } from '../../utils/clipRender';
import {
  incomingTransition,
  outgoingTransition,
  transitionStateAt,
} from '../../utils/transitions';
import { clipDuration } from '../../utils/time';
import {
  buildAudioChain,
  chainIsIdentity,
  envelopeGainAt,
  pitchSemitones,
} from '../../utils/audioChain';
import { MIN_STRETCH_SAMPLES, pitchShift, timeStretch } from '../../utils/timeStretch';
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
  const keys = 'gainKeyframes' in clip ? clip.gainKeyframes : undefined;
  const drawn = keys && keys.length > 0;
  if (fadeIn <= 0 && fadeOut <= 0 && !incoming && !outgoing && !drawn) {
    param.value = gain;
    return;
  }

  const envelope = (t: number) =>
    gain *
    fadeGainAt(clip, t) *
    transitionStateAt(clip, allClips, t).gain *
    // The drawn envelope is keyed in clip-local seconds, and multiplies into the rest.
    envelopeGainAt(keys, t - clip.timelineStart);

  const clipStart = clip.timelineStart;
  const duration = clipDuration(clip);
  const points = new Set<number>([overlapStart, overlapEnd]);
  const breakpoints = [clipStart + fadeIn, clipStart + duration - fadeOut];
  // Transition edges are breakpoints too, or the ramp would be cut off at a window edge.
  for (const window of [incoming, outgoing]) {
    if (window) breakpoints.push(window.start, window.end);
  }
  // Every envelope point is a breakpoint: without them the value curve would run straight
  // from one window edge to the other and ignore what was drawn in between.
  for (const key of keys ?? []) breakpoints.push(clipStart + key.t);
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

      // The source behind this window, through the one function that states the mapping.
      const { from, to } = sourceRangeFor(clip, overlapStart, overlapEnd);
      const segment = await decodeSegment(track, from, to);
      if (!segment) continue;

      const speed = clipSpeedOf(clip);
      const holdsPitch = speed !== 1 && !('pitchFollowsSpeed' in clip && clip.pitchFollowsSpeed);
      const effectsHere = 'audioEffects' in clip ? clip.audioEffects : undefined;
      /*
       * The pitch *effect* is applied to the samples here rather than by the worklet in the
       * graph below. The worklet works grain by grain because a live graph has no future
       * samples to look at, which costs it latency — and latency inside a fixed-length render
       * window delays the clip against everything else in the mix, on a path where nothing
       * compensates for it. Offline there is no reason to accept that: the whole segment is in
       * hand, so it is stretched and resampled exactly.
       */
      const retimed = stretchSegment(segment, from, to, speed, holdsPitch, pitchSemitones(effectsHere));

      const source = ctx.createBufferSource();
      source.buffer = retimed ?? segment.buffer;
      /*
       * Which of the two ways the retiming happened decides the rate, not whether the buffer
       * was replaced — a buffer can be replaced for the pitch effect alone and still need to
       * be played at the clip's speed. A time-stretched buffer is already the right length in
       * real time; a resampled one is played faster or slower to get there, which is what
       * moves its pitch and is exactly what "pitch follows the speed" asks for.
       */
      source.playbackRate.value = retimed && holdsPitch ? 1 : speed;
      const gainNode = ctx.createGain();
      scheduleFade(gainNode.gain, clip, gain, windowStart, overlapStart, overlapEnd, allClips);

      // The same chain the preview builds, from the same module — which is the whole reason
      // an effect heard while scrubbing is the effect that lands in the file.
      // Pitch is already in the samples; what is left is the filter chain, in order.
      const effects = effectsHere;
      if (chainIsIdentity(effects)) {
        source.connect(gainNode).connect(ctx.destination);
      } else {
        const chain = buildAudioChain(ctx, effects);
        source.connect(chain.input);
        chain.output.connect(gainNode).connect(ctx.destination);
      }
      source.start(
        overlapStart - windowStart,
        // A replaced buffer holds exactly the wanted range and nothing else; a raw segment
        // usually starts slightly before it, at the packet boundary the decoder landed on.
        retimed ? 0 : Math.max(0, from - segment.firstTimestamp),
        // Buffer seconds. Only a time-stretched buffer is in real time; everything else is
        // still the source range, and asking for the timeline length would cut a 2× clip off
        // half way through the window.
        retimed && holdsPitch ? overlapEnd - overlapStart : to - from,
      );
    }

    yield await ctx.startRendering();
  }
}

/**
 * The source behind one window, stretched to the length that window occupies.
 *
 * Retiming used to be a resample plus a pitch shift back, and the shift back was the problem:
 * 2× asks `pitch-processor.js` for a whole octave, and that shifter is a crossfaded delay line
 * whose taps sit 100 ms apart in a 200 ms ring — at an octave it re-reads a tenth of a second
 * of the past every fifth of a second, which is heard as chopped, reordered audio rather than
 * as the slight warble it produces at the small shifts the pitch *effect* asks of it. A
 * stretch does the job directly: same samples, laid down at a different spacing, no pitch to
 * put back.
 *
 * The exact range is sliced out first, because the decoder returns whole packets and usually
 * starts a little before what was asked for — stretching the overhang would drag audio from
 * outside the window into it.
 *
 * Each window is stretched on its own, so there is a phase discontinuity every
 * `MIX_WINDOW_SECONDS`. It is one boundary per ten seconds against a continuous artefact, and
 * WSOLA lands each window on the sample it should start on, so the content stays in step.
 */
function stretchSegment(
  segment: DecodedSegment,
  from: number,
  to: number,
  speed: number,
  holdsPitch: boolean,
  semitones: number,
): AudioBuffer | null {
  if (!holdsPitch && semitones === 0) return null;
  const { buffer, firstTimestamp } = segment;
  const rate = buffer.sampleRate;
  const start = Math.max(0, Math.round((from - firstTimestamp) * rate));
  const end = Math.min(buffer.length, Math.max(start, Math.round((to - firstTimestamp) * rate)));
  // Too short to stretch — the last sliver of a clip that ends just past a window boundary.
  // Returning it unstretched would play it at the wrong speed *and* drop what did not fit, so
  // the caller falls back to resampling: a pitch shift nobody can name in 80 ms of audio is a
  // far better failure than the wrong 80 ms.
  if (end - start < MIN_STRETCH_SAMPLES) return null;

  const sliced: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    sliced.push(buffer.getChannelData(ch).slice(start, end));
  }

  // Retiming first, then the pitch effect on top of it — the order the preview's graph puts
  // them in, and the order the Inspector describes.
  const retimed = holdsPitch ? timeStretch(sliced, speed) : sliced;
  const shifted = semitones === 0 ? retimed : pitchShift(retimed, semitones);
  const out = new AudioBuffer({
    length: shifted[0].length,
    sampleRate: rate,
    numberOfChannels: shifted.length,
  });
  for (let ch = 0; ch < shifted.length; ch++) out.copyToChannel(shifted[ch], ch);
  return out;
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
