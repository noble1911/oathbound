// BattleView: the renderer facade the UI talks to. See src/render/index.ts for the API overview.
import * as THREE from 'three';
import { Engine, type EngineOptions } from './core/engine.ts';
import type { QualityTier } from './core/quality.ts';
import { fieldToWorld, worldToField, worldX, worldZ, yawToFacing } from './core/coords.ts';
import { CameraRig, type CameraMode } from './camera/rig.ts';
import { Director } from './camera/director.ts';
import { UnitRenderer } from './crowd/units.ts';
import { createHeroMaterial } from './crowd/vat.ts';
import { archetypeFor } from './crowd/archetypes.ts';
import { Battlefield, defaultTerrain, type KeepArt, type KeepFaction } from './terrain/index.ts';
import { Vfx } from './vfx/index.ts';
import { SquadPlates, type PlateState } from './plates.ts';
import { BattlePlayback, type NumberMode, type PlaybackHooks } from './battle-playback.ts';
import { RangeRing, type RangeRingHandle } from './range-ring.ts';
import { GhostMarks, type GhostMark } from './ghost-marks.ts';
import { TEAM_COLORS } from './crowd/archetypes.ts';
import { UNITS, formationCols } from '../sim/data/units.ts';
import { makeTransforms, type BattleSource, type KeepInfo, type ReplaySoldier, type SoldierTransforms, type Terrain } from './battle-source.ts';

export interface BattleViewOptions extends EngineOptions {
  /** Art manifest URL (relative), e.g. 'models/v2/manifest.json'. Missing → procedural stand-ins. */
  artManifest?: string;
  /** Whose perspective (seat 1 looks from the other end). */
  seat?: 0 | 1;
  terrain?: Terrain;
  keeps?: KeepInfo[];
  /** Each seat's faction: picks its Keep and arrow towers (default: the Kingdom's castle for both). */
  keepFactions?: [KeepFaction, KeepFaction];
}

/** A squad as the planning screen knows it (sim `Squad` is compatible). */
export interface ArmySquad {
  id: number;
  owner: 0 | 1;
  type: string;
  lord?: string | null;
  /** cm */
  pos: [number, number];
  /** 0..255 binary angle (sim convention). */
  facing?: number;
  level?: number;
  /** Soldier count (defaults to the unit's squad size). */
  size?: number;
  modelId?: string;
}

export interface ArmyOptions {
  /** Draw these owners' squads as faded ghosts (the enemy's last-round army). */
  ghostOwners?: (0 | 1)[];
  /** Highlight state per squad id. */
  highlight?: Record<number, 'hover' | 'selected' | 'invalid'>;
}

const SQUAD_SIZE: Record<string, number> = {
  militia: 12, pikemen: 8, berserkers: 6, archers: 10, knights: 4, cavaliers: 4, mages: 4, clerics: 3, pegasus: 3,
  ballista: 1, trebuchet: 1, golem: 1, wyvern: 2, dragon: 1, lord: 1, skeleton: 1,
};
const SPACING: Record<string, number> = { cavaliers: 3, pegasus: 4, wyvern: 5, knights: 1.9, berserkers: 1.6 };
/** Soldiers per squad and formation spacing for any faction's unit: the sim's squadSize, spaced like its Kingdom twin. */
function squadSize(type: string): number {
  return (UNITS as Record<string, { squadSize: number } | undefined>)[type]?.squadSize ?? SQUAD_SIZE[type] ?? 1;
}
/**
 * The sim's starting formation (battle.ts): formationCols(n) columns, rows as far apart as columns, 2 x radius + 50
 * cm between soldiers. Planning draws a squad exactly where its battle will start it, which is also what its
 * footprint (match.ts squadFootprint) keeps clear of its neighbours: the older display spacing (up to 5 m between
 * riders, 7 columns for a grown 24-man Swarm squad) drew squads up to half again wider than that ground, so two
 * legally placed squads could stand inside each other. Null for a type the sim does not know (render-test fakes).
 */
