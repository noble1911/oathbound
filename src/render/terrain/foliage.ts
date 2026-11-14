// Instanced trees (broadleaf, conifer, slender birch) and grass clumps, both swaying in the
// wind in the vertex shader (WIND_GLSL; shared uTime/uWind uniforms). Trees cast shadows (with a
// matching wind-patched depth material); grass only receives them, is normal-up shaded so it
// melts into the ground, shrinks away with distance and picks up the planning overlay glow.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { WIND_GLSL, after, replace } from '../core/glsl.ts';
import type { Heightfield } from './heightfield.ts';
import { FIELD, WORLD, sdShape } from './layout.ts';
import { mulberry32, vnoise, smoothstep } from './noise.ts';
import { OVERLAY_GLSL, overlayUniforms } from './overlay.ts';

// ------------------------------------------------------------------ geometry helpers

function colorize(g: THREE.BufferGeometry, fn: (p: THREE.Vector3, n: THREE.Vector3) => [number, number, number], sway: (p: THREE.Vector3) => number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  const sw = new Float32Array(pos.count);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const c = fn(p, n);
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
    sw[i] = sway(p);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  return g;
}

function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal') ng.deleteAttribute(k);
  return ng;
}

const lin = (h: string): [number, number, number] => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b];
};

/** A lumpy foliage blob: displaced icosphere with normals blended towards the canopy centre. */
function blob(r: number, cx: number, cy: number, cz: number, seed: number, canopy: THREE.Vector3, detail = 1): THREE.BufferGeometry {
  const src = new THREE.IcosahedronGeometry(r, detail);
  src.deleteAttribute('uv');
  src.deleteAttribute('normal');
  const g = mergeVertices(src);
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + (vnoise(v.x * 2.1 + seed, v.y * 2.1 + v.z * 1.7, seed) - 0.5) * 0.45;
    v.multiplyScalar(k);
    v.y *= 0.82;
    pos.setXYZ(i, v.x + cx, v.y + cy, v.z + cz);
  }
  g.computeVertexNormals();
  const ng = g.toNonIndexed();
  // soft, rounded shading: normals lean away from the whole canopy's centre
  const p = ng.getAttribute('position');
  const n = ng.getAttribute('normal');
  const t = new THREE.Vector3();
  const nn = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    t.fromBufferAttribute(p, i).sub(canopy).normalize();
    nn.fromBufferAttribute(n, i).lerp(t, 0.55).normalize();
    n.setXYZ(i, nn.x, nn.y, nn.z);
  }
  return ng;
}

function trunk(h: number, r0: number, r1: number, lean = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, 7, 3, true);
  g.translate(0, h / 2, 0);
  if (lean) g.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, lean, 0, 0, 0));
  return strip(g);
}

function broadleaf(seed: number, lo = false): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const H = 4.2 + rnd() * 1.2;
  const parts: THREE.BufferGeometry[] = [];
  const bark = lin('#4a3a2c');
  const t = colorize(trunk(H + 0.8, 0.32, 0.17), (p) => (p.y < 0.4 ? [bark[0] * 0.7, bark[1] * 0.7, bark[2] * 0.7] : bark), (p) => Math.max(0, p.y / (H + 3)) * 0.4);
  parts.push(t);
  // two branches
  for (let b = 0; b < 2; b++) {
    const br = new THREE.CylinderGeometry(0.06, 0.12, 2.2, 5, 1, true);
    br.translate(0, 1.1, 0);
    br.rotateZ((b ? -1 : 1) * (0.7 + rnd() * 0.3));
    br.rotateY(rnd() * Math.PI);
    br.translate(0, H * 0.7, 0);
    parts.push(colorize(strip(br), () => bark, (p) => p.y / (H + 3) * 0.6));
  }
  const canopy = new THREE.Vector3(0, H + 1.6, 0);
  const leafA = lin('#38632a');
  const leafB = lin('#577f2f');
  const nBlobs = 6 + Math.floor(rnd() * 3);
  for (let i = 0; i < nBlobs; i++) {
    const a = (i / nBlobs) * Math.PI * 2 + rnd() * 0.6;
    const rr = i === 0 ? 0 : 1.2 + rnd() * 0.9;
    const cy = H + 1.2 + (i === 0 ? 1.4 : rnd() * 1.8 - 0.3);
    const r = i === 0 ? 2.1 : 1.3 + rnd() * 0.6;
    const g = blob(r, Math.cos(a) * rr, cy, Math.sin(a) * rr, seed * 13 + i, canopy, lo ? 0 : 1);
    const tone = rnd();
    parts.push(
      colorize(
        g,
        (p, n) => {
          const up = smoothstep(-0.6, 0.9, n.y);
          const inner = smoothstep(0.6, 2.8, p.distanceTo(canopy));
          const base: [number, number, number] = [leafA[0] + (leafB[0] - leafA[0]) * tone, leafA[1] + (leafB[1] - leafA[1]) * tone, leafA[2] + (leafB[2] - leafA[2]) * tone];
          const k = (0.45 + 0.55 * up) * (0.55 + 0.45 * inner);
          return [base[0] * k * (0.95 + 0.1 * up), base[1] * k, base[2] * k * 0.95];
        },
        (p) => 0.35 + Math.min(1, p.y / (H + 3.5)) * 0.65,
      ),
    );
  }
  return mergeGeometries(parts)!;
}

