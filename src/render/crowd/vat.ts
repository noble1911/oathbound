// Vertex Animation Textures for the crowd.
//
// A VAT stores, for every baked frame, the object-space position (and normal) of every vertex:
// texel (i % width, frame * rowsPerFrame + floor(i / width)), RGBA32F (xyz, w unused). Clips are
// contiguous frame ranges. The crowd shader reads two frames per clip (lerp) and cross-fades two
// clips, so 300+ soldiers animate with one draw call per archetype (plus shadow cascades).
//
// Sources: (1) `bakeVat()` — any SkinnedMesh + AnimationClips (procedural stand-ins, or a rigged
// GLB at load time), skinned on the CPU; (2) `loadVat()` — a prebaked bake from the art pipeline:
// `<name>.vat.json` (VatMeta) next to `<name>.vat.pos.bin` / `<name>.vat.nrm.bin` (little-endian
// float32 or float16 RGBA, `format`), with the mesh GLB whose vertex order matches the bake.
import * as THREE from 'three';
import { NOISE_GLSL, after, replace } from '../core/glsl.ts';
import type { Engine } from '../core/engine.ts';

export interface VatClip {
  name: string;
  /** First frame (row block) of the clip. */
  start: number;
  frames: number;
  fps: number;
  loop: boolean;
  duration: number;
}

export interface VatData {
  vertexCount: number;
  width: number;
  rowsPerFrame: number;
  totalFrames: number;
  clips: VatClip[];
  pos: THREE.DataTexture;
  nrm: THREE.DataTexture;
  bounds: THREE.Box3;
  /** Normals are octahedral-packed into pos.w (then `nrm` === `pos`). */
  octNormals?: boolean;
  vertexIndexAttribute?: string;
}

