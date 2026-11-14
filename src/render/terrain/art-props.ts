// Art-pipeline props (manifest `props`) replacing the procedural trees, rocks, ruins, bridges and
// arrow towers, plus bushes and reeds. Everything is instanced (one InstancedMesh per prop per LOD)
// and placed deterministically from the terrain layout:
//   * trees keep the procedural placement (same matrices): field forests use LOD0, outskirts LOD1;
//   * rocks keep their placement; small rocks use LOD1;
//   * ruins: per ruins feature a seeded arrangement of arch / wall / column pieces (mirrored pairs match);
//   * bridges: one bridge per deck, fitted non-uniformly to the crossing and to the deck height curve;
//   * bushes at forest edges, reeds along the river banks (density follows the tier's treeDensity).
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { WIND_GLSL, after } from '../core/glsl.ts';
import type { PropAsset, PropMesh } from '../crowd/assets.ts';
import type { Heightfield, Deck } from './heightfield.ts';
import { deckCurve } from './heightfield.ts';
import { WORLD, FIELD, type Feature } from './layout.ts';
import { mulberry32 } from './noise.ts';
import { overlayUniforms } from './overlay.ts';
import { NOISE_GLSL } from '../core/glsl.ts';

/**
 * Wind sway for instanced art props (sway weight from height in the attribute `aSway`). With
 * `canopyFade`, canopy fragments (more than ~2 m above the trunk base) over a planning zone's half
 * of the field are dithered away (uPlan.x = seat 0's half z > 0, uPlan.y = seat 1's half z < 0), so
 * the deploy area and units read through the forest; trunks stay.
 */
function windHook(stiffness: number, canopyFade = false): (shader: THREE.WebGLProgramParametersWithUniforms) => void {
  return (shader) => {
    Object.assign(shader.uniforms, globalUniforms);
    if (canopyFade) {
      shader.uniforms.uPlan = overlayUniforms.uPlan;
      shader.vertexShader = after(shader.vertexShader, '#include <common>', 'varying vec3 vObCan;');
      shader.vertexShader = after(shader.vertexShader, '#include <project_vertex>', `
#ifdef USE_INSTANCING
  vec4 obWp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  vObCan = vec3(obWp.x, obWp.y - (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).y, obWp.z);
#endif`);
      shader.fragmentShader = after(shader.fragmentShader, '#include <common>', `uniform vec3 uPlan;\nvarying vec3 vObCan;\n${NOISE_GLSL}`);
      shader.fragmentShader = after(shader.fragmentShader, 'void main() {', `
  {
    float side = vObCan.z > 0.0 ? uPlan.x : uPlan.y;
    float fade = side * smoothstep(1.4, 2.6, vObCan.y) * 0.8;
    if (fade > 0.001 && ob_hash12(floor(gl_FragCoord.xy)) < fade) discard;
  }`);
    }
    shader.vertexShader = after(shader.vertexShader, '#include <common>', `attribute float aSway;\n${WIND_GLSL}`);
    shader.vertexShader = after(
      shader.vertexShader,
      '#include <begin_vertex>',
      /* glsl */ `
#ifdef USE_INSTANCING
  vec3 obBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 obOff = ob_wind(obBase + transformed * 0.15, aSway, ${stiffness.toFixed(2)});
  mat3 obM = mat3(instanceMatrix);
  float obS2 = dot(obM[0], obM[0]);
  transformed += transpose(obM) * obOff / obS2;
#endif`,
    );
  };
}

/** Team-tinted prop material: albedo *= mix(1, team, tintMask.r at UV0). */
export function tintedPropMaterial(engine: Engine, src: THREE.MeshStandardMaterial, tintMap: THREE.Texture | null, team: THREE.Color): THREE.MeshStandardMaterial {
  const m = src.clone();
  if (!tintMap) {
    engine.prepare(new THREE.Mesh(undefined, m));
    return m;
  }
  const u = { uTint: { value: tintMap }, uTeam: { value: team.clone() } };
  engine.patch(m, 'art-tint', (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = after(shader.vertexShader, '#include <common>', 'varying vec2 vTintUv;');
    shader.vertexShader = after(shader.vertexShader, '#include <begin_vertex>', 'vTintUv = uv;');
    shader.fragmentShader = after(shader.fragmentShader, '#include <common>', 'uniform sampler2D uTint;\nuniform vec3 uTeam;\nvarying vec2 vTintUv;');
    shader.fragmentShader = after(shader.fragmentShader, '#include <color_fragment>', 'diffuseColor.rgb *= mix(vec3(1.0), uTeam, texture2D(uTint, vTintUv).r);');
  });
  return m;
}

