// Art-pipeline props (manifest `props`) replacing the procedural rocks (boulders only), ruins and arrow
// towers; bridges stay procedural (props.ts). Everything is instanced (one InstancedMesh per prop per LOD) and placed deterministically
// from the terrain layout:
//   * rocks keep their placement; small rocks use LOD1;
//   * ruins: per ruins feature a seeded arrangement of arch / wall / column pieces (mirrored pairs match);
// Vegetation (trees, bushes, reeds) is procedural: see foliage.ts / trees.ts.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { after } from '../core/glsl.ts';
import type { Feature } from './layout.ts';
import type { PropAsset, PropMesh } from '../crowd/assets.ts';
import type { Heightfield } from './heightfield.ts';
import { mulberry32 } from './noise.ts';

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

function propMat(engine: Engine, src: THREE.MeshStandardMaterial, cache: Map<THREE.Material, THREE.MeshStandardMaterial>): THREE.MeshStandardMaterial {
  let m = cache.get(src);
  if (m) return m;
  m = src.clone();
  // stone and wood are never metal, but some TRELLIS metallic-roughness maps read as metal (black,
  // mirror-like rocks): drop the metal channel entirely and keep the roughness map
  m.metalness = 0;
  m.metalnessMap = null;
  m.roughness = Math.max(m.roughness, 0.85);
  m.envMapIntensity = 0.8;
  engine.prepare(new THREE.Mesh(undefined, m));
  cache.set(src, m);
  return m;
}

/** Geometry scaled uniformly to height `h` (base at y = 0). */
function fitted(pm: PropMesh, h: number | null): THREE.BufferGeometry {
  const g = pm.geometry.clone();
  const b = pm.box;
  const k = h ? h / Math.max(0.01, b.max.y - b.min.y) : 1;
  g.translate(0, -b.min.y, 0);
  if (k !== 1) g.scale(k, k, k);
  g.computeBoundingSphere();
  return g;
}

export interface ArtPropTargets {
  engine: Engine;
  hf: Heightfield;
  /** Procedural props group (rocks-0/1, ruin, bridge meshes). */
  props: THREE.Group;
}

export class ArtProps {
  readonly group = new THREE.Group();
  private geos: THREE.BufferGeometry[] = [];
  private rocks: { mesh: THREE.InstancedMesh; total: number }[] = [];
  /** Triangle budget for art boulders per rock mesh (the rest stay procedural). */
  static readonly ART_ROCK_TRIS = 150_000;
  private readonly t: ArtPropTargets;

  constructor(t: ArtPropTargets, art: Map<string, PropAsset>) {
    this.t = t;
    this.group.name = 'art-props';
    const mats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    // --- rocks: keep placement; small variant -> LOD1, large -> LOD0 (unit-size fit)
    const rocks = art.get('rocks');
    if (rocks) {
      t.props.children.forEach((o) => {
        const m = o as THREE.InstancedMesh;
        if (!m.isInstancedMesh || !/^rocks-/.test(m.name)) return;
        const pm = rocks.lod1 ?? rocks.lod0;
        const g = fitted(pm, 1.1);
        g.translate(0, -0.15, 0);
        this.geos.push(g);
        const rm = propMat(t.engine, pm.material, mats);
        // the TRELLIS rock bake is near black: lift it to a mid grey stone
        rm.color.setRGB(1.75, 1.7, 1.6);
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
        // only the boulders get the art mesh (thousands of triangles each); the hundreds of pebbles
        // keep the cheap procedural rock, which reads the same at their size
        const nArt = Math.min(list.length, Math.ceil(ArtProps.ART_ROCK_TRIS / Math.max(1, (g.index ? g.index.count : g.getAttribute('position').count) / 3)));
        const art = new THREE.InstancedMesh(g, rm, Math.max(1, nArt));
        list.slice(0, nArt).forEach((it, i) => {
          art.setMatrixAt(i, it.m);
          art.setColorAt(i, it.c);
        });
        art.count = nArt;
        art.name = `${m.name}-art`;
        art.computeBoundingSphere();
        this.group.add(art);
        list.slice(nArt).forEach((it, i) => {
          m.setMatrixAt(i, it.m);
          if (m.instanceColor) m.setColorAt(i, it.c);
        });
        m.count = list.length - nArt;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
        this.rocks.push({ mesh: art, total: nArt }, { mesh: m, total: m.count });
      });
    }
    // --- ruins and bridges replace the procedural meshes
    const hide = (name: string) => t.props.children.forEach((o) => o.name === name && (o.visible = false));
    if (art.has('ruins_arch') || art.has('ruins_wall') || art.has('ruins_column')) {
      hide('ruin');
      this.placeRuins(art, mats);
    }
    // bridges stay procedural (a three-span stone arch with cutwaters, parapets and coping, fitted
    // exactly to each crossing): the image-to-3D bridge was a blurry box stretched over the deck
    for (const o of this.group.children) {
      const m = o as THREE.Mesh;
      m.castShadow = true;
      m.receiveShadow = true;
    }
    t.props.add(this.group);
  }

  private instanced(pm: PropMesh, h: number | null, mats: Map<THREE.Material, THREE.MeshStandardMaterial>, list: THREE.Matrix4[], name: string): THREE.InstancedMesh | null {
    if (!list.length) return null;
    const g = fitted(pm, h);
    this.geos.push(g);
    const mesh = new THREE.InstancedMesh(g, propMat(this.t.engine, pm.material, mats), list.length);
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
      if (a) this.instanced(a.lod0, null, mats, list, id);
    }
  }

  /** Tier budget: rock counts. */
  setQuality(q: { tier: string; treeDensity: number }): void {
    const rockK = q.tier === 'low' ? 0.35 : q.tier === 'medium' ? 0.6 : 1;
    for (const r of this.rocks) r.mesh.count = Math.round(r.total * rockK);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
  }
}
