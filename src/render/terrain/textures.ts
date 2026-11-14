// Procedural, tileable textures generated once at startup (no files, no licences): the macro
// variation map and a rock texture (albedo in RGB, height in A), a water normal map, masonry and roof
// tiles. The ground's scanned layers live in env-textures.ts.
import * as THREE from 'three';
import { fbm, worley, vnoise, hash2, smoothstep, clamp01, lerp } from './noise.ts';

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const c = new THREE.Color(h); // linear-ish handling is done by marking textures sRGB; keep sRGB bytes
  c.convertLinearToSRGB();
  return [c.r, c.g, c.b];
};
const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

function makeTex(size: number, fn: (u: number, v: number) => [number, number, number, number], srgb: boolean): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = fn(x / size, y / size);
      const k = (y * size + x) * 4;
      data[k] = Math.round(clamp01(p[0]) * 255);
      data[k + 1] = Math.round(clamp01(p[1]) * 255);
      data[k + 2] = Math.round(clamp01(p[2]) * 255);
      data[k + 3] = Math.round(clamp01(p[3]) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export interface TerrainTextures {
  rock: THREE.DataTexture;
  waterNormal: THREE.DataTexture;
  bricks: THREE.DataTexture;
  bricksBump: THREE.DataTexture;
  tiles: THREE.DataTexture;
  /** Tileable low-frequency variation (three independent fbm channels) for the ground's macro tone. */
  macro: THREE.DataTexture;
  all: THREE.Texture[];
}

let cached: TerrainTextures | null = null;

/** Shared (cached) texture set. ~0.5 s to build at 512². */
export function terrainTextures(size = 512): TerrainTextures {
  if (cached) return cached;
  const S = 8; // lattice periods per tile

  const rA = hex('#77756d');
  const rB = hex('#9a978c');
  const lichen = hex('#8c9450');
  const rock = makeTex(size, (u, v) => {
    const w = worley(u * 6, v * 6, 6, 31);
    const n = fbm(u * S, v * S, 32, 5, S);
    const crack = smoothstep(0.0, 0.08, w.f2 - w.f1);
    let c = mix3(rA, rB, smoothstep(0.3, 0.75, n * 0.7 + w.id * 0.3));
    c = mul3(c, 0.55 + 0.45 * crack);
    const l = smoothstep(0.58, 0.7, fbm(u * S * 2, v * S * 2, 33, 3, S * 2));
    c = mix3(c, lichen, l * 0.55);
    c = mul3(c, 0.9 + 0.2 * vnoise(u * 160, v * 160, 34, 160));
    return [c[0], c[1], c[2], crack * (0.5 + 0.5 * (1 - w.f1)) * 0.8 + n * 0.2];
  }, true);

  // water normal: from a periodic height field (central differences)
  const WN = 256;
  const wh = new Float32Array(WN * WN);
  for (let y = 0; y < WN; y++)
    for (let x = 0; x < WN; x++) wh[y * WN + x] = fbm((x / WN) * 8, (y / WN) * 8, 51, 5, 8) + 0.3 * fbm((x / WN) * 16, (y / WN) * 16, 52, 3, 16);
  const waterNormal = makeTex(WN, (u, v) => {
    const x = Math.round(u * WN);
    const y = Math.round(v * WN);
    const at = (i: number, j: number) => wh[(((j + WN) % WN) * WN) + ((i + WN) % WN)];
    const dx = (at(x + 1, y) - at(x - 1, y)) * 6;
    const dy = (at(x, y + 1) - at(x, y - 1)) * 6;
    const n = new THREE.Vector3(-dx, -dy, 1).normalize();
    return [n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, n.z * 0.5 + 0.5, 1];
  }, false);

  // masonry: coursed ashlar blocks (1 tile ≈ 2 m: 5 courses), mortar, grime
  const courses = 4;
  const sA = hex('#e6e0d4');
  const sB = hex('#c4bcae');
  const mortar = hex('#8f887c');
  const brickInfo = (u: number, v: number) => {
    const row = Math.floor(v * courses);
    const fy = v * courses - row;
    const blocksPerRow = 3 + (row % 2);
    const off = hash2(row, 0, 61) * 0.5;
    const bu = (u + off) * blocksPerRow;
    const col = Math.floor(bu);
    const fx = bu - col;
    const id = hash2(((col % blocksPerRow) + blocksPerRow) % blocksPerRow, row, 62);
    const ex = Math.min(fx, 1 - fx) / blocksPerRow * courses; // edge distance in course units
    const ey = Math.min(fy, 1 - fy);
    const edge = Math.min(ex, ey);
    return { id, edge };
  };
  const bricks = makeTex(size, (u, v) => {
    const { id, edge } = brickInfo(u, v);
    const n = fbm(u * S, v * S, 63, 4, S);
    const m = smoothstep(0.03, 0.07, edge + (n - 0.5) * 0.03);
    let c = mix3(sA, sB, id * 0.8 + (n - 0.5) * 0.4);
    c = mul3(c, 0.88 + 0.22 * vnoise(u * 128, v * 128, 64, 128));
    c = mix3(mortar, c, m);
    c = mul3(c, 0.88 + 0.12 * smoothstep(0.0, 0.25, edge));
    return [c[0], c[1], c[2], 1];
  }, true);
  const bricksBump = makeTex(size, (u, v) => {
    const { edge } = brickInfo(u, v);
    const n = fbm(u * S * 2, v * S * 2, 65, 3, S * 2);
    const h = smoothstep(0.02, 0.12, edge) * (0.75 + 0.25 * n);
    return [h, h, h, 1];
  }, false);

  // roof tiles / slates (greyscale, tinted by the team material colour)
  const tiles = makeTex(size, (u, v) => {
    const rows = 16;
    const row = Math.floor(v * rows);
    const fy = v * rows - row;
    const per = 12;
    const bu = (u + (row % 2) * 0.5 / per) * per;
    const fx = bu - Math.floor(bu);
    const id = hash2(Math.floor(bu) % per, row, 71);
    const round = 1 - Math.pow(Math.abs(fx - 0.5) * 2, 3);
    const shade = (0.55 + 0.45 * fy) * (0.75 + 0.25 * round) * (0.82 + 0.3 * id);
    const gap = smoothstep(0.0, 0.06, Math.min(fx, 1 - fx));
    const g = shade * (0.55 + 0.45 * gap);
    return [g, g, g, 1];
  }, true);

  const macro = makeTex(256, (u, v) => [fbm(u * 4, v * 4, 81, 4, 4), fbm(u * 4 + 9, v * 4, 82, 4, 4), fbm(u * 8, v * 8, 83, 3, 8), 1], false);

  cached = { macro, rock, waterNormal, bricks, bricksBump, tiles, all: [rock, waterNormal, bricks, bricksBump, tiles, macro] };
  return cached;
}

export function setAnisotropy(t: TerrainTextures, a: number): void {
  for (const tex of t.all) {
    tex.anisotropy = a;
    tex.needsUpdate = true;
  }
}