function simSpacing(type: string): number | null {
  const u = (UNITS as Record<string, { radius: number } | undefined>)[type];
  return u ? u.radius * 2 + 50 : null;
}
function spacing(type: string): number {
  const like = (UNITS as Record<string, { like: string } | undefined>)[type]?.like;
  return SPACING[type] ?? (like ? SPACING[like] : undefined) ?? 1.5;
}

export class BattleView {
  readonly engine: Engine;
  readonly camera: CameraRig;
  readonly director: Director;
  readonly units: UnitRenderer;
  field: Battlefield;
  readonly vfx: Vfx;
  /** In-world squad plates (crest, HP bar, level pips); see `setSquadPlate`. */
  readonly plates: SquadPlates;
  seat: 0 | 1;
  private playback: BattlePlayback | null = null;
  private army: { tf: SoldierTransforms; squads: number[]; ghosts: Set<number> } | null = null;
  private marchTick = 0;
  private keepFactions: [KeepFaction, KeepFaction] = ['kingdom', 'kingdom'];
  private keepArtLoads = new Map<string, Promise<KeepArt | null>>();
  private hasArt = false;
  private artPropSet: Map<string, import('./crowd/assets.ts').PropAsset> | null = null;
  /** Art downloads so far: [{ model, ms, bytes }]. */
  get artLoads(): { model: string; ms: number; bytes: number }[] {
    return this.units.assets.loads;
  }
  private lastFrame = 0;

  constructor(container: HTMLElement, opts: BattleViewOptions = {}) {
    this.engine = new Engine(container, opts);
    this.seat = opts.seat ?? 0;
    this.field = new Battlefield(this.engine, opts.terrain ?? defaultTerrain(), opts.keeps);
    this.camera = new CameraRig(this.engine);
    this.camera.setGround((x, z) => this.field.heightAt(x, z));
    this.camera.setObstacles((x, z) => this.field.canopyAt(x, z), (x, z) => Math.max(this.field.solidAt(x, z), this.unitTop(x, z)));
    this.units = new UnitRenderer(this.engine, (x, z) => this.field.heightAt(x, z), (surf, src, tintMap) => {
      const sm = src as THREE.MeshStandardMaterial;
      const { material, uniforms } = createHeroMaterial(this.engine, 'hero', { surf, map: sm.map ?? null, tintMap, vertexColors: surf || !!sm.vertexColors });
      if (!surf) {
        material.roughness = sm.roughness ?? 0.7;
        material.metalness = sm.metalness ?? 0;
        material.roughnessMap = sm.roughnessMap ?? null;
        material.metalnessMap = sm.metalnessMap ?? null;
        material.normalMap = sm.normalMap ?? null;
        // authored cloth (capes, banners, caparisons: a material whose name contains `cloth`, exported double-sided) is
        // drawn from both sides. Every other material stays single-sided even when the file says doubleSided (the
        // Blender exporter flags every material that way), so closed bodies never pay for their back faces.
        if (sm.side === THREE.DoubleSide && /cloth/i.test(sm.name)) material.side = THREE.DoubleSide;
      }
      return { material, uniforms };
    });
    this.director = new Director(this.camera, this.units);
    this.syncKeeps();
    this.vfx = new Vfx(this.engine, (x, z) => this.field.heightAt(x, z));
    this.plates = new SquadPlates(this.engine);
    this.engine.scene.add(this.ghostMarks.mesh);
    this.camera.home(this.seat);
    this.camera.snap();
    if (opts.artManifest) {
      void this.units.assets.loadManifest(opts.artManifest);
      // the keeps are always on the field: fetch them right away (units load lazily per type present)
      this.hasArt = true;
      if (opts.keepFactions) this.keepFactions = [...opts.keepFactions];
      this.loadKeepArt();
      this.engine.onQuality.add(() => this.loadKeepArt());
      // props (trees, rocks, ruins, bridge, towers, bushes, reeds) are always on the field
      void this.units.assets.props().then((p) => {
        this.artPropSet = p;
        this.field.setArtProps(p);
      });
    }

    this.units.onAssetsChanged = () => {
      // re-pose the new instances immediately (a paused battle / planning view doesn't tick)
      if (this.playback) this.playback.refresh();
      else if (this.army) this.units.update(this.army.tf, this.engine.time, 0);
    };
    this.units.onMarch = (s) => {
      if ((this.marchTick++ & 7) !== 0) return;
      if (Math.random() < 0.35 * s.arch.dust) this.vfx.marchDust(s.pos.clone(), s.arch.dust);
    };
    this.engine.beforeRender.add((dt) => this.frame(dt));
  }

