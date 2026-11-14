// Batched world-space damage numbers: one instanced quad per glyph from a canvas glyph atlas,
// ONE draw call. Each number pops, drifts up and fades in the vertex shader; the CPU only writes
// on spawn. Numbers keep a constant on-screen size (a fraction of the viewport height) and draw
// on top (no depth test) so they stay readable over troops and hills.
//
// The atlas stores fill coverage (R), a top-to-bottom shade (G) and outline + shadow coverage (A),
// so each glyph gets a dark rim, a soft drop shadow and a subtle metallic gradient in its colour.
import * as THREE from 'three';
import { LAYER_VFX } from '../core/post.ts';

export type NumberStyle = 'normal' | 'crit' | 'heal' | 'effective' | 'weak' | 'miss';

const GLYPHS = '0123456789+MIS!-';
const COLS = 8;
const ROWS = 2;
const GW = 96;
const GH = 128;
const FONT = `800 ${Math.round(GH * 0.7)}px Cinzel, 'Trajan Pro', Georgia, 'Times New Roman', serif`;

/** colour (linear, lit by the grade), height as a fraction of the viewport, life in seconds. */
const STYLE: Record<NumberStyle, { color: [number, number, number]; size: number; life: number }> = {
  normal: { color: [1.0, 0.97, 0.9], size: 0.046, life: 1.05 },
  crit: { color: [1.9, 1.05, 0.22], size: 0.078, life: 1.5 },
  heal: { color: [0.42, 1.45, 0.5], size: 0.048, life: 1.25 },
  effective: { color: [1.6, 0.78, 0.2], size: 0.054, life: 1.15 },
  weak: { color: [0.62, 0.64, 0.7], size: 0.037, life: 0.9 },
  miss: { color: [0.7, 0.78, 0.95], size: 0.034, life: 0.8 },
};