function conifer(seed: number, lo = false): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const H = 9 + rnd() * 4;
  const parts: THREE.BufferGeometry[] = [];
  const bark = lin('#3f3127');
  parts.push(colorize(trunk(H * 0.5, 0.24, 0.12), () => bark, (p) => p.y / H * 0.3));
  const nA = lin('#1f4428');
  const nB = lin('#2f5a33');
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = (1 - t) * 2.5 + 0.5;
    const h = 2.6 - t * 0.8;
    const y = 1.6 + t * (H - 3);
    const c = new THREE.ConeGeometry(r, h, lo ? 6 : 9, lo ? 1 : 2, true);
    const pos = c.getAttribute('position');
    const v = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      const rr = Math.hypot(v.x, v.z);
      const jag = 1 + (vnoise(Math.atan2(v.z, v.x) * 3 + i * 7, v.y * 3, seed + i) - 0.5) * 0.5;
      pos.setXYZ(k, v.x * jag, v.y - (rr / r) * 0.35, v.z * jag);
    }
    c.translate(0, y + h / 2, 0);
    const g = strip(c);
    g.computeVertexNormals();
    const tone = rnd();
    parts.push(
      colorize(
        g,
        (p, n) => {
          const up = smoothstep(-0.5, 0.8, n.y);
          const k = (0.5 + 0.5 * up) * (0.75 + 0.25 * t);
          return [(nA[0] + (nB[0] - nA[0]) * tone) * k, (nA[1] + (nB[1] - nA[1]) * tone) * k, (nA[2] + (nB[2] - nA[2]) * tone) * k];
        },
        (p) => 0.2 + (p.y / H) * 0.8,
      ),
    );
  }
  return mergeGeometries(parts)!;
}

function birch(seed: number, lo = false): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const H = 5 + rnd() * 1.5;
  const parts: THREE.BufferGeometry[] = [];
  const barkL = lin('#cfc8b8');
  const barkD = lin('#3a3530');
  parts.push(colorize(trunk(H + 2, 0.18, 0.09), (p) => (vnoise(p.y * 4, Math.atan2(p.z, p.x) * 2, seed) > 0.72 ? barkD : barkL), (p) => p.y / (H + 4) * 0.5));
  const canopy = new THREE.Vector3(0, H + 2, 0);
  const lA = lin('#62862f');
  const lB = lin('#829a36');
  for (let i = 0; i < 5; i++) {
    const a = rnd() * Math.PI * 2;
    const g = blob(1.0 + rnd() * 0.5, Math.cos(a) * 0.6, H + 0.4 + i * 0.8, Math.sin(a) * 0.6, seed * 7 + i, canopy, lo ? 0 : 1);
    const tone = rnd();
    parts.push(
      colorize(
        g,
        (p, n) => {
          const up = smoothstep(-0.6, 0.9, n.y);
          const k = 0.5 + 0.5 * up;
          return [(lA[0] + (lB[0] - lA[0]) * tone) * k, (lA[1] + (lB[1] - lA[1]) * tone) * k, (lA[2] + (lB[2] - lA[2]) * tone) * k * 0.9];
        },
        (p) => 0.4 + Math.min(1, p.y / (H + 4)) * 0.6,
      ),
    );
  }
  return mergeGeometries(parts)!;
}

// ------------------------------------------------------------------ materials

/** Wind patch for instanced meshes with an `aSway` attribute (0 rooted .. 1 free). */
function windVertex(stiffness: string): (shader: THREE.WebGLProgramParametersWithUniforms) => void {
  return (shader) => {
    Object.assign(shader.uniforms, globalUniforms);
    shader.vertexShader = after(shader.vertexShader, '#include <common>', `attribute float aSway;\n${WIND_GLSL}`);
    shader.vertexShader = after(
      shader.vertexShader,
      '#include <begin_vertex>',
      /* glsl */ `
#ifdef USE_INSTANCING
  vec3 obBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 obOff = ob_wind(obBase + transformed * 0.15, aSway, ${stiffness});
  mat3 obM = mat3(instanceMatrix);
  float obS2 = dot(obM[0], obM[0]);
  transformed += transpose(obM) * obOff / obS2;
#endif
`,
    );
  };
}