function propMat(engine: Engine, src: THREE.MeshStandardMaterial, wind: number | null, cache: Map<THREE.Material, THREE.MeshStandardMaterial>, canopyFade = false): THREE.MeshStandardMaterial {
  let m = cache.get(src);
  if (m) return m;
  m = src.clone();
  // stone / wood / leaves are never metal; some prop MR maps read as metal (black rocks): cap it
  m.metalness = Math.min(m.metalness, 0.1);
  m.envMapIntensity = 1;
  if (wind !== null) engine.patch(m, `art-wind-${wind}${canopyFade ? '-fade' : ''}`, windHook(wind, canopyFade));
  else engine.prepare(new THREE.Mesh(undefined, m));
  cache.set(src, m);
  return m;
}

/** Geometry scaled uniformly to height `h` (base at y = 0) with an `aSway` weight. */
function fitted(pm: PropMesh, h: number | null, sway: boolean): THREE.BufferGeometry {
  const g = pm.geometry.clone();
  const b = pm.box;
  const k = h ? h / Math.max(0.01, b.max.y - b.min.y) : 1;
  g.translate(0, -b.min.y, 0);
  if (k !== 1) g.scale(k, k, k);
  if (sway) {
    const pos = g.getAttribute('position');
    const top = (b.max.y - b.min.y) * k;
    const sw = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) sw[i] = Math.min(1, Math.max(0, pos.getY(i) / top)) ** 1.5;
    g.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  }
  g.computeBoundingSphere();
  return g;
}

export interface ArtPropTargets {
  engine: Engine;
  hf: Heightfield;
  /** Procedural tree meshes: [0..4] field (hi), [5..9] outskirts (lo); species oak, oak_b, pine, fir, birch. */
  trees: THREE.InstancedMesh[];
  /** Procedural props group (rocks-0/1, ruin, bridge meshes). */
  props: THREE.Group;
  treeDepth: THREE.Material;
}

export class ArtProps {
  readonly group = new THREE.Group();
  private geos: THREE.BufferGeometry[] = [];
  /** Bush / reed meshes with their full instance counts (thinned by density). */
  private thinned: { mesh: THREE.InstancedMesh; total: number }[] = [];
  /** Field-forest trees: both LODs (low/medium tiers draw LOD1 up close too). */
  private treeLods: { mesh: THREE.InstancedMesh; lod0: THREE.BufferGeometry; lod1: THREE.BufferGeometry }[] = [];
  private treeVariants: { mesh: THREE.InstancedMesh; plain: THREE.Material; fade: THREE.Material }[] = [];

  /** Swap trees to the canopy-fade material (planning) or back to the plain one (battle: no discard). */
  setCanopyFade(on: boolean): void {
    for (const v of this.treeVariants) v.mesh.material = on ? v.fade : v.plain;
  }
  private rocks: { mesh: THREE.InstancedMesh; total: number }[] = [];
  private readonly t: ArtPropTargets;

