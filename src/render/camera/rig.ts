// Camera rig: an orbit parameterisation (target on the ground, yaw, distance; pitch follows a tilt
// curve of the zoom unless a shot overrides it) with critically-damped smoothing.
//
// Modes:
//   'rts'      — planning: WASD/arrows/edge pan, wheel zoom (tilt curve), Q/E or right-drag rotate,
//                middle-drag pan, touch pan/pinch/twist; clamped to the battlefield.
//   'director' — battle: the Director drives `shot()`s; any manual input switches to 'free'.
//   'free'     — battle under user control (same controls as rts); `setMode('director')` /
//                `returnToDirector()` hands back. The rig binds no mode keys: the UI owns C / Home
//                and calls `setMode` / `BattleView.resetCamera()`.
//   'orbit'    — slow automatic orbit around the target (title / loot screen backdrops).
// Obstacles never lift a player camera (rts / free / orbit): its height and pitch are pure orbit maths,
// with only a smoothed floor keeping the lens out of the ground and of solid geometry. Castles and
// towers that sit between the lens and the focus fade, leaves near the lens erode. The director may
// raise its pitch to clear crowns, by at most `maxLift`.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';

export type CameraMode = 'rts' | 'director' | 'free' | 'orbit';

export interface Shot {
  target: THREE.Vector3;
  yaw: number;
  dist: number;
  /** Radians above the horizon; omitted = tilt curve. */
  pitch?: number;
  fov?: number;
  /** Over `dur` seconds, move to these (dolly / pan). */
  toTarget?: THREE.Vector3;
  toYaw?: number;
  toDist?: number;
  toPitch?: number;
  dur?: number;
  /** true = jump there instantly (a cut); false = glide with the rig smoothing. */
  cut?: boolean;
  /** Depth of field strength 0..1 (focus at the target). */
  dof?: number;
}

const MIN_DIST = 9;
/** Planning home view: radians above the horizon (0.78 = a ~45 degree battlefield shot, not a map view). */
const HOME_PITCH = 0.78;
/** Zoom-out stops where the dressed world still fills the frame (the home fit needs <= ~130 m). */
const MAX_DIST = 140;

export class CameraRig {
  mode: CameraMode = 'rts';
  readonly target = new THREE.Vector3(0, 0, 30);
  yaw = 0;
  dist = 95;
  pitch = 1.0;
  fov = 34;
  readonly goal = { target: new THREE.Vector3(0, 0, 30), yaw: 0, dist: 95, pitch: NaN as number, fov: 34 };
  /** Per-axis smoothing rate (1/s). */
  smoothing = 7;
  /** Bounds for the target (world XZ). */
  bounds = { minX: -48, maxX: 48, minZ: -72, maxZ: 72 };
  /** The player's home yaw (0 = seat 0's side; π = seat 1's). */
  homeYaw = 0;
  /** The yaw the player last used in planning: the free battle camera starts from it. */
  planYaw = 0;
  /** World z the home view must reach on the enemy side (null = the enemy deploy-zone front edge). */
  private homeFar: number | null = null;
  /** The current view is the fitted home framing (re-fitted when the viewport / HUD insets change). */
  private atHome: { seat: 0 | 1; overview: boolean } | null = null;
  /** Edge pan arms only after the pointer has really moved since the last home / mode change. */
  private edgeArmed = false;
  private edgeTravel = 0;
  private edgeDwell = 0;
  edgePan = true;
  dofAmount = 0;
  dofGoal = 0;
  /** Notified when the user takes control during battle. */
  onUserControl: (() => void) | null = null;
  onReturnToDirector: (() => void) | null = null;