function drawAtlas(c: HTMLCanvasElement): void {
  c.width = COLS * GW;
  c.height = ROWS * GH;
  const mk = () => {
    const k = document.createElement('canvas');
    k.width = c.width;
    k.height = c.height;
    const x = k.getContext('2d')!;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = FONT;
    x.lineJoin = 'round';
    return x;
  };
  const fill = mk();
  const rim = mk();
  for (let i = 0; i < GLYPHS.length; i++) {
    const x = (i % COLS) * GW + GW / 2;
    const y = Math.floor(i / COLS) * GH + GH / 2 + 3;
    fill.fillStyle = '#fff';
    fill.fillText(GLYPHS[i], x, y);
    // soft drop shadow, then the hard rim
    rim.save();
    rim.shadowColor = 'rgba(255,255,255,0.75)';
    rim.shadowBlur = 9;
    rim.shadowOffsetY = 5;
    rim.fillStyle = '#fff';
    rim.fillText(GLYPHS[i], x, y);
    rim.restore();
    rim.strokeStyle = '#fff';
    rim.lineWidth = 10;
    rim.strokeText(GLYPHS[i], x, y);
    rim.fillStyle = '#fff';
    rim.fillText(GLYPHS[i], x, y);
  }
  const f = fill.getImageData(0, 0, c.width, c.height).data;
  const r = rim.getImageData(0, 0, c.width, c.height).data;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    // shade: bright upper half, darker foot, a specular band just above the middle
    const v = (y % GH) / GH;
    const shade = 0.62 + 0.38 * (1 - v) + 0.22 * Math.exp(-Math.pow((v - 0.4) / 0.07, 2));
    const s8 = Math.max(0, Math.min(255, Math.round(shade * 200)));
    for (let x = 0; x < c.width; x++) {
      const k = (y * c.width + x) * 4;
      out.data[k] = f[k + 3];
      out.data[k + 1] = s8;
      out.data[k + 2] = 0;
      out.data[k + 3] = r[k + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
}

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aInfo;   // birth, x offset (glyph advances), glyph, size (viewport fraction)
attribute vec4 aColor;  // rgb, life
attribute vec2 aMove;   // sideways drift, pop strength
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aInfo.x;
  float life = aColor.a;
  if (age < 0.0 || age > life) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vAlpha = 0.0; vUv = vec2(0.0); vColor = vec3(0.0); return; }
  float t = age / life;
  // pop: overshoot, settle
  float pk = 1.0 + aMove.y;
  float pop = age < 0.07 ? mix(0.35, pk, age / 0.07) : mix(pk, 1.0, clamp((age - 0.07) / 0.16, 0.0, 1.0));
  vec4 mv = viewMatrix * vec4(aOrigin, 1.0);
  float dist = clamp(-mv.z, 6.0, 220.0);
  // constant screen size: world height that covers "size" of the viewport at this depth
  float h = aInfo.w * 2.0 * dist / projectionMatrix[1][1] * pop;
  float rise = 1.0 - (1.0 - t) * (1.0 - t);
  mv.y += h * (0.9 + 1.5 * rise);
  mv.x += h * aMove.x * (0.7 + 0.5 * rise);
  mv.xy += vec2((position.x * 0.75 + aInfo.y * 0.5), position.y) * h;
  gl_Position = projectionMatrix * mv;
  float g = aInfo.z;
  vec2 cell = vec2(mod(g, ${COLS}.0), floor(g / ${COLS}.0));
  vec2 c = position.xy + 0.5;
  vUv = vec2((cell.x + c.x) / ${COLS}.0, 1.0 - (cell.y + 1.0 - c.y) / ${ROWS}.0);
  vColor = aColor.rgb;
  vAlpha = 1.0 - smoothstep(0.6, 1.0, t);
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
  vec3 rim = vColor * 0.035 + vec3(0.012, 0.008, 0.006);
  vec3 col = mix(rim, vColor * (tx.g * 1.275), tx.r);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class DamageNumbers {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aOrigin: THREE.InstancedBufferAttribute;
  private aInfo: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aMove: THREE.InstancedBufferAttribute;
  private cap: number;
  private head = 0;
  private dirty = false;
  private lane = 0;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
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
    this.aColor = mk(4);
    this.aMove = mk(2);
    for (let i = 0; i < capacity; i++) this.aInfo.array[i * 4] = -1e6;
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aInfo', this.aInfo);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aMove', this.aMove);
    geo.instanceCount = capacity;
    this.geo = geo;
    drawAtlas(this.canvas);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.anisotropy = 4;
    // the display face is a web font: redraw once it has arrived
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts && !fonts.check(FONT)) {
      fonts.load(FONT).then(() => {
        drawAtlas(this.canvas);
        this.tex.needsUpdate = true;
      }, () => {});
    }
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 }, uMap: { value: this.tex } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 100;
    this.mesh.name = 'vfx.numbers';
    this.mesh.visible = false;
  }

  show(pos: THREE.Vector3, value: number, style: NumberStyle = 'normal'): void {
    const st = STYLE[style];
    let text: string;
    if (style === 'miss') text = 'MISS';
    else {
      const v = Math.max(0, Math.round(Math.abs(value)));
      text = (style === 'heal' ? '+' : '') + String(v) + (style === 'crit' ? '!' : '');
    }
    // bigger hits read bigger (log scale, capped)
    const mag = style === 'miss' ? 1 : 1 + 0.4 * Math.max(0, Math.min(1, Math.log10(Math.max(1, Math.abs(value)) / 30)));
    // successive numbers fan out over five lanes so simultaneous totals don't stack on one spot
    const lane = [0, -1.5, 1.5, -2.8, 2.8][this.lane++ % 5];
    const drift = (style === 'crit' ? lane * 0.5 : lane) + (Math.random() - 0.5) * 0.3;
    const pop = style === 'crit' ? 0.9 : style === 'effective' ? 0.45 : 0.25;
    const n = text.length;
    const o = this.aOrigin.array as Float32Array;
    const inf = this.aInfo.array as Float32Array;
    const c = this.aColor.array as Float32Array;
    const mv = this.aMove.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const g = GLYPHS.indexOf(text[i]);
      if (g < 0) continue;
      const k = this.head++ % this.cap;
      o[k * 3] = pos.x;
      o[k * 3 + 1] = pos.y;
      o[k * 3 + 2] = pos.z;
      inf[k * 4] = this.time;
      inf[k * 4 + 1] = i - (n - 1) / 2;
      inf[k * 4 + 2] = g;
      inf[k * 4 + 3] = st.size * mag;
      c[k * 4] = st.color[0];
      c[k * 4 + 1] = st.color[1];
      c[k * 4 + 2] = st.color[2];
      c[k * 4 + 3] = st.life;
      mv[k * 2] = drift;
      mv[k * 2 + 1] = pop;
    }
    this.dirty = true;
    this.aliveUntil = Math.max(this.aliveUntil, this.time + st.life);
  }

  get alive(): boolean {
    return this.time < this.aliveUntil;
  }

  tick(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    this.mesh.visible = this.time < this.aliveUntil;
    if (this.dirty) {
      // numbers are sparse: re-upload whole (small) buffers
      this.aOrigin.needsUpdate = true;
      this.aInfo.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aMove.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) this.aInfo.array[i * 4] = -1e6;
    this.aInfo.needsUpdate = true;
    this.aliveUntil = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.tex.dispose();
    this.mat.dispose();
  }
}
