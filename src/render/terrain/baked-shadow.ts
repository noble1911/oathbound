// A baked "static" shadow for trees on tiers without prop shadow-map casters (power saving):
// each tree stamps a soft dark ellipse on a 1 m mask over the world, offset along the sun's
// direction; the ground shader multiplies its direct (sun) light by the mask. Rebaked only when the
// tree density changes.
import * as THREE from 'three';
import { WORLD } from './layout.ts';

export const bakedShadowUniforms = {
  tTreeShadow: { value: null as THREE.Texture | null },
  uTreeShadow: { value: 0 },
};

export const BAKED_SHADOW_GLSL = /* glsl */ `
uniform sampler2D tTreeShadow;
uniform float uTreeShadow;`;

/** Inserted after <lights_fragment_end>; needs vObW, uWorldMin, uWorldSize. */
export const BAKED_SHADOW_APPLY = /* glsl */ `
  {
    float obTs = mix(1.0, texture2D(tTreeShadow, (vObW.xz - uWorldMin) / uWorldSize).r, uTreeShadow);
    reflectedLight.directDiffuse *= obTs;
    reflectedLight.directSpecular *= obTs;
  }`;

export function bakeTreeShadow(trees: THREE.InstancedMesh[], sunDir: THREE.Vector3, prev: THREE.DataTexture | null): THREE.DataTexture {
  const W = WORLD.x1 - WORLD.x0;
  const H = WORLD.z1 - WORLD.z0;
  const data = prev && prev.image.width === W ? (prev.image.data as Uint8Array) : new Uint8Array(W * H);
  data.fill(255);
  const k = 1 / Math.max(0.2, -sunDir.y);
  const ox = sunDir.x * k;
  const oz = sunDir.z * k;
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  for (const mesh of trees) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      const sc = s.y;
      const hgt = 5.5 * sc; // crown centre height
      const r = 2.8 * sc;
      // the shadow is the crown projected along the sun: stretched along the offset
      for (let t = 0.35; t <= 1.0; t += 0.325) {
        const cx = p.x + ox * hgt * t;
        const cz = p.z + oz * hgt * t;
        stamp(data, W, H, cx - WORLD.x0, cz - WORLD.z0, r * (0.7 + 0.3 * t), 0.5);
      }
    }
  }
  const tex = prev && prev.image.width === W ? prev : new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function stamp(d: Uint8Array, W: number, H: number, cx: number, cz: number, r: number, dark: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const z0 = Math.max(0, Math.floor(cz - r));
  const z1 = Math.min(H - 1, Math.ceil(cz + r));
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const dd = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / r;
      if (dd >= 1) continue;
      const a = (1 - dd * dd) * dark;
      const i = z * W + x;
      d[i] = Math.min(d[i], Math.round(255 * (1 - a)));
    }
  }
}
