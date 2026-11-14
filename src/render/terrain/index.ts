// The battlefield: terrain, water, foliage, props, keeps and the planning overlay, built from
// the sim's Terrain (features in cm, already mirrored). See layout.ts for the world mapping.
//
//   const bf = new Battlefield(engine, replay.terrain, replay.keeps);
//   bf.heightAt(x, z)                  // ground under soldiers (riverbed, bridge decks)
//   bf.setPlanning({ visible: true, seat: 0, grid: true, bothSides: false })
//   bf.keep(1).setStage(2); bf.keep(1).hitPoint()
//   engine.animate((dt) => bf.update(dt)) — or call update from your own per-frame loop
import * as THREE from 'three';
import type { Terrain, TerrainFeature, KeepInfo } from '../../sim/types.ts';
import type { Engine } from '../core/engine.ts';
import type { QualitySettings } from '../core/quality.ts';
import { Layout, defaultKeeps, WATER_LEVEL, TEAM_COLORS } from './layout.ts';
import { Heightfield } from './heightfield.ts';
import { terrainTextures, setAnisotropy, type TerrainTextures } from './textures.ts';
import { buildGround } from './ground.ts';
import { Water } from './water.ts';
import { Foliage } from './foliage.ts';
import { Props } from './props.ts';
import { bakeTreeShadow, bakedShadowUniforms } from './baked-shadow.ts';
import { ArtProps, tintedPropMaterial } from './art-props.ts';
import { CanopyGrid } from './canopy.ts';
import type { PropAsset } from '../crowd/assets.ts';
import { Keep, keepMaterials, type KeepView } from './keep.ts';
import { ZONES, buildCurtain, overlayUniforms } from './overlay.ts';
import { mulberry32 } from './noise.ts';

export type { KeepView } from './keep.ts';
export { WATER_LEVEL, TEAM_COLORS } from './layout.ts';

export interface PlanningOverlay {
  visible: boolean;
  /** The seat whose zone is highlighted (default 0). */
  seat?: 0 | 1;
  /** Show the fine placement grid inside the zone. */
  grid?: boolean;
  /** Also show the other seat's zone (dimmer). */
  bothSides?: boolean;
}

export class Battlefield {
  readonly group = new THREE.Group();
  readonly waterLevel = WATER_LEVEL;
  private engine: Engine;
  private tex: TerrainTextures;
  private hf!: Heightfield;
  private ground!: THREE.Mesh;
  private water!: Water;
  private foliage!: Foliage;
  private props!: Props;
  private keeps: Keep[] = [];
  private keepMats: THREE.Material[] = [];
  private curtains: THREE.Mesh[] = [];
  private keepInfo: KeepInfo[];
  private planTarget = new THREE.Vector3(0, 0, 0);
  private onQ = (q: QualitySettings) => this.applyQuality(q);

  constructor(engine: Engine, terrain: Terrain, keeps?: KeepInfo[]) {
    this.engine = engine;
    this.keepInfo = keeps && keeps.length >= 2 ? keeps : defaultKeeps();
    this.group.name = 'battlefield';
    this.tex = terrainTextures();
    engine.scene.add(this.group);
    this.build(terrain);
    engine.onQuality.add(this.onQ);
  }

  private build(terrain: Terrain): void {
    const e = this.engine;
    const layout = new Layout(terrain, this.keepInfo);
    this.hf = new Heightfield(layout);
    this.ground = buildGround(e, this.hf, this.tex);
    this.group.add(this.ground);
    this.water = new Water(e, this.hf, this.tex);
    this.group.add(this.water.mesh);
    this.foliage = new Foliage(e, this.hf);
    this.group.add(this.foliage.group);
    this.props = new Props(e, this.hf, this.tex);
    this.group.add(this.props.group);
    for (const k of layout.keeps) {
      const mats = keepMaterials(e, this.tex, this.props.masonry, k.seat);
      this.keepMats.push(mats.roof, mats.cloth, mats.wood, mats.glow);
      const keep = new Keep(e, this.hf, k, mats);
      this.keeps[k.seat] = keep;
      this.group.add(keep.group);
      if (this.keepModel) keep.useModel(this.keepModel);
    }
    if (this.art) this.buildArt();
    this.curtains = ZONES.map((z, i) => {
      const frontZ = Math.abs(z.z) < Math.abs(z.w) ? z.z : z.w;
      const c = buildCurtain(z, (x, zz) => this.hf.heightAt(x, zz), new THREE.Color(TEAM_COLORS[i]), frontZ);
      this.group.add(c);
      return c;
    });
    this.water.hideInReflection.push(this.foliage.grass, ...this.foliage.trees.slice(5), ...this.curtains);
    this.applyQuality(e.quality);
    e.wake();
  }