/** JSON contract for prebaked VATs (docs/ART.md should reference this). */
export interface VatMeta {
  version: 1;
  vertexCount: number;
  width: number;
  rowsPerFrame: number;
  totalFrames: number;
  format: 'f32' | 'f16';
  clips: VatClip[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  pos: string;
  /** null when normals are packed into pos.w ('octPosW45'). */
  nrm: string | null;
  /** 'octPosW45': pos texel .w = ox*45+oy (0..44 each), octahedral-encoded normal. */
  normalEncoding?: 'octPosW45';
  /** Geometry attribute holding each vertex's VAT texel index (UV-seam duplicates share one). */
  vertexIndexAttribute?: string;
  mesh?: string;
  tintMask?: string;
}

const MAX_W = 4096;

function makeTex(data: Float32Array | Uint16Array, w: number, h: number, half: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, half ? THREE.HalfFloatType : THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * Bake a skinned mesh's clips into a VAT. `root` is the object the clips animate (bones under it).
 * Returns the static crowd geometry (skin attributes removed, `vatIndex` added) and the VAT.
 */
export function bakeVat(root: THREE.Object3D, mesh: THREE.SkinnedMesh, clips: THREE.AnimationClip[], fps = 30): { geometry: THREE.BufferGeometry; vat: VatData } {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const si = geo.getAttribute('skinIndex');
  const swt = geo.getAttribute('skinWeight');
  const n = pos.count;
  const width = Math.min(n, MAX_W);
  const rows = Math.ceil(n / width);
  const plan = clips.map((c) => {
    const loop = (c.userData?.loop as boolean | undefined) ?? /idle|move|walk|run|fly/i.test(c.name);
    const frames = Math.max(1, Math.round(c.duration * fps) + (loop ? 0 : 1));
    return { clip: c, loop, frames };
  });
  const total = plan.reduce((a, p) => a + p.frames, 0);
  const P = new Float32Array(width * rows * total * 4);
  const N = new Float32Array(width * rows * total * 4);
  const mixer = new THREE.AnimationMixer(root);
  const skeleton = mesh.skeleton;
  const bm = skeleton.boneMatrices!;
  const m = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const bounds = new THREE.Box3();
  const out: VatClip[] = [];
  let frame = 0;
  for (const p of plan) {
    mixer.stopAllAction();
    const action = mixer.clipAction(p.clip);
    action.setLoop(p.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.reset().play();
    out.push({ name: p.clip.name, start: frame, frames: p.frames, fps, loop: p.loop, duration: p.clip.duration });
    for (let f = 0; f < p.frames; f++) {
      const t = Math.min(f / fps, p.clip.duration - 1e-4);
      mixer.setTime(t);
      root.updateMatrixWorld(true);
      skeleton.update();
      const rowBase = (frame + f) * rows * width;
      for (let i = 0; i < n; i++) {
        m.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const w = swt.getComponent(i, k);
          if (w === 0) continue;
          const b = si.getComponent(i, k);
          tmp.fromArray(bm, b * 16);
          const e = m.elements;
          const te = tmp.elements;
          for (let q = 0; q < 16; q++) e[q] += te[q] * w;
        }
        tmp.multiplyMatrices(mesh.bindMatrixInverse, m).multiply(mesh.bindMatrix);
        v.fromBufferAttribute(pos, i).applyMatrix4(tmp);
        nm.setFromMatrix4(tmp);
        nv.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
        const o = (rowBase + i) * 4;
        P[o] = v.x;
        P[o + 1] = v.y;
        P[o + 2] = v.z;
        P[o + 3] = 1;
        N[o] = nv.x;
        N[o + 1] = nv.y;
        N[o + 2] = nv.z;
        N[o + 3] = 0;
        bounds.expandByPoint(v);
      }
    }
    frame += p.frames;
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  const g = geo.clone();
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  const idx = new Float32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setAttribute('vatIndex', new THREE.BufferAttribute(idx, 1));
  g.boundingBox = bounds.clone();
  g.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
  return {
    geometry: g,
    vat: { vertexCount: n, width, rowsPerFrame: rows, totalFrames: total, clips: out, pos: makeTex(P, width, rows * total, false), nrm: makeTex(N, width, rows * total, false), bounds },
  };
}

/** Load a prebaked VAT (VatMeta JSON + binaries). `url` is the JSON; bins resolve relative to it. */
export async function loadVat(url: string): Promise<VatData> {
  const meta = (await (await fetch(url)).json()) as VatMeta;
  const baseUrl = new URL(url, location.href);
  const load = async (f: string) => (await fetch(new URL(f, baseUrl))).arrayBuffer();
  const oct = meta.nrm === null || meta.normalEncoding === 'octPosW45';
  const [pb, nb] = await Promise.all([load(meta.pos), oct || !meta.nrm ? Promise.resolve(null) : load(meta.nrm)]);
  const half = meta.format === 'f16';
  const h = meta.rowsPerFrame * meta.totalFrames;
  const mk = (b: ArrayBuffer) => makeTex(half ? new Uint16Array(b) : new Float32Array(b), meta.width, h, half);
  const pos = mk(pb);
  return {
    vertexCount: meta.vertexCount, width: meta.width, rowsPerFrame: meta.rowsPerFrame, totalFrames: meta.totalFrames, clips: meta.clips,
    pos, nrm: nb ? mk(nb) : pos, bounds: new THREE.Box3(new THREE.Vector3(...meta.bounds.min), new THREE.Vector3(...meta.bounds.max)),
    octNormals: oct, vertexIndexAttribute: meta.vertexIndexAttribute,
  };
}

// ------------------------------------------------------------------ materials

/** Shared fragment patch: team tint mask, per-vertex PBR, emissive, flash, dither fade, detail noise. */
function patchFragment(fs: string, opts: { surf: boolean; tintAttr: boolean; tintMap: boolean }): string {
  fs = after(fs, '#include <common>', `
${NOISE_GLSL}
varying vec3 vSurf;
varying float vTintMask;
varying vec3 vTeam;
varying float vFlash;
varying float vFlashCol;
varying float vFade;
varying vec3 vRest;
varying vec2 vObUv;
varying float vMirror;
${opts.tintMap ? 'uniform sampler2D uTintMap;' : ''}`);
  fs = after(fs, 'void main() {', `
  if (vFade < 0.999) {
    float h = ob_hash12(floor(gl_FragCoord.xy));
    if (h > vFade) discard;
  }`);
  fs = after(fs, '#include <color_fragment>', `
  {
    float mask = vTintMask;
    ${opts.tintMap ? 'mask = max(mask, texture2D(uTintMap, vObUv).r);' : ''}
    diffuseColor.rgb *= mix(vec3(1.0), vTeam, mask);
    float dn = ob_noise(vRest.xy * 38.0 + vRest.z * 17.0) * 0.5 + ob_noise(vRest.zy * 9.0) * 0.5;
    diffuseColor.rgb *= 0.86 + 0.26 * dn;
    // soft knee on near-white albedo (fur mantles, white horses): keeps shading instead of
    // blowing out to a flat white blob in sunlight
    vec3 over = max(diffuseColor.rgb - 0.45, 0.0);
    diffuseColor.rgb = min(diffuseColor.rgb, vec3(0.45)) + over * 0.3;
  }`);
  // mirrored instances (death2) have reversed winding: flip the face direction back
  fs = after(fs, '#include <normal_fragment_begin>', '#ifdef DOUBLE_SIDED\n  normal *= vMirror;\n  #ifdef USE_TANGENT\n  tbn[2] *= vMirror;\n  #endif\n#endif');
  if (opts.surf) {
    fs = after(fs, '#include <roughnessmap_fragment>', 'roughnessFactor = clamp(vSurf.x, 0.04, 1.0);');
    fs = after(fs, '#include <metalnessmap_fragment>', 'metalnessFactor = vSurf.y;');
  }
  fs = after(fs, '#include <emissivemap_fragment>', `
  totalEmissiveRadiance += diffuseColor.rgb * vSurf.z;
  // hit flash / highlight: a warm lift on top of the lit surface (never a flat white silhouette)
  totalEmissiveRadiance += vFlash * mix(vec3(0.5, 0.42, 0.34) + diffuseColor.rgb * 0.6, vec3(2.6, 0.3, 0.2), vFlashCol);`);
  return fs;
}

const VAT_VERTEX_HEADER = /* glsl */ `
attribute float vatIndex;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec3 iTeam;
uniform highp sampler2D uVatPos;
uniform highp sampler2D uVatNrm;
uniform int uVatW;
uniform int uVatRows;
ivec2 vatUV(float frame) {
  int i = int(vatIndex + 0.5);
  int f = int(frame + 0.5);
  return ivec2(i - (i / uVatW) * uVatW, f * uVatRows + i / uVatW);
}
vec3 vatSample(highp sampler2D tex) {
  vec3 a = mix(texelFetch(tex, vatUV(iA.x), 0).xyz, texelFetch(tex, vatUV(iA.y), 0).xyz, iA.z);
  if (iC.x > 0.001) {
    vec3 b = mix(texelFetch(tex, vatUV(iB.x), 0).xyz, texelFetch(tex, vatUV(iB.y), 0).xyz, iB.z);
    a = mix(a, b, iC.x);
  }
  return a;
}
// 'octPosW45': w = ox*45 + oy, ox/oy in 0..44 -> octahedral [-1,1]^2 -> unit normal
vec3 octDec(float w) {
  w = floor(w + 0.5);
  float ox = floor(w / 45.0);
  float oy = w - ox * 45.0;
  vec2 e = vec2(ox, oy) / 44.0 * 2.0 - 1.0;
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return normalize(n);
}
vec3 vatNormal() {
#ifdef OB_VAT_OCT
  vec3 a = normalize(mix(octDec(texelFetch(uVatPos, vatUV(iA.x), 0).w), octDec(texelFetch(uVatPos, vatUV(iA.y), 0).w), iA.z));
  if (iC.x > 0.001) {
    vec3 b = normalize(mix(octDec(texelFetch(uVatPos, vatUV(iB.x), 0).w), octDec(texelFetch(uVatPos, vatUV(iB.y), 0).w), iB.z));
    a = normalize(mix(a, b, iC.x));
  }
  return a;
#else
  return normalize(vatSample(uVatNrm));
#endif
}`;

export interface CrowdMaterialOpts {
  map?: THREE.Texture | null;
  tintMap?: THREE.Texture | null;
  /** Packed metal (B) / roughness (G) map (glTF convention). */
  mrMap?: THREE.Texture | null;
  roughness?: number;
  metalness?: number;
  /** Geometry has `surf` (rough, metal, emissive) and `tint` vertex attributes (procedural models). */
  surf: boolean;
  vertexColors: boolean;
  key: string;
}

/**
 * The instanced VAT material (+ its shadow depth material). Per-instance attributes:
 *  iA = (clip A frame0, frame1, frac, -), iB = same for the cross-fade source clip,
 *  iC = (blend weight of B, fade 0..1, flash 0..1, -), iTeam = team colour (linear RGB).
 */
export function createCrowdMaterials(engine: Engine, vat: VatData, o: CrowdMaterialOpts): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; ghost: THREE.MeshBasicMaterial } {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: o.vertexColors, roughness: o.mrMap ? 1 : (o.roughness ?? 0.7), metalness: o.surf || o.mrMap ? 1 : (o.metalness ?? 0), map: o.map ?? null,
    roughnessMap: o.mrMap ?? null, metalnessMap: o.mrMap ?? null,
    // double-sided so mirrored (death2) instances aren't culled inside-out; the shader fixes normals
    side: THREE.DoubleSide,
  });
  if (vat.octNormals) mat.defines = { ...(mat.defines ?? {}), OB_VAT_OCT: '' };
  const uniforms = {
    uVatPos: { value: vat.pos },
    uVatNrm: { value: vat.nrm },
    uVatW: { value: vat.width },
    uVatRows: { value: vat.rowsPerFrame },
    uTintMap: { value: o.tintMap ?? null },
  };
  const vertexPatch = (vs: string, depth: boolean) => {
    vs = after(vs, '#include <common>', `${VAT_VERTEX_HEADER}
${o.surf ? 'attribute vec3 surf;\nattribute float tint;' : ''}
varying vec3 vSurf;
varying float vTintMask;
varying vec3 vTeam;
varying float vFlash;
varying float vFlashCol;
varying float vFade;
varying vec3 vRest;
varying vec2 vObUv;
varying float vMirror;`);
    if (!depth) vs = replace(vs, '#include <beginnormal_vertex>', 'vec3 objectNormal = vatNormal();\n  if (iA.w < 0.0) objectNormal.x = -objectNormal.x;');
    vs = replace(vs, '#include <begin_vertex>', `vec3 transformed = vatSample(uVatPos);
  vMirror = iA.w < 0.0 ? -1.0 : 1.0;
  transformed.x *= vMirror;
  vObUv = ${o.tintMap ? 'uv' : 'vec2(0.0)'};
  vRest = position;
  vSurf = ${o.surf ? 'surf' : 'vec3(0.7, 0.0, 0.0)'};
  vTintMask = ${o.surf ? 'tint' : '0.0'};
  vTeam = iTeam;
  vFade = iC.y;
  vFlash = iC.z;
  vFlashCol = iC.w;`);
    return vs;
  };
  engine.patch(mat, `vat:${o.key}:${vat.octNormals ? 'o' : ''}${o.tintMap ? 't' : ''}${o.mrMap ? 'm' : ''}`, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = vertexPatch(shader.vertexShader, false);
    shader.fragmentShader = patchFragment(shader.fragmentShader, { surf: o.surf, tintAttr: o.surf, tintMap: !!o.tintMap });
  });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  if (vat.octNormals) depth.defines = { ...(depth.defines ?? {}), OB_VAT_OCT: '' };
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = vertexPatch(shader.vertexShader, true);
    shader.fragmentShader = after(shader.fragmentShader, '#include <common>', `${NOISE_GLSL}\nvarying float vFade;`);
    shader.fragmentShader = after(shader.fragmentShader, 'void main() {', 'if (vFade < 0.999 && ob_hash12(floor(gl_FragCoord.xy)) > vFade) discard;');
  };
  depth.customProgramCacheKey = () => `vatdepth:${o.key}:${vat.octNormals ? 'o' : ''}`;
  // occluded-unit silhouette: drawn only where something is MORE than ~4 m in front of the soldier
  // (depth test GREATER after pulling the soldier 4 m toward the camera), so canopies / walls / hills
  // reveal a team-coloured shape while neighbouring soldiers don't ghost each other
  const ghost = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthFunc: THREE.GreaterDepth, side: THREE.DoubleSide, fog: false });
  if (vat.octNormals) ghost.defines = { ...(ghost.defines ?? {}), OB_VAT_OCT: '' };
  ghost.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = vertexPatch(shader.vertexShader, true);
    vs = after(vs, '#include <project_vertex>', 'mvPosition.xyz += normalize(-mvPosition.xyz) * 4.0;\n  gl_Position = projectionMatrix * mvPosition;');
    shader.vertexShader = vs;
    shader.fragmentShader = after(shader.fragmentShader, '#include <common>', 'varying vec3 vTeam;\nvarying float vFade;');
    shader.fragmentShader = after(shader.fragmentShader, '#include <opaque_fragment>', 'gl_FragColor = vec4(vTeam * 1.6 + 0.08, 0.5 * vFade * vFade);');
  };
  ghost.customProgramCacheKey = () => `vatghost:${o.key}:${vat.octNormals ? 'o' : ''}`;
  return { material: mat, depth, ghost };
}

