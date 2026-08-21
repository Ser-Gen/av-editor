// @name Ordered dither
// @channel0 bayer8 repeat nearest
// @channel1 input
// @toggle GAMMA off
//
// From https://www.shadertoy.com/view/MllSzj, inspired by
// https://www.shadertoy.com/view/lllSRj. The 8x8 threshold matrix is generated rather
// than imported, and it is sampled with repeat + nearest: with this compositor's usual
// clamp + linear it would stretch one texel over the frame and come out flat grey.

void mainImage( out vec4 o, vec2 i ) {
#ifdef GAMMA
    // The published gamma-corrected variant: darker, and closer to how the eye reads it.
    o = step(pow(texture(iChannel0, i / 8.), vec4(.45)), texture(iChannel1, i / iResolution.xy));
#else
    o = step(texture(iChannel0, i / 8.).r, texture(iChannel1, i / iResolution.xy));
#endif
}
