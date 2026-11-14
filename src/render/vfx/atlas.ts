// The VFX texture atlas (built by tools/vfx/build_atlas.py; licences in docs/ART.md → VFX).
// 8 × 8 cells of 256 px, RGB on black: the shaders derive coverage from luminance, so the same
// sheet serves additive fire/sparks and premultiplied smoke. Flipbooks run left→right, top→bottom.
import * as THREE from 'three';

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;

/** First cell of each sprite / flipbook. */
export const CELL = { explosion: 0, smoke: 24, fire: 44, dot: 60, spark: 61, ring: 62, star: 63 } as const;
/** Frame counts of the flipbooks. */
export const FRAMES = { explosion: 20, smoke: 19, fire: 16 } as const;

/** Ground decal sheet: 2 × 3 cells of 512 px, greyscale masks. */
export const DECAL_COLS = 2;
export const DECAL_ROWS = 3;
export const DECAL = { scorch: 0, cracks: 1, heal: 2, rally: 3, arcane: 4, frost: 5 } as const;

function load(url: string, color: boolean, onLoad?: () => void): THREE.Texture {
  const tex = new THREE.TextureLoader().load(url, () => onLoad?.());
  // the particle sheet is colour; the decal sheet is a mask (kept linear so mid-greys stay strong)
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = false;
  return tex;
}

/** `onLoad` fires when the image arrives (wake the render-on-demand loop). */
export function makeAtlas(onLoad?: () => void): THREE.Texture {
  return load(new URL('./assets/atlas.webp', import.meta.url).href, true, onLoad);
}
export function makeDecalSheet(onLoad?: () => void): THREE.Texture {
  return load(new URL('./assets/decals.webp', import.meta.url).href, false, onLoad);
}
