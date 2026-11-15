// Batched ground decals: every scorch mark, crater, shockwave ring, sigil and scuff is one
// instance of a single quad mesh (ONE draw call), laid on the terrain along the local slope.
// Premultiplied blending: glowing decals add light, soot / cracks darken the ground.
//
// Animation is analytic in the shader (birth + life per instance); the CPU only writes at spawn.
// `animatedUntil` tells the VFX loop how long frames are needed: long-lived static marks (scorch,
// scuffs) only ask for frames while they appear, then sit in the scene for free and fade
// whenever the battle is rendering anyway.
import * as THREE from 'three';
import { LAYER_VFX } from '../core/post.ts';
import { DECAL_COLS, DECAL_ROWS } from './atlas.ts';

export type Ground = (wx: number, wz: number) => number;

/** kind 6 = rime: frost creeping over the ground (soft whitening, feathery crystalline rim, melts back at the end).
 * kind: 0 expanding shockwave ring · 1 soft glow · 2 glowing sheet cell (sigil) · 3 dark sheet cell (scorch / cracks, optional ember glow) · 4 soft dark scuff · 5 pulsing warning ring */
export const DK = { shock: 0, glow: 1, sigil: 2, mark: 3, scuff: 4, warn: 5, rime: 6 } as const;

export interface DecalSpec {
  kind: number;
  x: number;
  z: number;
  radius: number;
  life: number;
  /** Linear HDR colour (glow kinds) or ember colour (marks). */
  r: number;
  g: number;
  b: number;
  alpha?: number;
  /** Sheet cell for sigil / mark kinds. */
  cell?: number;
  rot?: number;
  /** rad/s (sigils turn slowly). */
  spin?: number;
  /** Seconds to fade in. */
  fadeIn?: number;
  /** Radius at birth as a fraction of `radius` (sigils unfurl). */
  grow?: number;
  delay?: number;
}