  // ------------------------------------------------------------------ terrain

  setTerrain(t: Terrain, keeps?: KeepInfo[]): void {
    if (keeps) {
      this.field.dispose();
      this.field = new Battlefield(this.engine, t, keeps);
      this.loadKeepArt();
      if (this.artPropSet) this.field.setArtProps(this.artPropSet);
    } else this.field.setTerrain(t);
    this.syncKeeps();
    this.engine.wake();
  }

  /** Each seat's faction (engine seats: 0 = blue, near side): swaps in that faction's Keep and arrow towers. */
  setKeepFactions(f: [KeepFaction, KeepFaction]): void {
    if (f[0] === this.keepFactions[0] && f[1] === this.keepFactions[1]) return;
    this.keepFactions = [f[0], f[1]];
    this.loadKeepArt();
  }

  /**
   * Fetch (once per faction) and apply the Keep art. The low tier loads only the LOD1 files; the
   * others load both and switch by distance.
   */
  private loadKeepArt(): void {
    if (!this.hasArt) return;
    const low = this.engine.quality.tier === 'low';
    const A = this.units.assets;
    for (const seat of [0, 1] as const) {
      const f = this.keepFactions[seat];
      const key = `${f}|${low ? 'far' : 'full'}`;
      let p = this.keepArtLoads.get(key);
      if (!p) {
        p = Promise.all([
          low ? null : A.structure(`keep_${f}`),
          A.structure(`keep_${f}`, true),
          low ? null : A.structure(`arrow_tower_${f}`),
          A.structure(`arrow_tower_${f}`, true),
        ]).then(([near, far, towerNear, towerFar]): KeepArt | null => (near || far ? { faction: f, near, far, towerNear, towerFar } : null));
        this.keepArtLoads.set(key, p);
      }
      void p.then((art) => {
        // still the wanted faction and tier when it arrives?
        if (this.keepFactions[seat] !== f || (this.engine.quality.tier === 'low') !== low) return;
        this.field.setKeepArt(seat, art);
      });
    }
  }

  private syncKeeps(): void {
    this.director.setKeeps(this.field.keep(0).position, this.field.keep(1).position);
  }

  /** The seat being planned (deploy zone shown), and points along each zone's back rows that must stay visible. */
  private planning: { seat: 0 | 1 } | null = null;
  private zoneBack: [THREE.Vector3[], THREE.Vector3[]] = [1, -1].map((sg) => [-30, -15, 0, 15, 30].flatMap((x) => [new THREE.Vector3(x, 0.5, 54 * sg), new THREE.Vector3(x, 0.5, 46 * sg)])) as [THREE.Vector3[], THREE.Vector3[]];

  private ghostMarks = new GhostMarks();

  /**
   * Extend the planning home view to a far edge (field y in cm, e.g. the enemy ghosts' front line or
   * their rearmost squad), or null for the default (the enemy deploy-zone front edge). The home pitch
   * stays; the view re-fits now if the camera is at home, and on every later home / resetCamera.
   */
  setHomeFarEdge(yCm: number | null): void {
    this.camera.setHomeFar(yCm === null ? null : worldZ(yCm));
  }

  /** Whose side the camera defaults to. */
  setSeat(seat: 0 | 1): void {
    this.seat = seat;
    this.camera.home(seat);
  }

  // ------------------------------------------------------------------ planning

