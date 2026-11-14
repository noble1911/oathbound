// The river: a transparent MeshStandardMaterial patch (so CSM shadows, fog and the sky's PMREM
// reflection all apply) coloured by water depth (a per-vertex attribute = water level − bed),
// with two flow-scrolled normal layers, shore foam where it's shallow and, on tiers with
// `waterReflection > 0`, a planar reflection (mirrored camera, WORLD layer only, at a fraction of
// the screen resolution, with an oblique near plane at the water surface).
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { NOISE_GLSL, after, replace } from '../core/glsl.ts';
import { LAYER_WORLD } from '../core/post.ts';
import type { Heightfield } from './heightfield.ts';
import { WORLD, WATER_LEVEL } from './layout.ts';
import type { TerrainTextures } from './textures.ts';

export class Water {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private rt: THREE.WebGLRenderTarget | null = null;
  private scale = 0;
  private reflCam = new THREE.PerspectiveCamera();
  private uniforms: Record<string, THREE.IUniform>;
  /** Objects hidden while rendering the reflection (grass, curtains). */
  readonly hideInReflection: THREE.Object3D[] = [];
  private readonly engine: Engine;

  constructor(engine: Engine, hf: Heightfield, tex: TerrainTextures) {
    this.engine = engine;
    const geo = buildWaterGeometry(hf);
    this.uniforms = {
      tWaterN: { value: tex.waterNormal },
      uShallow: { value: new THREE.Color('#3c7a74') },
      uDeep: { value: new THREE.Color('#0f2c36') },
      tRefl: { value: null },
      uReflAmt: { value: 0 },
      uReflMat: { value: new THREE.Matrix4() },
      uTime: globalUniforms.uTime,
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0, transparent: true, envMapIntensity: 1.5 });
    this.material = mat;
    const u = this.uniforms;
    engine.patch(mat, 'ob-water', (shader) => {
      Object.assign(shader.uniforms, u);
      let v = shader.vertexShader;
      v = after(v, '#include <common>', 'attribute float aDepth;\nvarying float vDepth;\nvarying vec3 vObW;\nvarying vec4 vRefl;\nuniform mat4 uReflMat;');
      v = after(v, '#include <project_vertex>', 'vDepth = aDepth;\nvObW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvRefl = uReflMat * vec4(vObW, 1.0);');
      shader.vertexShader = v;
      let f = shader.fragmentShader;
      f = after(
        f,
        '#include <common>',
        /* glsl */ `
varying float vDepth;
varying vec3 vObW;
varying vec4 vRefl;
uniform sampler2D tWaterN;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform sampler2D tRefl;
uniform float uReflAmt;
uniform float uTime;
${NOISE_GLSL}
`,
      );
      f = after(
        f,
        '#include <color_fragment>',
        /* glsl */ `
vec2 wp = vObW.xz;
float d = vDepth;
vec2 flow = vec2(uTime * 0.32, 0.0);
float fn = ob_noise(wp * 0.9 - flow * 1.4) * 0.6 + ob_noise(wp * 2.6 - flow * 2.2) * 0.4;
float shore = 1.0 - smoothstep(0.0, 0.16 + 0.14 * fn, d);
float streaks = smoothstep(0.62, 0.8, ob_noise(vec2(wp.x * 0.35 - uTime * 0.45, wp.y * 2.2)) * fn + 0.2) * smoothstep(0.1, 0.5, d) * 0.35;
float obFoam = clamp(shore * (0.55 + 0.45 * fn) + streaks * 0.5, 0.0, 1.0);
vec3 wcol = mix(uShallow, uDeep, smoothstep(0.05, 1.1, d));
diffuseColor.rgb = mix(wcol, vec3(0.92, 0.95, 0.94), obFoam * 0.85);
diffuseColor.a = mix(0.38, 0.93, smoothstep(0.0, 1.0, d));
diffuseColor.a = max(diffuseColor.a, obFoam * 0.9) * smoothstep(-0.03, 0.03, d);
`,
      );
      f = replace(f, '#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.6, obFoam);');
      f = after(
        f,
        '#include <normal_fragment_maps>',
        /* glsl */ `
vec3 n1 = texture2D(tWaterN, wp * 0.09 + vec2(uTime * 0.035, uTime * 0.006)).xyz * 2.0 - 1.0;
vec3 n2 = texture2D(tWaterN, wp * vec2(0.17, 0.21) + vec2(uTime * 0.052, -uTime * 0.017) + 0.43).xyz * 2.0 - 1.0;
vec3 n3 = texture2D(tWaterN, wp * 0.5 + vec2(uTime * 0.09, uTime * 0.03)).xyz * 2.0 - 1.0;
vec2 nxy = (n1.xy + n2.xy) * 0.5 + n3.xy * 0.25;
float ns = mix(0.35, 0.12, obFoam);
vec3 nW = normalize(vec3(nxy.x * ns, 1.0, nxy.y * ns));
normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
`,
      );
      f = replace(
        f,
        '#include <opaque_fragment>',
        /* glsl */ `
if (uReflAmt > 0.0) {
  vec3 V = normalize(vViewPosition);
  float ndv = clamp(dot(normal, V), 0.0, 1.0);
  float fr = (0.1 + 0.9 * pow(1.0 - ndv, 4.0)) * (1.0 - obFoam);
  vec2 ruv = vRefl.xy / vRefl.w + nxy * 0.035;
  vec3 refl = texture2D(tRefl, ruv).rgb;
  outgoingLight = mix(outgoingLight, refl * 0.9 + outgoingLight * 0.1, fr * uReflAmt);
  diffuseColor.a = max(diffuseColor.a, fr * uReflAmt * smoothstep(0.0, 0.08, d));
}
#include <opaque_fragment>
`,
      );
      shader.fragmentShader = f;
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'water';
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.mesh.onBeforeRender = (renderer, scene, camera) => this.renderReflection(renderer, scene, camera as THREE.PerspectiveCamera);
  }

  /** 0 = env-map reflections only; otherwise the planar reflection's resolution scale. */
  setReflection(scale: number): void {
    this.scale = scale;
    this.uniforms.uReflAmt.value = scale > 0 ? 1 : 0;
    if (scale <= 0) {
      this.rt?.dispose();
      this.rt = null;
      this.uniforms.tRefl.value = null;
    }
  }

  private renderReflection(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    if (this.scale <= 0 || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    if (camera === this.reflCam) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.round(size.x * this.scale));
    const h = Math.max(64, Math.round(size.y * this.scale));
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
      this.rt.texture.name = 'ob.waterRefl';
      this.uniforms.tRefl.value = this.rt.texture;
    } else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);