  private bakedTex: THREE.DataTexture | null = null;
  private applyQuality(q: QualitySettings): void {
    this.foliage.setDensity(q.grassDensity, q.treeDensity);
    this.artProps?.setQuality(q);
    if (this.props) this.rebuildCanopy();
    // power: prop shadows from the shadow map only on high/ultra; elsewhere a baked tree mask
    // shadow-map casters only near the action: field-forest trees and props on high/ultra; the
    // outskirts (thousands of trees, far bushes, reeds) always use the baked ground shadow
    // trees: real-time shadows only on ultra (field forests); everything else bakes them
    const liveTrees = q.propShadows && q.tier === 'ultra';
    this.foliage.trees.forEach((t, k) => (t.castShadow = liveTrees && k < 5));
    this.props.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = q.propShadows && !/lod1|reeds|rocks|bush/.test(m.name);
    });
    this.ground.castShadow = q.propShadows;
    this.bakedTex = bakeTreeShadow(liveTrees ? this.foliage.trees.slice(5) : this.foliage.trees, this.engine.sun.direction, this.bakedTex);
    bakedShadowUniforms.tTreeShadow.value = this.bakedTex;
    bakedShadowUniforms.uTreeShadow.value = 1;
    this.engine.markShadows();
    this.water.setReflection(q.waterReflection);
    setAnisotropy(this.tex, q.anisotropy);
    this.engine.wake();
  }

  // ---------------------------------------------------------------- queries

  heightAt(wx: number, wz: number): number {
    return this.hf.heightAt(wx, wz);
  }
  /** Ground without bridge decks (riverbed). */
  groundAt(wx: number, wz: number): number {
    return this.hf.ground(wx, wz);
  }
  isWater(wx: number, wz: number): boolean {
    return this.hf.isWater(wx, wz);
  }
  normalAt(wx: number, wz: number, out = new THREE.Vector3()): THREE.Vector3 {
    return this.hf.normalAt(wx, wz, out);
  }
  raycast(ray: THREE.Ray): THREE.Vector3 | null {
    return this.hf.raycast(ray);
  }
  private keepModel: THREE.Object3D | null = null;
  private art: Map<string, PropAsset> | null = null;
  private canopy = new CanopyGrid();
  /** Trees currently use the planning canopy-fade material. */
  private canopyFade = false;

  /** Highest tree crown / prop / castle top at a world point (−1e9 on open ground): the camera stays above it. */
  canopyAt(x: number, z: number): number {
    return this.canopy.at(x, z);
  }

  private rebuildCanopy(): void {
    const c = this.canopy;
    c.clear();
    for (const t of this.foliage.trees) c.instanced(t, 0.95);
    this.props.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && !/rocks|bush|reeds|bridge/.test(m.name)) c.instanced(m, 0.9);
    });
    for (const k of this.keeps) if (k) c.box(new THREE.Box3().setFromObject(k.group));
  }
  private artProps: ArtProps | null = null;
  private towerGeo: THREE.BufferGeometry | null = null;

  /** Use the art pipeline's props (manifest `props`) instead of the procedural ones (kept across setTerrain). */
  setArtProps(art: Map<string, PropAsset>): void {
    this.art = art.size ? art : null;
    if (this.art) this.buildArt();
  }

  private buildArt(): void {
    const art = this.art!;
    this.artProps?.dispose();
    this.artProps = new ArtProps({ engine: this.engine, hf: this.hf, trees: this.foliage.trees, props: this.props.group, treeDepth: this.foliage.treeDepth }, art);
    this.artProps.setCanopyFade(this.canopyFade);
    const tower = art.get('arrow_tower');
    if (tower) {
      const b = tower.lod0.box;
      if (!this.towerGeo) {
        this.towerGeo = tower.lod0.geometry.clone().translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
        this.towerGeo.computeBoundingSphere();
      }
      for (const k of this.keeps) {
        if (!k) continue;
        const mat = tintedPropMaterial(this.engine, tower.lod0.material, tower.tintMap, new THREE.Color(TEAM_COLORS[k.seat]));
        k.useTowerModel(this.towerGeo, mat, b.max.y - b.min.y);
      }
    }
    this.applyQuality(this.engine.quality);
  }
  /** Use the art keep (keep.glb) for both castles (kept across setTerrain). */
  setKeepModel(model: THREE.Object3D | null): void {
    this.keepModel = model;
    for (const seat of [0, 1] as const) this.keep(seat).useModel(model);
    this.rebuildCanopy();
  }

  keep(seat: 0 | 1): KeepView {
    return this.keeps[seat];
  }

  // ---------------------------------------------------------------- planning

  setPlanning(p: PlanningOverlay): void {
    const seat = p.seat ?? 0;
    if (p.visible) {
      this.canopyFade = true;
      this.artProps?.setCanopyFade(true);
    }
    if (!p.visible) this.planTarget.set(0, 0, 0);
    else {
      const other = p.bothSides ? 0.4 : 0;
      this.planTarget.set(seat === 0 ? 1 : other, seat === 1 ? 1 : other, p.grid ? 1 : 0);
    }
    this.engine.wake();
  }

  setTerrain(t: Terrain, keeps?: KeepInfo[]): void {
    if (keeps && keeps.length >= 2) this.keepInfo = keeps;
    this.disposeContent();
    this.build(t);
  }

  /** Per frame. True while something non-ambient animates (overlay fades, keep collapses). */
  update(dt: number): boolean {
    let busy = false;
    const u = overlayUniforms.uPlan.value;
    const k = 1 - Math.exp(-dt * 6);
    const tgt = this.planTarget;
    if (u.distanceToSquared(tgt) > 1e-5) {
      u.lerp(tgt, k);
      busy = true;
    } else {
      u.copy(tgt);
      // overlay fully gone: back to the plain tree material (keeps early-z in battle)
      if (tgt.x === 0 && tgt.y === 0 && this.canopyFade) {
        this.canopyFade = false;
        this.artProps?.setCanopyFade(false);
      }
    }
    this.curtains.forEach((c, i) => {
      const f = i === 0 ? u.x : u.y;
      c.visible = f > 0.002;
      const m = c.material as THREE.ShaderMaterial;
      m.uniforms.uFade.value = f;
      m.uniforms.uTime.value = this.engine.time;
    });
    // (the curtains' shimmer only advances while frames are drawn for other reasons: idle = 0 fps)
    for (const kp of this.keeps) if (kp && kp.update(dt)) busy = true;
    return busy;
  }

  private disposeContent(): void {
    this.artProps?.dispose();
    this.artProps = null;
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.hf.splat.dispose();
    this.water.dispose();
    this.foliage.dispose();
    for (const k of this.keeps) k?.dispose();
    this.props.dispose();
    for (const m of this.keepMats) m.dispose();
    this.keepMats = [];
    this.keeps = [];
    for (const c of this.curtains) {
      c.geometry.dispose();
      (c.material as THREE.Material).dispose();
    }
    this.group.clear();
  }

  dispose(): void {
    this.engine.onQuality.delete(this.onQ);
    this.disposeContent();
    this.engine.scene.remove(this.group);
  }
}

