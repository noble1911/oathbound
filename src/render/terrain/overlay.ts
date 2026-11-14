// Planning overlay: deploy-zone glow + fine grid, evaluated in the ground (and grass) shaders so
// it hugs the terrain, plus an additive light curtain along each zone's edge on the VFX layer.
import * as THREE from 'three';
import { LAYER_VFX } from '../core/post.ts';
import { worldZ } from '../core/coords.ts';
import { FIELD, TEAM_COLORS } from './layout.ts';

/** Deploy zones in world space: x0, x1, z0, z1 (seat 0: field y 400–3999, seat 1: 8000–11599). */
export const ZONES: [THREE.Vector4, THREE.Vector4] = [
  new THREE.Vector4(FIELD.x0, FIELD.x1, worldZ(4000), worldZ(400)),
  new THREE.Vector4(FIELD.x0, FIELD.x1, worldZ(11600), worldZ(8000)),
];

export const overlayUniforms = {
  uZone0: { value: ZONES[0] },
  uZone1: { value: ZONES[1] },
  uZoneCol0: { value: new THREE.Color(TEAM_COLORS[0]).multiplyScalar(1.0) },
  uZoneCol1: { value: new THREE.Color(TEAM_COLORS[1]).multiplyScalar(1.0) },
  /** x: seat-0 fade, y: seat-1 fade, z: grid amount (0..1). */
  uPlan: { value: new THREE.Vector3(0, 0, 0) },
};

export const OVERLAY_GLSL = /* glsl */ `
uniform vec4 uZone0;
uniform vec4 uZone1;
uniform vec3 uZoneCol0;
uniform vec3 uZoneCol1;
uniform vec3 uPlan;
float ob_zoneSd(vec2 p, vec4 r) {
  vec2 c = vec2(r.x + r.y, r.z + r.w) * 0.5;
  vec2 hs = vec2(r.y - r.x, r.w - r.z) * 0.5;
  vec2 d = abs(p - c) - hs;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float ob_gridLine(vec2 p, float cell, float width) {
  vec2 q = p / cell;
  vec2 fw = fwidth(q);
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(fw, 1e-4);
  float l = 1.0 - min(min(g.x, g.y) / width, 1.0);
  // fade lines that are below a pixel apart
  return l * (1.0 - smoothstep(0.25, 0.6, max(fw.x, fw.y)));
}
vec3 ob_zone(vec2 p, vec4 r, vec3 col, float fade, float grid) {
  if (fade <= 0.001) return vec3(0.0);
  float sd = ob_zoneSd(p, r);
  float inside = 1.0 - smoothstep(-0.05, 0.05, sd);
  float edge = exp(-abs(sd) * 3.0) * 1.6 + exp(-abs(sd) * 0.45) * 0.22;
  // the front edge (facing the enemy) is the one that matters: brighter
  float fz = abs(r.z) < abs(r.w) ? r.z : r.w;
  float front = smoothstep(3.0, 0.0, abs(p.y - fz));
  edge *= 1.0 + front * 0.6;
  float fill = inside * 0.05;
  float g = inside * (ob_gridLine(p, 1.0, 1.0) * 0.16 + ob_gridLine(p, 4.0, 1.4) * 0.34) * grid;
  g *= smoothstep(0.0, 1.5, -sd);
  return col * fade * (edge + fill + g);
}
vec3 ob_zones(vec2 p) {
  return ob_zone(p, uZone0, uZoneCol0, uPlan.x, uPlan.z) + ob_zone(p, uZone1, uZoneCol1, uPlan.y, uPlan.z);
}
`;

const curtainVert = /* glsl */ `
attribute float aFront;
varying vec2 vUv;
varying float vFront;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vFront = aFront;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const curtainFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uFade;
uniform float uTime;
varying vec2 vUv;
varying float vFront;
#include <fog_pars_fragment>
void main() {
  float v = vUv.y;
  float a = pow(1.0 - v, 2.2) * (0.5 + 0.5 * vFront);
  float scan = 0.75 + 0.25 * sin(vUv.x * 0.9 - uTime * 2.2);
  float stripes = 0.85 + 0.15 * sin(vUv.x * 12.0 + v * 4.0 - uTime * 1.3);
  vec3 c = uColor * a * scan * stripes * uFade * 1.4;
  gl_FragColor = vec4(c, 1.0);
  #include <fog_fragment>
}`;

/** A ribbon around zone `r` hugging the ground (`h(x, z)`), additive, on the VFX layer. */
export function buildCurtain(r: THREE.Vector4, h: (x: number, z: number) => number, color: THREE.Color, frontZ: number): THREE.Mesh {
  const pts: [number, number][] = [];
  const inset = 0.15;
  const x0 = r.x + inset;
  const x1 = r.y - inset;
  const z0 = r.z + inset;
  const z1 = r.w - inset;
  const edge = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az)));
    for (let i = 0; i < n; i++) pts.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
  };
  edge(x0, z0, x1, z0);
  edge(x1, z0, x1, z1);
  edge(x1, z1, x0, z1);
  edge(x0, z1, x0, z0);
  pts.push(pts[0]);
  const pos: number[] = [];
  const uv: number[] = [];
  const front: number[] = [];
  const idx: number[] = [];
  let run = 0;
  const H = 1.5;
  // the ribbon rides a smoothed terrain profile (a +-4 m moving average, never below the ground):
  // every bump of the heightfield used to kink the border
  const raw = pts.map(([x, z]) => h(x, z));
  const n = pts.length - 1;
  const ys = raw.map((_, i) => {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += raw[(((i + k) % n) + n) % n];
    return Math.max(s / 9, raw[i]) + 0.04;
  });
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    if (i > 0) run += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
    const y = ys[i];
    const f = Math.abs(z - frontZ) < 0.6 ? 1 : 0.25;
    pos.push(x, y, z, x, y + H, z);
    uv.push(run, 0, run, 1);
    front.push(f, f);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFront', new THREE.Float32BufferAttribute(front, 1));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    vertexShader: curtainVert,
    fragmentShader: curtainFrag,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: color.clone() }, uFade: { value: 0 }, uTime: { value: 0 } }]),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.layers.set(LAYER_VFX);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.name = 'deploy-curtain';
  return mesh;
}
