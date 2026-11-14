// Scanned environment textures (CC0 Poly Haven, packed by tools/art/env.py into public/textures/env/):
//   * ground layers as two texture arrays (5 layers: grass, forest floor, dirt path, mud / bank, rock):
//       tGroundA  RGB albedo (sRGB), A = height           (1024² on high / ultra, 512² on low / medium)
//       tGroundN  R = normal X, G = normal Y (GL), 0..1   (512²)
//   * the vegetation atlas (leaf clusters + bark strips, RGBA, alpha-tested).
// Everything starts as a flat-colour placeholder and swaps in when the files arrive (the caller's
// `onReady` wakes the render loop); a failed download just keeps the placeholder.
import * as THREE from 'three';

export const GROUND_LAYERS = ['grass', 'forest', 'dirt', 'mud', 'rock'] as const;
const BASE = 'textures/env/';
/** Placeholder albedo (sRGB bytes) per layer, close to each scan's mean. */
const FLAT: [number, number, number][] = [[92, 118, 52], [70, 60, 40], [128, 112, 90], [84, 68, 52], [118, 118, 108]];

export const groundTextures = {
  tGroundA: { value: null as THREE.DataArrayTexture | null },
  tGroundN: { value: null as THREE.DataArrayTexture | null },
};

function arrayTex(data: Uint8Array, size: number, srgb: boolean): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, size, size, GROUND_LAYERS.length);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = size > 1 ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  t.magFilter = size > 1 ? THREE.LinearFilter : THREE.NearestFilter;
  t.generateMipmaps = size > 1;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function placeholders(): void {
  const n = GROUND_LAYERS.length;
  const a = new Uint8Array(n * 4);
  const nn = new Uint8Array(n * 4);
  FLAT.forEach((c, i) => {
    a.set([c[0], c[1], c[2], 128], i * 4);
    nn.set([128, 128, 255, 255], i * 4);
  });
  groundTextures.tGroundA.value = arrayTex(a, 1, true);
  groundTextures.tGroundN.value = arrayTex(nn, 1, false);
}
placeholders();

async function pixels(url: string, size: number): Promise<Uint8ClampedArray> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, size, size);
  bmp.close();
  return ctx.getImageData(0, 0, size, size).data;
}

let loadedSize = 0;
let wanted = 0;
let normalsLoaded = false;
let normalsWanted = false;
let anisotropy = 4;

/**
 * Load the ground arrays: albedo at `size` (1024 or 512) and, with `normals`, the 512² normal maps
 * (the low tier never samples them: no download, no memory). Safe to call again (tier change);
 * resolves once the arrays are swapped in. `onReady` runs after each swap.
 */
export async function loadGround(size: 512 | 1024, normals: boolean, onReady: () => void): Promise<void> {
  const needN = normals && !normalsLoaded && !normalsWanted;
  if (size === wanted && !needN) return;
  const needA = size !== wanted;
  wanted = size;
  if (needN) normalsWanted = true;
  const n = GROUND_LAYERS.length;
  try {
    const NS = 512;
    const [as, ns] = await Promise.all([
      needA ? Promise.all(GROUND_LAYERS.map((l) => pixels(`${BASE}ground_${l}_a${size === 512 ? '_512' : ''}.webp`, size))) : Promise.resolve(null),
      needN ? Promise.all(GROUND_LAYERS.map((l) => pixels(`${BASE}ground_${l}_n.webp`, NS))) : Promise.resolve(null),
    ]);
    if (as && wanted === size) {
      const a = new Uint8Array(size * size * 4 * n);
      as.forEach((px, i) => {
        const o = i * size * size * 4;
        a.set(px, o);
        // alpha = 128 + height * 127 (kept >= 128 so the canvas round trip keeps the colour): back to 0..255
        for (let k = 3; k < px.length; k += 4) a[o + k] = Math.min(255, Math.max(0, (px[k] - 128) * 2));
      });
      const old = groundTextures.tGroundA.value;
      const ta = arrayTex(a, size, true);
      ta.anisotropy = anisotropy;
      groundTextures.tGroundA.value = ta;
      old?.dispose();
      loadedSize = size;
    }
    if (ns) {
      const d = new Uint8Array(NS * NS * 4 * n);
      ns.forEach((px, i) => {
        const o = i * NS * NS * 4;
        for (let k = 0; k < px.length; k += 4) {
          d[o + k] = Math.min(255, Math.max(0, (px[k + 3] - 128) * 2)); // X
          d[o + k + 1] = px[k]; // Y
          d[o + k + 2] = 255;
          d[o + k + 3] = 255;
        }
      });
      const oldN = groundTextures.tGroundN.value;
      const tn = arrayTex(d, NS, false);
      tn.anisotropy = anisotropy;
      groundTextures.tGroundN.value = tn;
      oldN?.dispose();
      normalsLoaded = true;
    }
    onReady();
  } catch (err) {
    console.warn(`ground textures: ${(err as Error).message}`);
    wanted = loadedSize;
    if (needN) normalsWanted = false;
  }
}

export function setGroundAnisotropy(a: number): void {
  anisotropy = a;
  for (const t of [groundTextures.tGroundA.value, groundTextures.tGroundN.value]) {
    if (!t || t.image.width <= 1 || t.anisotropy === a) continue;
    t.anisotropy = a;
    t.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ vegetation atlas

/** Atlas cells in pixels (x, y from the top-left of the 1024² atlas, w, h). */
export const VEG_CELLS = {
  oak: [0, 0, 512, 512],
  birch: [512, 0, 512, 512],
  fir: [0, 512, 320, 512],
  bush: [320, 608, 320, 320],
  reeds: [640, 512, 192, 512],
  /** Bark columns (tile vertically; 12 px of wrapped padding left / right). */
  barkOak: [832 + 12, 512, 40, 512],
  barkPine: [896 + 12, 512, 40, 512],
  barkBirch: [960 + 12, 512, 40, 512],
} as const;
export type VegCell = keyof typeof VEG_CELLS;

/** UV rect (u0, v0, u1, v1; v up) of a cell, inset by `pad` px. */
export function cellUv(cell: VegCell, pad = 0): [number, number, number, number] {
  const [x, y, w, h] = VEG_CELLS[cell];
  return [(x + pad) / 1024, 1 - (y + h - pad) / 1024, (x + w - pad) / 1024, 1 - (y + pad) / 1024];
}

let atlas: THREE.Texture | null = null;
const atlasWaiters = new Set<() => void>();

/** The shared vegetation atlas (a 1×1 green placeholder until the file arrives). */
export function vegAtlas(onReady?: () => void): THREE.Texture {
  if (onReady) atlasWaiters.add(onReady);
  if (atlas) return atlas;
  const t = new THREE.Texture();
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.image = new ImageData(new Uint8ClampedArray([70, 104, 44, 0]), 1, 1);
  t.needsUpdate = true;
  atlas = t;
  new THREE.ImageLoader().load(
    `${BASE}veg_atlas.webp`,
    (img) => {
      // the placeholder's 1x1 storage is immutable: drop it so the atlas gets its own
      t.dispose();
      t.image = img;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.needsUpdate = true;
      for (const f of atlasWaiters) f();
    },
    undefined,
    () => console.warn('vegetation atlas failed to load'),
  );
  return t;
}
export function forgetAtlasWaiter(f: () => void): void {
  atlasWaiters.delete(f);
}
