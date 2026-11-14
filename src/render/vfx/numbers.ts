// Batched world-space damage numbers: one instanced quad per glyph from a canvas glyph atlas.
// Each number pops, floats up and fades in the vertex shader; the CPU only writes on spawn.
// Numbers draw on top (no depth test) so they stay readable over troops and hills.
import * as THREE from 'three';
import { LAYER_VFX } from '../core/post.ts';

export type NumberStyle = 'normal' | 'crit' | 'heal' | 'effective' | 'weak' | 'miss';

const GLYPHS = '0123456789+MIS!-';
const COLS = 8;
const ROWS = 2;
const GW = 64;
const GH = 96;
const LIFE = 1.15;

const STYLE: Record<NumberStyle, { color: [number, number, number]; scale: number }> = {
  normal: { color: [1.25, 1.22, 1.15], scale: 0.62 },
  crit: { color: [3.2, 1.9, 0.35], scale: 1.0 },
  heal: { color: [0.55, 2.2, 0.6], scale: 0.62 },
  effective: { color: [2.6, 1.2, 0.3], scale: 0.8 },
  weak: { color: [0.75, 0.75, 0.8], scale: 0.5 },
  miss: { color: [0.85, 0.9, 1.1], scale: 0.5 },
};

function glyphAtlas(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = COLS * GW;
  c.height = ROWS * GH;
  const ctx = c.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${Math.round(GH * 0.82)}px Georgia, 'Times New Roman', serif`;
  ctx.lineJoin = 'round';
  for (let i = 0; i < GLYPHS.length; i++) {
    const x = (i % COLS) * GW + GW / 2;
    const y = Math.floor(i / COLS) * GH + GH / 2 + 4;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = 11;
    ctx.strokeText(GLYPHS[i], x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(GLYPHS[i], x, y);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aInfo;   // birth, x offset (glyph widths), glyph, scale
attribute vec3 aColor;
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aInfo.x;
  if (age < 0.0 || age > ${LIFE.toFixed(2)}) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vAlpha = 0.0; return; }
  float t = age / ${LIFE.toFixed(2)};
  float pop = t < 0.08 ? mix(0.3, 1.45, t / 0.08) : mix(1.45, 1.0, clamp((t - 0.08) / 0.14, 0.0, 1.0));
  vec3 p = aOrigin;
  p.y += 1.7 * (1.0 - (1.0 - t) * (1.0 - t));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float sz = aInfo.w * clamp(-mv.z * 0.02, 0.45, 3.2) * pop;
  mv.xy += vec2((position.x + aInfo.y) * 0.6, position.y) * sz;
  gl_Position = projectionMatrix * mv;
  float g = aInfo.z;
  vec2 cell = vec2(mod(g, ${COLS}.0), floor(g / ${COLS}.0));
  vec2 c = position.xy + 0.5;
  vUv = vec2((cell.x + c.x) / ${COLS}.0, 1.0 - (cell.y + 1.0 - c.y) / ${ROWS}.0);
  vColor = aColor;
  vAlpha = 1.0 - smoothstep(0.65, 1.0, t);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.a * vAlpha;
  if (a < 0.01) discard;
  vec3 col = mix(vec3(0.02, 0.015, 0.01), vColor, tx.r);
  gl_FragColor = vec4(col, a);
}`;

export class DamageNumbers {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aOrigin: THREE.InstancedBufferAttribute;
  private aInfo: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private cap: number;
  private head = 0;
  private dirty = false;
  time = 0;
  aliveUntil = 0;

  constructor(capacity = 1024) {
    this.cap = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.aOrigin = mk(3);
    this.aInfo = mk(4);
    this.aColor = mk(3);
    for (let i = 0; i < capacity; i++) this.aInfo.array[i * 4] = -1e6;
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aInfo', this.aInfo);
    geo.setAttribute('aColor', this.aColor);
    geo.instanceCount = capacity;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 }, uMap: { value: glyphAtlas() } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 100;
  }

  show(pos: THREE.Vector3, value: number, style: NumberStyle = 'normal'): void {
    const st = STYLE[style];
    let text: string;
    if (style === 'miss') text = 'MISS';
    else {
      const v = Math.max(0, Math.round(Math.abs(value)));
      text = (style === 'heal' ? '+' : '') + String(v) + (style === 'crit' ? '!' : '');
    }
    const jx = (Math.random() - 0.5) * 0.6;
    const jz = (Math.random() - 0.5) * 0.6;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const g = GLYPHS.indexOf(text[i]);
      if (g < 0) continue;
      const k = this.head++ % this.cap;
      const o = this.aOrigin.array as Float32Array;
      const inf = this.aInfo.array as Float32Array;
      const c = this.aColor.array as Float32Array;
      o[k * 3] = pos.x + jx;
      o[k * 3 + 1] = pos.y;
      o[k * 3 + 2] = pos.z + jz;
      inf[k * 4] = this.time;
      inf[k * 4 + 1] = i - (n - 1) / 2;
      inf[k * 4 + 2] = g;
      inf[k * 4 + 3] = st.scale;
      c[k * 3] = st.color[0];
      c[k * 3 + 1] = st.color[1];
      c[k * 3 + 2] = st.color[2];
    }
    this.dirty = true;
    this.aliveUntil = this.time + LIFE;
  }

  get alive(): boolean {
    return this.time < this.aliveUntil;
  }

  tick(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (this.dirty) {
      // numbers are sparse: re-upload whole (small) buffers
      this.aOrigin.needsUpdate = true;
      this.aInfo.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) this.aInfo.array[i * 4] = -1e6;
    this.aInfo.needsUpdate = true;
    this.aliveUntil = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mat.uniforms.uMap.value as THREE.Texture).dispose();
    this.mat.dispose();
  }
}