  private shot: { s: Shot; t: number; from: { target: THREE.Vector3; yaw: number; dist: number; pitch: number } } | null = null;
  private keys = new Set<string>();
  private drag: { id: number; x: number; y: number; button: number; moved: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; a: number; cx: number; cy: number } | null = null;
  private mouse = { x: -1, y: -1, inside: false };
  private readonly engine: Engine;
  private ground: (x: number, z: number) => number = () => 0;
  /** Obstacle tops for the director's line of sight (tree crowns, ruins, towers, castle bodies). */
  private obstacle: (x: number, z: number) => number = () => -1e9;
  /** Solid tops (ruins, towers, castle bodies; no foliage): no camera ever sits inside these. */
  private solid: (x: number, z: number) => number = () => -1e9;
  /** Smoothed minimum camera height (ground / solids under the camera): no popping while panning. */
  private floorY = -1e9;
  /** The point the camera looks at (world), updated every frame. */
  readonly lookPoint = new THREE.Vector3();
  /** Director only: the most extra pitch (rad) the line-of-sight lift may add to a shot. */
  maxLift = 0.3;
  /** Extra pitch (rad) currently added to clear obstacles; eases in fast, out slowly. */
  private lift = 0;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  /** Metres the camera keeps above any obstacle top below / near it. */
  clearance = 3;
  /** Return true from this to claim a pointer-down (e.g. the UI drags a squad). */
  claimPointer: ((e: PointerEvent) => boolean) | null = null;
  private abort = new AbortController();

  constructor(engine: Engine) {
    this.engine = engine;
    this.bindInput();
    engine.beforeRender.add((dt) => this.update(dt));
    engine.onResize.add(() => {
      if (this.atHome && this.mode === 'rts') this.fitHome(this.atHome.seat, this.atHome.overview);
    });
  }

  setGround(fn: (x: number, z: number) => number): void {
    this.ground = fn;
  }
  /**
   * `fn`: obstacle tops for the director's line of sight; `solid`: tops of solid geometry only (the
   * player's cameras ignore foliage and never lift for the line of sight: occluding castles fade and
   * leaves near the lens erode instead; see Battlefield.fadeOccluders / foliage.ts).
   */
  setObstacles(fn: (x: number, z: number) => number, solid?: (x: number, z: number) => number): void {
    if (solid) this.solid = solid;
    this.obstacle = fn;
  }

  /** Camera position for an orbit (no lift / clamps). */
  orbitPosition(target: THREE.Vector3, yaw: number, pitch: number, dist: number, out = new THREE.Vector3()): THREE.Vector3 {
    const ty = this.ground(target.x, target.z) + 1.2 + target.y;
    const cp = Math.cos(pitch);
    return out.set(target.x + Math.sin(yaw) * cp * dist, ty + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * cp * dist);
  }

