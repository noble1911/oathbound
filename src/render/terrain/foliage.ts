// Vegetation: instanced trees (oak x2, pine, fir, birch), bushes at forest edges, reeds on the river
// banks and grass clumps. Trees are procedural branch geometry + alpha-tested leaf-cluster cards
// (trees.ts, atlas in env-textures.ts), one InstancedMesh per species per LOD:
//   trees[0..4]  near set (field forests, then the outskirts within ~26 m of the field): LOD0 on
//                high / ultra, LOD1 on low / medium
//   trees[5..9]  far outskirts: camera-facing impostors
// One shared material: wind sway + leaf flutter in the vertex shader (shared uTime: it only advances
// while frames are drawn, so idle = no motion and no rendering), normals bent away from the crown
// centre and never flipped on back faces (a crown shades as one soft volume), a backlight /
// translucency term on the leaves, and alpha coverage kept up at distance. In planning, trees
// standing in a visible deploy zone shrink to saplings (uPlan, same patch in the depth material), so
// units and the grid read without any transparency or dithering.
// Grass only receives shadows, is normal-up shaded so it melts into the ground, shrinks away with
// distance and picks up the planning overlay glow.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { WIND_GLSL, after, replace } from '../core/glsl.ts';
import type { Heightfield } from './heightfield.ts';
import { FIELD, WORLD, sdShape } from './layout.ts';
import { mulberry32, vnoise, smoothstep } from './noise.ts';
import { OVERLAY_GLSL, overlayUniforms } from './overlay.ts';
import { vegAtlas, forgetAtlasWaiter } from './env-textures.ts';
import { treeGeometry, treeImpostor, bushGeometry, reedsGeometry, TREE_SPECIES } from './trees.ts';

// ------------------------------------------------------------------ materials

type Hook = (shader: THREE.WebGLProgramParametersWithUniforms) => void;

const VEG_VERT_PARS = /* glsl */ `
attribute float aSway;
attribute float aLeaf;
varying float vLeaf;
uniform vec3 uPlan;
uniform vec4 uZone0;
uniform vec4 uZone1;
${WIND_GLSL}
float ob_inZone(vec3 p, vec4 r) {
  return step(r.x - 2.5, p.x) * step(p.x, r.y + 2.5) * step(r.z - 2.5, p.z) * step(p.z, r.w + 2.5);
}
`;

/** Near vegetation vertex patch: planning shrink, wind sway, leaf flutter. */
function vegVertex(stiffness: number, shrink: boolean): Hook {
  return (shader) => {
    Object.assign(shader.uniforms, globalUniforms, { uPlan: overlayUniforms.uPlan, uZone0: overlayUniforms.uZone0, uZone1: overlayUniforms.uZone1 });
    shader.vertexShader = after(shader.vertexShader, '#include <common>', VEG_VERT_PARS);
    shader.vertexShader = after(
      shader.vertexShader,
      '#include <begin_vertex>',
      /* glsl */ `
vLeaf = aLeaf;
#ifdef USE_INSTANCING
  vec3 obBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  ${shrink ? 'transformed *= mix(1.0, 0.24, max(ob_inZone(obBase, uZone0) * uPlan.x, ob_inZone(obBase, uZone1) * uPlan.y));' : ''}
  vec3 obOff = ob_wind(obBase + transformed * 0.15, aSway, ${stiffness.toFixed(2)});
  // leaf flutter: each cluster card twitches on its own phase
  float obPh = dot(obBase.xz, vec2(1.3, 1.7)) + dot(transformed, vec3(2.1, 1.3, 1.7));
  obOff += normal * sin(uTime * 2.7 + obPh) * 0.045 * aLeaf * uWindStrength;
  mat3 obM = mat3(instanceMatrix);
  float obS2 = dot(obM[0], obM[0]);
  transformed += transpose(obM) * obOff / obS2;
#endif
`,
    );
  };
}