const VERT = /* glsl */ `
attribute vec4 aCenter;  // xyz, radius
attribute vec4 aTime;    // birth, life, fadeIn, kind
attribute vec4 aColor;   // rgb, alpha
attribute vec4 aParam;   // cell, rot, spin, grow
attribute vec2 aTilt;    // ground slope dy/dx, dy/dz
uniform float uTime;
varying vec2 vLocal;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vInfo;      // kind, life fraction, age
void main() {
  float age = uTime - aTime.x;
  float life = aTime.y;
  if (age < 0.0 || age > life) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vColor = vec4(0.0); vLocal = vec2(0.0); vUv = vec2(0.0); vInfo = vec3(0.0); return; }
  float t = age / life;
  float kind = aTime.w;
  float grow = mix(aParam.w, 1.0, 1.0 - pow(1.0 - clamp(age / max(aTime.z, 0.001), 0.0, 1.0), 3.0));
  float rad = aCenter.w * grow;
  float ang = aParam.y + aParam.z * age;
  float cs = cos(ang);
  float sn = sin(ang);
  vec2 l = position.xz;
  vec2 q = vec2(l.x * cs - l.y * sn, l.x * sn + l.y * cs) * rad;
  vec3 p = aCenter.xyz + vec3(q.x, q.x * aTilt.x + q.y * aTilt.y + 0.07, q.y);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // projected-decal feel: bias the depth toward the camera so grass tufts and pebbles take the mark too
  vec4 near = projectionMatrix * vec4(mv.xy, mv.z + 0.6, 1.0);
  gl_Position.z = near.z / near.w * gl_Position.w;
  vLocal = l;
  float cell = aParam.x;
  vec2 cr = vec2(mod(cell, ${DECAL_COLS}.0), floor(cell / ${DECAL_COLS}.0));
  vUv = (cr + clamp(l * 0.5 + 0.5, 0.003, 0.997)) / vec2(${DECAL_COLS}.0, ${DECAL_ROWS}.0);
  float fin = aTime.z > 0.0 ? clamp(age / aTime.z, 0.0, 1.0) : 1.0;
  float fout = 1.0 - smoothstep(0.72, 1.0, t);
  vColor = vec4(aColor.rgb, aColor.a * fin * fout);
  vInfo = vec3(kind, t, age);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vLocal;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vInfo;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;
  float kind = vInfo.x;
  float t = vInfo.y;
  float edge = smoothstep(1.0, 0.94, r);
  vec3 add = vec3(0.0);
  float dark = 0.0;
  if (kind < 0.5) {
    // shockwave: a thin ring racing outward with a soft trailing fill
    float rr = 1.0 - pow(1.0 - t, 2.4);
    float w = 0.035 + 0.07 * t;
    float a = exp(-pow((r - rr) / w, 2.0)) * 1.3 + smoothstep(rr, 0.0, r) * 0.14 * (1.0 - t);
    add = vColor.rgb * a * pow(1.0 - t, 1.5) * vColor.a;
  } else if (kind < 1.5) {
    add = vColor.rgb * exp(-r * r * 3.6) * vColor.a;
  } else if (kind < 2.5) {
    float m = texture2D(uMap, vUv).r;
    add = vColor.rgb * (m * 1.25 + exp(-r * r * 4.0) * 0.12) * vColor.a;
  } else if (kind < 3.5) {
    float m = texture2D(uMap, vUv).r;
    dark = clamp(m * 1.7 + exp(-r * r * 3.0) * 0.35, 0.0, 1.0) * 0.86 * vColor.a;
    // embers glowing in the cracks for the first part of its life
    float hot = max(0.0, 1.0 - vInfo.z / 2.2);
    add = vColor.rgb * m * m * hot * hot * exp(-r * r * 2.5) * 1.6;
  } else if (kind < 4.5) {
    dark = exp(-r * r * 4.5) * 0.55 * vColor.a;
  } else if (kind > 5.5) {
    // rime: frost races out over the ground, holds, then melts back from its edge
    float ang = atan(vLocal.y, vLocal.x);
    float lumpy = n2(vLocal * 3.5 + 11.0);
    float fine = n2(vLocal * 13.0 + 3.0);
    float front = (1.0 - exp(-vInfo.z * 4.5)) * (1.0 - 0.75 * smoothstep(0.62, 1.0, t));
    // feathery crystal needles push the rim outward in spikes of different length
    float seg = ang * 9.0 + lumpy * 1.2;
    float needle = pow(abs(sin(seg * 3.0)), 10.0) * (0.35 + 0.65 * n2(vec2(floor(seg * 0.955) * 7.3, 2.0)));
    float patchy = n2(vLocal * 2.1 + 5.0);
    float edgeR = front * (0.56 + 0.34 * patchy + 0.07 * needle);
    float body = 1.0 - smoothstep(edgeR - 0.2 - 0.12 * fine, edgeR, r);
    // thin toward the middle where feet have churned it, densest in a band inside the rim
    float band = 0.55 + 0.45 * smoothstep(0.0, edgeR * 0.75, r);
    float cover = body * band * (0.72 + 0.28 * fine) * (0.4 + 0.6 * smoothstep(0.2, 0.7, lumpy + 0.3 * fine));
    // hard glints along crystal edges and scattered sparkles
    float crystal = smoothstep(0.55, 0.9, needle) * smoothstep(edgeR - 0.28, edgeR - 0.05, r) * body;
    float spark = step(0.993, h2(floor(vLocal * 70.0))) * body * (0.5 + 0.5 * sin(vInfo.z * 9.0 + h2(floor(vLocal * 90.0) + 3.0) * 40.0));
    float a = cover * vColor.a;
    dark = a * 0.34;                                   // whitens the ground instead of glowing over it
    add = vColor.rgb * (crystal * 0.35 + spark * 1.2) * vColor.a * 2.5;
    add *= edge * 0.4;
    dark *= edge;
    if (dark < 0.003 && max(add.r, max(add.g, add.b)) < 0.002) discard;
    gl_FragColor = vec4(add + vec3(0.5, 0.62, 0.78) * dark, dark);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  } else {
    // warning: pulsing rim + a ring closing on the centre as the strike nears
    float a = exp(-pow((r - 0.95) / 0.035, 2.0)) * (0.6 + 0.4 * sin(vInfo.z * 18.0));
    a += smoothstep(1.0, 0.0, r) * 0.3 * t + exp(-pow((r - (1.0 - t)) / 0.045, 2.0)) * 0.8;
    add = vColor.rgb * a * min(1.0, vInfo.z * 4.0) * vColor.a;
  }
  add *= edge * 0.4;
  dark *= edge;
  if (dark < 0.003 && max(add.r, max(add.g, add.b)) < 0.002) discard;
  // darkening multiplies the ground toward a warm soot colour
  gl_FragColor = vec4(add + vec3(0.03, 0.024, 0.02) * dark, dark);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class DecalBatch {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private aCenter: Float32Array;
  private aTime: Float32Array;
  private aColor: Float32Array;
  private aParam: Float32Array;
  private aTilt: Float32Array;
  private cap: number;
  private head = 0;
  private dirty = false;
  private ground: Ground;
  time = 0;
  /** Latest time at which any decal is still visibly animating. */
  animatedUntil = 0;
  private aliveUntil = 0;

  constructor(capacity: number, sheet: THREE.Texture, ground: Ground) {
    this.cap = capacity;
    this.ground = ground;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    const mk = (name: string, n: number): Float32Array => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      this.attrs.push(a);
      return a.array as Float32Array;
    };
    this.aCenter = mk('aCenter', 4);
    this.aTime = mk('aTime', 4);
    this.aColor = mk('aColor', 4);
    this.aParam = mk('aParam', 4);
    this.aTilt = mk('aTilt', 2);
    for (let i = 0; i < capacity; i++) this.aTime[i * 4] = -1e6;
    geo.instanceCount = capacity;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 }, uMap: { value: sheet } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      premultipliedAlpha: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 4;
    this.mesh.name = 'vfx.decals';
    this.mesh.visible = false;
  }

  spawn(d: DecalSpec): void {
    const i = this.head++ % this.cap;
    const i4 = i * 4;
    const y = this.ground(d.x, d.z);
    // slope from a central difference at half the radius (flat decals stay glued to hillsides)
    const h = Math.max(0.4, d.radius * 0.5);
    let sx = (this.ground(d.x + h, d.z) - this.ground(d.x - h, d.z)) / (2 * h);
    let sz = (this.ground(d.x, d.z + h) - this.ground(d.x, d.z - h)) / (2 * h);
    sx = Math.max(-0.6, Math.min(0.6, sx));
    sz = Math.max(-0.6, Math.min(0.6, sz));
    const birth = this.time + (d.delay ?? 0);
    this.aCenter[i4] = d.x;
    this.aCenter[i4 + 1] = y;
    this.aCenter[i4 + 2] = d.z;
    this.aCenter[i4 + 3] = d.radius;
    this.aTime[i4] = birth;
    this.aTime[i4 + 1] = d.life;
    this.aTime[i4 + 2] = d.fadeIn ?? 0;
    this.aTime[i4 + 3] = d.kind;
    this.aColor[i4] = d.r;
    this.aColor[i4 + 1] = d.g;
    this.aColor[i4 + 2] = d.b;
    this.aColor[i4 + 3] = d.alpha ?? 1;
    this.aParam[i4] = d.cell ?? 0;
    this.aParam[i4 + 1] = d.rot ?? Math.random() * Math.PI * 2;
    this.aParam[i4 + 2] = d.spin ?? 0;
    this.aParam[i4 + 3] = d.grow ?? 1;
    this.aTilt[i * 2] = sx;
    this.aTilt[i * 2 + 1] = sz;
    this.dirty = true;
    const end = birth + d.life;
    if (end > this.aliveUntil) this.aliveUntil = end;
    // static marks only need frames while they appear / while their embers glow
    const anim = d.kind === DK.rime ? end : d.kind === DK.mark ? birth + Math.min(d.life, 2.4) : d.kind === DK.scuff ? birth + Math.min(d.life, (d.fadeIn ?? 0) + 0.1) : end;
    if (anim > this.animatedUntil) this.animatedUntil = anim;
  }

  get alive(): boolean {
    return this.time < this.animatedUntil;
  }

  tick(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    this.mesh.visible = this.time < this.aliveUntil;
    if (this.dirty) {
      for (const a of this.attrs) a.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) this.aTime[i * 4] = -1e6;
    this.attrs[1].needsUpdate = true;
    this.aliveUntil = this.animatedUntil = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