  /**
   * How blocked a view is: the fraction of samples along camera → look point (and around the camera)
   * that are inside an obstacle (crown / prop top above the sample, with a margin). 0 = clear.
   * `nearOnly` checks only the first 12 m from the camera (manual cameras: don't fight the player).
   */
  blocked(cam: THREE.Vector3, look: THREE.Vector3, nearOnly = false): number {
    const len = cam.distanceTo(look);
    const n = 16;
    let hits = 0;
    let total = 0;
    const p = this.tmpA;
    // a shot aimed at an obstacle (a keep, a ruin) is not blocked by its own subject: samples in
    // the subject's footprint don't count (otherwise the rig lifts to a top-down view and ends on the roof)
    const subject = this.obstacle(look.x, look.z) > look.y ? 15 : 0;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * (nearOnly ? Math.min(1, 12 / Math.max(1, len)) : 0.85);
      p.lerpVectors(cam, look, t);
      total++;
      if (i > 0 && subject && Math.hypot(p.x - look.x, p.z - look.z) < subject) continue;
      const margin = i === 0 ? this.clearance : 0.6;
      if (this.obstacle(p.x, p.z) > p.y - margin) hits++;
    }
    // the camera's own neighbourhood (near plane / wide FOV edges)
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
      total++;
      if (this.obstacle(cam.x + dx, cam.z + dz) > cam.y - 1.5) hits++;
    }
    // the near view cone (3/6/9 m out, a ring spanning the frustum width): nothing may poke into it
    const dir = this.tmpDir.subVectors(look, cam).normalize();
    for (const d of [3, 6, 9]) {
      const r = d * 0.62;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        // lateral (horizontal) and vertical offsets around the axis
        p.copy(cam).addScaledVector(dir, d);
        p.x += Math.cos(a) * r * Math.cos(Math.atan2(dir.z, dir.x) + Math.PI / 2);
        p.z += Math.cos(a) * r * Math.sin(Math.atan2(dir.z, dir.x) + Math.PI / 2);
        p.y += Math.sin(a) * r * 0.6;
        total++;
        if (this.obstacle(p.x, p.z) > p.y - 0.5) hits++;
      }
    }
    return hits / total;
  }

  /** Tilt curve: low and cinematic when close, top-down-ish when far. */
  tilt(dist: number): number {
    const k = THREE.MathUtils.clamp((dist - MIN_DIST) / (MAX_DIST - MIN_DIST), 0, 1);
    return THREE.MathUtils.lerp(0.5, 1.12, Math.sqrt(k));
  }

  /**
   * The one place the mode changes (the UI cycles director <-> free through this; the rig binds no
   * mode keys itself). Leaving planning remembers its yaw; entering 'free' starts from that yaw
   * (not from wherever the director's last shot pointed).
   */
  setMode(m: CameraMode): void {
    const was = this.mode;
    if (was === 'rts' && m !== 'rts') this.planYaw = this.goal.yaw;
    this.mode = m;
    this.engine.backdrop = m === 'orbit'; // title / loot backdrops render at <= 30 fps
    if (m !== 'director') this.shot = null;
    if (m === 'rts' || m === 'free') this.dofGoal = 0;
    if (m === 'free' && was !== 'free') this.inheritPlanYaw();
    if (m !== 'rts') this.atHome = null;
    if (m !== was) this.disarmEdge();
    if (m === 'director' && was === 'free') this.onReturnToDirector?.();
    this.engine.wake();
  }

  returnToDirector(): void {
    if (this.mode === 'free') this.setMode('director');
  }

  /** Point the goal yaw at the planning yaw (the equivalent angle nearest the current one: no spin). */
  private inheritPlanYaw(): void {
    const d = Math.atan2(Math.sin(this.planYaw - this.yaw), Math.cos(this.planYaw - this.yaw));
    this.goal.yaw = this.yaw + d;
    this.goal.pitch = NaN;
  }

  private disarmEdge(): void {
    this.edgeArmed = false;
    this.edgeTravel = 0;
    this.edgeDwell = 0;
  }

  /**
   * Frame the home view for planning (seat 0 looks from +Z, seat 1 from -Z) and restore the home
   * rotation: a low battlefield shot (HOME_PITCH, ~45 degrees) of the deploy zone, the river and
   * the enemy front line between the HUD insets at any aspect (4:3 .. 32:9). The own Keep and the
   * last few metres of the zone in front of it are cropped at the bottom (scroll back to reach
   * them; whatever of the Keep / towers still overlaps the zone is ghosted by the field). Re-fitted when the viewport or the insets change,
   * until the player moves the camera. `overview` frames the whole field instead.
   */
  home(seat: 0 | 1 = 0, overview = false): void {
    this.homeYaw = seat === 0 ? 0 : Math.PI;
    this.planYaw = this.homeYaw;
    // unwind any accumulated rotation (orbit backdrops, Q/E) so the glide home takes the short way
    this.yaw = this.homeYaw + Math.atan2(Math.sin(this.yaw - this.homeYaw), Math.cos(this.yaw - this.homeYaw));
    this.fitHome(seat, overview);
    this.atHome = { seat, overview };
    this.disarmEdge();
  }

  /** Extend (or reset with null) the far edge of the home framing; re-fits if the camera is at home. */
  setHomeFar(z: number | null): void {
    if (z === this.homeFar) return;
    this.homeFar = z;
    if (this.atHome && this.mode === 'rts') this.fitHome(this.atHome.seat, this.atHome.overview);
  }

  /** Solve target + distance so the home rectangle (on the ground plane) fills the free viewport. */
  private fitHome(seat: 0 | 1, overview: boolean): void {
    const sgn = seat === 0 ? 1 : -1;
    // near edge: 6 m short of the zone's back line (the Keep stays out of frame); far edge: the
    // enemy front line (their deploy-zone edge). The width has to fit up to 16 m short of the back line:
    // the nearest corners may run off the sides on narrow screens.
    const zNear = (overview ? 63 : 50) * sgn;
    // (never nearer than the enemy front line, never beyond the enemy Keep)
    const far = this.homeFar === null ? -21 : Math.max(-63, Math.min(-21, this.homeFar * sgn));
    const zFar = (overview ? -63 : far) * sgn;
    const zWide = (overview ? 63 : 40) * sgn;
    const halfX = 41;
    const pitch = overview ? 0.86 : HOME_PITCH;
    const tanV = Math.tan(THREE.MathUtils.degToRad(34 / 2));
    const tanH = tanV * Math.max(0.2, this.engine.camera.aspect);
    const margin = 0.04;
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    // NDC of a ground point for the home yaw: the camera sits at target + (0, sp, sgn * cp) * dist
    const ndc = (tz: number, dist: number, x: number, z: number): [number, number] => {
      const vy = -(sp * dist + 1.2);
      const vz = z - (tz + sgn * cp * dist);
      const depth = Math.max(1e-3, vy * -sp + vz * -sgn * cp);
      const up = vy * cp + vz * -sgn * sp;
      return [x / (depth * tanH), up / (depth * tanV)];
    };
    const fit = (dist: number): { tz: number; ok: boolean } => {
      // centre the rectangle vertically: bisect the target between the two edges until top and bottom balance
      let a = zNear;
      let b = zFar;
      let top = 0;
      let bot = 0;
      let tz = 0;
      for (let i = 0; i < 24; i++) {
        tz = (a + b) / 2;
        top = ndc(tz, dist, 0, zFar)[1];
        bot = ndc(tz, dist, 0, zNear)[1];
        // the rectangle sits too high on screen: aim further away (towards the far edge)
        if (top + bot > 0) a = tz;
        else b = tz;
      }
      const wide = Math.max(Math.abs(ndc(tz, dist, halfX, zWide)[0]), Math.abs(ndc(tz, dist, halfX, zFar)[0]));
      return { tz, ok: top <= 1 - margin && bot >= -(1 - margin) && wide <= 1 - margin };
    };
    let lo = 30;
    let hi = MAX_DIST;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (fit(mid).ok) hi = mid;
      else lo = mid;
    }
    this.goal.target.set(0, 0, fit(hi).tz);
    this.goal.yaw = this.homeYaw;
    this.goal.dist = hi;
    this.goal.pitch = pitch;
    this.goal.fov = 34;
    this.engine.wake();
  }

  /** Jump immediately to the goal (no smoothing). */
  snap(): void {
    this.target.copy(this.goal.target);
    this.yaw = this.goal.yaw;
    this.dist = this.goal.dist;
    this.pitch = Number.isNaN(this.goal.pitch) ? this.tilt(this.dist) : this.goal.pitch;
    this.engine.wake();
  }

  /** Play a director shot. */
  play(s: Shot): void {
    const from = { target: this.target.clone(), yaw: this.yaw, dist: this.dist, pitch: this.pitch };
    this.shot = { s, t: 0, from };
    this.goal.target.copy(s.target);
    this.goal.yaw = s.yaw;
    this.goal.dist = s.dist;
    this.goal.pitch = s.pitch ?? NaN;
    this.goal.fov = s.fov ?? 34;
    this.dofGoal = s.dof ?? 0;
    if (s.cut) this.snap();
    this.engine.wake();
  }

  get busy(): boolean {
    const g = this.goal;
    const gp = Number.isNaN(g.pitch) ? this.tilt(g.dist) : g.pitch;
    return (
      this.keys.size > 0 ||
      this.mode === 'orbit' ||
      !!this.shot ||
      this.target.distanceToSquared(g.target) > 1e-4 ||
      Math.abs(this.yaw - g.yaw) > 1e-4 ||
      Math.abs(this.dist - g.dist) > 1e-3 ||
      Math.abs(this.pitch - gp) > 1e-4 ||
      Math.abs(this.fov - g.fov) > 1e-3 ||
      Math.abs(this.dofAmount - this.dofGoal) > 1e-3 ||
      (this.edgePan && this.edgeVector().lengthSq() > 0)
    );
  }

  // ------------------------------------------------------------------ manual control

  private userInput(): void {
    this.atHome = null;
    if (this.mode === 'director') {
      this.mode = 'free';
      this.shot = null;
      this.dofGoal = 0;
      this.inheritPlanYaw();
      this.onUserControl?.();
    }
  }
  private get manual(): boolean {
    return this.mode === 'rts' || this.mode === 'free' || this.mode === 'director';
  }

  panBy(dx: number, dz: number): void {
    // dx/dz in screen-aligned metres (right, forward)
    const c = Math.cos(this.goal.yaw);
    const s = Math.sin(this.goal.yaw);
    this.goal.target.x += dx * c + dz * -s;
    this.goal.target.z += -dx * s + dz * -c;
    this.clampGoal();
    this.engine.wake();
  }
  rotateBy(da: number): void {
    this.goal.yaw += da;
    this.engine.wake();
  }
  /** Zoom by factor `f`; with a cursor position (client px) the ground point under it stays put. */
  zoomBy(f: number, clientX?: number, clientY?: number): void {
    const d0 = this.goal.dist;
    const d1 = THREE.MathUtils.clamp(d0 * f, MIN_DIST, MAX_DIST);
    if (clientX !== undefined && clientY !== undefined && d1 !== d0) {
      const p = this.groundUnder(clientX, clientY);
      if (p) {
        // an orbit camera scales about its target: scaling the target about P keeps P under the cursor
        const k = d1 / d0;
        this.goal.target.x = p.x + (this.goal.target.x - p.x) * k;
        this.goal.target.z = p.z + (this.goal.target.z - p.z) * k;
        this.clampGoal();
      }
    }
    this.goal.dist = d1;
    this.goal.pitch = NaN;
    this.engine.wake();
  }

  /** The point on the look plane (target height) under a client position, or null above the horizon. */
  private groundUnder(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.engine.canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cam = this.engine.camera;
    const o = cam.position;
    const d = this.tmpA.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1), 0.5).unproject(cam).sub(o).normalize();
    const y = this.ground(this.target.x, this.target.z) + 1.2 + this.target.y;
    if (d.y > -0.05) return null;
    const t = (y - o.y) / d.y;
    if (t <= 0 || t > 600) return null;
    return new THREE.Vector3(o.x + d.x * t, y, o.z + d.z * t);
  }
  private clampGoal(): void {
    const b = this.bounds;
    this.goal.target.x = THREE.MathUtils.clamp(this.goal.target.x, b.minX, b.maxX);
    this.goal.target.z = THREE.MathUtils.clamp(this.goal.target.z, b.minZ, b.maxZ);
  }

  private edge = new THREE.Vector2();
  private look = new THREE.Vector3();
  private edgeVector(): THREE.Vector2 {
    const v = this.edge.set(0, 0);
    // only once the pointer has really moved since the last home / mode change, and only at the
    // very edge of the canvas (a pointer parked under a HUD bar must not drag the view away)
    if (!this.mouse.inside || !this.edgeArmed || this.drag || this.mode === 'director' || this.mode === 'orbit') return v;
    const r = this.engine.canvas.getBoundingClientRect();
    const m = 4;
    if (this.mouse.x - r.left < m) v.x = -1;
    else if (r.right - this.mouse.x < m) v.x = 1;
    if (this.mouse.y - r.top < m) v.y = 1;
    else if (r.bottom - this.mouse.y < m) v.y = -1;
    return v;
  }

  private bindInput(): void {
    const c = this.engine.canvas;
    const sig = { signal: this.abort.signal };
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '+', '-', '='].includes(k)) {
        if (!this.manual) return;
        this.keys.add(k);
        this.userInput();
        this.engine.wake();
      }
    }, sig);
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()), sig);
    window.addEventListener('blur', () => this.keys.clear(), sig);
    c.addEventListener('contextmenu', (e) => e.preventDefault(), sig);
    c.addEventListener('pointerdown', (e) => {
      if (!this.manual) return;
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size === 2) {
          const [a, b] = [...this.touches.values()];
          this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
          this.drag = null;
          return;
        }
      }
      if (e.button === 0 && this.claimPointer?.(e)) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.pointerType === 'touch' ? 1 : e.button, moved: 0 };
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
    }, sig);
    c.addEventListener('pointermove', (e) => {
      if (this.mouse.inside) this.edgeTravel += Math.abs(e.clientX - this.mouse.x) + Math.abs(e.clientY - this.mouse.y);
      if (this.edgeTravel > 40) this.edgeArmed = true;
      this.mouse = { x: e.clientX, y: e.clientY, inside: true };
      if (this.edgePan && this.edgeVector().lengthSq() > 0) this.engine.wake();
      if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size === 2 && this.pinch) {
          const [a, b] = [...this.touches.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          this.zoomBy(this.pinch.d / Math.max(1, d));
          this.rotateBy(ang - this.pinch.a);
          this.pinch.d = d;
          this.pinch.a = ang;
          this.userInput();
          return;
        }
      }
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.moved < 4) return;
      this.userInput();
      const h = this.engine.canvas.clientHeight || 1;
      const metresPerPx = (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.fov / 2))) / h;
      if (d.button === 2) {
        this.rotateBy(-dx * 0.005);
        this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(dy * 0.003), MIN_DIST, MAX_DIST);
      } else this.panBy(-dx * metresPerPx, dy * metresPerPx * 1.4);
    }, sig);
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    c.addEventListener('pointerup', up, sig);
    c.addEventListener('pointercancel', up, sig);
    c.addEventListener('pointerleave', () => (this.mouse.inside = false), sig);
    // the pointer left the window (the canvas gets no pointerleave when a HUD element was in between)
    document.addEventListener('mouseleave', () => (this.mouse.inside = false), sig);
    window.addEventListener('blur', () => (this.mouse.inside = false), sig);
    c.addEventListener('wheel', (e) => {
      if (!this.manual) return;
      e.preventDefault();
      this.userInput();
      this.zoomBy(Math.exp(e.deltaY * 0.0011), e.clientX, e.clientY);
    }, { passive: false, signal: this.abort.signal });
  }

  // ------------------------------------------------------------------ per frame

  private update(dt: number): void {
    const g = this.goal;
    // keyboard / edge pan
    if (this.manual && this.mode !== 'director') {
      const sp = (this.dist * 0.9 + 12) * dt;
      let px = 0;
      let pz = 0;
      if (this.keys.has('w') || this.keys.has('arrowup')) pz += 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) pz -= 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) px -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) px += 1;
      const ev = this.edgeVector();
      // edge pan starts after a short dwell (crossing the edge on the way to a HUD button doesn't pan)
      this.edgeDwell = ev.lengthSq() > 0 ? this.edgeDwell + dt : 0;
      if (this.edgeDwell > 0.3) {
        px += ev.x;
        pz += ev.y;
      }
      if (px || pz) {
        this.atHome = null;
        this.panBy(px * sp, pz * sp);
      }
      if (this.keys.has('q')) this.rotateBy(dt * 1.4);
      if (this.keys.has('e')) this.rotateBy(-dt * 1.4);
      if (this.mode === 'rts') this.planYaw = g.yaw;
      if (this.keys.has('+') || this.keys.has('=')) this.zoomBy(Math.exp(-dt * 1.5));
      if (this.keys.has('-')) this.zoomBy(Math.exp(dt * 1.5));
    }
    if (this.mode === 'orbit') g.yaw += dt * 0.06;
    // director shot animation (dolly / pan over the shot duration)
    if (this.shot) {
      const sh = this.shot;
      sh.t += dt;
      const s = sh.s;
      const k = s.dur ? easeInOut(Math.min(1, sh.t / s.dur)) : 1;
      if (s.toTarget) g.target.lerpVectors(s.target, s.toTarget, k);
      if (s.toYaw !== undefined) g.yaw = s.yaw + (s.toYaw - s.yaw) * k;
      if (s.toDist !== undefined) g.dist = s.dist + (s.toDist - s.dist) * k;
      if (s.toPitch !== undefined) g.pitch = (s.pitch ?? this.tilt(s.dist)) + (s.toPitch - (s.pitch ?? this.tilt(s.dist))) * k;
      if (s.cut) {
        // a cut moves rigidly with its dolly (no lag)
        this.target.copy(g.target);
        this.yaw = g.yaw;
        this.dist = g.dist;
        if (!Number.isNaN(g.pitch)) this.pitch = g.pitch;
      }
      if (!s.dur || sh.t >= s.dur) this.shot = null;
    }
    const kk = 1 - Math.exp(-dt * this.smoothing);
    this.target.lerp(g.target, kk);
    this.yaw += (g.yaw - this.yaw) * kk;
    this.dist += (g.dist - this.dist) * kk;
    const gp = Number.isNaN(g.pitch) ? this.tilt(this.dist) : g.pitch;
    this.pitch += (gp - this.pitch) * kk;
    this.fov += (g.fov - this.fov) * kk;
    this.dofAmount += (this.dofGoal - this.dofAmount) * (1 - Math.exp(-dt * 3));

    // place the camera.
    //  * Player cameras (rts / free / orbit): pure orbit maths. Nothing lifts the pitch: a castle or
    //    tower between the lens and the focus fades instead, and foliage near the lens erodes, so
    //    height and pitch stay flat while panning. Only the position is kept out of the ground and
    //    out of solid geometry, through a smoothed floor.
    //  * Director: the line of sight may raise the pitch to clear crowns / props, but only by
    //    `maxLift` (it picks clear angles first), and it stays above crowns.
    const cam = this.engine.camera;
    const ty = this.ground(this.target.x, this.target.z);
    const look = this.look.set(this.target.x, ty + 1.2 + this.target.y, this.target.z);
    this.lookPoint.copy(look);
    const director = this.mode === 'director';
    let need = 0;
    const pos = this.tmpB;
    if (director) {
      for (; need < this.maxLift; need += 0.05) {
        const pp = Math.min(1.45, this.pitch + need);
        const cp0 = Math.cos(pp);
        pos.set(look.x + Math.sin(this.yaw) * cp0 * this.dist, look.y + Math.sin(pp) * this.dist, look.z + Math.cos(this.yaw) * cp0 * this.dist);
        if (this.blocked(pos, look) === 0 || pp >= 1.45) break;
      }
      need = Math.min(need, this.maxLift);
    }
    this.lift += (need - this.lift) * (need > this.lift ? 1 - Math.exp(-dt * 8) : 1 - Math.exp(-dt * 1.5));
    if (director && this.shot?.s.cut && this.shot.t <= dt * 1.5) this.lift = need; // a cut starts at its final pitch
    if (this.lift < 1e-4 && need === 0) this.lift = 0;
    const pitch = Math.min(1.45, this.pitch + this.lift);
    const cp = Math.cos(pitch);
    cam.position.set(look.x + Math.sin(this.yaw) * cp * this.dist, look.y + Math.sin(pitch) * this.dist, look.z + Math.cos(this.yaw) * cp * this.dist);
    // the floor under the camera: ground, solids (and crowns for the director), eased both ways
    const cx = cam.position.x;
    const cz = cam.position.z;
    const top = director ? Math.max(this.obstacle(cx, cz) + this.clearance, this.solid(cx, cz) + 2) : this.solid(cx, cz) + 2;
    const floor = Math.max(this.ground(cx, cz) + 1.8, top);
    if (this.floorY < -1e8 || (director && this.shot?.s.cut && this.shot.t <= dt * 1.5)) this.floorY = floor;
    else {
      // eased, and never faster than 6 m/s: a hump over a wall, not a pop
      const step = (floor - this.floorY) * (1 - Math.exp(-dt * (floor > this.floorY ? 5 : 2.5)));
      this.floorY += Math.max(-6 * dt, Math.min(6 * dt, step));
    }
    if (Math.abs(floor - this.floorY) < 0.01) this.floorY = floor;
    else if (cam.position.y < Math.max(floor, this.floorY) + 0.5) this.engine.wake();
    if (cam.position.y < this.floorY) cam.position.y = this.floorY;
    if (Math.abs(need - this.lift) > 1e-3) this.engine.wake();
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
      this.engine.sun.updateFrustums();
    }
    cam.lookAt(look);
    const post = this.engine.post;
    post.dofAmount = this.dofAmount;
    post.dofFocus = cam.position.distanceTo(look);
    post.dofRange = Math.max(4, post.dofFocus * 0.2);
    if (this.busy) this.engine.wake();
  }

  dispose(): void {
    this.abort.abort();
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
