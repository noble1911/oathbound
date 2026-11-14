// The ground mesh (1 m heightfield grid) with a PBR splat MeshStandardMaterial patch: five scanned
// layers (grass, forest floor, dirt path, mud / river bank, rock; texture arrays, see
// env-textures.ts) chosen by the splat map, height-blended at transitions, anti-tiled with a second
// texture scale and a macro variation map, normal-mapped, with per-layer roughness and triplanar
// rock on slopes. Only the layers present at a pixel are sampled (textureGrad inside branches), and
// low drops the normal maps, low and medium the second scale and the triplanar path. Also draws the
// planning overlay (deploy-zone glow and grid) as emissive.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { NOISE_GLSL, after, replace } from '../core/glsl.ts';
import type { Heightfield } from './heightfield.ts';
import { WORLD, WATER_LEVEL } from './layout.ts';
import type { TerrainTextures } from './textures.ts';
import { OVERLAY_GLSL, overlayUniforms } from './overlay.ts';
import { BAKED_SHADOW_GLSL, BAKED_SHADOW_APPLY, bakedShadowUniforms } from './baked-shadow.ts';
import { groundTextures } from './env-textures.ts';

const BUMP_GLSL = /* glsl */ `
vec3 ob_perturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

export function buildGroundGeometry(hf: Heightfield): THREE.BufferGeometry {
  const { nx, nz, data, step } = hf;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = WORLD.x0 + i * step;
      pos[k * 3 + 1] = data[k];
      pos[k * 3 + 2] = WORLD.z0 + j * step;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let o = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // alternate the diagonal for a less regular look
      if ((i + j) & 1) {
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      } else {
        idx[o++] = a; idx[o++] = c; idx[o++] = d;
        idx[o++] = a; idx[o++] = d; idx[o++] = b;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export function buildGround(engine: Engine, hf: Heightfield, tex: TerrainTextures): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.envMapIntensity = 0.55;
  const uniforms = {
    tMacro: { value: tex.macro },
    tSplat: { value: hf.splat },
    uWorldMin: { value: new THREE.Vector2(WORLD.x0, WORLD.z0) },
    uWorldSize: { value: new THREE.Vector2(WORLD.x1 - WORLD.x0, WORLD.z1 - WORLD.z0) },
    uWaterLevel: { value: WATER_LEVEL },
    uBump: { value: 1.2 },
  };
  engine.patch(mat, 'ob-ground', (shader) => {
    Object.assign(shader.uniforms, uniforms, groundTextures, overlayUniforms, bakedShadowUniforms, { uTime: globalUniforms.uTime });
    shader.vertexShader = after(shader.vertexShader, '#include <common>', 'varying vec3 vObW;\nvarying vec3 vObN;');
    shader.vertexShader = after(shader.vertexShader, '#include <project_vertex>', 'vObW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvObN = normal;');
    let f = shader.fragmentShader;
    f = after(
      f,
      '#include <common>',
      /* glsl */ `
varying vec3 vObW;
varying vec3 vObN;
uniform highp sampler2DArray tGroundA;
uniform highp sampler2DArray tGroundN;
uniform sampler2D tMacro;
uniform sampler2D tSplat;
uniform vec2 uWorldMin;
uniform vec2 uWorldSize;
uniform float uWaterLevel;
uniform float uBump;
uniform float uTime;
${BAKED_SHADOW_GLSL}
${NOISE_GLSL}
${BUMP_GLSL}
${OVERLAY_GLSL}
`,
    );
    f = replace(
      f,
      '#include <map_fragment>',
      /* glsl */ `