export class Foliage {
  readonly group = new THREE.Group();
  readonly trees: THREE.InstancedMesh[] = [];
  readonly grass: THREE.InstancedMesh;
  private treeMat: THREE.MeshStandardMaterial;
  readonly treeDepth: THREE.MeshDepthMaterial;
  private grassMat: THREE.MeshStandardMaterial;
  /** Per species: number of core (field forest) trees; the rest are outskirts, shown by density. */
  private core: number[] = [];
  private maxGrass: number;
  private readonly engine: Engine;

  constructor(engine: Engine, hf: Heightfield) {
    this.engine = engine;
    this.group.name = 'foliage';
    this.treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    engine.patch(this.treeMat, 'ob-tree', windVertex('3.5'));
    this.treeDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    const dh = windVertex('3.5');
    this.treeDepth.onBeforeCompile = (s) => dh(s);
    this.treeDepth.customProgramCacheKey = () => 'ob-tree-depth';

    this.buildTrees(hf);

    // grass
    this.grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    engine.patch(this.grassMat, 'ob-grass', (shader) => {
      Object.assign(shader.uniforms, globalUniforms, overlayUniforms);
      let v = shader.vertexShader;
      v = after(v, '#include <common>', `attribute float aSway;\nvarying vec3 vObW;\n${WIND_GLSL}`);
      v = after(
        v,
        '#include <begin_vertex>',
        /* glsl */ `
#ifdef USE_INSTANCING
  vec3 obBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float obCd = distance(cameraPosition, obBase);
  transformed.y *= smoothstep(150.0, 85.0, obCd);
  vec3 obOff = ob_wind(obBase, aSway, 1.0) * 1.6;
  mat3 obM = mat3(instanceMatrix);
  float obS2 = dot(obM[0], obM[0]);
  transformed += transpose(obM) * obOff / obS2;
  vObW = obBase;
#endif
`,
      );
      shader.vertexShader = v;
      let f = shader.fragmentShader;
      f = after(f, '#include <common>', `varying vec3 vObW;\n${OVERLAY_GLSL}`);
      // shade like the ground: normal straight up, never flipped on back faces
      f = after(f, '#include <normal_fragment_begin>', 'normal = normalize(vNormal);');
      f = after(f, '#include <emissivemap_fragment>', 'totalEmissiveRadiance += ob_zones(vObW.xz) * 0.8;');
      shader.fragmentShader = f;
    });
    void replace;
    const clump = grassClump();
    this.maxGrass = 64000;
    this.grass = new THREE.InstancedMesh(clump, this.grassMat, this.maxGrass);
    this.grass.name = 'grass';
    this.grass.castShadow = false;
    this.grass.receiveShadow = true;
    this.grass.frustumCulled = false;
    this.placeGrass(hf);
    this.group.add(this.grass);
    this.setDensity(1, 1);
  }