/** Far impostor vertex patch: expand each quad towards the camera (aCorner, see trees.ts). */
const impostorVertex: Hook = (shader) => {
  Object.assign(shader.uniforms, globalUniforms);
  shader.vertexShader = after(shader.vertexShader, '#include <common>', `attribute float aSway;\nattribute float aLeaf;\nattribute vec3 aCorner;\nvarying float vLeaf;\n${WIND_GLSL}`);
  // the "normal" attribute holds the corner's hemisphere coordinates: a rounded view-space normal
  shader.vertexShader = after(shader.vertexShader, '#include <defaultnormal_vertex>', 'transformedNormal = normalize(vec3(normal.x, normal.y + 0.35, 0.8));');
  shader.vertexShader = after(
    shader.vertexShader,
    '#include <begin_vertex>',
    /* glsl */ `
vLeaf = aLeaf;
#ifdef USE_INSTANCING
  mat3 obM = mat3(instanceMatrix);
  float obS2 = dot(obM[0], obM[0]);
  float obS = sqrt(obS2);
  vec3 obR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 obU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // upright quads turn about the vertical axis and lean part of the way towards the camera
  vec3 obUp = normalize(mix(obU, normalize(vec3(0.0, 1.0, 0.0) + obU * 0.55), aCorner.z));
  vec3 obBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 obOff = (obR * aCorner.x + obUp * aCorner.y) * obS + ob_wind(obBase, aSway, 3.5);
  transformed += transpose(obM) * obOff / obS2;
#endif
`,
  );
};

