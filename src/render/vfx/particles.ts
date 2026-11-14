// GPU particle pool: a ring buffer of instanced camera-facing quads, ONE draw call per pool.
// Each particle is written once at spawn (only the touched range of each attribute is
// re-uploaded); motion is analytic in the vertex shader from a time uniform:
//   p(t) = p0 + v0·(1 − e^(−drag·t))/drag + ½·g·t²   (g along +Y: negative falls, positive rises)
// Size, colour and alpha interpolate over the particle's life. `stretch` > 0 turns the quad into a
// velocity-aligned streak (sparks, embers, rising light).
//
// Sprites come from the flipbook atlas (atlas.ts): `frames` > 1 plays a flipbook over the
// particle's life (or loops at `fps`), cross-fading neighbouring frames.
//
// Blending is premultiplied (ONE, ONE_MINUS_SRC_ALPHA) so one shader covers the whole range:
//   glow = 1 → pure additive HDR (sparks, magic; values > ~1.35 bloom)
//   glow = 0 → lit, occluding smoke / dust (tinted by the light uniform)
//   between → fire that both glows and hides what is behind it (explosion flipbooks)
//
// Soft particles: each particle carries the ground height under it and fades out where the
// quad dips below the ground, so puffs never show a hard line where they meet the terrain
// (works on every tier: no depth texture needed).
import * as THREE from 'three';
import { LAYER_VFX } from '../core/post.ts';
import { ATLAS_COLS, ATLAS_ROWS } from './atlas.ts';

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  size1?: number;
  rot?: number;
  spin?: number;
  /** m/s² along +Y (negative = falls). */
  gravity?: number;
  drag?: number;
  /** Linear HDR colour at birth. */
  r: number;
  g: number;
  b: number;
  /** Colour at death (defaults to birth colour). */
  r1?: number;
  g1?: number;
  b1?: number;
  alpha?: number;
  /** First atlas cell. */
  cell: number;
  /** Flipbook frame count (1 = still sprite). */
  frames?: number;
  /** > 0: loop the flipbook at this rate instead of playing it once over the life. */
  fps?: number;
  /** 1 = additive, 0 = lit alpha (default: the pool's mode). */
  glow?: number;
  /** HDR multiplier for the fire-coloured texels of a lit sprite (explosion flipbooks). */
  emis?: number;
  /** Velocity streak factor (seconds of travel per quad length), 0 = round sprite. */
  stretch?: number;
  /** Fraction of life spent fading in (0 = pop in). */
  fadeIn?: number;
  /** Fraction of life after which it fades out (default 0.5). */
  fadeOut?: number;
  /** Start delay in seconds. */
  delay?: number;
  /** Ground height under the particle for the soft fade (omit = no fade). */
  ground?: number;
}

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aTime;   // birth, life, gravity, drag
attribute vec4 aSize;   // size0, size1, rot0, spin
attribute vec4 aCol0;   // rgb0, alpha
attribute vec4 aCol1;   // rgb1, cell
attribute vec4 aExtra;  // stretch, fadeIn, ground, fadeOut
attribute vec4 aAnim;   // frames, fps, glow, emissive
uniform float uTime;
varying vec4 vUv;       // frame A uv, frame B uv
varying vec4 vCol;
varying vec3 vMix;      // frame blend, glow, soft fade
varying float vEmis;
vec2 cellUv(float cell, vec2 c) {
  vec2 cr = vec2(mod(cell, ${ATLAS_COLS}.0), floor(cell / ${ATLAS_COLS}.0));
  return (cr + vec2(clamp(c.x + 0.5, 0.004, 0.996), clamp(0.5 - c.y, 0.004, 0.996))) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0);
}
void main() {
  float age = uTime - aTime.x;
  float life = aTime.y;
  if (age < 0.0 || age > life) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vCol = vec4(0.0); vUv = vec4(0.0); vMix = vec3(0.0); vEmis = 0.0; return; }
  float t = age / life;
  float drag = aTime.w;
  float e = exp(-drag * age);
  float k = drag > 0.0001 ? (1.0 - e) / drag : age;
  vec3 p = aPos + aVel * k;
  p.y += 0.5 * aTime.z * age * age;
  vec3 v = aVel * e;
  v.y += aTime.z * age;
  float size = mix(aSize.x, aSize.y, 1.0 - (1.0 - t) * (1.0 - t));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  // nudge big sprites toward the camera so they don't slice into soldiers standing in them
  mv.z += min(size * 0.3, -mv.z * 0.2);
  vec2 c = position.xy;
  vec2 ax;
  vec2 ay;
  float len = 1.0;
  if (aExtra.x > 0.0) {
    vec3 vv = mat3(viewMatrix) * v;
    float sp = length(vv.xy);
    ay = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
    ax = vec2(ay.y, -ay.x);
    len = 1.0 + aExtra.x * sp / max(size, 0.01);
  } else {
    float ang = aSize.z + aSize.w * age;
    ax = vec2(cos(ang), sin(ang));
    ay = vec2(-ax.y, ax.x);
  }
  vec2 off = (ax * c.x + ay * c.y * len) * size;
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  // world height of this corner (camera right / up have these world-Y components)
  float wy = p.y + off.x * viewMatrix[0][1] + off.y * viewMatrix[1][1];
  float soft = max(0.12, size * 0.3);
  vMix.z = aExtra.z < -500.0 ? 1.0 : (wy - aExtra.z) / soft;
  // flipbook
  float frames = aAnim.x;
  float f = aAnim.y > 0.0 ? mod(age * aAnim.y + aSize.z * 7.0, frames) : min(t * frames, frames - 0.001);
  float f0 = floor(f);
  float f1 = aAnim.y > 0.0 ? mod(f0 + 1.0, frames) : min(f0 + 1.0, frames - 1.0);
  vUv = vec4(cellUv(aCol1.w + f0, c), cellUv(aCol1.w + f1, c));
  vMix.x = frames > 1.5 ? f - f0 : 0.0;
  vMix.y = aAnim.z;
  vEmis = aAnim.w;
  float fin = aExtra.y > 0.0 ? clamp(t / aExtra.y, 0.0, 1.0) : 1.0;
  float fout = 1.0 - smoothstep(aExtra.w, 1.0, t);
  vCol = vec4(mix(aCol0.rgb, aCol1.rgb, t), aCol0.a * fin * fout);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
