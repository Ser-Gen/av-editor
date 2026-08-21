import { QUAD_VERT } from '../shaders';
import type { ParsedShader } from './customShader';
import { buildShader } from './customShader';

/**
 * Compiles a shader away from the renderer so the editor can say what is wrong with it.
 *
 * The alternative — find out at draw time — puts the compile log in the console and an
 * unexplained unchanged picture on screen. A throwaway 1×1 context costs nothing and
 * turns that into a message next to the text that caused it.
 */

export interface ShaderCheck {
  ok: boolean;
  /** One entry per failing stage, already prefixed with the stage's name. */
  errors: string[];
}

let context: WebGL2RenderingContext | null | undefined;
const cache = new Map<string, string | null>();

function validator(): WebGL2RenderingContext | null {
  if (context !== undefined) return context;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  context = canvas.getContext('webgl2');
  return context;
}

export function checkShader(parsed: ParsedShader, params: Record<string, number>): ShaderCheck {
  const built = buildShader(parsed, params);
  const errors: string[] = [];
  for (const stage of built.stages) {
    const error = compile(stage.key, stage.source);
    if (error) {
      errors.push(built.stages.length > 1 ? `${stage.name}: ${error}` : error);
    }
  }
  return { ok: errors.length === 0, errors };
}

function compile(key: string, source: string): string | null {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const gl = validator();
  // No WebGL2 means the preview is on the Canvas2D fallback, where a custom shader will
  // not run at all. Claiming a compile error on top of that would be a second, wrong story.
  if (!gl) {
    cache.set(key, null);
    return null;
  }

  const result = compileOnce(gl, source);
  if (cache.size > 64) cache.clear();
  cache.set(key, result);
  return result;
}

function compileOnce(gl: WebGL2RenderingContext, source: string): string | null {
  const vert = gl.createShader(gl.VERTEX_SHADER);
  const frag = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vert || !frag) return null;
  try {
    gl.shaderSource(vert, QUAD_VERT);
    gl.compileShader(vert);
    gl.shaderSource(frag, source);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
      return tidy(gl.getShaderInfoLog(frag) ?? 'The shader failed to compile.');
    }

    const program = gl.createProgram();
    if (!program) return null;
    try {
      gl.attachShader(program, vert);
      gl.attachShader(program, frag);
      gl.bindAttribLocation(program, 0, 'aPos');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        return tidy(gl.getProgramInfoLog(program) ?? 'The shader failed to link.');
      }
    } finally {
      gl.deleteProgram(program);
    }
    return null;
  } finally {
    gl.deleteShader(vert);
    gl.deleteShader(frag);
  }
}

/**
 * Line numbers in the log count the generated file, which begins with a prelude the
 * author never wrote. Reporting them unadjusted would send someone hunting for a line
 * that is not in their shader, so the shifted numbers are dropped rather than guessed at.
 */
function tidy(log: string): string {
  return log
    .split('\n')
    .map((line) => line.replace(/^ERROR:\s*\d+:\d+:\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 6)
    .join('\n');
}
