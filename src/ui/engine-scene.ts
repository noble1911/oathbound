// SceneAdapter on the render agent's engine (src/render/index.ts: BattleView). The screens keep
// talking to SceneAdapter; this file is the whole mapping:
//   planning   → setPlanning (deploy zone + grid while placing), showArmy (army + ghostOwners +
//                the deploy preview as one more squad, highlight 'selected' / 'invalid'),
//                highlightSquads, pickGround / pickSquad, fieldToScreen, camera.claimPointer
//   battle     → playBattle(replaySource(decoded)) with onEvent / onEnd; speed and seek on the playback
//   camera     → rts / director / free / orbit; onUserControl / onReturnToDirector → onCameraMode
//   power      → setBatterySaver / setFpsCap; framesDrawn = engine.frames
// The attack-range ring is drawn here (a flat ring in the engine's scene); the engine has none.
//
// Viewer-relative sides: the engine paints seat 0 blue and seat 1 red. A seat-1 viewer therefore
// gets the match rotated half a turn with the owners swapped (src/ui/flip.ts; the field is its own
// mirror), so "my army is blue and at the bottom" holds for both seats. Everything crossing this
// seam is mapped (`in*` towards the engine, `out*` back); the screens only ever see sim coordinates.
import * as THREE from 'three';
import type { DecodedReplay, ReplayEvent, Seat, Terrain, Vec2 } from '../sim/types.ts';
import { sampleReplay, makeTransforms } from '../sim/index.ts';
import { BattleView, replaySource, type ArmySquad } from '../render/index.ts';
import type { CameraMode, PlaybackHandle, PreviewSpec, QualityChoice, RangeSpec, SceneAdapter, SceneMode, ScreenPoint, SquadVisual } from './scene-adapter.ts';
import { flipFacing, flipPos, flippedSource } from './flip.ts';

const PREVIEW_ID = -77;
/** Menu backdrops (the results orbit) draw at most this often. */
const BACKDROP_FPS = 10;

export class EngineScene implements SceneAdapter {
  readonly kind = 'engine' as const;
  readonly view: BattleView;
  readonly canvas: HTMLCanvasElement;
  onCameraMode: ((m: CameraMode) => void) | null = null;
  /** The viewer's seat (null = spectator, shown as seat 0). */
  private seat: Seat = 0;
  /** Seat-1 viewer: the engine sees everything rotated half a turn. */
  private flip = false;
  private spectator = false;
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
  private batterySaver = false;
  private v3 = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.view = new BattleView(host, { quality: 'auto', idleFps: 0, artManifest: 'models/v2/manifest.json', seat: 0 });
    this.canvas = this.view.engine.canvas;
    this.batterySaver = !!this.view.stats.batterySaver;
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

  // ---------------------------------------------------------------- viewer-relative mapping

  private inPos(p: Vec2): Vec2 {
    return this.flip ? flipPos(p) : p;
  }
  private inFacing(f: number): number {
    return this.flip ? flipFacing(f) : f;
  }
  private inSeat(s: Seat): Seat {
    return this.flip ? ((1 - s) as Seat) : s;
  }

  setMode(m: SceneMode): void {
    const was = this.mode;
    this.mode = m;
    const eng = this.view.engine as unknown as { backdropFps?: number };
    if (m === 'title' || m === 'lobby' || m === 'lordPick') {
      // painted backdrops cover the canvas on these screens: nothing to draw, so nothing is drawn
      this.view.setPlanning({ visible: false });
      this.view.setCameraMode('rts');
    } else if (m === 'results') {
      // the aftermath turns slowly behind the results card; no motion at all in battery saver
      if (this.batterySaver) this.view.setCameraMode('rts');
      else {
        if ('backdropFps' in eng) eng.backdropFps = BACKDROP_FPS;
        this.view.setCameraMode('orbit');
      }
    } else if (m === 'planning') {
      this.view.setPlanning({ visible: this.zoneSeat !== null, seat: this.zoneSeat !== null ? this.inSeat(this.zoneSeat) : 0, grid: !!this.preview });
      if (was !== 'planning') {
        this.view.setCameraMode('rts');
        this.resetCamera();
      }
    }
    if (m !== 'planning') this.setRange(null);
    this.view.engine.wake();
  }

