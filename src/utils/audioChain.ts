/**
 * What a clip sounds like — defined once, built once, used by every path that makes sound.
 *
 * This is the audio counterpart of `clipRender.ts`, and it exists for the same reason. The
 * preview routes each media element through `createMediaElementSource` into a gain graph
 * (`preview/PlaybackEngine.ts`), and the export mixdown renders every window through an
 * `OfflineAudioContext` with a `GainNode` per clip (`export/webcodecs/audioMixdown.ts`). Both
 * are Web Audio graphs, so `buildAudioChain` returns the *same node objects* to both: the
 * preview and the two fast export paths agree by construction, not by testing.
 *
 * The FFmpeg fallback is the exception, and it is the familiar one — it filters in its own
 * domain, so `ffmpegAudioFilters` returns an equivalent, never the same thing. Where there is
 * no equivalent, `unsupportedForFfmpeg` names the effect and the export refuses rather than
 * quietly producing something that sounds different.
 */
import type { AudioEffect, AudioEffectType, Clip, Keyframe } from '../types/editor';
import { evaluateChannel } from './keyframes';

export interface AudioParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export interface AudioEffectDescriptor {
  type: AudioEffectType;
  label: string;
  hint: string;
  params: AudioParamSpec[];
}

export const AUDIO_EFFECTS: Record<AudioEffectType, AudioEffectDescriptor> = {
  highpass: {
    type: 'highpass',
    label: 'High-pass',
    hint: 'Cuts everything below the cutoff. Rumble, handling noise, air conditioning.',
    params: [
      { key: 'frequency', label: 'Cutoff', min: 20, max: 2000, step: 1, default: 80, unit: 'Hz' },
      { key: 'q', label: 'Resonance', min: 0.1, max: 8, step: 0.1, default: 0.707 },
    ],
  },
  lowpass: {
    type: 'lowpass',
    label: 'Low-pass',
    hint: 'Cuts everything above the cutoff. Hiss, sibilance, a telephone effect.',
    params: [
      { key: 'frequency', label: 'Cutoff', min: 200, max: 20000, step: 10, default: 12000, unit: 'Hz' },
      { key: 'q', label: 'Resonance', min: 0.1, max: 8, step: 0.1, default: 0.707 },
    ],
  },
  eq: {
    type: 'eq',
    label: 'EQ',
    hint: 'Three peaking bands. Cut where it is muddy, lift where it is dull.',
    params: [
      { key: 'lowGain', label: 'Low', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'lowFreq', label: 'Low at', min: 40, max: 400, step: 5, default: 160, unit: 'Hz' },
      { key: 'midGain', label: 'Mid', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'midFreq', label: 'Mid at', min: 300, max: 4000, step: 25, default: 1000, unit: 'Hz' },
      { key: 'highGain', label: 'High', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'highFreq', label: 'High at', min: 2000, max: 16000, step: 100, default: 6000, unit: 'Hz' },
    ],
  },
  pitch: {
    type: 'pitch',
    label: 'Pitch',
    hint: 'Shifts pitch without changing length. Overlap-add with waveform alignment: applied to the samples themselves on export, and grain by grain in the preview, which costs the preview a few milliseconds of delay.',
    params: [
      { key: 'semitones', label: 'Shift', min: -12, max: 12, step: 1, default: 0, unit: 'st' },
    ],
  },
};

export const AUDIO_EFFECT_ORDER: AudioEffectType[] = ['highpass', 'lowpass', 'eq', 'pitch'];

export function defaultAudioParams(type: AudioEffectType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of AUDIO_EFFECTS[type].params) out[spec.key] = spec.default;
  return out;
}

export function audioParam(effect: AudioEffect, key: string): number {
  const spec = AUDIO_EFFECTS[effect.type].params.find((p) => p.key === key);
  const value = effect.params[key];
  return Number.isFinite(value) ? value : (spec?.default ?? 0);
}

/** Enabled effects, in order. An effect at its default is still applied — it just does nothing. */
export function activeAudioEffects(effects: AudioEffect[] | undefined): AudioEffect[] {
  return (effects ?? []).filter((e) => e.enabled);
}

/* ------------------------------------------------------------------ the envelope */

/**
 * Envelope gain at a clip-local time, multiplied into everything else.
 *
 * A clip with no points returns 1 rather than its `gain`: this is a *modifier*, and the flat
 * gain is applied by the caller alongside fades, track volume and solo. Keeping them separate
 * is what lets the Inspector's gain slider go on working while an envelope is drawn.
 */
export function envelopeGainAt(keys: Keyframe[] | undefined, localTime: number): number {
  if (!keys || keys.length === 0) return 1;
  return Math.max(0, evaluateChannel(keys, localTime, 1));
}

export function hasEnvelope(clip: Clip): boolean {
  return 'gainKeyframes' in clip && (clip.gainKeyframes?.length ?? 0) > 0;
}

/* ------------------------------------------------------- the Web Audio node chain */

/** Just enough of a context to build nodes — both `AudioContext` and `OfflineAudioContext`. */
export type AnyAudioContext = BaseAudioContext;