varying vec4 vUv;
varying vec4 vCol;
varying vec3 vMix;
varying float vEmis;
void main() {
  vec3 tx = texture2D(uMap, vUv.xy).rgb;
  if (vMix.x > 0.001) tx = mix(tx, texture2D(uMap, vUv.zw).rgb, vMix.x);
  float lum = max(tx.r, max(tx.g, tx.b));
  float fade = vCol.a * clamp(vMix.z, 0.0, 1.0);
  if (lum * fade < 0.003) discard;
  float glow = vMix.y;
  // saturated texels are fire (emissive); grey ones are smoke (lit, occluding)
  float sat = (lum - min(tx.r, min(tx.g, tx.b))) / max(lum, 0.001);
  float cover = clamp(lum * 2.4, 0.0, 1.0) * fade * (1.0 - glow);
  float fire = vEmis > 0.0 ? max(sat, smoothstep(0.4, 0.75, lum)) : 0.0;
  vec3 lit = (0.4 + 0.6 * lum) * vCol.rgb * uLight * cover * (1.0 - fire);
  vec3 emit = tx * (fade * 0.32) * (glow * vCol.rgb + (1.0 - glow) * fire * vEmis);
  gl_FragColor = vec4(lit + emit, cover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private attrs: THREE.InstancedBufferAttribute[];
  private aPos: Float32Array;
  private aVel: Float32Array;
  private aTime: Float32Array;
  private aSize: Float32Array;
  private aCol0: Float32Array;
  private aCol1: Float32Array;
  private aExtra: Float32Array;
  private aAnim: Float32Array;
  private head = 0;
  private flushed = 0;
  private defGlow: number;
  private full = false;
  /** Pool time (seconds); advanced by `tick`. */
  time = 0;
  /** Latest death time of any particle. */
  aliveUntil = 0;

  constructor(capacity: number, mode: 'add' | 'alpha', atlas: THREE.Texture) {
    this.capacity = capacity;
    this.defGlow = mode === 'add' ? 1 : 0;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = [];
    const mk = (name: string, n: number): Float32Array => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      this.attrs.push(a);
      return a.array as Float32Array;
    };
    this.aPos = mk('aPos', 3);
    this.aVel = mk('aVel', 3);
    this.aTime = mk('aTime', 4);
    this.aSize = mk('aSize', 4);
    this.aCol0 = mk('aCol0', 4);
    this.aCol1 = mk('aCol1', 4);
    this.aExtra = mk('aExtra', 4);
    this.aAnim = mk('aAnim', 4);
    for (let i = 0; i < capacity; i++) this.aTime[i * 4] = -1e6;
    geo.instanceCount = capacity;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: atlas },
        uLight: { value: new THREE.Color(1.3, 1.24, 1.12) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      premultipliedAlpha: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    // smoke draws first, glows over it
    this.mesh.renderOrder = mode === 'alpha' ? 10 : 20;
    this.mesh.name = `vfx.particles.${mode}`;
    this.mesh.visible = false;
  }

  /** Light colour multiplying lit particles (sun + sky). */
  get light(): THREE.Color {
    return this.mat.uniforms.uLight.value as THREE.Color;
  }

  emit(p: Particle): void {
    const i = this.head % this.capacity;
    this.head++;
    const birth = this.time + (p.delay ?? 0);
    const i3 = i * 3;
    const i4 = i * 4;
    this.aPos[i3] = p.x;
    this.aPos[i3 + 1] = p.y;
    this.aPos[i3 + 2] = p.z;
    this.aVel[i3] = p.vx ?? 0;
    this.aVel[i3 + 1] = p.vy ?? 0;
    this.aVel[i3 + 2] = p.vz ?? 0;
    this.aTime[i4] = birth;
    this.aTime[i4 + 1] = p.life;
    this.aTime[i4 + 2] = p.gravity ?? 0;
    this.aTime[i4 + 3] = p.drag ?? 0;
    this.aSize[i4] = p.size;
    this.aSize[i4 + 1] = p.size1 ?? p.size;
    this.aSize[i4 + 2] = p.rot ?? Math.random() * Math.PI * 2;
    this.aSize[i4 + 3] = p.spin ?? 0;
    this.aCol0[i4] = p.r;
    this.aCol0[i4 + 1] = p.g;
    this.aCol0[i4 + 2] = p.b;
    this.aCol0[i4 + 3] = p.alpha ?? 1;
    this.aCol1[i4] = p.r1 ?? p.r;
    this.aCol1[i4 + 1] = p.g1 ?? p.g;
    this.aCol1[i4 + 2] = p.b1 ?? p.b;
    this.aCol1[i4 + 3] = p.cell;
    this.aExtra[i4] = p.stretch ?? 0;
    this.aExtra[i4 + 1] = p.fadeIn ?? 0;
    this.aExtra[i4 + 2] = p.ground ?? -1000;
    this.aExtra[i4 + 3] = p.fadeOut ?? 0.5;
    this.aAnim[i4] = p.frames ?? 1;
    this.aAnim[i4 + 1] = p.fps ?? 0;
    this.aAnim[i4 + 2] = p.glow ?? this.defGlow;
    this.aAnim[i4 + 3] = p.emis ?? 0;
    const end = birth + p.life;
    if (end > this.aliveUntil) this.aliveUntil = end;
  }

  get alive(): boolean {
    return this.time < this.aliveUntil;
  }

  /** Advance time and upload what was written since the last tick. */
  tick(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    // nothing alive: skip the draw call entirely
    this.mesh.visible = this.time < this.aliveUntil;
    const written = this.head - this.flushed;
    if (this.full) {
      // after a clear: push every attribute whole (a partial range would leave stale particles on the GPU)
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
      this.full = false;
      this.flushed = this.head;
      return;
    }
    if (written <= 0) return;
    const cap = this.capacity;
    const start = this.flushed % cap;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      const n = a.itemSize;
      if (written >= cap) a.addUpdateRange(0, cap * n);
      else if (start + written <= cap) a.addUpdateRange(start * n, written * n);
      else {
        a.addUpdateRange(start * n, (cap - start) * n);
        a.addUpdateRange(0, (start + written - cap) * n);
      }
      a.needsUpdate = true;
    }
    this.flushed = this.head;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.aTime[i * 4] = -1e6;
    this.full = true;
    this.aliveUntil = 0;
    this.flushed = this.head;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
  }
}
