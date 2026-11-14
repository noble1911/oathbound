// Geometry building blocks for stonework: box-mapped / cylinder-mapped UVs (1 texture tile = 2 m),
// vertex colours (moss, soot, dark openings), and a piece list that merges into few draw calls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { vnoise } from './noise.ts';

export const TILE = 3;

/** Non-indexed copy keeping only position + normal. */
export function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal') ng.deleteAttribute(k);
  return ng;
}

/** World-space box mapping per vertex (faces are flat, so this is seamless per face). */
export function boxUV(g: THREE.BufferGeometry, tile = TILE): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) (u = x), (v = z);
    else if (ax >= az) (u = z), (v = y);
    else (u = x), (v = y);
    uv[i * 2] = u / tile;
    uv[i * 2 + 1] = v / tile;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Cylindrical mapping around the local Y axis (call before translating). */
export function cylUV(g: THREE.BufferGeometry, radius: number, tile = TILE): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    if (Math.abs(n.getY(i)) > 0.7) {
      uv[i * 2] = x / tile;
      uv[i * 2 + 1] = z / tile;
    } else {
      uv[i * 2] = ((Math.atan2(z, x) + Math.PI) * radius) / tile;
      uv[i * 2 + 1] = y / tile;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Vertex colours: base tint, with moss on upward faces near the ground and grime at the bottom. */
export function tint(g: THREE.BufferGeometry, base: THREE.Color, opts: { moss?: number; grime?: number; seed?: number; groundY?: number } = {}): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const col = new Float32Array(p.count * 3);
  const moss = new THREE.Color('#5d6e35');
  const c = new THREE.Color();
  const gy = opts.groundY ?? 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    c.copy(base);
    const nz = vnoise(x * 0.7 + y * 0.5, z * 0.7, opts.seed ?? 1);
    c.multiplyScalar(0.85 + 0.3 * nz);
    const up = Math.max(0, n.getY(i));
    if (opts.moss) c.lerp(moss, Math.min(1, opts.moss * (up * 0.8 + 0.25 * Math.max(0, 1 - (y - gy) / 1.5)) * (0.5 + nz)));
    if (opts.grime) c.multiplyScalar(1 - opts.grime * Math.max(0, 1 - (y - gy) / 1.2) * 0.45);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A box piece in place: size, centre, yaw, with box UVs and tint. */
export function boxPiece(w: number, h: number, d: number, x: number, y: number, z: number, yaw: number, color: THREE.Color, opts: { moss?: number; grime?: number; roll?: number; pitch?: number; seed?: number; groundY?: number } = {}): THREE.BufferGeometry {
  const g = bare(new THREE.BoxGeometry(w, h, d));
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.pitch ?? 0, yaw, opts.roll ?? 0, 'YXZ'));
  m.setPosition(x, y, z);
  g.applyMatrix4(m);
  boxUV(g);
  return tint(g, color, opts);
}

export function cylPiece(r0: number, r1: number, h: number, x: number, y: number, z: number, color: THREE.Color, opts: { seg?: number; moss?: number; grime?: number; open?: boolean; seed?: number; groundY?: number; tilt?: THREE.Euler } = {}): THREE.BufferGeometry {
  const g = bare(new THREE.CylinderGeometry(r1, r0, h, opts.seg ?? 12, 1, !!opts.open));
  cylUV(g, Math.max(r0, r1));
  if (opts.tilt) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(opts.tilt));
  g.translate(x, y, z);
  return tint(g, color, opts);
}

/** Merge pieces (all non-indexed with position/normal/uv/color). */
export function merge(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!pieces.length) return null;
  const g = mergeGeometries(pieces, false);
  for (const p of pieces) p.dispose();
  g?.computeBoundingSphere();
  return g;
}