  setPerspective(seat: Seat | null): void {
    const s = (seat ?? 0) as Seat;
    this.spectator = seat === null;
    if (s === this.seat) return;
    this.seat = s;
    this.flip = s === 1;
    // the engine always looks from seat 0's end; a seat-1 viewer's world is rotated instead
    this.rebuild();
  }

  setTerrain(t: Terrain): void {
    if (t.seed === this.terrainSeed) return;
    this.terrainSeed = t.seed;
    // the field is its own half-turn mirror, so the same features serve both viewers
    this.view.setTerrain(t);
  }

  setKeeps(hp: [number, number], max: [number, number]): void {
    for (const s of [0, 1] as Seat[]) {
      const f = hp[s] / Math.max(1, max[s]);
      const stage = f <= 0 ? 4 : f < 0.25 ? 3 : f < 0.5 ? 2 : f < 0.75 ? 1 : 0;
      const k = this.view.field.keep(this.inSeat(s));
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
    return g ? this.inPos([Math.round(g[0]), Math.round(g[1])]) : null;
  }

  /**
   * The squad under the pointer. A soldier under the cursor wins (the engine's ray pick); otherwise
   * the squad whose screen footprint holds the pointer: the box around every soldier's feet and
   * head as drawn, so the gaps inside a loose formation and airborne squads (whose models hang far
   * above their ground position) pick as well.
   */
  squadAt(x: number, y: number): { id: number; ghost: boolean } | null {
    const direct = this.view.pickSquad(x, y);
    if (direct !== null && direct !== PREVIEW_ID && direct !== this.hidden) return { id: direct, ghost: this.ghostIds.has(direct) };
    const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    const eng = this.view.engine;
    for (const s of this.view.units.slots) {
      if (!s.visible || s.deadAt >= 0) continue;
      const id = s.header.squad;
      if (id === PREVIEW_ID) continue;
      const top = Math.max(1.2, s.arch.chest * 1.7);
      // from the ground under the model (where its plate, ring and shadow sit) up to its head: an
      // airborne squad picks both at its ground position and where it is drawn
      const ground = Math.min(s.pos.y, this.view.field.heightAt(s.pos.x, s.pos.z));
      for (const y of [ground, s.pos.y + top]) {
        const p = eng.toScreen(this.v3.set(s.pos.x, y, s.pos.z));
        if (!p) continue;
        const b = boxes.get(id);
        if (!b) boxes.set(id, { x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        else {
          if (p.x < b.x0) b.x0 = p.x;
          if (p.x > b.x1) b.x1 = p.x;
          if (p.y < b.y0) b.y0 = p.y;
          if (p.y > b.y1) b.y1 = p.y;
        }
      }
    }
    let best: number | null = null;
    let bd = Infinity;
    for (const [id, b] of boxes) {
      // a lone model's two points make a sliver: give every box a body's width
      const padX = Math.max(10, 26 - (b.x1 - b.x0) / 2);
      const padY = 8;
      if (x < b.x0 - padX || x > b.x1 + padX || y < b.y0 - padY || y > b.y1 + padY) continue;
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      // own squads before ghosts when both hold the pointer
      const d = Math.hypot(x - cx, y - cy) + (this.ghostIds.has(id) ? 40 : 0);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best === null ? null : { id: best, ghost: this.ghostIds.has(best) };
  }

  showDeployZone(seat: Seat | null): void {
    this.zoneSeat = seat;
    this.view.setPlanning({ visible: seat !== null && this.mode === 'planning', seat: seat !== null ? this.inSeat(seat) : 0, grid: !!this.preview });
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
    if (grid && this.zoneSeat !== null) this.view.setPlanning({ visible: true, seat: this.inSeat(this.zoneSeat), grid: !!p });
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
      const add = (s: SquadVisual) => list.push({ id: s.id, owner: this.inSeat(s.owner), type: s.type, lord: s.lord ?? null, pos: this.inPos([s.pos[0], s.pos[1]]), facing: this.inFacing(s.facing), level: s.level });
      for (const s of this.army) if (s.id !== this.hidden) add(s);
      for (const s of this.ghosts ?? []) add(s);
      const p = this.preview;
      if (p) add({ id: PREVIEW_ID, type: p.type, lord: p.lord, owner: p.seat, pos: p.pos, facing: p.facing, level: 1 });
      const ghostOwners = this.ghosts?.length ? [this.inSeat(this.ghosts[0]!.owner)] : [];
      this.view.showArmy(list, { ghostOwners, highlight: this.highlights() });
    });
  }

  setRange(r: RangeSpec | null): void {
    this.ring.visible = !!r;
    this.minRing.visible = !!r && r.minRange > 0;
    if (r) {
      const c = this.inPos(r.pos);
      const place = (m: THREE.Mesh, rcm: number) => {
        const x = c[0] / 100 - 40;
        const z = 60 - c[1] / 100;
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
    const p = this.inPos(pos);
    return this.view.fieldToScreen(p[0], p[1], h);
  }

  cameraFocus(): { pos: Vec2; dist: number } | null {
    // world metres → field cm (core/coords.ts: X = x/100 − 40, Z = 60 − y/100)
    const t = this.view.camera.target;
    return { pos: this.inPos([(t.x + 40) * 100, (60 - t.z) * 100]), dist: this.view.camera.dist };
  }

  setInputLocked(_locked: boolean): void {
    /* the engine's camera asks setPointerClaim instead */
  }

  setPointerClaim(fn: ((e: PointerEvent) => boolean) | null): void {
    this.view.camera.claimPointer = fn;
  }

  /** Back to the home framing of the current screen (planning: the deploy zone inside the HUD insets). */
  resetCamera(): void {
    const v = this.view as unknown as { resetCamera?: () => void };
    if (this.spectator && !this.view.battle) {
      // a spectator watches both halves: the whole field, not one deploy zone
      this.view.setCameraMode('rts');
      this.view.camera.home(0, true);
    } else if (typeof v.resetCamera === 'function') v.resetCamera();
    else this.view.camera.home(0);
  }

  // ---------------------------------------------------------------- battle

  playReplay(d: DecodedReplay, o: { offsetMs: number; onEvent(e: ReplayEvent, ms: number): void; onEnd(): void }): PlaybackHandle {
    this.setRange(null);
    let src;
    let onEvent = o.onEvent;
    if (this.flip) {
      const f = flippedSource(d, sampleReplay, makeTransforms);
      src = f;
      onEvent = (e, ms) => o.onEvent(f.original.get(e) ?? e, ms);
    } else src = replaySource(d, sampleReplay, makeTransforms);
    const pb = this.view.playBattle(src, { onEvent, onEnd: o.onEnd, damageNumbers: 'important', director: true });
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

  /** Explicit, both ways: the UI owns the C key (the rig's own toggle only ever went one way). */
  setCameraMode(m: CameraMode): void {
    this.view.setCameraMode(m === 'director' ? 'director' : 'free');
  }

  cameraMode(): CameraMode {
    return this.view.camera.mode === 'director' ? 'director' : 'free';
  }

  setPower(p: { batterySaver?: boolean; fpsCap?: number }): void {
    if (p.batterySaver !== undefined) {
      this.batterySaver = p.batterySaver;
      this.view.setBatterySaver(p.batterySaver);
      if (this.mode === 'results') this.setMode('results');
    }
    if (p.fpsCap !== undefined) this.view.setFpsCap(p.fpsCap as 0 | 30 | 60);
  }

  power(): { batterySaver: boolean; fpsCap: number } {
    const s = this.view.stats;
    return { batterySaver: !!s.batterySaver, fpsCap: s.fpsCap || 0 };
  }

  setQuality(q: QualityChoice): void {
    this.view.setQuality(q);
  }

  quality(): { choice: QualityChoice; tier: string } {
    const s = this.view.stats;
    return { choice: s.auto ? 'auto' : (s.tier as QualityChoice), tier: s.tier };
  }

  dispose(): void {
    this.view.dispose();
  }
}