  private buildTrees(hf: Heightfield): void {
    const L = hf.layout;
    const rnd = mulberry32(L.seed * 31 + 7);
    // species variants: 3 geometries per species merged as separate instanced meshes
    const hi: THREE.BufferGeometry[] = [broadleaf(11), broadleaf(23), conifer(31), conifer(47), birch(53)];
    const lo: THREE.BufferGeometry[] = [broadleaf(11, true), broadleaf(23, true), conifer(31, true), conifer(47, true), birch(53, true)];
    // index = species (core/near: hi detail) and species + 5 (far outskirts: lo detail)
    const species = [...hi, ...lo];
    const coreSets: THREE.Matrix4[][] = species.map(() => []);
    const outSets: THREE.Matrix4[][] = species.map(() => []);
    const colorsCore: THREE.Color[][] = species.map(() => []);
    const colorsOut: THREE.Color[][] = species.map(() => []);
    const placed: number[] = [];
    const tooClose = (x: number, z: number, d: number) => {
      for (let i = 0; i < placed.length; i += 2) {
        const dx = placed[i] - x;
        const dz = placed[i + 1] - z;
        if (dx * dx + dz * dz < d * d) return true;
      }
      return false;
    };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const add = (x: number, z: number, core: boolean, pick: number) => {
      const y = hf.ground(x, z) - 0.15;
      const sc = (core ? 0.58 : 0.8) + rnd() * (core ? 0.27 : 0.45);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (rnd() - 0.5) * 0.08);
      q.multiply(tilt);
      s.setScalar(sc);
      p.set(x, y, z);
      m.compose(p, q, s);
      const c = new THREE.Color().setScalar(0.85 + rnd() * 0.3);
      c.r *= 0.95 + rnd() * 0.12;
      const far = !core && L.outDist(x, z) > 26;
      const slot = pick + (far ? 5 : 0);
      (core ? coreSets : outSets)[slot].push(m.clone());
      (core ? colorsCore : colorsOut)[slot].push(c);
      placed.push(x, z);
    };
    const pickSpecies = (x: number, z: number) => {
      const n = vnoise(x * 0.04, z * 0.04, L.seed + 91);
      const r = rnd();
      if (n < 0.4) return r < 0.5 ? 2 : 3; // conifer stands
      if (n > 0.72) return r < 0.25 ? 4 : r < 0.6 ? 0 : 1;
      return r < 0.48 ? 0 : r < 0.96 ? 1 : 4;
    };
    // field forests: dense, mirrored placement (each forest uses its pair seed)
    for (const f of L.features) {
      if (f.kind !== 'forest') continue;
      const fr = mulberry32(f.pairSeed);
      const ext = f.shape.circle ? f.shape.circle.r : Math.max(f.shape.rect.x1 - f.shape.rect.x0, f.shape.rect.z1 - f.shape.rect.z0) / 2;
      const tries = Math.round(ext * ext * 1.4);
      for (let i = 0; i < tries; i++) {
        let dx = (fr() * 2 - 1) * (ext + 1);
        let dz = (fr() * 2 - 1) * (ext + 1);
        const spec = fr();
        if (f.mirrored) (dx = -dx), (dz = -dz);
        const x = f.cx + dx;
        const z = f.cz + dz;
        if (sdShape(f.shape, x, z) > 0.5) continue;
        if (tooClose(x, z, 4.3)) continue;
        if (hf.isWater(x, z)) continue;
        add(x, z, true, spec < 0.45 ? (spec < 0.22 ? 0 : 1) : spec < 0.92 ? (spec < 0.68 ? 2 : 3) : 4);
      }
    }
    // outskirts woodland
    for (let i = 0; i < 26000; i++) {
      const x = WORLD.x0 + rnd() * (WORLD.x1 - WORLD.x0);
      const z = WORLD.z0 + rnd() * (WORLD.z1 - WORLD.z0);
      const fo = L.outskirtsForest(x, z);
      if (fo < 0.05 || rnd() > fo) continue;
      if (tooClose(x, z, 3.4 - fo * 0.9)) continue;
      if (hf.isWater(x, z) || L.riverSd(x, z) < 4) continue;
      add(x, z, false, pickSpecies(x, z));
    }
    // lone trees dotting the open field edges
    for (let i = 0; i < 60; i++) {
      const x = FIELD.x0 - 2 + rnd() * (FIELD.x1 - FIELD.x0 + 4);
      const z = FIELD.z0 + rnd() * (FIELD.z1 - FIELD.z0);
      if (Math.abs(x) < 33 || L.riverSd(x, z) < 4 || L.pathDist(x, z) < 3 || L.keepDist(x, z) < 26 || tooClose(x, z, 6)) continue;
      add(x, z, false, pickSpecies(x, z));
    }
    // shuffle the outskirts so a prefix is an even thinning
    for (let k = 0; k < species.length; k++) {
      const arr = outSets[k];
      const cols = colorsOut[k];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
        [cols[i], cols[j]] = [cols[j], cols[i]];
      }
      const all = coreSets[k].concat(arr);
      const allC = colorsCore[k].concat(cols);
      const mesh = new THREE.InstancedMesh(species[k], this.treeMat, Math.max(1, all.length));
      all.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      allC.forEach((c, i) => mesh.setColorAt(i, c));
      mesh.count = all.length;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = this.treeDepth;
      mesh.name = `trees-${k}`;
      mesh.computeBoundingSphere();
      this.trees.push(mesh);
      this.core.push(coreSets[k].length);
      this.group.add(mesh);
    }
  }

  private grassTotal = 0;
  private placeGrass(hf: Heightfield): void {
    const L = hf.layout;
    const rnd = mulberry32(L.seed * 17 + 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    const gA = new THREE.Color('#4d6e2a');
    const gB = new THREE.Color('#7f9a3c');
    const dry = new THREE.Color('#a29b56');
    let n = 0;
    const x0 = FIELD.x0 - 18;
    const x1 = FIELD.x1 + 18;
    const z0 = FIELD.z0 - 16;
    const z1 = FIELD.z1 + 16;
    for (let tries = 0; tries < this.maxGrass * 4 && n < this.maxGrass; tries++) {
      const x = x0 + rnd() * (x1 - x0);
      const z = z0 + rnd() * (z1 - z0);
      const [dirt, rock, mud, forest] = hf.splatAt(x, z);
      const bare = Math.max(dirt * 1.3, rock * 1.6, mud * 1.5);
      if (rnd() < bare) continue;
      if (hf.isWater(x, z) || hf.deckAt(x, z, -0.5) > -Infinity) continue;
      if (L.keepDist(x, z) < 15) continue;
      // patchy: denser in meadows
      const meadow = vnoise(x * 0.09, z * 0.09, L.seed + 77);
      if (rnd() > 0.35 + meadow * 0.9) continue;
      const nrm = hf.normalAt(x, z);
      p.set(x, hf.ground(x, z) - 0.03, z);
      q.setFromUnitVectors(up, nrm.lerp(up, 0.5).normalize());
      q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rnd() * Math.PI * 2));
      const h = (0.28 + rnd() * 0.3) * (0.7 + meadow * 0.6) * (1 - forest * 0.35);
      const w = 0.9 + rnd() * 0.5;
      s.set(w, h, w);
      m.compose(p, q, s);
      this.grass.setMatrixAt(n, m);
      const tone = vnoise(x * 0.018 + 3, z * 0.018, 0) * 0.5 + vnoise(x * 0.11, z * 0.11, L.seed + 5) * 0.5;
      c.copy(gA).lerp(gB, smoothstep(0.3, 0.75, tone));
      c.lerp(dry, smoothstep(0.62, 0.8, vnoise(x * 0.05, z * 0.05, L.seed + 6)) * 0.4);
      if (forest > 0.3) c.multiplyScalar(0.7);
      c.multiplyScalar(0.92 + rnd() * 0.16);
      this.grass.setColorAt(n, c);
      n++;
    }
    this.grassTotal = n;
    this.grass.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
  }

  /** Grass density ~0..1.6 (1 = 40k clumps), tree density 0..1 thins the outskirts. */
  setDensity(grass: number, trees: number): void {
    this.grass.count = Math.min(this.grassTotal, Math.round(40000 * grass));
    this.grass.visible = this.grass.count > 0;
    this.trees.forEach((t, i) => {
      const core = this.core[i];
      const total = t.instanceMatrix.count;
      t.count = core + Math.round((total - core) * trees);
    });
    this.engine.wake();
  }

  dispose(): void {
    for (const t of this.trees) t.geometry.dispose();
    this.grass.geometry.dispose();
    this.treeMat.dispose();
    this.treeDepth.dispose();
    this.grassMat.dispose();
  }
}

