// SceneAdapter on the render agent's engine (src/render/index.ts: BattleView). The screens keep
// talking to SceneAdapter; this file is the whole mapping:
//   planning   → setPlanning (deploy zone + grid while placing), showArmy (army + ghostOwners +
//                the deploy preview as one more squad, highlight 'selected' / 'invalid'),
//                highlightSquads, pickGround / pickSquad, fieldToScreen, camera.claimPointer
//   battle     → playBattle(replaySource(decoded)) with onEvent / onEnd; speed and seek on the playback
//   camera     → rts / director / free / orbit; onUserControl / onReturnToDirector → onCameraMode
//   power      → setBatterySaver / setFpsCap; framesDrawn = engine.frames
// The attack-range ring is drawn here (a flat ring in the engine's scene); the engine has none.
import * as THREE from 'three';
import type { DecodedReplay, ReplayEvent, Seat, Terrain, Vec2 } from '../sim/types.ts';
import { sampleReplay, makeTransforms } from '../sim/index.ts';
import { BattleView, replaySource, type ArmySquad } from '../render/index.ts';
import type { CameraMode, PlaybackHandle, PreviewSpec, RangeSpec, SceneAdapter, SceneMode, ScreenPoint, SquadVisual } from './scene-adapter.ts';

const PREVIEW_ID = -77;

export class EngineScene implements SceneAdapter {
  readonly kind = 'engine' as const;
  readonly view: BattleView;
  readonly canvas: HTMLCanvasElement;
  onCameraMode: ((m: CameraMode) => void) | null = null;
  private seat: Seat = 0;
  private mode: SceneMode = 'title';
  private terrainSeed = -1;
  private army: SquadVisual[] = [];
  private ghosts: SquadVisual[] | null = null;
  private ghostIds = new Set<number>();
  private preview: PreviewSpec | null = null;
  private hidden: number | null = null;
  private selected: number | null = null;
  private hovered: number | null = null;
  private zoneSeat: Seat | null = null;
  private ring: THREE.Mesh;
  private minRing: THREE.Mesh;
  private pending = false;

