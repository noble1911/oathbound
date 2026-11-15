// Materials and textures of the faction Keeps (tools/art/blender/keep_build.py, tools/art/keep_tex.py).
//
// A Keep GLB carries geometry, vertex colours (tint x baked AO x weathering) and two untextured
// materials: `keep` and `cloth`. Everything solid is ONE draw: its texture layer rides in the UV
// (u = local u + 8 * layer + 4) and is sampled from a per-faction texture array of 8 tiling 512²
// layers (wall, trim, roof, wood, metal, accent, floor, plain); layer 8 is glow (windows, soul-fire).
// Banners are the second draw: a banner texture whose alpha (128..255) marks the team-tinted cloth,
// swaying in the shared wind (vertex colour red = sway weight).
// The low tier samples no normal maps (and never downloads them).
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { WIND_GLSL, after } from '../core/glsl.ts';
import { assetUrlReady } from '../../assets.ts';

export type KeepFaction = 'kingdom' | 'ashen' | 'caliphate';
export const KEEP_FACTIONS: KeepFaction[] = ['kingdom', 'ashen', 'caliphate'];

const LAYERS = 8;
const SIZE = 512;
const BASE = 'textures/keep/';

/** Per-layer roughness / metalness (wall, trim, roof, wood, metal, accent, floor, plain) and glow strength. */
const SURFACE: Record<KeepFaction, { rough: number[]; metal: number[]; glow: number; nscale: number }> = {
  kingdom: { rough: [0.92, 0.88, 0.62, 0.85, 0.5, 0.9, 0.9, 0.8], metal: [0, 0, 0.05, 0, 0.3, 0, 0, 0], glow: 1.5, nscale: 1.0 },
  ashen: { rough: [0.9, 0.82, 0.55, 0.85, 0.55, 0.75, 0.9, 0.8], metal: [0, 0, 0.12, 0, 0.15, 0, 0, 0], glow: 1.6, nscale: 1.1 },
  caliphate: { rough: [0.92, 0.85, 0.3, 0.8, 0.4, 0.38, 0.88, 0.8], metal: [0, 0, 0.06, 0, 0.1, 0.04, 0, 0], glow: 1.5, nscale: 1.0 },
};

interface FactionTex {
  tKeepA: { value: THREE.DataArrayTexture };
  tKeepN: { value: THREE.DataArrayTexture };
  banner: THREE.Texture;
  albedo: Promise<void> | null;
  normals: Promise<void> | null;
}
const cache = new Map<KeepFaction, FactionTex>();
let anisotropy = 4;
/** Glow multiplier shared by every Keep: lower without the post stack (no bloom, three's own tone mapping whitens bright emissive). */
const glowScale = { value: 1 };
export function setKeepGlowScale(post: boolean): void {
  glowScale.value = post ? 1 : 0.55;
}

function arrayTex(data: Uint8Array, size: number, srgb: boolean): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, size, size, LAYERS);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = size > 1 ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  t.magFilter = size > 1 ? THREE.LinearFilter : THREE.NearestFilter;
  t.generateMipmaps = size > 1;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = size > 1 ? anisotropy : 1;
  t.needsUpdate = true;
  return t;
}

function flat(rgb: [number, number, number], srgb: boolean): THREE.DataArrayTexture {
  const d = new Uint8Array(LAYERS * 4);
  for (let i = 0; i < LAYERS; i++) d.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return arrayTex(d, 1, srgb);
}

/** The 8 layers stacked vertically in one image -> RGBA bytes, layer-major. */
async function strip(url: string): Promise<Uint8Array> {
  const res = await fetch(await assetUrlReady(url));
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE * LAYERS;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, SIZE, SIZE * LAYERS);
  bmp.close();
  const px = ctx.getImageData(0, 0, SIZE, SIZE * LAYERS).data;
  return new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
}

const PLACEHOLDER: Record<KeepFaction, [number, number, number]> = { kingdom: [150, 150, 152], ashen: [60, 62, 64], caliphate: [190, 160, 118] };