export interface BuiltChain {
  /** Feed the source into this. */
  input: AudioNode;
  /** Take the result from this. Identical to `input` when nothing is enabled. */
  output: AudioNode;
  /**
   * Apply a new set of parameter values to the nodes already in place.
   *
   * A Web Audio graph cannot gain or lose a *node* in place, but every filter's numbers are
   * `AudioParam`s and can be changed while it runs. Without this, dragging a cutoff slider
   * during playback tore the whole chain down and built it again on every step — which is
   * heard as a gap, not as a filter sweeping. `chainStructureKey` is what says whether a
   * change needs new nodes or only new numbers.
   */
  tune: (effects: AudioEffect[] | undefined) => void;
}

/**
 * What about a chain requires new *nodes*.
 *
 * Types, order and which effects are switched on — not their values. Two chains with the same
 * structure key can be moved onto each other's settings with `tune`.
 */
export function chainStructureKey(effects: AudioEffect[] | undefined): string {
  return activeAudioEffects(effects)
    .map((e) => `${e.type}:${e.id}`)
    .join('|');
}

function peaking(
  ctx: AnyAudioContext,
  frequency: number,
  gainDb: number,
  q = 1,
): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = 'peaking';
  node.frequency.value = frequency;
  node.gain.value = gainDb;
  node.Q.value = q;
  return node;
}

/**
 * Builds the node chain for one clip's effects and returns its two ends.
 *
 * Pitch is handled by the caller: it needs an `AudioWorkletNode`, whose module has to be
 * added to the context first, and that is an async step this function deliberately does not
 * have. `pitchSemitones` reports what the caller must arrange.
 */
export function buildAudioChain(ctx: AnyAudioContext, effects: AudioEffect[] | undefined): BuiltChain {
  const passthrough = ctx.createGain();
  let tail: AudioNode = passthrough;
  /** One per effect: given the new settings, move this effect's nodes onto them. */
  const tuners: ((next: AudioEffect[] | undefined) => void)[] = [];

  const find = (next: AudioEffect[] | undefined, id: string) =>
    activeAudioEffects(next).find((e) => e.id === id);

  for (const effect of activeAudioEffects(effects)) {
    if (effect.type === 'pitch') continue;

    if (effect.type === 'highpass' || effect.type === 'lowpass') {
      const node = ctx.createBiquadFilter();
      node.type = effect.type;
      node.frequency.value = audioParam(effect, 'frequency');
      node.Q.value = audioParam(effect, 'q');
      tail.connect(node);
      tail = node;
      tuners.push((next) => {
        const current = find(next, effect.id);
        if (!current) return;
        node.frequency.value = audioParam(current, 'frequency');
        node.Q.value = audioParam(current, 'q');
      });
      continue;
    }

    // EQ is three peaking bands in series, which is what a three-band EQ is. All three are
    // always built, even at 0 dB where a peaking filter is transparent: skipping the flat ones
    // would make the *structure* depend on the values, and then nudging a band off zero would
    // need a new node rather than a new number.
    for (const band of ['low', 'mid', 'high'] as const) {
      const node = peaking(ctx, audioParam(effect, `${band}Freq`), audioParam(effect, `${band}Gain`));
      tail.connect(node);
      tail = node;
      tuners.push((next) => {
        const current = find(next, effect.id);
        if (!current) return;
        node.frequency.value = audioParam(current, `${band}Freq`);
        node.gain.value = audioParam(current, `${band}Gain`);
      });
    }
  }

  return {
    input: passthrough,
    output: tail,
    tune: (next) => {
      for (const tuner of tuners) tuner(next);
    },
  };
}

/** Semitones of pitch shift asked for, or 0. Only one pitch effect has any meaning. */
export function pitchSemitones(effects: AudioEffect[] | undefined): number {
  const pitch = activeAudioEffects(effects).find((e) => e.type === 'pitch');
  return pitch ? Math.round(audioParam(pitch, 'semitones')) : 0;
}

export function chainIsIdentity(effects: AudioEffect[] | undefined): boolean {
  return activeAudioEffects(effects).length === 0;
}

/* --------------------------------------------------------------- the FFmpeg side */

/**
 * `af` filters equivalent to the chain above, for the fallback path.
 *
 * Equivalent, not identical — FFmpeg filters in its own domain, exactly as its video filters
 * are not the same thing as the compositor's shaders. Returns `null` for a chain it cannot
 * express, and the caller refuses the export rather than dropping the effect silently.
 */
export function ffmpegAudioFilters(effects: AudioEffect[] | undefined): string[] | null {
  const out: string[] = [];

  for (const effect of activeAudioEffects(effects)) {
    switch (effect.type) {
      case 'highpass':
        out.push(`highpass=f=${audioParam(effect, 'frequency')}`);
        break;
      case 'lowpass':
        out.push(`lowpass=f=${audioParam(effect, 'frequency')}`);
        break;
      case 'eq':
        for (const band of ['low', 'mid', 'high'] as const) {
          const gainDb = audioParam(effect, `${band}Gain`);
          if (gainDb === 0) continue;
          out.push(`equalizer=f=${audioParam(effect, `${band}Freq`)}:t=q:w=1:g=${gainDb}`);
        }
        break;
      case 'pitch':
        // `asetrate` + `atempo` is the classic shift, but it resamples the whole stream and
        // the two engines would not agree on the result. Refusing is the honest answer.
        return null;
    }
  }

  return out;
}

/** Names the effects the fallback cannot render, for the message that refuses the export. */
export function unsupportedForFfmpeg(effects: AudioEffect[] | undefined): string[] {
  return activeAudioEffects(effects)
    .filter((e) => e.type === 'pitch')
    .map((e) => AUDIO_EFFECTS[e.type].label);
}
