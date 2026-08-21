import vhsGlitch from './presets/vhsGlitch.glsl?raw';
import orderedDither from './presets/orderedDither.glsl?raw';
import ntscPal from './presets/ntscPal.glsl?raw';
import extrudedVideo from './presets/extrudedVideo.glsl?raw';

/**
 * Shaders to start from.
 *
 * Four published Shadertoy effects, annotated but otherwise as their authors wrote them —
 * each file keeps its link and its author's comments, and each one is here because it
 * demanded something the renderer did not have: parameters, a tiled channel with its own
 * wrap and filter, feed-forward stages, and a cost high enough to need a render scale.
 * They are examples in both senses: things to use, and the cases the feature was built
 * against.
 */
export interface ShaderPreset {
  id: string;
  label: string;
  /** What it costs and what it needs, shown next to the name. */
  note: string;
  source: string;
}

const BLANK = `// @name My shader
// @channel0 input
// @param amount 0 1 0.5 Amount

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec4 src = texture(iChannel0, uv);
  fragColor = vec4(mix(src.rgb, 1.0 - src.rgb, amount), src.a);
}
`;

export const SHADER_PRESETS: ShaderPreset[] = [
  { id: 'blank', label: 'Blank template', note: 'One pass, one slider — a place to paste into.', source: BLANK },
  { id: 'vhs', label: 'VHS glitch', note: 'Single pass. Five sliders, all keyframable.', source: vhsGlitch },
  { id: 'dither', label: 'Ordered dither', note: 'Generated 8×8 threshold channel, tiled.', source: orderedDither },
  { id: 'ntsc', label: 'NTSC / PAL', note: 'Two stages. Compile-time video standard.', source: ntscPal },
  { id: 'extruded', label: 'Extruded video', note: 'Raymarched — expensive. Half scale by default.', source: extrudedVideo },
];