  constructor(t: ArtPropTargets, art: Map<string, PropAsset>) {
    this.t = t;
    this.group.name = 'art-props';
    const mats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const species = ['tree_oak', 'tree_oak_b', 'tree_pine', 'tree_fir', 'tree_birch'];
    const treeMats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    // --- trees: swap geometry + material, keep matrices / colours / counts
    t.trees.forEach((mesh, k) => {
      const a = art.get(species[k % 5]);
      if (!a) return;
      const pm = k < 5 ? a.lod0 : (a.lod1 ?? a.lod0);
      mesh.geometry.computeBoundingBox();
      const pb = mesh.geometry.boundingBox!;
      const h = pb.max.y - Math.min(0, pb.min.y);
      const g = fitted(pm, h, true);
      this.geos.push(g);
      mesh.geometry = g;
      if (k < 5 && a.lod1) {
        const g1 = fitted(a.lod1, h, true);
        this.geos.push(g1);
        this.treeLods.push({ mesh, lod0: g, lod1: g1 });
      }
      // two variants: plain (early-z friendly) and the planning canopy fade (has a discard)
      const plain = propMat(t.engine, pm.material, 3.5, mats);
      const fade = propMat(t.engine, pm.material, 3.5, treeMats, true);
      mesh.material = plain;
      this.treeVariants.push({ mesh, plain, fade });
      mesh.customDepthMaterial = t.treeDepth;
    });
    // --- rocks: keep placement; small variant -> LOD1, large -> LOD0 (unit-size fit)
    const rocks = art.get('rocks');
    if (rocks) {
      t.props.children.forEach((o) => {
        const m = o as THREE.InstancedMesh;
        if (!m.isInstancedMesh || !/^rocks-/.test(m.name)) return;
        const pm = rocks.lod1 ?? rocks.lod0;
        const g = fitted(pm, 1.1, false);
        g.translate(0, -0.15, 0);
        this.geos.push(g);
        m.geometry = g;
        m.material = propMat(t.engine, pm.material, null, mats);
        // biggest first, so tier thinning (a count prefix) drops pebbles before boulders
        const list: { m: THREE.Matrix4; c: THREE.Color; s: number }[] = [];
        for (let i = 0; i < m.count; i++) {
          const mm = new THREE.Matrix4();
          m.getMatrixAt(i, mm);
          const c = new THREE.Color(1, 1, 1);
          if (m.instanceColor) m.getColorAt(i, c);
          list.push({ m: mm, c, s: new THREE.Vector3().setFromMatrixScale(mm).length() });
        }
        list.sort((x, y) => y.s - x.s);
        list.forEach((it, i) => {
          m.setMatrixAt(i, it.m);
          if (m.instanceColor) m.setColorAt(i, it.c);
        });
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        this.rocks.push({ mesh: m, total: m.count });
      });
    }
    // --- ruins and bridges replace the procedural meshes
    const hide = (name: string) => t.props.children.forEach((o) => o.name === name && (o.visible = false));
    if (art.has('ruins_arch') || art.has('ruins_wall') || art.has('ruins_column')) {
      hide('ruin');
      this.placeRuins(art, mats);
    }
    if (art.has('bridge')) {
      hide('bridge');
      this.placeBridges(art.get('bridge')!, mats);
    }
    // --- new: bushes at forest edges, reeds on the river banks
    const bush = art.get('bush');
    if (bush) this.scatter(bush, mats, 900, 0.9 + 0.2, 2.4, (x, z, L) => {
      const f = L.forestAt(x, z);
      return f > 0.08 && f < 0.7 && L.riverSd(x, z) > 3 && L.pathDist(x, z) > 2.5 && L.keepDist(x, z) > 26;
    }, true);
    const reeds = art.get('reeds');
    if (reeds) this.scatter(reeds, mats, 420, 0.7, 1.5, (x, z, L) => {
      const sd = L.riverSd(x, z);
      return sd > -0.4 && sd < 1.6 && t.hf.deckAt(x, z, 1.5) === -Infinity && !L.crossings.some((c) => x > c.x0 - 2 && x < c.x1 + 2);
    }, false, 'river');
    for (const o of this.group.children) {
      const m = o as THREE.Mesh;
      m.castShadow = true;
      m.receiveShadow = true;
    }
    t.props.add(this.group);
  }