/**
 * Material for a skinned hero mesh built by the rig builder (surf/tint vertex attributes), with
 * per-object uniforms for team colour, hit flash and fade.
 */
export function createHeroMaterial(engine: Engine, key: string, o: { surf: boolean; map?: THREE.Texture | null; tintMap?: THREE.Texture | null; vertexColors: boolean }): { material: THREE.MeshStandardMaterial; uniforms: { uTeam: { value: THREE.Color }; uFlash: { value: number }; uFade: { value: number } } } {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: o.vertexColors, roughness: 0.7, metalness: o.surf ? 1 : 0, map: o.map ?? null });
  const uniforms = { uTeam: { value: new THREE.Color(1, 1, 1) }, uFlash: { value: 0 }, uFade: { value: 1 }, uTintMap: { value: o.tintMap ?? null } };
  engine.patch(mat, `hero:${o.surf ? 's' : ''}${o.tintMap ? 't' : ''}`, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = after(shader.vertexShader, '#include <common>', `
${o.surf ? 'attribute vec3 surf;\nattribute float tint;' : ''}
uniform vec3 uTeam;
uniform float uFlash;
uniform float uFade;
varying vec3 vSurf;
varying float vTintMask;
varying vec3 vTeam;
varying float vFlash;
varying float vFlashCol;
varying float vFade;
varying vec3 vRest;
varying vec2 vObUv;
varying float vMirror;`);
    shader.vertexShader = after(shader.vertexShader, '#include <begin_vertex>', `
  vObUv = ${o.tintMap ? 'uv' : 'vec2(0.0)'};
  vMirror = 1.0;
  vRest = position;
  vSurf = ${o.surf ? 'surf' : 'vec3(0.7, 0.0, 0.0)'};
  vTintMask = ${o.surf ? 'tint' : '0.0'};
  vTeam = uTeam;
  vFade = uFade;
  vFlash = uFlash;
  vFlashCol = 0.0;`);
    shader.fragmentShader = patchFragment(shader.fragmentShader, { surf: o.surf, tintAttr: o.surf, tintMap: !!o.tintMap });
  });
  // per-object uniforms: each hero gets its own material instance, but they share one program
  return { material: mat, uniforms };
}
