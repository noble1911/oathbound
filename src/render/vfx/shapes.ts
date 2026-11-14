// Shader-driven VFX meshes: ground decals that hug the terrain (shockwaves, auras, glows, frost),
// the Bulwark dome, light pillars (loot beams, level-ups), and camera-facing ribbons (lightning,
// dive streaks). All additive HDR, depth-tested, no depth writes, on the VFX layer.
import * as THREE from 'three';
import { LAYER_VFX } from '../core/post.ts';

export type Ground = (wx: number, wz: number) => number;

const additive = {
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: THREE.AdditiveBlending,
} as const;

// ------------------------------------------------------------------ ground decals

export type DecalMode = 'shockwave' | 'aura' | 'glow' | 'frost' | 'heal' | 'warn' | 'sigil';
const DECAL_MODE: Record<DecalMode, number> = { shockwave: 0, aura: 1, glow: 2, frost: 3, heal: 4, warn: 5, sigil: 6 };

const DECAL_VERT = /* glsl */ `
attribute vec2 aLocal;
varying vec2 vLocal;
void main() {
  vLocal = aLocal;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // depth bias toward the camera so grass tufts take the light too
  vec4 near = projectionMatrix * vec4(mv.xy, mv.z + 0.6, 1.0);
  gl_Position.z = near.z / near.w * gl_Position.w;
}`;

const DECAL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
uniform float uAlpha;
uniform float uTime;
uniform int uMode;
uniform sampler2D uMap;
uniform vec2 uCell;
varying vec2 vLocal;
float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  float a = 0.0;
  if (uMode == 0) {
    // expanding shockwave ring with a soft trailing fill
    float rr = uProgress;
    float w = 0.05 + 0.1 * uProgress;
    a = exp(-pow((r - rr) / w, 2.0)) * 1.2;
    a += smoothstep(rr, 0.0, r) * 0.18 * (1.0 - uProgress);
    a *= pow(1.0 - uProgress, 1.4);
  } else if (uMode == 1) {
    // aura: rim + inner glow + rotating rune ticks
    a = exp(-pow((r - 0.93) / 0.035, 2.0));
    a += exp(-pow((r - 0.78) / 0.012, 2.0)) * 0.6;
    float ticks = step(0.55, fract(ang / 6.28318 * 24.0 + uTime * 0.15));
    a += ticks * smoothstep(0.83, 0.85, r) * smoothstep(0.89, 0.87, r) * 0.9;
    a += smoothstep(1.0, 0.0, r) * 0.16;
    a *= 0.85 + 0.15 * sin(uTime * 3.0);
  } else if (uMode == 2) {
    a = exp(-r * r * 3.5);
  } else if (uMode == 3) {
    // frost: crystalline spikes radiating from a ring
    float seg = floor(ang / 6.28318 * 36.0);
    float len = 0.55 + 0.45 * h1(seg);
    float spike = smoothstep(0.08, 0.0, abs(fract(ang / 6.28318 * 36.0) - 0.5)) * step(r, len) * smoothstep(0.2, 0.6, r);
    a = spike * 0.8 + exp(-pow((r - 0.6) / 0.06, 2.0)) * 0.6 + smoothstep(1.0, 0.0, r) * 0.15;
  } else if (uMode == 4) {
    // heal: soft ring + slowly orbiting dots
    a = exp(-pow((r - 0.85) / 0.08, 2.0)) * 0.8;
    float dots = smoothstep(0.75, 1.0, sin(ang * 8.0 + uTime * 2.0)) * exp(-pow((r - 0.85) / 0.05, 2.0));
    a += dots + smoothstep(1.0, 0.0, r) * 0.25;
  } else if (uMode == 6) {
    // sigil: a sheet cell turning slowly, with a soft rim and inner glow
    float cs = cos(uTime * 0.12);
    float sn = sin(uTime * 0.12);
    vec2 q = vec2(vLocal.x * cs - vLocal.y * sn, vLocal.x * sn + vLocal.y * cs);
    float m = texture2D(uMap, (uCell + clamp(q * 0.56 + 0.5, 0.003, 0.997)) / vec2(2.0, 3.0)).r;
    // the emblem is a faint watermark; the rim carries the read (uProgress = emblem strength)
    a = m * uProgress * (0.85 + 0.15 * sin(uTime * 2.4));
    a += exp(-pow((r - 0.96) / 0.018, 2.0)) * 1.6 + exp(-pow((r - 0.9) / 0.006, 2.0)) * 0.8 + smoothstep(1.0, 0.0, r) * 0.06;
  } else {
    // warn: pulsing target circle that tightens as impact nears
    a = exp(-pow((r - 0.95) / 0.04, 2.0)) * (0.6 + 0.4 * sin(uTime * 18.0));
    a += smoothstep(1.0, 0.0, r) * 0.35 * uProgress;
    a += exp(-pow((r - (1.0 - uProgress)) / 0.05, 2.0)) * 0.7;
  }
  a *= uAlpha * smoothstep(1.0, 0.97, r);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * (a * 0.4), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