/** Shared fragment patch: unflipped bent normals, alpha coverage at distance, leaf translucency. */
const vegFragment: Hook = (shader) => {
  let f = shader.fragmentShader;
  f = after(f, '#include <common>', 'varying float vLeaf;');
  // mips average the alpha down: boost it with the mip level so far crowns keep their coverage
  f = after(
    f,
    '#include <map_fragment>',
    /* glsl */ `
{
  vec2 obTx = vMapUv * 1024.0;
  float obLod = max(0.0, 0.5 * log2(max(dot(dFdx(obTx), dFdx(obTx)), dot(dFdy(obTx), dFdy(obTx)))));
  diffuseColor.a *= 1.0 + obLod * 0.4;
}`,
  );
  f = after(f, '#include <normal_fragment_begin>', 'normal = normalize(vNormal);');
  f = replace(f, '#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.92, roughness, vLeaf);');
  f = after(
    f,
    '#include <lights_fragment_end>',
    /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  // translucency: leaves facing away from the sun still pass some of its light (warmer, greener),
  // strongest when looking towards the sun through the crown
  vec3 obL = directionalLights[0].direction;
  float obWrap = clamp(0.55 - 0.45 * dot(normal, obL), 0.0, 1.0);
  float obBack = pow(clamp(dot(normalize(vViewPosition), -obL), 0.0, 1.0), 3.0);
  reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * vec3(1.1, 1.2, 0.55) * RECIPROCAL_PI * (0.16 * obWrap + 0.45 * obBack * obWrap) * vLeaf;
}
#endif
`,
  );
  shader.fragmentShader = f;
};

export class Foliage {
  readonly group = new THREE.Group();
  readonly trees: THREE.InstancedMesh[] = [];
  readonly grass: THREE.InstancedMesh;
  /** Bushes and reeds (count thinned by the tier's tree density; hidden on low). */
  readonly plants: { mesh: THREE.InstancedMesh; total: number }[] = [];
  private treeMat: THREE.MeshStandardMaterial;
  private farMat: THREE.MeshStandardMaterial;
  private plantMat: THREE.MeshStandardMaterial;
  readonly treeDepth: THREE.MeshDepthMaterial;
  private grassMat: THREE.MeshStandardMaterial;
  /** Per species: number of core (field forest) trees; the rest are outskirts, shown by density. */
  private core: number[] = [];
  /** Near geometries per species: [LOD0, LOD1]. */
  private lods: [THREE.BufferGeometry, THREE.BufferGeometry][] = [];
  private maxGrass: number;
  private readonly engine: Engine;
  private onAtlas = () => this.engine.wake();

  constructor(engine: Engine, hf: Heightfield) {
    this.engine = engine;
    this.group.name = 'foliage';
    const atlas = vegAtlas(this.onAtlas);
    const mk = (key: string, vert: Hook): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, roughness: 0.62, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
      m.envMapIntensity = 1.15;
      engine.patch(m, key, (shader) => {
        vert(shader);
        vegFragment(shader);
      });
      return m;
    };
    this.treeMat = mk('ob-veg-tree', vegVertex(3.5, true));
    this.plantMat = mk('ob-veg-plant', vegVertex(1.6, false));
    this.farMat = mk('ob-veg-far', impostorVertex);
    this.treeDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.5, side: THREE.DoubleSide });
    const dh = vegVertex(3.5, true);
    this.treeDepth.onBeforeCompile = (s) => dh(s);
    this.treeDepth.customProgramCacheKey = () => 'ob-veg-depth';

    this.buildTrees(hf);
    this.buildPlants(hf);

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
    // index = species (near set: branch + leaf-card geometry) and species + 5 (far outskirts: impostors)
    const ids = Array.from({ length: TREE_SPECIES }, (_, k) => k);
    this.lods = ids.map((k) => [treeGeometry(k, 0), treeGeometry(k, 1)]);
    const species = [...this.lods.map((l) => l[0]), ...ids.map((k) => treeImpostor(k))];
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
      // per-tree tone: brightness, plus a drift towards yellow-green or deep green
      const c = new THREE.Color().setScalar(0.82 + rnd() * 0.3);
      const hue = rnd();
      c.r *= 0.9 + hue * 0.24;
      c.b *= 1.08 - hue * 0.26;
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
      const mesh = new THREE.InstancedMesh(species[k], k < TREE_SPECIES ? this.treeMat : this.farMat, Math.max(1, all.length));
      all.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      allC.forEach((c, i) => mesh.setColorAt(i, c));
      mesh.count = all.length;
      mesh.castShadow = k < TREE_SPECIES;
      mesh.receiveShadow = true;
      if (k < TREE_SPECIES) mesh.customDepthMaterial = this.treeDepth;
      mesh.name = `trees-${k}`;
      mesh.computeBoundingSphere();
      this.trees.push(mesh);
      this.core.push(coreSets[k].length);
      this.group.add(mesh);
    }
  }

  /** Bushes at forest edges and reeds along the river banks (deterministic from the layout seed). */
  private buildPlants(hf: Heightfield): void {
    const L = hf.layout;
    const scatter = (name: string, geo: THREE.BufferGeometry, tries: number, s0: number, s1: number, river: boolean, ok: (x: number, z: number) => boolean) => {
      const rnd = mulberry32(L.seed * 13 + (river ? 7 : 3) + name.length);
      const list: THREE.Matrix4[] = [];
      const cols: THREE.Color[] = [];
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const n = river ? tries : tries * 8;
      for (let i = 0; i < n && list.length < tries; i++) {
        const x = WORLD.x0 + rnd() * (WORLD.x1 - WORLD.x0);
        const z = river ? (rnd() - 0.5) * 22 : WORLD.z0 + rnd() * (WORLD.z1 - WORLD.z0);
        if (!ok(x, z)) continue;
        if (!river && hf.isWater(x, z)) continue;
        const sc = s0 + rnd() * (s1 - s0);
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        list.push(new THREE.Matrix4().compose(new THREE.Vector3(x, hf.ground(x, z) - 0.05, z), q, new THREE.Vector3(sc, sc * (0.8 + rnd() * 0.4), sc)));
        const c = new THREE.Color().setScalar(0.8 + rnd() * 0.3);
        c.r *= 0.92 + rnd() * 0.2;
        cols.push(c);
      }
      if (!list.length) {
        geo.dispose();
        return;
      }
      const mesh = new THREE.InstancedMesh(geo, this.plantMat, list.length);
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      cols.forEach((c, i) => mesh.setColorAt(i, c));
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.plants.push({ mesh, total: list.length });
      this.group.add(mesh);
    };
    scatter('bush', bushGeometry(), 900, 1.0, 2.2, false, (x, z) => {
      const f = L.forestAt(x, z);
      return f > 0.08 && f < 0.7 && L.riverSd(x, z) > 3 && L.pathDist(x, z) > 2.5 && L.keepDist(x, z) > 26;
    });
    scatter('reeds', reedsGeometry(), 520, 0.8, 1.5, true, (x, z) => {
      const sd = L.riverSd(x, z);
      return sd > -0.4 && sd < 1.6 && hf.deckAt(x, z, 1.5) === -Infinity && !L.crossings.some((c) => x > c.x0 - 2 && x < c.x1 + 2);
    });
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
    const gA = new THREE.Color('#44622a');
    const gB = new THREE.Color('#6d8a38');
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

  /** Grass density ~0..1.6 (1 = 40k clumps), tree density 0..1 thins the outskirts; `cheap` = LOD1 near trees, no plants on low. */
  setDensity(grass: number, trees: number, tier = 'high'): void {
    const cheap = tier === 'low' || tier === 'medium';
    this.lods.forEach((l, k) => (this.trees[k].geometry = l[cheap ? 1 : 0]));
    for (const p of this.plants) {
      p.mesh.count = tier === 'low' ? 0 : Math.round(p.total * Math.max(0.15, trees));
      p.mesh.visible = p.mesh.count > 0;
    }
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
    forgetAtlasWaiter(this.onAtlas);
    for (const l of this.lods) for (const g of l) g.dispose();
    for (const t of this.trees.slice(TREE_SPECIES)) t.geometry.dispose();
    for (const p of this.plants) p.mesh.geometry.dispose();
    this.grass.geometry.dispose();
    this.treeMat.dispose();
    this.farMat.dispose();
    this.plantMat.dispose();
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