  private instanced(pm: PropMesh, h: number | null, sway: number | null, mats: Map<THREE.Material, THREE.MeshStandardMaterial>, list: THREE.Matrix4[], name: string): THREE.InstancedMesh | null {
    if (!list.length) return null;
    const g = fitted(pm, h, sway !== null);
    this.geos.push(g);
    const mesh = new THREE.InstancedMesh(g, propMat(this.t.engine, pm.material, sway, mats), list.length);
    list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.count = list.length;
    mesh.name = name;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  private placeRuins(art: Map<string, PropAsset>, mats: Map<THREE.Material, THREE.MeshStandardMaterial>): void {
    const L = this.t.hf.layout;
    const sets: Record<string, THREE.Matrix4[]> = { ruins_arch: [], ruins_wall: [], ruins_column: [] };
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const f of L.features as Feature[]) {
      if (f.kind !== 'ruins') continue;
      const rnd = mulberry32(f.pairSeed);
      const r = Math.max(3.5, f.shape.circle ? f.shape.circle.r : 4.5);
      const rot = (f.mirrored ? Math.PI : 0) + rnd() * Math.PI * 2;
      const cs = Math.cos(rot);
      const sn = Math.sin(rot);
      // local layout: an arch on the centre line, walls either side, columns on a ring
      const pieces: [string, number, number, number, number][] = [
        ['ruins_arch', 0, -0.15 * r, 0, 1],
        ['ruins_wall', -0.55 * r, 0.1 * r, Math.PI / 2 + (rnd() - 0.5) * 0.4, 0.9 + rnd() * 0.25],
        ['ruins_wall', 0.5 * r, 0.25 * r, -0.2 + (rnd() - 0.5) * 0.4, 0.75 + rnd() * 0.25],
      ];
      const nc = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < nc; i++) {
        const a = (i / nc) * Math.PI * 2 + rnd() * 0.5;
        pieces.push(['ruins_column', Math.cos(a) * r * 0.75, Math.sin(a) * r * 0.75, rnd() * 6.28, 0.6 + rnd() * 0.5]);
      }
      for (const [id, u, v, yaw, sc] of pieces) {
        const x = f.cx + u * cs - v * sn;
        const z = f.cz + u * sn + v * cs;
        if (this.t.hf.isWater(x, z)) continue;
        const y = this.t.hf.ground(x, z) - 0.12;
        q.setFromAxisAngle(up, yaw + rot);
        sets[id].push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sc, sc, sc)));
      }
    }
    for (const [id, list] of Object.entries(sets)) {
      const a = art.get(id);
      if (a) this.instanced(a.lod0, null, null, mats, list, id);
    }
  }

  private placeBridges(a: PropAsset, mats: Map<THREE.Material, THREE.MeshStandardMaterial>): void {
    const pm = a.lod0;
    const b = pm.box;
    // measure the art deck: top surface at the centre and near the ends
    const probe = new THREE.Mesh(pm.geometry);
    const ray = new THREE.Raycaster();
    const top = (z: number) => {
      ray.set(new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + 5, z), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObject(probe);
      return hits.length ? hits[0].point.y : b.max.y;
    };
    const zc = (b.min.z + b.max.z) / 2;
    const half = (b.max.z - b.min.z) / 2;
    const topC = top(zc);
    const topE = (top(zc - half * 0.88) + top(zc + half * 0.88)) / 2;
    const list: THREE.Matrix4[] = [];
    for (const d of this.t.hf.decks as Deck[]) {
      const c = d.c;
      const len = d.z1 - d.z0;
      const wid = c.x1 - c.x0;
      const sx = wid / Math.max(0.1, b.max.x - b.min.x);
      const sz = len / Math.max(0.1, b.max.z - b.min.z);
      const endH = (d.h0 + d.h1) / 2 + 0.08;
      const midH = deckCurve(d, 0.5);
      const sy = topC - topE > 0.2 ? Math.min(2, Math.max(0.5, (midH - endH) / (topC - topE))) : 1;
      const y = endH - sy * topE;
      const m = new THREE.Matrix4().makeScale(sx, sy, sz);
      m.setPosition(c.cx - ((b.min.x + b.max.x) / 2) * sx, y, (d.z0 + d.z1) / 2 - zc * sz);
      list.push(m);
    }
    this.instanced(pm, null, null, mats, list, 'art-bridge');
  }

  private scatter(
    a: PropAsset,
    mats: Map<THREE.Material, THREE.MeshStandardMaterial>,
    tries: number,
    s0: number,
    s1: number,
    ok: (x: number, z: number, L: Heightfield['layout']) => boolean,
    sway: boolean,
    where: 'world' | 'river' = 'world',
  ): void {
    const hf = this.t.hf;
    const L = hf.layout;
    const rnd = mulberry32(L.seed * 13 + (where === 'river' ? 7 : 3) + a.id.length);
    const near: THREE.Matrix4[] = [];
    const far: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const n = where === 'river' ? tries : tries * 8;
    let placed = 0;
    for (let i = 0; i < n && placed < tries; i++) {
      const x = WORLD.x0 + rnd() * (WORLD.x1 - WORLD.x0);
      const z = where === 'river' ? (rnd() - 0.5) * 22 : WORLD.z0 + rnd() * (WORLD.z1 - WORLD.z0);
      if (!ok(x, z, L)) continue;
      if (where !== 'river' && hf.isWater(x, z)) continue;
      const s = s0 + rnd() * (s1 - s0);
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, hf.ground(x, z) - 0.05, z), q, new THREE.Vector3(s, s * (0.8 + rnd() * 0.4), s));
      const inField = x > FIELD.x0 - 6 && x < FIELD.x1 + 6 && z > FIELD.z0 - 6 && z < FIELD.z1 + 6;
      (inField ? near : far).push(m);
      placed++;
    }
    const k = where === 'river' ? 'reeds' : 'bush';
    const m0 = this.instanced(a.lod0, null, sway ? 6 : 2.5, mats, near, `${k}-lod0`);
    const m1 = this.instanced(a.lod1 ?? a.lod0, null, sway ? 6 : 2.5, mats, far, `${k}-lod1`);
    for (const m of [m0, m1]) if (m) this.thinned.push({ mesh: m, total: m.count });
  }

  /** Tier budget: LOD choice for field trees, rock / bush / reed counts. */
  setQuality(q: { tier: string; treeDensity: number }): void {
    const cheap = q.tier === 'low' || q.tier === 'medium';
    for (const t of this.treeLods) t.mesh.geometry = cheap ? t.lod1 : t.lod0;
    const rockK = q.tier === 'low' ? 0.35 : q.tier === 'medium' ? 0.6 : 1;
    for (const r of this.rocks) r.mesh.count = Math.round(r.total * rockK);
    for (const t of this.thinned) t.mesh.count = q.tier === 'low' ? 0 : Math.round(t.total * Math.max(0.15, q.treeDensity));
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
  }
}
