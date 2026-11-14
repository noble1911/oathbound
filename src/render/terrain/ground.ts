// The ground mesh (1 m heightfield grid) with a splat-blended MeshStandardMaterial patch:
// grass (two tones + macro variation), dirt/paths, rock, mud/wet banks and forest litter, height-
// blended, anti-tiled with two texture scales and bump-mapped from the blended height. Also draws
// the planning overlay (deploy-zone glow and grid) as emissive.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { NOISE_GLSL, after, replace } from '../core/glsl.ts';
import type { Heightfield } from './heightfield.ts';
import { WORLD, WATER_LEVEL } from './layout.ts';
import type { TerrainTextures } from './textures.ts';
import { OVERLAY_GLSL, overlayUniforms } from './overlay.ts';
import { BAKED_SHADOW_GLSL, BAKED_SHADOW_APPLY, bakedShadowUniforms } from './baked-shadow.ts';

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
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0 });
  const uniforms = {
    tGrass: { value: tex.grass },
    tDirt: { value: tex.dirt },
    tRock: { value: tex.rock },
    tMud: { value: tex.mud },
    tSplat: { value: hf.splat },
    uWorldMin: { value: new THREE.Vector2(WORLD.x0, WORLD.z0) },
    uWorldSize: { value: new THREE.Vector2(WORLD.x1 - WORLD.x0, WORLD.z1 - WORLD.z0) },
    uWaterLevel: { value: WATER_LEVEL },
    uBump: { value: 1.6 },
  };
  engine.patch(mat, 'ob-ground', (shader) => {
    Object.assign(shader.uniforms, uniforms, overlayUniforms, bakedShadowUniforms, { uTime: globalUniforms.uTime });
    shader.vertexShader = after(shader.vertexShader, '#include <common>', 'varying vec3 vObW;');
    shader.vertexShader = after(shader.vertexShader, '#include <project_vertex>', 'vObW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    let f = shader.fragmentShader;
    f = after(
      f,
      '#include <common>',
      /* glsl */ `
varying vec3 vObW;
uniform sampler2D tGrass;
uniform sampler2D tDirt;
uniform sampler2D tRock;
uniform sampler2D tMud;
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
vec4 obT(sampler2D t, vec2 p, float k) {
  vec4 a = texture2D(t, p * 0.29);
  vec4 b = texture2D(t, p * 0.083 + vec2(0.37, 0.61));
  return mix(a, b, k);
}
`,
    );
    f = replace(
      f,
      '#include <map_fragment>',
      /* glsl */ `
vec2 wp = vObW.xz;
vec4 sp = texture2D(tSplat, (wp - uWorldMin) / uWorldSize);
float macro = ob_noise(wp * 0.045);
float mk = 0.2 + 0.4 * macro;
vec4 tg = obT(tGrass, wp, mk);
vec4 td = obT(tDirt, wp, mk);
vec4 tr = obT(tRock, wp * 0.7, mk);
vec4 tm = obT(tMud, wp, mk);
// large-scale tone variation: lush / sun-dried patches
float tone = ob_fbm(wp * 0.018 + 3.0);
tg.rgb *= mix(vec3(0.86, 0.98, 0.82), vec3(1.1, 1.04, 0.86), smoothstep(0.3, 0.7, tone));
// forest litter: dark grass + leaf-brown dirt
vec4 tf = vec4(mix(tg.rgb * vec3(0.55, 0.58, 0.42), td.rgb * vec3(0.78, 0.68, 0.55), 0.55), td.a);
float wD = sp.r;
float wR = sp.g;
float wM = sp.b;
float wF = sp.a * (1.0 - wR);
float wG = max(0.0, 1.0 - max(max(wD, wR), max(wM, wF)));
// height blending (stones poke through grass at transitions)
float sG = wG + tg.a * 0.5;
float sD = wD + td.a * 0.5;
float sR = wR + tr.a * 0.5;
float sM = wM + tm.a * 0.5;
float sF = wF + tf.a * 0.5;
float smax = max(max(max(sG, sD), max(sR, sM)), sF) - 0.18;
vec4 bw = vec4(max(sG - smax, 0.0) * step(0.001, wG), max(sD - smax, 0.0) * step(0.001, wD), max(sR - smax, 0.0) * step(0.001, wR), max(sM - smax, 0.0) * step(0.001, wM));
float bF = max(sF - smax, 0.0) * step(0.001, wF);
float bs = bw.x + bw.y + bw.z + bw.w + bF + 1e-4;
vec3 albedo = (tg.rgb * bw.x + td.rgb * bw.y + tr.rgb * bw.z + tm.rgb * bw.w + tf.rgb * bF) / bs;
float obH = (tg.a * bw.x + td.a * bw.y + tr.a * bw.z + tm.a * bw.w + tf.a * bF) / bs;
float obWet = clamp(wM * 1.2, 0.0, 1.0);
albedo *= mix(1.0, 0.72, obWet);
// riverbed under the water: darker, cooler
float under = smoothstep(uWaterLevel + 0.02, uWaterLevel - 0.5, vObW.y);
albedo *= mix(vec3(1.0), vec3(0.62, 0.7, 0.68), under);
// soft caustics on the shallow bed
float ca = ob_noise(wp * 1.7 + vec2(uTime * 0.35, uTime * 0.2)) * ob_noise(wp * 2.3 - vec2(uTime * 0.25, -uTime * 0.3));
albedo += vec3(0.5, 0.6, 0.55) * pow(ca, 3.0) * under * smoothstep(uWaterLevel - 1.2, uWaterLevel - 0.2, vObW.y) * 0.6;
diffuseColor.rgb *= albedo;
`,
    );
    f = replace(f, '#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * mix(1.0, 0.42, obWet * (1.0 - under * 0.5)) * mix(1.0, 0.9, bw.z / bs);');
    f = after(
      f,
      '#include <normal_fragment_maps>',
      'normal = ob_perturb(-vViewPosition, normal, vec2(dFdx(obH), dFdy(obH)) * uBump * smoothstep(160.0, 25.0, length(vViewPosition)), faceDirection);',
    );
    f = after(f, '#include <emissivemap_fragment>', 'totalEmissiveRadiance += ob_zones(wp);');
    f = after(f, '#include <lights_fragment_end>', BAKED_SHADOW_APPLY);
    shader.fragmentShader = f;
  });
  const mesh = new THREE.Mesh(buildGroundGeometry(hf), mat);
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}