  constructor(host: HTMLElement) {
    this.view = new BattleView(host, { quality: 'auto', idleFps: 0, artManifest: 'models/v2/manifest.json', seat: 0 });
    this.canvas = this.view.engine.canvas;
    const mk = (color: string, inner: number) => {
      const g = new THREE.RingGeometry(inner, 1, 96);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, depthTest: false }));
      m.renderOrder = 10;
      m.visible = false;
      this.view.engine.scene.add(m);
      return m;
    };
    this.ring = mk('#ffd77a', 0.985);
    this.minRing = mk('#ff6a5a', 0.975);
    this.view.camera.onUserControl = () => this.mode === 'battle' && this.onCameraMode?.('free');
    this.view.camera.onReturnToDirector = () => this.mode === 'battle' && this.onCameraMode?.('director');
  }

  get framesDrawn(): number {
    return this.view.engine.frames;
  }

  setMode(m: SceneMode): void {
    const was = this.mode;
    this.mode = m;
    if (m === 'title' || m === 'lobby' || m === 'lordPick') {
      this.view.setPlanning({ visible: false });
      this.view.setCameraMode('orbit');
    } else if (m === 'planning') {
      this.view.setPlanning({ visible: this.zoneSeat !== null, seat: this.zoneSeat ?? this.seat, grid: !!this.preview });
      if (was !== 'planning') {
        this.view.setCameraMode('rts');
        this.view.camera.home(this.seat);
      }
    }
    if (m !== 'planning') this.setRange(null);
    this.view.engine.wake();
  }

  setPerspective(seat: Seat | null): void {
    const s = (seat ?? 0) as Seat;
    if (s === this.seat) return;
    this.seat = s;
    this.view.setSeat(s);
  }

  setTerrain(t: Terrain): void {
    if (t.seed === this.terrainSeed) return;
    this.terrainSeed = t.seed;
    this.view.setTerrain(t);
  }

  setKeeps(hp: [number, number], max: [number, number]): void {
    for (const s of [0, 1] as Seat[]) {
      const f = hp[s] / Math.max(1, max[s]);
      const stage = f <= 0 ? 4 : f < 0.25 ? 3 : f < 0.5 ? 2 : f < 0.75 ? 1 : 0;
      const k = this.view.field.keep(s);
      if (k.stage !== stage) k.setStage(stage);
    }
    this.view.engine.wake();
  }

  setInsets(i: { left?: number; right?: number; top?: number; bottom?: number }): void {
    this.view.engine.setInsets(i);
  }

  // ---------------------------------------------------------------- planning

  groundAt(x: number, y: number): Vec2 | null {
    // the sim wants integer centimetres
    const g = this.view.pickGround(x, y);
    return g ? [Math.round(g[0]), Math.round(g[1])] : null;
  }

  squadAt(x: number, y: number): { id: number; ghost: boolean } | null {
    const id = this.view.pickSquad(x, y);
    if (id === null || id === PREVIEW_ID) return null;
    return { id, ghost: this.ghostIds.has(id) };
  }

  showDeployZone(seat: Seat | null): void {
    this.zoneSeat = seat;
    this.view.setPlanning({ visible: seat !== null && this.mode === 'planning', seat: seat ?? this.seat, grid: !!this.preview });
  }

  setArmy(squads: SquadVisual[]): void {
    this.army = squads;
    this.rebuild();
  }

  setGhosts(squads: SquadVisual[] | null): void {
    this.ghosts = squads;
    this.ghostIds = new Set((squads ?? []).map((s) => s.id));
    this.rebuild();
  }

  setPreview(p: PreviewSpec | null): void {
    const grid = !!p !== !!this.preview;
    this.preview = p;
    if (grid && this.zoneSeat !== null) this.view.setPlanning({ visible: true, seat: this.zoneSeat, grid: !!p });
    this.rebuild();
  }

  setHidden(id: number | null): void {
    if (this.hidden === id) return;
    this.hidden = id;
    this.rebuild();
  }

  setSelected(id: number | null): void {
    this.selected = id;
    this.highlight();
  }

  setHovered(id: number | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.highlight();
  }

  private highlights(): Record<number, 'hover' | 'selected' | 'invalid'> {
    const h: Record<number, 'hover' | 'selected' | 'invalid'> = {};
    if (this.hovered !== null) h[this.hovered] = 'hover';
    if (this.selected !== null) h[this.selected] = 'selected';
    if (this.preview) h[PREVIEW_ID] = this.preview.valid ? 'selected' : 'invalid';
    return h;
  }

  private highlight(): void {
    if (this.view.battle) return;
    this.view.highlightSquads(this.highlights());
  }

  /** One showArmy per animation frame at most (drag previews move every pointer event). */
  private rebuild(): void {
    if (this.view.battle || this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (this.view.battle) return;
      const list: ArmySquad[] = [];
      const add = (s: SquadVisual) => list.push({ id: s.id, owner: s.owner, type: s.type, lord: s.lord ?? null, pos: [s.pos[0], s.pos[1]], facing: s.facing, level: s.level });
      for (const s of this.army) if (s.id !== this.hidden) add(s);
      for (const s of this.ghosts ?? []) add(s);
      const p = this.preview;
      if (p) add({ id: PREVIEW_ID, type: p.type, lord: p.lord, owner: p.seat, pos: p.pos, facing: p.facing, level: 1 });
      const ghostOwners = this.ghosts?.length ? [this.ghosts[0]!.owner] : [];
      this.view.showArmy(list, { ghostOwners, highlight: this.highlights() });
    });
  }

  setRange(r: RangeSpec | null): void {
    this.ring.visible = !!r;
    this.minRing.visible = !!r && r.minRange > 0;
    if (r) {
      const place = (m: THREE.Mesh, rcm: number) => {
        const x = r.pos[0] / 100 - 40;
        const z = 60 - r.pos[1] / 100;
        m.position.set(x, this.view.field.heightAt(x, z) + 0.2, z);
        m.scale.set(rcm / 100, 1, rcm / 100);
      };
      (this.ring.material as THREE.MeshBasicMaterial).color.set(r.enemy ? '#ff6a5a' : '#ffd77a');
      place(this.ring, Math.max(150, r.range));
      if (r.minRange) place(this.minRing, r.minRange);
    }
    this.view.engine.wake();
  }

  toScreen(pos: Vec2, h = 0): ScreenPoint | null {
    return this.view.fieldToScreen(pos[0], pos[1], h);
  }

  setInputLocked(_locked: boolean): void {
    /* the engine's camera asks setPointerClaim instead */
  }

  setPointerClaim(fn: ((e: PointerEvent) => boolean) | null): void {
    this.view.camera.claimPointer = fn;
  }

  // ---------------------------------------------------------------- battle

  playReplay(d: DecodedReplay, o: { offsetMs: number; onEvent(e: ReplayEvent, ms: number): void; onEnd(): void }): PlaybackHandle {
    this.setRange(null);
    const pb = this.view.playBattle(replaySource(d, sampleReplay, makeTransforms), { onEvent: o.onEvent, onEnd: o.onEnd, damageNumbers: 'important', director: true });
    if (o.offsetMs > 0) pb.seek(o.offsetMs);
    return {
      get speed() { return pb.speed; },
      set speed(v: number) { pb.speed = v; },
      get timeMs() { return pb.timeMs; },
      get durationMs() { return pb.durationMs; },
      seek: (ms: number) => pb.seek(ms),
      stop: () => (pb.playing = false),
    };
  }

  clearReplay(): void {
    this.view.stopBattle();
    this.rebuild();
  }

  setCameraMode(m: CameraMode): void {
    if (m === 'director') this.view.camera.returnToDirector();
    else this.view.setCameraMode('free');
  }

  setPower(p: { batterySaver?: boolean; fpsCap?: number }): void {
    if (p.batterySaver !== undefined) this.view.setBatterySaver(p.batterySaver);
    if (p.fpsCap !== undefined) this.view.setFpsCap(p.fpsCap as 0 | 30 | 60);
  }

  dispose(): void {
    this.view.dispose();
  }
}