  /** Deploy-zone overlay (glow + optional grid). Switches the camera to RTS control. */
  setPlanning(p: { visible: boolean; seat?: 0 | 1; grid?: boolean; bothSides?: boolean }): void {
    this.planning = p.visible ? { seat: p.seat ?? this.seat } : null;
    this.field.setPlanning({ seat: this.seat, ...p });
    if (p.visible && !this.playback) this.camera.setMode('rts');
    this.engine.wake();
  }

  /** Show squads standing in formation (planning). Replaces any battle playback. */
  showArmy(squads: ArmySquad[], o: ArmyOptions = {}): void {
    this.stopBattle();
    const headers: ReplaySoldier[] = [];
    const places: { x: number; y: number; f: number }[] = [];
    const squadOf: number[] = [];
    const ghosts = new Set<number>();
    const marks: GhostMark[] = [];
    for (const sq of squads) {
      const type = sq.type;
      const n = sq.size ?? squadSize(type);
      const facing = sq.facing ?? (sq.owner === 0 ? 64 : 192);
      const rad = (facing / 256) * Math.PI * 2;
      const modelId = sq.modelId ?? (type === 'lord' && sq.lord ? `lord_${sq.lord}` : type);
      const arch = archetypeFor({ modelId, type, lord: sq.lord ?? undefined });
      const ssp = simSpacing(type);
      const sp = ssp ?? spacing(type) * 100;
      const cols = n <= 1 ? 1 : ssp !== null ? formationCols(n) : Math.ceil(Math.sqrt(n * 2));
      const rows = Math.ceil(n / cols);
      // the display-only layout (no sim twin) staggers its rows and packs them a little closer
      const rowSp = ssp !== null ? sp : sp * 0.9;
      const stagger = ssp !== null ? 0 : sp / 4;
      // formation axes: "right" and "forward" in field space
      const fx = Math.cos(rad);
      const fy = Math.sin(rad);
      const rx = fy;
      const ry = -fx;
      if (o.ghostOwners?.includes(sq.owner)) {
        // intel footprint under a ghost squad: its formation box, facing its facing
        const w = fieldToWorld(sq.pos[0], sq.pos[1]);
        const big = Math.max(0, arch.chest - 1.3) * 1.6;
        marks.push({ x: w.x, y: this.field.heightAt(w.x, w.z), z: w.z, w: ((cols - 1) * sp) / 100 + big, d: ((rows - 1) * rowSp) / 100 + big, yaw: Math.atan2(fx, -fy), color: new THREE.Color(TEAM_COLORS[sq.owner]).multiplyScalar(1.5) });
      }
      for (let k = 0; k < n; k++) {
        const c = k % cols;
        const r = Math.floor(k / cols);
        const a = (c - (cols - 1) / 2) * sp + (r % 2) * stagger;
        const b = -(r - (rows - 1) / 2) * rowSp;
        const id = headers.length;
        headers.push({
          id, squad: sq.id, side: sq.owner, type: type as ReplaySoldier['type'], modelId, lord: (sq.lord ?? undefined) as ReplaySoldier['lord'],
          level: sq.level ?? 1, maxHp: 100, items: [], flags: arch.flyHeight > 0 ? ['flier'] : [], spawnTick: 0, summoned: false,
        });
        places.push({ x: sq.pos[0] + rx * a + fx * b, y: sq.pos[1] + ry * a + fy * b, f: rad });
        squadOf.push(sq.id);
        if (o.ghostOwners?.includes(sq.owner)) ghosts.add(id);
      }
    }
    this.units.showGhosts = false;
    this.units.setRoster(headers);
    const tf = makeTransforms(headers.length);
    places.forEach((p, i) => {
      tf.x[i] = p.x;
      tf.y[i] = p.y;
      tf.facing[i] = p.f;
      tf.hp[i] = 100;
      tf.anim[i] = 0;
      tf.visible[i] = 1;
    });
    this.ghostMarks.set(marks);
    this.army = { tf, squads: squadOf, ghosts };
    this.units.slots.forEach((s, i) => {
      // < 1 marks a ghost: drawn solid in a team-coloured intel look (see vat.ts), never dithered
      s.ghost = ghosts.has(i) ? 0.6 : 1;
      const h = o.highlight?.[squadOf[i]];
      s.glow = h === 'selected' ? 0.16 : h === 'hover' ? 0.08 : h === 'invalid' ? 0.2 : 0;
      s.glowColor = h === 'invalid' ? 1 : 0;
    });
    this.plates.clearStates();
    for (const id in o.highlight ?? {}) this.plates.setState(Number(id), { hovered: o.highlight![id] === 'hover', selected: o.highlight![id] === 'selected' });
    this.units.update(tf, this.engine.time, 0);
    this.engine.markShadows();
    this.engine.wake();
  }

