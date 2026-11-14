// GPU particle pool: a ring buffer of instanced camera-facing quads. Each particle is written once
// at spawn (only the touched range of each attribute is re-uploaded); motion is analytic in the
// vertex shader from a time uniform:
//   p(t) = p0 + v0·(1 − e^(−drag·t))/drag + ½·g·t²   (g along +Y: negative falls, positive rises)
// Size, colour and alpha interpolate over the particle's life. `stretch` > 0 turns the quad into a
// velocity-aligned streak (sparks, embers, rising light). Two blend modes: additive HDR (fire,
// sparks, magic — values > 1 bloom) and alpha (dust, smoke — tinted by a light colour uniform).
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
  cell: number;
  /** Velocity streak factor (seconds of travel per quad length), 0 = round sprite. */
  stretch?: number;
  /** Fraction of life spent fading in (0 = pop in). */
  fadeIn?: number;
  /** Start delay in seconds. */
  delay?: number;
}

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aTime;   // birth, life, gravity, drag
attribute vec4 aSize;   // size0, size1, rot0, spin
attribute vec4 aCol0;   // rgb0, alpha
attribute vec4 aCol1;   // rgb1, cell
attribute vec2 aExtra;  // stretch, fadeIn
uniform float uTime;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  float age = uTime - aTime.x;
  float life = aTime.y;
  if (age < 0.0 || age > life) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vCol = vec4(0.0); vUv = vec2(0.0); return; }
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
  // pull big sprites toward the camera so they don't slice into the ground (cheap soft-particle stand-in)
  mv.z += min(size * 0.5, -mv.z * 0.3);
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
  mv.xy += (ax * c.x + ay * c.y * len) * size;
  gl_Position = projectionMatrix * mv;
  float cell = aCol1.w;
  vec2 cr = vec2(mod(cell, ${ATLAS_COLS}.0), floor(cell / ${ATLAS_COLS}.0));
  vUv = vec2((cr.x + c.x + 0.5) / ${ATLAS_COLS}.0, 1.0 - (cr.y + 0.5 - c.y) / ${ATLAS_ROWS}.0);
  float fin = aExtra.y > 0.0 ? clamp(t / aExtra.y, 0.0, 1.0) : 1.0;
  float fout = 1.0 - smoothstep(0.5, 1.0, t);
  vCol = vec4(mix(aCol0.rgb, aCol1.rgb, t), aCol0.a * fin * fout);
}`;

const FRAG_ADD = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.a * tx.r * vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * (a * 0.32), 0.0);
}`;

const FRAG_ALPHA = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.a * vCol.a;
  if (a < 0.004) discard;
  // fake self-shadowing: denser (redder channel) parts read a little darker
  float shade = mix(0.72, 1.0, tx.r);
  gl_FragColor = vec4(vCol.rgb * uLight * shade, a);
}`;

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aTime: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aCol0: THREE.InstancedBufferAttribute;
  private aCol1: THREE.InstancedBufferAttribute;
  private aExtra: THREE.InstancedBufferAttribute;
  private head = 0;
  private flushed = 0;
  /** Pool time (seconds); advanced by `tick`. */
  time = 0;
  /** Latest death time of any particle. */
  aliveUntil = 0;

  constructor(capacity: number, mode: 'add' | 'alpha', atlas: THREE.Texture) {
    this.capacity = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(3);
    this.aVel = mk(3);
    this.aTime = mk(4);
    this.aSize = mk(4);
    this.aCol0 = mk(4);
    this.aCol1 = mk(4);
    this.aExtra = mk(2);
    // everything starts dead: birth far in the future would also work; life 0 is simplest
    for (let i = 0; i < capacity; i++) this.aTime.array[i * 4] = -1e6;
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aCol0', this.aCol0);
    geo.setAttribute('aCol1', this.aCol1);
    geo.setAttribute('aExtra', this.aExtra);
    geo.instanceCount = capacity;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: mode === 'add' ? FRAG_ADD : FRAG_ALPHA,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: atlas },
        uLight: { value: new THREE.Color(1.7, 1.6, 1.45) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: mode === 'add' ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    });
    if (mode === 'alpha') {
      this.mat.blendSrc = THREE.SrcAlphaFactor;
      this.mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    }
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    // alpha smoke draws first, additive glows over it
    this.mesh.renderOrder = mode === 'alpha' ? 10 : 20;
    this.mesh.name = `vfx.particles.${mode}`;
  }

  /** Light colour multiplying alpha-pool particles (sun + sky). */
  get light(): THREE.Color {
    return this.mat.uniforms.uLight.value as THREE.Color;
  }

  emit(p: Particle): void {
    const i = this.head % this.capacity;
    this.head++;
    const birth = this.time + (p.delay ?? 0);
    const pos = this.aPos.array as Float32Array;
    const vel = this.aVel.array as Float32Array;
    const tm = this.aTime.array as Float32Array;
    const sz = this.aSize.array as Float32Array;
    const c0 = this.aCol0.array as Float32Array;
    const c1 = this.aCol1.array as Float32Array;
    const ex = this.aExtra.array as Float32Array;
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    vel[i * 3] = p.vx ?? 0;
    vel[i * 3 + 1] = p.vy ?? 0;
    vel[i * 3 + 2] = p.vz ?? 0;
    tm[i * 4] = birth;
    tm[i * 4 + 1] = p.life;
    tm[i * 4 + 2] = p.gravity ?? 0;
    tm[i * 4 + 3] = p.drag ?? 0;
    sz[i * 4] = p.size;
    sz[i * 4 + 1] = p.size1 ?? p.size;
    sz[i * 4 + 2] = p.rot ?? Math.random() * Math.PI * 2;
    sz[i * 4 + 3] = p.spin ?? 0;
    c0[i * 4] = p.r;
    c0[i * 4 + 1] = p.g;
    c0[i * 4 + 2] = p.b;
    c0[i * 4 + 3] = p.alpha ?? 1;
    c1[i * 4] = p.r1 ?? p.r;
    c1[i * 4 + 1] = p.g1 ?? p.g;
    c1[i * 4 + 2] = p.b1 ?? p.b;
    c1[i * 4 + 3] = p.cell;
    ex[i * 2] = p.stretch ?? 0;
    ex[i * 2 + 1] = p.fadeIn ?? 0;
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
    const written = this.head - this.flushed;
    if (written <= 0) return;
    const attrs = [this.aPos, this.aVel, this.aTime, this.aSize, this.aCol0, this.aCol1, this.aExtra];
    const cap = this.capacity;
    const start = this.flushed % cap;
    for (const a of attrs) {
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
    const tm = this.aTime.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) tm[i * 4] = -1e6;
    this.aTime.clearUpdateRanges();
    this.aTime.needsUpdate = true;
    this.aliveUntil = 0;
    this.flushed = this.head;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
  }
}
