/**
 * What the renderer knows about a custom shader that the Inspector needs to say.
 *
 * A module-level map rather than store state: it is measurement, not document — it must
 * not land in the undo history, and it changes at frame rate. The Inspector polls it.
 */

const timings = new Map<string, number>();
const failures = new Map<string, string>();

/** GPU milliseconds for one effect instance's last measured frame. */
export function recordShaderTime(effectId: string, ms: number): void {
  // Smoothed: a single frame's number jumps around too much to read off a panel.
  const previous = timings.get(effectId);
  timings.set(effectId, previous === undefined ? ms : previous * 0.8 + ms * 0.2);
}

export function shaderTime(effectId: string): number | null {
  return timings.get(effectId) ?? null;
}

/**
 * Takes an effect out of the chain and says why.
 *
 * The one case that matters is a shader heavy enough to lose the GPU context. WebGL
 * cannot interrupt a running shader, so retrying means crashing again — the honest
 * response is to stop running it and put the reason where the user is looking.
 */
export function disableShader(effectId: string, reason: string): void {
  failures.set(effectId, reason);
}

export function shaderFailure(effectId: string): string | null {
  return failures.get(effectId) ?? null;
}

export function isShaderDisabled(effectId: string): boolean {
  return failures.has(effectId);
}

/** Called when the user edits the shader or re-enables it: the next frame gets a chance. */
export function clearShaderFailure(effectId: string): void {
  failures.delete(effectId);
  timings.delete(effectId);
}