/** One clump: 9 bent, tapered blades with root-dark → tip-light vertex colours. */
function grassClump(): THREE.BufferGeometry {
  const rnd = mulberry32(99);
  const pos: number[] = [];
  const col: number[] = [];
  const sway: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const blades = 9;
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 0.22;
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    const yaw = rnd() * Math.PI * 2;
    const w = 0.035 + rnd() * 0.03;
    const h = 0.6 + rnd() * 0.45;
    const bend = 0.12 + rnd() * 0.22;
    const lean = Math.atan2(bz, bx);
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    const base = pos.length / 3;
    const rows = [0, 0.45, 0.8, 1];
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      const ww = w * (1 - t * 0.85);
      const off = bend * t * t;
      const cx = bx + Math.cos(lean) * off;
      const cz = bz + Math.sin(lean) * off;
      const y = h * t;
      if (i < rows.length - 1) {
        pos.push(cx - dx * ww, y, cz - dz * ww, cx + dx * ww, y, cz + dz * ww);
        for (let k = 0; k < 2; k++) {
          const g = 0.42 + 0.68 * t;
          col.push(g * 0.95, g, g * 0.85);
          sway.push(t);
          nor.push(0, 1, 0);
        }
      } else {
        pos.push(cx, y, cz);
        const g = 1.15;
        col.push(g, g * 1.02, g * 0.82);
        sway.push(1);
        nor.push(0, 1, 0);
      }
    }
    // rows 0..2 have 2 verts, tip 1
    const v = (row: number, side: number) => base + row * 2 + side;
    idx.push(v(0, 0), v(0, 1), v(1, 0), v(0, 1), v(1, 1), v(1, 0));
    idx.push(v(1, 0), v(1, 1), v(2, 0), v(1, 1), v(2, 1), v(2, 0));
    idx.push(v(2, 0), v(2, 1), base + 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  return g;
}
