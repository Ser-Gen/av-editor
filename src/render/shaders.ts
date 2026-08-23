/**
 * Shared shader sources for the WebGL2 compositor.
 *
 * One vertex shader serves every pass: it maps a unit quad onto a destination
 * rectangle given in *pixels* (y down, matching Canvas2D convention) and samples a
 * source rectangle given in UV space. Uploads keep the default orientation, which
 * already puts the source's top row at v = 0 — exactly what the y-down maths wants.
 *
 * Framebuffer textures are the exception: rendering into one stores the image
 * bottom-up, so any pass reading a framebuffer texture passes a v-flipped source rect.
 */
export const QUAD_VERT = `#version 300 es
precision highp float;

in vec2 aPos;              // unit quad, 0..1

uniform vec4 uDest;        // x, y, w, h in destination pixels (y down)
uniform vec4 uSrc;         // x, y, w, h in UV space
uniform vec2 uResolution;  // destination size in pixels
uniform float uRotate;     // radians, clockwise, about uDest's centre

out vec2 vUv;

void main() {
  // Rotation happens in *pixels*, not in the unit quad: rotating first and scaling by a
  // non-square uDest afterwards would shear the picture rather than turn it.
  vec2 half_ = uDest.zw * 0.5;
  vec2 offset = (aPos - 0.5) * uDest.zw;
  float c = cos(uRotate);
  float s = sin(uRotate);
  // y grows downward here, so a positive angle turns clockwise on screen — the same
  // direction Canvas2D's rotate() and FFmpeg's rotate filter take a positive angle.
  offset = vec2(offset.x * c - offset.y * s, offset.x * s + offset.y * c);
  vec2 px = uDest.xy + half_ + offset;
  vec2 clip = (px / uResolution) * 2.0 - 1.0;
  // Destination y grows downward; clip space y grows upward.
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = uSrc.xy + aPos * uSrc.zw;
}
`;

/**
 * Mask compositing pass: mixes the effected layer back over the original by the region's
 * coverage. Runs once per masked effect, so a moving region costs exactly what a static
 * one does — the payoff for compositing on the GPU.
 */
export const MASK_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;      // the effect's output
uniform sampler2D uOriginal; // the layer as it was before this effect
uniform vec2 uResolution;
uniform vec4 uMaskRect;      // x, y, w, h in 0..1, y down like the canvas
uniform float uMaskShape;    // 1 = rectangle, 2 = ellipse
uniform float uMaskFeather;  // fraction of the shorter frame edge
uniform float uMaskInvert;
out vec4 outColor;

void main() {
  vec4 effected = texture(uTex, vUv);
  vec4 original = texture(uOriginal, vUv);

  // Framebuffer textures are stored bottom-up while the region is authored y-down,
  // so flip before doing any geometry.
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  vec2 centre = (uMaskRect.xy + uMaskRect.zw * 0.5) * uResolution;
  vec2 half_ = max(vec2(1.0), uMaskRect.zw * 0.5 * uResolution);
  vec2 d = abs(p - centre);

  // Distance in pixels, so the feather is the same width on both axes.
  float dist;
  if (uMaskShape > 1.5) {
    float r = length(d / half_);
    dist = (r - 1.0) * min(half_.x, half_.y);
  } else {
    dist = max(d.x - half_.x, d.y - half_.y);
  }

  float feather = max(0.5, uMaskFeather * min(uResolution.x, uResolution.y));
  float coverage = 1.0 - smoothstep(-feather, 0.0, dist);
  if (uMaskInvert > 0.5) coverage = 1.0 - coverage;
  outColor = mix(original, effected, coverage);
}
`;

/** Parity shader: straight texture copy. Alpha is premultiplied on upload. */
export const BLIT_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 outColor;

void main() {
  outColor = texture(uTex, vUv) * uAlpha;
}
`;

/**
 * Input pass for a custom shader chain.
 *
 * The compositor's layers are premultiplied; a Shadertoy shader expects straight colour
 * and will happily sample `iChannel0` itself, so there is nowhere to intercept the read.
 * The fix is to hand it a texture that is already straight — one extra blit, which also
 * does the downsample when the effect runs at reduced render scale.
 */
export const CUSTOM_INPUT_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;

void main() {
  vec4 c = texture(uTex, vUv);
  outColor = c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}
`;

/**
 * Output pass for a custom shader chain: back to premultiplied, and back to full size.
 *
 * The layer's own alpha bounds the result. Most Shadertoy shaders end with
 * `fragColor = vec4(rgb, 1.0)`, and taking that at face value would turn the transparent
 * letterbox around a clip into an opaque black frame that hides every track below it.
 */
export const CUSTOM_RESOLVE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;      // the last stage's output, straight alpha
uniform sampler2D uOriginal; // the layer as the chain received it
out vec4 outColor;

void main() {
  vec4 c = texture(uTex, vUv);
  float a = clamp(c.a, 0.0, 1.0) * texture(uOriginal, vUv).a;
  outColor = vec4(clamp(c.rgb, 0.0, 1.0) * a, a);
}
`;