  /** Update highlight states without rebuilding the army. */
  highlightSquads(h: Record<number, 'hover' | 'selected' | 'invalid'>): void {
    if (!this.army) return;
    const sq = this.army.squads;
    this.units.slots.forEach((s, i) => {
      const st = h[sq[i]];
      s.glow = st === 'selected' ? 0.16 : st === 'hover' ? 0.08 : st === 'invalid' ? 0.2 : 0;
      s.glowColor = st === 'invalid' ? 1 : 0;
    });
    this.plates.clearStates();
    for (const id in h) this.plates.setState(Number(id), { hovered: h[id] === 'hover', selected: h[id] === 'selected' });
    this.engine.wake();
  }

  /** Hover / selected state of a squad's in-world plate (planning and battle). `{}` clears it. */
  setSquadPlate(squadId: number, state: PlateState): void {
    this.plates.setState(squadId, state);
  }
  /** Show / hide all squad plates (default on). */
  setSquadPlates(visible: boolean): void {
    this.plates.enabled = visible;
    this.engine.wake();
  }

  private rings = new Set<{ ring: RangeRing; squad: number | null }>();

  /**
   * Show an attack-range ring around a squad (follows its soldiers' centre) or a field point [x, y] cm.
   * `radiusCm` is the sim range; colour defaults to the squad owner's team colour (gold for points).
   */
  showRangeRing(target: number | [number, number], radiusCm: number, opts: { color?: THREE.ColorRepresentation } = {}): RangeRingHandle {
    const squad = typeof target === 'number' ? target : null;
    let color = opts.color;
    if (color === undefined && squad !== null) {
      const s = this.units.slots.find((x) => x.header.squad === squad);
      color = s ? TEAM_COLORS[s.header.side] : '#e8c66f';
    }
    const ring = new RangeRing((x, z) => this.field.heightAt(x, z), radiusCm / 100, color ?? '#e8c66f');
    this.engine.scene.add(ring.group);
    const entry = { ring, squad };
    this.rings.add(entry);
    if (squad === null) {
      const p = target as [number, number];
      ring.place(worldX(p[0]), worldZ(p[1]));
    } else this.placeRing(entry);
    this.engine.wake();
    return {
      setCenter: (x, y) => {
        entry.squad = null;
        ring.place(worldX(x), worldZ(y));
        this.engine.wake();
      },
      setRadius: (r) => {
        ring.setRadius(r / 100);
        this.engine.wake();
      },
      dispose: () => {
        ring.dispose();
        this.rings.delete(entry);
        this.engine.wake();
      },
    };
  }
  /** Remove every range ring. */
  clearRangeRings(): void {
    for (const e of this.rings) e.ring.dispose();
    this.rings.clear();
    this.engine.wake();
  }
  private placeRing(e: { ring: RangeRing; squad: number | null }): void {
    if (e.squad === null) return;
    let x = 0;
    let z = 0;
    let n = 0;
    for (const s of this.units.slots) if (s.visible && s.deadAt < 0 && s.header.squad === e.squad) {
      x += s.pos.x;
      z += s.pos.z;
      n++;
    }
    if (n) e.ring.place(x / n, z / n);
  }

  /** Ground point (field cm) under a client position, or null. */
  pickGround(clientX: number, clientY: number): [number, number] | null {
    const p = this.field.raycast(this.engine.rayAt(clientX, clientY));
    return p ? worldToField(p) : null;
  }