/** Shared textures of a faction (placeholders until the files arrive); `normals` = also fetch the normal maps. */
export function keepTextures(faction: KeepFaction, normals: boolean, onReady: () => void): FactionTex {
  let t = cache.get(faction);
  if (!t) {
    const banner = new THREE.Texture();
    banner.colorSpace = THREE.SRGBColorSpace;
    banner.flipY = false;
    banner.wrapS = banner.wrapT = THREE.ClampToEdgeWrapping;
    banner.anisotropy = 4;
    t = { tKeepA: { value: flat(PLACEHOLDER[faction], true) }, tKeepN: { value: flat([128, 128, 255], false) }, banner, albedo: null, normals: null };
    cache.set(faction, t);
    const tex = t;
    void assetUrlReady(`${BASE}${faction}_banner.webp`).then((u) =>
      new THREE.ImageLoader().load(u, (img) => {
        banner.image = img;
        banner.needsUpdate = true;
        onReady();
      }),
    );
    tex.albedo = strip(`${BASE}${faction}_a.webp`)
      .then((px) => {
        const old = tex.tKeepA.value;
        tex.tKeepA.value = arrayTex(px, SIZE, true);
        old.dispose();
        onReady();
      })
      .catch((err) => console.warn(`keep textures: ${(err as Error).message}`));
  }
  if (normals && !t.normals) {
    const tex = t;
    tex.normals = strip(`${BASE}${faction}_n.webp`)
      .then((px) => {
        const old = tex.tKeepN.value;
        tex.tKeepN.value = arrayTex(px, SIZE, false);
        old.dispose();
        onReady();
      })
      .catch((err) => {
        tex.normals = null;
        console.warn(`keep textures: ${(err as Error).message}`);
      });
  }
  return t;
}

export function setKeepAnisotropy(a: number): void {
  anisotropy = a;
  for (const t of cache.values()) {
    for (const x of [t.tKeepA.value, t.tKeepN.value]) {
      if (x.image.width <= 1 || x.anisotropy === a) continue;
      x.anisotropy = a;
      x.needsUpdate = true;
    }
  }
}

export interface KeepMaterials {
  body: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
}

/**
 * The two materials of one Keep (or one arrow tower: each fades on its own, so each gets its own pair;
 * the textures and the compiled programs are shared).
 */