// ------------------------------------------------------------------ default layout

const FW = 8000;
const FH = 12000;
function circle(kind: TerrainFeature['kind'], x: number, y: number, r: number): TerrainFeature {
  return { kind, shape: 'circle', x, y, r, w: 0, h: 0 };
}
function rect(kind: TerrainFeature['kind'], x: number, y: number, w: number, h: number): TerrainFeature {
  return { kind, shape: 'rect', x, y, r: 0, w, h };
}
function mirror(f: TerrainFeature): TerrainFeature {
  if (f.shape === 'circle') return { ...f, x: FW - 1 - f.x, y: FH - 1 - f.y };
  return { ...f, x: FW - f.x - f.w, y: FH - f.y - f.h };
}

/** A showcase layout in the sim's format: river, 2 bridges + a ford, forests, hills, ruins (mirrored). */
export function defaultTerrain(seed = 7): Terrain {
  const rnd = mulberry32(seed);
  const j = (v: number) => Math.round(v + (rnd() - 0.5) * 300);
  const half: TerrainFeature[] = [
    circle('forest', j(1300), j(2700), 850),
    circle('forest', j(6500), j(4300), 950),
    circle('forest', j(3000), j(4700), 600),
    circle('hill', j(5600), j(2200), 750),
    circle('hill', j(1800), j(4400), 650),
    circle('ruins', j(4700), j(4700), 500),
  ];
  const features: TerrainFeature[] = [rect('river', 0, 5500, FW, 1000)];
  const bridge = rect('bridge', 1500, 5500, 700, 1000);
  features.push(bridge, mirror(bridge));
  features.push(rect('ford', 3550, 5500, 900, 1000));
  for (const f of half) features.push(f, mirror(f));
  return { seed, features };
}
