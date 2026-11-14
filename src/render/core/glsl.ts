// Shared GLSL snippets (hash / value noise / fbm) and helpers for patching built-in three.js
// materials. Every patched material MUST get a distinct `customProgramCacheKey`, because the
// shadow wrapper chains `onBeforeCompile` hooks and three would otherwise share one program
// between materials whose wrapper functions stringify identically.

export const NOISE_GLSL = /* glsl */ `
float ob_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 ob_hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float ob_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = ob_hash12(i);
  float b = ob_hash12(i + vec2(1.0, 0.0));
  float c = ob_hash12(i + vec2(0.0, 1.0));
  float d = ob_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float ob_fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * ob_noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s;
}
`;

/** Wind sway shared by trees and grass. `h` is the 0..1 height weight (0 = rooted). */
export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
vec3 ob_wind(vec3 worldPos, float h, float stiffness) {
  float t = uTime;
  float phase = dot(worldPos.xz, vec2(0.11, 0.07));
  float gust = 0.55 + 0.45 * sin(t * 0.6 + dot(worldPos.xz, uWindDir) * 0.035);
  float sway = sin(t * 1.7 + phase) * 0.6 + sin(t * 3.1 + phase * 1.7) * 0.25;
  float amt = uWindStrength * gust * h * h / stiffness;
  vec3 off = vec3(uWindDir.x, 0.0, uWindDir.y) * (sway + 0.6) * amt;
  off.xz += vec2(-uWindDir.y, uWindDir.x) * sin(t * 2.3 + phase * 2.1) * amt * 0.3;
  off.y -= length(off.xz) * 0.25;
  return off;
}
`;

/** Insert `code` after the first occurrence of `marker` in `src` (throws if missing). */
export function after(src: string, marker: string, code: string): string {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`shader patch: marker not found: ${marker}`);
  return src.slice(0, i + marker.length) + '\n' + code + '\n' + src.slice(i + marker.length);
}
/** Replace the first occurrence of `marker` in `src` with `code` (throws if missing). */
export function replace(src: string, marker: string, code: string): string {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`shader patch: marker not found: ${marker}`);
  return src.slice(0, i) + code + src.slice(i + marker.length);
}