    const rc = this.reflCam;
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y < WATER_LEVEL) return;
    const L = WATER_LEVEL;
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    rc.position.set(camPos.x, 2 * L - camPos.y, camPos.z);
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(rot);
    up.y = -up.y;
    rc.up.copy(up);
    rc.lookAt(look.x, 2 * L - look.y, look.z);
    rc.near = camera.near;
    rc.far = camera.far;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(camera.projectionMatrix);
    rc.layers.set(LAYER_WORLD);

    const tm = this.uniforms.uReflMat.value as THREE.Matrix4;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);

    // oblique near plane = the water surface (Lengyel)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, L, 0));
    plane.applyMatrix4(rc.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = rc.projectionMatrix;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0],
      (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5],
      -1,
      (1 + pm.elements[10]) / pm.elements[14],
    );
    clip.multiplyScalar(2 / clip.dot(q));
    pm.elements[2] = clip.x;
    pm.elements[6] = clip.y;
    pm.elements[10] = clip.z + 1 - 0.003;
    pm.elements[14] = clip.w;

    const prevRT = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    this.mesh.visible = false;
    const hidden: THREE.Object3D[] = [];
    for (const o of this.hideInReflection) if (o.visible) (o.visible = false), hidden.push(o);
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(scene, rc);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevRT);
    for (const o of hidden) o.visible = true;
    this.mesh.visible = true;
    void this.engine;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.rt?.dispose();
  }
}

function buildWaterGeometry(hf: Heightfield): THREE.BufferGeometry {
  const pos: number[] = [];
  const depth: number[] = [];
  const idx: number[] = [];
  for (const r of hf.layout.rivers) {
    const x0 = Math.max(WORLD.x0, r.x0);
    const x1 = Math.min(WORLD.x1, r.x1);
    const z0 = r.z0 - 3.5;
    const z1 = r.z1 + 3.5;
    const sx = 1;
    const sz = 0.5;
    const nx = Math.ceil((x1 - x0) / sx) + 1;
    const nz = Math.ceil((z1 - z0) / sz) + 1;
    const base = pos.length / 3;
    for (let j = 0; j < nz; j++) {
      const z = z0 + j * sz;
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * sx;
        pos.push(x, WATER_LEVEL, z);
        depth.push(WATER_LEVEL - hf.ground(x, z));
      }
    }
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = base + j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        // skip quads entirely under dry ground
        const k = a - base;
        const dmax = Math.max(depth[base + k], depth[base + k + 1], depth[base + k + nx], depth[base + k + nx + 1]);
        if (dmax < -0.05) continue;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