vec2 wp = vObW.xz;
vec4 sp = texture2D(tSplat, (wp - uWorldMin) / uWorldSize);
// macro variation (two scales of a tileable noise map): tone, lushness, brightness
vec3 mac = texture2D(tMacro, wp * 0.0113).rgb;
vec3 mac2 = texture2D(tMacro, wp * 0.047 + vec2(0.37, 0.11)).rgb;
float mk = 0.25 + 0.3 * mac2.g;
float wD = sp.r;
float wR = sp.g;
float wM = sp.b;
float wF = sp.a * (1.0 - wR);
float wG = max(0.0, 1.0 - max(max(wD, wR), max(wM, wF)));
// layers: 0 grass, 1 forest floor, 2 dirt path, 3 mud / bank, 4 rock (tiles per metre below)
float obW[5] = float[5](wG, wF, wD, wM, wR);
const float obSc[5] = float[5](0.19, 0.22, 0.24, 0.2, 0.13);
vec2 obGx = dFdx(wp);
vec2 obGy = dFdy(wp);
vec3 obNw = normalize(vObN);
vec4 obT[5];
float obS[5];
float smax = 0.0;
for (int i = 0; i < 5; i++) {
  obT[i] = vec4(0.0);
  obS[i] = 0.0;
  if (obW[i] > 0.004) {
    float k = obSc[i];
    vec4 t = textureGrad(tGroundA, vec3(wp * k, float(i)), obGx * k, obGy * k);
#ifdef OB_DETAIL
    float k2 = k * 0.23;
    t = mix(t, textureGrad(tGroundA, vec3(wp * k2 + vec2(0.37, 0.61), float(i)), obGx * k2, obGy * k2), mk);
#endif
    obT[i] = t;
    obS[i] = obW[i] + t.a * 0.5;
    smax = max(smax, obS[i]);
  }
}
#ifdef OB_DETAIL
// triplanar rock on slopes (cliffs, river banks): side projections replace the stretched top one
float obSlope = smoothstep(0.22, 0.5, 1.0 - obNw.y) * step(0.004, wR);
if (obSlope > 0.01) {
  float k = obSc[4];
  vec2 ux = vec2(vObW.z, vObW.y) * k;
  vec2 uz = vec2(vObW.x, vObW.y) * k;
  vec4 tx = textureGrad(tGroundA, vec3(ux, 4.0), dFdx(ux), dFdy(ux));
  vec4 tz = textureGrad(tGroundA, vec3(uz, 4.0), dFdx(uz), dFdy(uz));
  float bx = abs(obNw.x) / (abs(obNw.x) + abs(obNw.z) + 1e-4);
  obT[4] = mix(obT[4], mix(tz, tx, bx), obSlope);
}
#endif
// grass: lush / sun-dried patches
obT[0].rgb *= mix(vec3(0.84, 0.98, 0.82), vec3(1.16, 1.06, 0.78), smoothstep(0.3, 0.72, mac.g));
// height blending (stones poke through grass at transitions)
smax -= 0.2;
float obB[5];
float bs = 1e-4;
vec3 albedo = vec3(0.0);
float obH = 0.0;
for (int i = 0; i < 5; i++) {
  obB[i] = max(obS[i] - smax, 0.0);
  bs += obB[i];
  albedo += obT[i].rgb * obB[i];
  obH += obT[i].a * obB[i];
}
albedo /= bs;
obH /= bs;
// roughness per layer (mud is wet: puddles in the low spots)
float obRough = (0.96 * obB[0] + 0.93 * obB[1] + 0.9 * obB[2] + mix(0.3, 0.82, smoothstep(0.2, 0.7, obT[3].a)) * obB[3] + 0.84 * obB[4]) / bs;
albedo *= 0.8 + 0.28 * mac.r + 0.14 * (mac2.b - 0.5);
// cavities (height) read darker
albedo *= mix(0.8, 1.06, obH);
float obWet = clamp(wM * 1.2, 0.0, 1.0);
albedo *= mix(1.0, 0.78, obWet);
// riverbed under the water: darker, cooler
float under = smoothstep(uWaterLevel + 0.02, uWaterLevel - 0.5, vObW.y);
albedo *= mix(vec3(1.0), vec3(0.6, 0.7, 0.68), under);
// soft caustics on the shallow bed
float ca = ob_noise(wp * 1.7 + vec2(uTime * 0.35, uTime * 0.2)) * ob_noise(wp * 2.3 - vec2(uTime * 0.25, -uTime * 0.3));
albedo += vec3(0.5, 0.6, 0.55) * pow(ca, 3.0) * under * smoothstep(uWaterLevel - 1.2, uWaterLevel - 0.2, vObW.y) * 0.6;
diffuseColor.rgb *= albedo;
`,
    );
    f = replace(f, '#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * obRough * mix(1.0, 0.7, under);');
    f = after(
      f,
      '#include <normal_fragment_maps>',
      /* glsl */ `
#ifdef OB_NORMALS
{
  vec2 nxy = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    if (obB[i] > 0.01) {
      float k = obSc[i];
      nxy += (textureGrad(tGroundN, vec3(wp * k, float(i)), obGx * k, obGy * k).rg * 2.0 - 1.0) * obB[i];
    }
  }
  nxy *= uBump / bs;
  // heightfield tangent frame: T = +X, B = +Z (uv = world xz)
  vec3 nW = normalize(obNw + vec3(nxy.x, 0.0, nxy.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
#else
normal = ob_perturb(-vViewPosition, normal, vec2(dFdx(obH), dFdy(obH)) * 1.4 * smoothstep(160.0, 25.0, length(vViewPosition)), faceDirection);
#endif
`,
    );
    f = after(f, '#include <emissivemap_fragment>', 'totalEmissiveRadiance += ob_zones(wp);');
    f = after(f, '#include <lights_fragment_end>', BAKED_SHADOW_APPLY);
    shader.fragmentShader = f;
  });
  const mesh = new THREE.Mesh(buildGroundGeometry(hf), mat);
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  /** Tier switch: 0 = albedo splat only (low), 1 = + normal maps (medium), 2 = + second texture scale and triplanar rock. */
  mesh.userData.setDetail = (level: 0 | 1 | 2): void => {
    const want: Record<string, number> = level === 2 ? { OB_DETAIL: 1, OB_NORMALS: 1 } : level === 1 ? { OB_NORMALS: 1 } : {};
    if (JSON.stringify(mat.defines ?? {}) === JSON.stringify(want)) return;
    mat.defines = want;
    mat.needsUpdate = true;
  };
  return mesh;
}
