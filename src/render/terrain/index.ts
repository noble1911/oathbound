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
import { ArtProps } from './art-props.ts';
import { CanopyGrid } from './canopy.ts';
import { loadGround, setGroundAnisotropy } from './env-textures.ts';
import type { PropAsset } from '../crowd/assets.ts';
import { Keep, keepMaterials, type KeepArt, type KeepView } from './keep.ts';
import { setKeepAnisotropy, setKeepGlowScale } from './keep-art.ts';
import { ZONES, buildCurtain, overlayUniforms } from './overlay.ts';
import { mulberry32 } from './noise.ts';

export type { KeepArt, KeepView } from './keep.ts';
export { KEEP_FACTIONS, type KeepFaction } from './keep-art.ts';
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
      const art = this.keepArt[k.seat];
      if (art) keep.useArt(art, e.quality.tier !== 'low');
    }
    if (this.art) this.buildArt();
    this.curtains = ZONES.map((z, i) => {
      const frontZ = Math.abs(z.z) < Math.abs(z.w) ? z.z : z.w;
      const c = buildCurtain(z, (x, zz) => this.hf.heightAt(x, zz), new THREE.Color(TEAM_COLORS[i]), frontZ);
      this.group.add(c);
      return c;
    });
    this.water.hideInReflection.push(this.foliage.grass, ...this.foliage.trees.slice(5), ...this.foliage.plants.map((pl) => pl.mesh), ...this.curtains);
    this.applyQuality(e.quality);
    e.wake();
  }

  private bakedTex: THREE.DataTexture | null = null;
  private applyQuality(q: QualitySettings): void {
    this.foliage.setDensity(q.grassDensity, q.treeDensity, q.tier);
    this.artProps?.setQuality(q);
    // scanned ground layers: half-resolution albedo on the cheap tiers; low has no normal maps, low / medium no second scale
    const cheap = q.tier === 'low' || q.tier === 'medium';
    void loadGround(cheap ? 512 : 1024, q.tier !== 'low', () => this.engine.wake());
    setGroundAnisotropy(q.anisotropy);
    (this.ground.userData.setDetail as (level: 0 | 1 | 2) => void)(q.tier === 'low' ? 0 : q.tier === 'medium' ? 1 : 2);
    if (this.props) this.rebuildCanopy();
    // power: prop shadows from the shadow map only on high/ultra; elsewhere a baked tree mask
    // shadow-map casters only near the action: field-forest trees and props on high/ultra; the
    // outskirts (thousands of trees, far bushes, reeds) always use the baked ground shadow
    // trees: real-time shadows only on ultra (field forests); everything else bakes them
    const liveTrees = q.propShadows && q.tier === 'ultra';
    this.foliage.trees.forEach((t, k) => (t.castShadow = liveTrees && k < 5));
    this.props.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = q.propShadows && !/lod1|rocks/.test(m.name);
    });
    this.ground.castShadow = q.propShadows;
    this.bakedTex = bakeTreeShadow(liveTrees ? this.foliage.trees.slice(5) : this.foliage.trees, this.engine.sun.direction, this.bakedTex);
    bakedShadowUniforms.tTreeShadow.value = this.bakedTex;
    bakedShadowUniforms.uTreeShadow.value = 1;
    this.engine.markShadows();
    this.water.setReflection(q.waterReflection);
    setAnisotropy(this.tex, q.anisotropy);
    setKeepAnisotropy(q.anisotropy);
    setKeepGlowScale(q.post);
    for (const k of this.keeps) k?.setArtNormals(q.tier !== 'low');
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
  private keepArt: (KeepArt | null)[] = [null, null];
  private art: Map<string, PropAsset> | null = null;
  private canopy = new CanopyGrid();

  private solids = new CanopyGrid();

  /** Highest tree crown / prop / tower / castle-body top at a world point (−1e9 on open ground): the director's view stays clear of it. */
  canopyAt(x: number, z: number): number {
    return this.canopy.at(x, z);
  }
  /** Top of solid geometry only (ruins, arrow towers, castle bodies; no foliage): no camera sits inside it. */
  solidAt(x: number, z: number): number {
    return this.solids.at(x, z);
  }

  private fadeBox = new THREE.Box3();
  private fadeRay = new THREE.Ray();
  private fadeHit = new THREE.Vector3();
  private fadeNow: number[][] = [[1, 1, 1], [1, 1, 1]];
  /**
   * Castles and arrow towers standing between the camera and its focus fade to a 30 % ghost (one
   * opacity per object, depth still written: no dither); also when the lens is inside one. Looking
   * AT a castle (focus inside it) leaves it solid. `also`: more points that must stay visible. Returns true while a fade is still moving.
   */
  fadeOccluders(cam: THREE.Vector3, look: THREE.Vector3, dt: number, also: THREE.Vector3[] = []): boolean {
    let busy = false;
    const ray = this.fadeRay;
    const len = cam.distanceTo(look);
    ray.origin.copy(cam);
    ray.direction.subVectors(look, cam).normalize();
    const b = this.fadeBox;
    const blocks = (): boolean => {
      if (b.containsPoint(cam)) return true;
      if (b.containsPoint(look)) return false;
      const h = ray.intersectBox(b, this.fadeHit);
      if (h && h.distanceTo(cam) < len) return true;
      // other ground the player must see (planning: the back rows of the deploy zone)
      for (const p of also) {
        ray.direction.subVectors(p, cam);
        const l = ray.direction.length();
        ray.direction.divideScalar(l);
        const hit = ray.intersectBox(b, this.fadeHit);
        ray.direction.subVectors(look, cam).normalize();
        if (hit && hit.distanceTo(cam) < l) return true;
      }
      return false;
    };
    this.keeps.forEach((k, s) => {
      if (!k) return;
      const parts = 1 + k.towers.length;
      for (let p = 0; p < parts; p++) {
        if (p === 0) k.bodyBox(b).expandByScalar(0.6);
        else {
          const t = k.towers[p - 1];
          b.min.set(t.x - 2.4, t.y - 9, t.z - 2.4);
          b.max.set(t.x + 2.4, t.y + 2.5, t.z + 2.4);
        }
        const target = blocks() ? 0.3 : 1;
        const cur = this.fadeNow[s][p] ?? 1;
        if (cur === target) continue;
        let next = cur + (target - cur) * (1 - Math.exp(-dt * 9));
        if (Math.abs(next - target) < 0.01) next = target;
        else busy = true;
        this.fadeNow[s][p] = next;
        k.setFade(p, next);
      }
    });
    return busy;
  }

  private rebuildCanopy(): void {
    const c = this.canopy;
    c.clear();
    for (const t of this.foliage.trees) c.instanced(t, 0.95);
    this.props.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && !/rocks|bush|reeds|bridge/.test(m.name)) c.instanced(m, 0.9);
    });
    // solids: ruins, arrow towers and the castle bodies, each with its own tight footprint (one box
    // around a whole castle group, towers included, used to push the camera up over half the yard)
    const s = this.solids;
    s.clear();
    this.props.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && /ruin/.test(m.name)) s.instanced(m, 0.7);
    });
    const box = new THREE.Box3();
    for (const k of this.keeps) {
      if (!k) continue;
      k.bodyBox(box);
      // the body's wall-walk height, not its spire tips
      box.max.y = box.min.y + (box.max.y - box.min.y) * 0.8;
      for (const g of [c, s]) {
        g.rect(box);
        for (const t of k.towers) g.disc(t.x, t.z, 1.2, t.y + 1.5);
      }
    }
  }
  private artProps: ArtProps | null = null;

  /** Use the art pipeline's props (manifest `props`) instead of the procedural ones (kept across setTerrain). */
  setArtProps(art: Map<string, PropAsset>): void {
    this.art = art.size ? art : null;
    if (this.art) this.buildArt();
  }

  private buildArt(): void {
    const art = this.art!;
    this.artProps?.dispose();
    this.artProps = new ArtProps({ engine: this.engine, hf: this.hf, props: this.props.group }, art);
    this.applyQuality(this.engine.quality);
  }
  /** A seat's Keep and arrow towers in its faction's art (kept across setTerrain); null = the procedural castle. */
  setKeepArt(seat: 0 | 1, art: KeepArt | null): void {
    if (this.keepArt[seat] === art) return;
    this.keepArt[seat] = art;
    this.keeps[seat]?.useArt(art, this.engine.quality.tier !== 'low');
    this.rebuildCanopy();
  }

  keep(seat: 0 | 1): KeepView {
    return this.keeps[seat];
  }

  // ---------------------------------------------------------------- planning

  setPlanning(p: PlanningOverlay): void {
    const seat = p.seat ?? 0;
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
      // trees in the deploy zone shrink / grow with the overlay: their shadows follow
      this.engine.markShadows();
    } else u.copy(tgt);
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