  /** The squad id under a client position (nearest soldier within ~1 m of the ray). */
  pickSquad(clientX: number, clientY: number): number | null {
    const ray = this.engine.rayAt(clientX, clientY);
    let best = -1;
    let bd = Infinity;
    const p = new THREE.Vector3();
    for (const s of this.units.slots) {
      if (!s.visible || s.deadAt >= 0) continue;
      p.copy(s.pos).setY(s.pos.y + s.arch.chest);
      const d = ray.distanceSqToPoint(p);
      const r = s.arch.render === 'hero' ? 2.2 : 0.9;
      if (d < r * r) {
        const along = p.sub(ray.origin).dot(ray.direction);
        if (along < bd) {
          bd = along;
          best = s.header.squad;
        }
      }
    }
    return best >= 0 ? best : null;
  }

  /** Screen position (CSS px) of a field point at height `h` metres above the ground. */
  fieldToScreen(xcm: number, ycm: number, h = 0): { x: number; y: number } | null {
    const wx = worldX(xcm);
    const wz = worldZ(ycm);
    return this.engine.toScreen(new THREE.Vector3(wx, this.field.heightAt(wx, wz) + h, wz));
  }

  /** Squad centre on screen (for UI labels / health bars). */
  squadScreen(squadId: number, h = 2.4): { x: number; y: number } | null {
    const c = new THREE.Vector3();
    let n = 0;
    for (const s of this.units.slots) if (s.visible && s.deadAt < 0 && s.header.squad === squadId) {
      c.add(s.pos);
      n++;
    }
    if (!n) return null;
    c.divideScalar(n);
    c.y += h;
    return this.engine.toScreen(c);
  }

  // ------------------------------------------------------------------ battle

  /** Play a battle (sim replay via `replaySource`, or any BattleSource). Camera → director. */
  playBattle(src: BattleSource, hooks: PlaybackHooks & { director?: boolean; ghosts?: boolean } = {}): BattlePlayback {
    this.stopBattle();
    this.army = null;
    this.ghostMarks.set([]);
    this.field.setPlanning({ visible: false });
    this.planning = null;
    // (a backdrop draws no see-through silhouettes: `ghosts: false`)
    this.units.showGhosts = hooks.ghosts !== false;
    this.playback = new BattlePlayback(src, this.units, this.director, this.vfx, this.field, hooks);
    for (const seat of [0, 1] as const) this.field.keep(seat).setStage(0);
    this.director.reset(this.seat === 0 ? 0 : Math.PI);
    this.camera.setMode(hooks.director === false ? 'free' : 'director');
    this.engine.animate(this.playbackAnimator);
    this.playback.onResume = () => this.engine.animate(this.playbackAnimator);
    // a stored / explicitly set mode wins over the caller's default
    if (this.numberMode) this.playback.damageNumbers = this.numberMode;
    return this.playback;
  }

  get battle(): BattlePlayback | null {
    return this.playback;
  }

  stopBattle(): void {
    if (!this.playback) return;
    this.engine.cancel(this.playbackAnimator);
    this.playback = null;
    this.vfx.clear();
    this.units.clear();
  }

  private playbackAnimator = (dt: number): boolean => {
    const pb = this.playback;
    if (!pb) return false;
    pb.tick(dt);
    // paused or finished: let the loop sleep (camera moves / VFX wake it on their own)
    return pb.playing && !pb.ended;
  };

  // ------------------------------------------------------------------ camera / quality

