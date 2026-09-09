/**
 * Loading the pitch worklet into a context, once per context.
 *
 * `audioWorklet.addModule` is the async step `buildAudioChain` deliberately does not have. The
 * promise is cached per context because a worklet module belongs to a context rather than to
 * the page.
 *
 * **The preview is the only caller.** The export used to run the same worklet inside each
 * `OfflineAudioContext` window, which meant the shifter's latency delayed that clip against
 * everything else in the mix and its state restarted at every window boundary. Offline there
 * is no reason to work grain by grain at all: `pitchShift` in `utils/timeStretch.ts` has the
 * whole segment and shifts it exactly. This file is what a *live* graph needs, and only that.
 */
import { publicUrl } from './publicUrl';

const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/**
 * Resolves true when the context can make `pitch-processor` nodes.
 *
 * False rather than throwing: a browser without AudioWorklet should lose the pitch effect and
 * keep the rest of the sound, and the caller can say so once.
 */
export function ensurePitchWorklet(ctx: BaseAudioContext): Promise<boolean> {
  const existing = loaded.get(ctx);
  if (existing) return existing;

  const promise = (async () => {
    if (!ctx.audioWorklet) return false;
    try {
      await ctx.audioWorklet.addModule(publicUrl('worklets/pitch-processor.js'));
      return true;
    } catch (e) {
      console.warn('[audio] pitch worklet unavailable:', e);
      return false;
    }
  })();

  loaded.set(ctx, promise);
  return promise;
}

/** Null when the worklet is not available; the caller then connects around it. */
export function createPitchNode(ctx: BaseAudioContext, semitones: number): AudioWorkletNode | null {
  try {
    const node = new AudioWorkletNode(ctx, 'pitch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.parameters.get('ratio')?.setValueAtTime(semitonesToRatio(semitones), ctx.currentTime);
    return node;
  } catch (e) {
    console.warn('[audio] pitch node could not be created:', e);
    return null;
  }
}