let decalGeo: THREE.BufferGeometry | null = null;
function baseDecalGeo(): THREE.BufferGeometry {
  if (decalGeo) return decalGeo;
  const g = new THREE.RingGeometry(0.0001, 1, 64, 8);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const local = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    local[i * 2] = pos.getX(i);
    local[i * 2 + 1] = pos.getZ(i);
  }
  g.setAttribute('aLocal', new THREE.BufferAttribute(local, 2));
  decalGeo = g;
  return g;
}

/** A disc decal of radius `radius` that conforms to the ground (re-sampled when moved). */
export class GroundDecal {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private ground: Ground;
  private local: Float32Array;
  radius: number;
  private cx = NaN;
  private cz = NaN;
  private cr = NaN;

  constructor(mode: DecalMode, color: THREE.ColorRepresentation | [number, number, number], radius: number, ground: Ground) {
    this.ground = ground;
    this.radius = radius;
    this.geo = baseDecalGeo().clone();
    this.local = this.geo.attributes.aLocal.array as Float32Array;
    const c = Array.isArray(color) ? new THREE.Color(color[0], color[1], color[2]) : new THREE.Color(color);
    this.material = new THREE.ShaderMaterial({
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      uniforms: { uColor: { value: c }, uProgress: { value: 0 }, uAlpha: { value: 1 }, uTime: { value: 0 }, uMode: { value: DECAL_MODE[mode] }, uMap: { value: null }, uCell: { value: new THREE.Vector2() } },
      ...additive,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Place at a world point (x, z); the height follows the ground. */
  place(x: number, z: number, radius = this.radius): void {
    this.radius = radius;
    if (Math.abs(x - this.cx) < 0.02 && Math.abs(z - this.cz) < 0.02 && radius === this.cr) return;
    this.cx = x;
    this.cz = z;
    this.cr = radius;
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const y0 = this.ground(x, z);
    for (let i = 0; i < pos.count; i++) {
      const lx = this.local[i * 2] * radius;
      const lz = this.local[i * 2 + 1] * radius;
      arr[i * 3] = lx;
      arr[i * 3 + 1] = this.ground(x + lx, z + lz) - y0 + 0.08;
      arr[i * 3 + 2] = lz;
    }
    pos.needsUpdate = true;
    this.mesh.position.set(x, y0, z);
  }

  /** Sheet texture + cell for 'sigil' mode. */
  setSheet(tex: THREE.Texture, cell: number): void {
    this.material.uniforms.uMap.value = tex;
    (this.material.uniforms.uCell.value as THREE.Vector2).set(cell % 2, Math.floor(cell / 2));
  }
  set progress(v: number) {
    this.material.uniforms.uProgress.value = v;
  }
  set alpha(v: number) {
    this.material.uniforms.uAlpha.value = v;
  }
  set time(v: number) {
    this.material.uniforms.uTime.value = v;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------ dome

const DOME_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uRipple;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x);
}
vec4 hexCoords(vec2 uv) {
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  return vec4(gv, uv - gv);
}
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  vec3 p = normalize(vP);
  vec2 uv = vec2(atan(p.z, p.x) * 3.2, asin(clamp(p.y, -1.0, 1.0)) * 6.4);
  vec4 hc = hexCoords(uv * 1.6);
  float edge = smoothstep(0.42, 0.5, hexDist(hc.xy));
  float cellFlick = fract(sin(dot(hc.zw, vec2(12.9898, 78.233))) * 43758.5453);
  float pulse = 0.5 + 0.5 * sin(uTime * 2.2 + cellFlick * 6.28);
  float fromTop = 1.0 - p.y;
  float ripple = exp(-pow((fromTop - uRipple * 1.3) * 5.0, 2.0)) * step(uRipple, 1.0);
  // edge-lit glass: almost clear face-on, bright only at the silhouette, the seam and the ripple
  float rimLight = pow(fres, 1.6);
  float a = rimLight * 0.75 + edge * (0.05 + 0.1 * pulse) * (0.12 + rimLight) + ripple * (0.12 + 0.5 * rimLight);
  a += smoothstep(0.08, 0.0, p.y) * 0.45; // bright seam at the ground
  a *= uAlpha;
  gl_FragColor = vec4(uColor * (a * 0.32), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Dome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(color: [number, number, number]) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: { uColor: { value: new THREE.Color(color[0], color[1], color[2]) }, uAlpha: { value: 0 }, uRipple: { value: 0 }, uTime: { value: 0 } },
      ...additive,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 20, 0, Math.PI * 2, 0, Math.PI / 2), this.material);
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 15;
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------ light pillar

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uStreaks;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float facing = smoothstep(0.0, 1.0, abs(dot(normalize(vN), normalize(vV))));
  facing *= facing;
  float hgt = vUv.y;
  float fade = pow(1.0 - hgt, 1.3) * smoothstep(0.0, 0.03, hgt);
  float s = n(vec2(vUv.x * 14.0, hgt * 3.0 - uTime * 1.6));
  float streak = mix(1.0, 0.45 + s * 1.1, uStreaks);
  float a = facing * fade * streak * uAlpha;
  gl_FragColor = vec4(uColor * (a * 0.38), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Pillar {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(color: [number, number, number], radius: number, height: number, streaks = 1) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uColor: { value: new THREE.Color(color[0], color[1], color[2]) }, uAlpha: { value: 1 }, uTime: { value: 0 }, uStreaks: { value: streaks } },
      ...additive,
      side: THREE.FrontSide,
    });
    const g = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
    g.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.scale.set(radius, height, radius);
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 16;
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------ ribbons

export interface Ribbon {
  points: THREE.Vector3[];
  /** Width per point (or one width for all). */
  width: number | number[];
  color: THREE.Color;
  alpha: number;
}

const RIBBON_VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aV;
varying vec4 vColor;
varying float vV;
void main() {
  vColor = aColor;
  vV = aV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RIBBON_FRAG = /* glsl */ `
varying vec4 vColor;
varying float vV;
void main() {
  float x = abs(vV * 2.0 - 1.0);
  float a = (1.0 - x * x) * vColor.a;
  a = a * a;
  gl_FragColor = vec4(vColor.rgb * (a * 0.45), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Camera-facing triangle strips rebuilt on the CPU every frame. */
export class RibbonBatch {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private v: Float32Array;
  private maxVerts: number;
  private tmp = new THREE.Vector3();
  private side = new THREE.Vector3();
  private toCam = new THREE.Vector3();

  constructor(maxVerts = 6000) {
    this.maxVerts = maxVerts;
    this.pos = new Float32Array(maxVerts * 3);
    this.col = new Float32Array(maxVerts * 4);
    this.v = new Float32Array(maxVerts);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aV', new THREE.BufferAttribute(this.v, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array((maxVerts / 2) * 6);
    for (let i = 0, q = 0; q < maxVerts / 2 - 1; q++, i += 6) {
      const a = q * 2;
      idx[i] = a;
      idx[i + 1] = a + 1;
      idx[i + 2] = a + 2;
      idx[i + 3] = a + 1;
      idx[i + 4] = a + 3;
      idx[i + 5] = a + 2;
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({ vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG, ...additive, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 25;
  }

  /** Rebuild from ribbons. Strips are joined with degenerate quads (index gaps skipped). */
  build(ribbons: Ribbon[], camPos: THREE.Vector3): void {
    let n = 0;
    const idx = this.geo.index!.array as Uint32Array;
    const ranges: number[] = [];
    for (const rb of ribbons) {
      const pts = rb.points;
      if (pts.length < 2 || n + pts.length * 2 > this.maxVerts) continue;
      const start = n;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        this.tmp.subVectors(b, a).normalize();
        this.toCam.subVectors(camPos, p).normalize();
        this.side.crossVectors(this.tmp, this.toCam).normalize();
        const w = (Array.isArray(rb.width) ? rb.width[i] : rb.width) * 0.5;
        for (let s = 0; s < 2; s++) {
          const k = s === 0 ? -w : w;
          this.pos[n * 3] = p.x + this.side.x * k;
          this.pos[n * 3 + 1] = p.y + this.side.y * k;
          this.pos[n * 3 + 2] = p.z + this.side.z * k;
          this.col[n * 4] = rb.color.r;
          this.col[n * 4 + 1] = rb.color.g;
          this.col[n * 4 + 2] = rb.color.b;
          this.col[n * 4 + 3] = rb.alpha;
          this.v[n] = s;
          n++;
        }
      }
      ranges.push(start, n);
    }
    // rebuild the index so strips don't connect to each other
    let ii = 0;
    for (let r = 0; r < ranges.length; r += 2) {
      for (let a = ranges[r]; a + 3 < ranges[r + 1]; a += 2) {
        idx[ii++] = a;
        idx[ii++] = a + 1;
        idx[ii++] = a + 2;
        idx[ii++] = a + 1;
        idx[ii++] = a + 3;
        idx[ii++] = a + 2;
      }
    }
    this.geo.index!.needsUpdate = true;
    this.geo.setDrawRange(0, ii);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aV as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = ii > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