  setCameraMode(m: CameraMode): void {
    this.camera.setMode(m);
  }
  /**
   * Home / reset key. Planning: back to the fitted home framing (also undoes Q/E rotation and zoom).
   * Battle: hand the camera back to the director.
   */
  resetCamera(): void {
    if (this.playback) this.camera.setMode('director');
    else {
      this.camera.setMode('rts');
      this.camera.home(this.seat);
    }
  }
  /**
   * Floating damage numbers: 'all' (every hit), 'important' (default: crits, skill hits, Lord hits and big
   * per-squad totals, about one figure a second per squad) or 'off'. Applies at once and to later battles;
   * stored as localStorage 'oathbound.render.damageNumbers'.
   */
  setDamageNumbers(mode: NumberMode): void {
    this.numberMode = mode;
    try {
      localStorage.setItem('oathbound.render.damageNumbers', mode);
    } catch {
      /* private mode: not stored */
    }
    if (this.playback) this.playback.damageNumbers = mode;
  }
  get damageNumbers(): NumberMode {
    return this.numberMode ?? 'important';
  }
  private numberMode: NumberMode | null = (() => {
    try {
      const v = localStorage.getItem('oathbound.render.damageNumbers');
      return v === 'all' || v === 'important' || v === 'off' ? v : null;
    } catch {
      return null;
    }
  })();
  setQuality(t: QualityTier | 'auto'): void {
    this.engine.setQuality(t);
  }
  /** Battery saver: low tier, DPR 1, 30 fps cap (stored). */
  setBatterySaver(on: boolean): void {
    this.engine.setBatterySaver(on);
  }
  /** Frame cap during battle: 0 = display refresh, 30 or 60 (stored). */
  setFpsCap(fps: 0 | 30 | 60): void {
    this.engine.setFpsCap(fps);
  }
  get stats(): Engine['stats'] & { soldiers: number; heroes: number } {
    const c = this.units.counts;
    return { ...this.engine.stats, soldiers: c.crowd, heroes: c.heroes };
  }

  // ------------------------------------------------------------------ frame

  /**
   * Top of a flier / large unit the lens would sit inside at (x, z), else -1e9: part of the camera's
   * smoothed floor (cursor-zooming onto a dragon ends above it, not in it).
   */
  private unitTop(x: number, z: number): number {
    let top = -1e9;
    if (!this.units) return top;
    for (const s of this.units.slots) {
      if (!s.visible || s.deadAt >= 0) continue;
      const big = !!s.hero && s.arch.chest > 2;
      if (s.arch.flyHeight <= 0 && !big) continue;
      const r = big ? 4.5 : 2.5;
      const dx = s.pos.x - x;
      const dz = s.pos.z - z;
      if (dx * dx + dz * dz > r * r) continue;
      top = Math.max(top, s.pos.y + s.lift + s.arch.chest * 1.5 + 0.5);
    }
    return top;
  }

  private frame(dt: number): void {
    const now = this.engine.time;
    // far zoom: soldiers grow a little so formations stay readable
    this.units.farScale = 1 + 0.3 * THREE.MathUtils.smoothstep(this.camera.dist, 55, 115);
    if (this.army) this.units.update(this.army.tf, now, now - this.lastFrame);
    this.lastFrame = now;
    const pb = this.playback;
    if (this.army) this.plates.sync(this.units.slots, null);
    else if (pb) this.plates.sync(this.units.slots, pb.tf.hp);
    else this.plates.hide();
    if (pb && pb.playing && !pb.ended) this.engine.markShadows(); // units move: shadow maps redraw
    for (const e of this.rings) if (e.squad !== null) this.placeRing(e);
    // a finished battle is a backdrop (results screen): lingering fires / smoke draw at <= 30 fps
    this.engine.backdrop = this.camera.mode === 'orbit' || (!!pb && pb.ended && !this.camera.busy);
    const speed = pb ? (pb.playing ? pb.speed : 0) : 1;
    if (this.vfx.update(dt * speed)) this.engine.wake();
    if (this.field.update(dt)) {
      this.engine.markShadows();
      this.engine.wake();
    }
    // castles / towers between the lens and the focus fade (the camera itself never lifts for them)
    if (this.field.fadeOccluders(this.engine.camera.position, this.camera.lookPoint, dt, this.planning ? this.zoneBack[this.planning.seat] : [])) this.engine.wake();
  }

  dispose(): void {
    this.stopBattle();
    this.plates.dispose();
    this.ghostMarks.mesh.removeFromParent();
    this.ghostMarks.dispose();
    this.camera.dispose();
    this.field.dispose();
    this.engine.dispose();
  }
}

export { fieldToWorld, worldToField, yawToFacing };
