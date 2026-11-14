// Camera rig: an orbit parameterisation (target on the ground, yaw, distance; pitch follows a tilt
// curve of the zoom unless a shot overrides it) with critically-damped smoothing.
//
// Modes:
//   'rts'      — planning: WASD/arrows/edge pan, wheel zoom (tilt curve), Q/E or right-drag rotate,
//                middle-drag pan, touch pan/pinch/twist; clamped to the battlefield.
//   'director' — battle: the Director drives `shot()`s; any manual input switches to 'free'.
//   'free'     — battle under user control (same controls as rts); `returnToDirector()` (key C or
//                Home by default) hands back.
//   'orbit'    — slow automatic orbit around the target (title / loot screen backdrops).
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
const MAX_DIST = 170;

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
  /** Obstacle tops (tree crowns, ruins, castles); the camera and its view stay above them. */
  private obstacle: (x: number, z: number) => number = () => -1e9;
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
  }

  setGround(fn: (x: number, z: number) => number): void {
    this.ground = fn;
  }
  setObstacles(fn: (x: number, z: number) => number): void {
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
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * (nearOnly ? Math.min(1, 12 / Math.max(1, len)) : 0.85);
      p.lerpVectors(cam, look, t);
      total++;
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

  setMode(m: CameraMode): void {
    this.mode = m;
    this.engine.backdrop = m === 'orbit'; // title / loot backdrops render at <= 30 fps
    if (m !== 'director') this.shot = null;
    if (m === 'rts' || m === 'free') this.dofGoal = 0;
    this.engine.wake();
  }

  returnToDirector(): void {
    if (this.mode !== 'free') return;
    this.setMode('director');
    this.onReturnToDirector?.();
  }

  /** Frame a home view for planning (seat 0 looks from +Z, seat 1 from −Z). */
  home(seat: 0 | 1 = 0, overview = false): void {
    this.homeYaw = seat === 0 ? 0 : Math.PI;
    // home: the own deploy zone fills most of the view, the river and a strip of the enemy half show
    // beyond it (16:9 with the HUD insets)
    const z = overview ? 0 : seat === 0 ? 17 : -17;
    this.goal.target.set(0, 0, z);
    this.goal.yaw = this.homeYaw;
    this.goal.dist = overview ? 130 : 92;
    this.goal.pitch = overview ? NaN : 0.86;
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
    if (this.mode === 'director') {
      this.mode = 'free';
      this.shot = null;
      this.dofGoal = 0;
      this.goal.pitch = NaN;
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
  zoomBy(f: number): void {
    this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * f, MIN_DIST, MAX_DIST);
    this.goal.pitch = NaN;
    this.engine.wake();
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
    if (!this.mouse.inside || this.drag || this.mode === 'director' || this.mode === 'orbit') return v;
    const r = this.engine.canvas.getBoundingClientRect();
    const m = 10;
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
      } else if ((k === 'c' || k === 'home') && this.mode === 'free') this.returnToDirector();
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
    c.addEventListener('wheel', (e) => {
      if (!this.manual) return;
      e.preventDefault();
      this.userInput();
      this.zoomBy(Math.exp(e.deltaY * 0.0011));
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
      px += ev.x;
      pz += ev.y;
      if (px || pz) this.panBy(px * sp, pz * sp);
      if (this.keys.has('q')) this.rotateBy(dt * 1.4);
      if (this.keys.has('e')) this.rotateBy(-dt * 1.4);
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

    // place the camera; keep it above the ground, and it and its view out of tree crowns / props:
    // raise the pitch until the line of sight clears (director: whole line; manual: the first 12 m)
    const cam = this.engine.camera;
    const ty = this.ground(this.target.x, this.target.z);
    const look = this.look.set(this.target.x, ty + 1.2 + this.target.y, this.target.z);
    const nearOnly = this.mode !== 'director';
    let need = 0;
    const pos = this.tmpB;
    for (; need < 1.2; need += 0.06) {
      const pp = Math.min(1.45, this.pitch + need);
      const cp0 = Math.cos(pp);
      pos.set(look.x + Math.sin(this.yaw) * cp0 * this.dist, look.y + Math.sin(pp) * this.dist, look.z + Math.cos(this.yaw) * cp0 * this.dist);
      if (this.blocked(pos, look, nearOnly) === 0 || pp >= 1.45) break;
    }
    this.lift += (need - this.lift) * (need > this.lift ? 1 - Math.exp(-dt * 14) : 1 - Math.exp(-dt * 1.5));
    if (need > this.lift + 0.25) this.lift = need - 0.25; // never lag far behind (cuts)
    const pitch = Math.min(1.45, this.pitch + this.lift);
    const cp = Math.cos(pitch);
    cam.position.set(look.x + Math.sin(this.yaw) * cp * this.dist, look.y + Math.sin(pitch) * this.dist, look.z + Math.cos(this.yaw) * cp * this.dist);
    const minY = Math.max(this.ground(cam.position.x, cam.position.z) + 1.8, this.obstacle(cam.position.x, cam.position.z) + this.clearance);
    if (cam.position.y < minY) cam.position.y = minY;
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