export function keepArtMaterials(engine: Engine, faction: KeepFaction, team: THREE.Color, normals: boolean): KeepMaterials {
  const tex = keepTextures(faction, normals, () => engine.wake());
  const s = SURFACE[faction];
  const body = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true });
  body.envMapIntensity = 0.9;
  body.name = `keep-${faction}`;
  if (normals) body.defines = { ...(body.defines ?? {}), KEEP_NORMALS: '' };
  const u = {
    tKeepA: tex.tKeepA,
    tKeepN: tex.tKeepN,
    uKeepRough: { value: s.rough },
    uKeepMetal: { value: s.metal },
    uKeepGlow: { value: s.glow },
    uKeepGlowScale: glowScale,
    uKeepNScale: { value: s.nscale },
  };
  engine.patch(body, 'ob-keep-art', (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = after(shader.vertexShader, '#include <common>', 'varying vec2 vKeepUv;');
    shader.vertexShader = after(shader.vertexShader, '#include <begin_vertex>', 'vKeepUv = uv;');
    shader.fragmentShader = after(
      shader.fragmentShader,
      '#include <common>',
      /* glsl */ `
varying vec2 vKeepUv;
uniform highp sampler2DArray tKeepA;
uniform highp sampler2DArray tKeepN;
uniform float uKeepRough[8];
uniform float uKeepMetal[8];
uniform float uKeepGlow;
uniform float uKeepGlowScale;
uniform float uKeepNScale;
`,
    );
    shader.fragmentShader = after(
      shader.fragmentShader,
      '#include <map_fragment>',
      /* glsl */ `
float kL = floor(vKeepUv.x / 8.0);
vec2 kUv = vec2(vKeepUv.x - kL * 8.0 - 4.0, vKeepUv.y);
float kT = clamp(kL, 0.0, 7.0);
float kGlow = step(7.5, kL);
diffuseColor.rgb *= texture(tKeepA, vec3(kUv, kT)).rgb;
`,
    );
    shader.fragmentShader = after(shader.fragmentShader, '#include <roughnessmap_fragment>', 'roughnessFactor = uKeepRough[int(kT)];');
    shader.fragmentShader = after(shader.fragmentShader, '#include <metalnessmap_fragment>', 'metalnessFactor = uKeepMetal[int(kT)];');
    shader.fragmentShader = after(
      shader.fragmentShader,
      '#include <normal_fragment_maps>',
      /* glsl */ `
#ifdef KEEP_NORMALS
{
  vec3 kN = texture(tKeepN, vec3(kUv, kT)).xyz * 2.0 - 1.0;
  kN.xy *= uKeepNScale;
  vec3 kQ0 = dFdx(-vViewPosition);
  vec3 kQ1 = dFdy(-vViewPosition);
  vec2 kS0 = dFdx(kUv);
  vec2 kS1 = dFdy(kUv);
  vec3 kQ1p = cross(kQ1, normal);
  vec3 kQ0p = cross(normal, kQ0);
  vec3 kTan = kQ1p * kS0.x + kQ0p * kS1.x;
  vec3 kBit = kQ1p * kS0.y + kQ0p * kS1.y;
  float kDet = max(dot(kTan, kTan), dot(kBit, kBit));
  float kSc = kDet == 0.0 ? 0.0 : inversesqrt(kDet);
  normal = normalize(mat3(kTan * kSc, kBit * kSc, normal) * kN);
}
#endif
`,
    );
    // glow: the vertex colour is the light's colour; nothing else of the surface shows
    shader.fragmentShader = after(shader.fragmentShader, '#include <emissivemap_fragment>', 'totalEmissiveRadiance += kGlow * vColor.rgb * uKeepGlow * uKeepGlowScale;\ndiffuseColor.rgb *= 1.0 - kGlow * 0.9;');
  });

  const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex.banner, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  cloth.name = `keep-cloth-${faction}`;
  const cu = { uKeepTeam: { value: team.clone() } };
  engine.patch(cloth, 'ob-keep-cloth', (shader) => {
    Object.assign(shader.uniforms, globalUniforms, cu);
    shader.vertexShader = after(shader.vertexShader, '#include <common>', `attribute vec4 color;\n${WIND_GLSL}`);
    shader.vertexShader = after(
      shader.vertexShader,
      '#include <begin_vertex>',
      /* glsl */ `
vec3 obW = (modelMatrix * vec4(position, 1.0)).xyz;
vec3 obOff = ob_wind(obW, 1.0, 1.0) * color.r * 1.5;
obOff.y += sin(uTime * 3.7 + obW.x * 2.1 + obW.y * 1.3) * 0.07 * color.r;
obOff += normal * sin(uTime * 2.6 + obW.y * 1.9 + obW.x) * 0.16 * color.r;
transformed += obOff;
`,
    );
    shader.fragmentShader = after(shader.fragmentShader, '#include <common>', 'uniform vec3 uKeepTeam;');
    shader.fragmentShader = after(
      shader.fragmentShader,
      '#include <map_fragment>',
      /* glsl */ `
float kMask = clamp((diffuseColor.a * 255.0 - 128.0) / 127.0, 0.0, 1.0);
diffuseColor.rgb *= mix(vec3(1.0), uKeepTeam, kMask);
diffuseColor.a = opacity;
`,
    );
  });
  return { body, cloth };
}

/** Switch the normal maps of a body material on / off (tier change). */
export function setKeepNormals(engine: Engine, faction: KeepFaction, m: THREE.MeshStandardMaterial, on: boolean): void {
  const has = !!m.defines && 'KEEP_NORMALS' in m.defines;
  if (on) keepTextures(faction, true, () => engine.wake());
  if (has === on) return;
  m.defines = { ...(m.defines ?? {}) };
  if (on) m.defines.KEEP_NORMALS = '';
  else delete m.defines.KEEP_NORMALS;
  m.needsUpdate = true;
}
