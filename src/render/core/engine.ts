// The engine: WebGL2 renderer (physically based lights, ACES + sRGB done in the grade pass), the
// scene, camera, sky + PMREM environment, the cascaded-shadow sun, the post stack, quality tiers,
// stats, and an on-demand loop.
//
// On-demand loop: nothing is drawn unless something asks. `animate(fn)` registers a per-frame
// callback that keeps the loop alive while it returns true; `wake()` draws at least a few frames.
// When idle, the loop sleeps (0 fps) or, if `idleFps > 0`, keeps ambient motion (water, wind)
// going at that rate.
import * as THREE from 'three';
import { Sky } from './sky.ts';
import { Sun, type ShaderHook } from './shadows.ts';
import { PostStack, LAYER_WORLD } from './post.ts';
import { TIERS, TIER_ORDER, BATTERY_SAVER, SAVER_KEY, FPS_CAP_KEY, FrameProbe, guessTier, isMobile, mobilePixelRatioCap, storedTier, storeTier, gpuName, type QualitySettings, type QualityTier } from './quality.ts';
import { LAYER_VFX } from './post.ts';

export type Animator = (dt: number, now: number) => boolean;

export interface EngineStats {
  /** Frames actually drawn per second (0 when idle). */
  fps: number;
  frameMs: number;
  /** GPU time per frame (EXT_disjoint_timer_query_webgl2), -1 if unavailable. */
  gpuMs: number;
  batterySaver: boolean;
  fpsCap: number;
  drawCalls: number;
  triangles: number;
  tier: QualityTier;
  auto: boolean;
  gpu: string;
  width: number;
  height: number;
}

/** See `Engine.setOverride`. */
export interface QualityOverride {
  tier: QualityTier;
  /** Multiplies the drawing buffer (the device pixel ratio counts as 1). */
  renderScale: number;
  /** Frame cap. */
  maxFps: number;
}

export interface EngineOptions {
  /** Fixed tier, or 'auto' (stored choice → GPU guess → frame probe). */
  quality?: QualityTier | 'auto';
  /** Keep ambient animation (water, wind, idle poses) at this rate when idle; 0 = sleep (default). Max 10. */
  idleFps?: number;
  /** Pause drawing while the window is blurred (always paused while the tab is hidden). Default true. */
  pauseOnBlur?: boolean;
  batterySaver?: boolean;
  /** 0 (display refresh), 30 or 60. */
  fpsCap?: number;
  /** Preserve the drawing buffer (screenshots in tests). */
  preserveDrawingBuffer?: boolean;
}

/** Uniforms shared by every patched material (wind, time). */
export const globalUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
  uWindStrength: { value: 0.22 },
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.5, 1400);
  readonly canvas: HTMLCanvasElement;
  readonly sky: Sky;
  readonly sun: Sun;
  readonly post: PostStack;
  quality: QualitySettings;
  auto: boolean;
  /** Ambient rate when idle (<= 10 fps; 0 = sleep). */
  idleFps: number;
  /** User frame cap: 0 = display refresh, else 30 / 60. */
  fpsCap = 0;
  /** Backdrop scenes (title / loot orbit) cap themselves at this rate. */
  backdrop = false;
  backdropFps = 30;
  batterySaver = false;
  pauseOnBlur = true;
  /** The player's tier setting ('auto' = GPU guess + frame probe). An override does not change it. */
  choice: QualityTier | 'auto' = 'auto';
  /** A scene that sets its own cost whatever the player's setting (the title backdrop): see `setOverride`. */
  private override: QualityOverride | null = null;
  private hidden = false;
  /** Set when something that casts shadows moved; the shadow maps redraw only then. */
  shadowsDirty = true;
  private lastCam = new Float32Array(16);
  private timer: { ext: EngineTimerExt | null; query: WebGLQuery | null; ms: number } = { ext: null, query: null, ms: -1 };
  private timerActive = false;
  private unbind: () => void = () => {};
  /** Called after quality changes (terrain rebuilds grass, crowd resizes budgets, ...). */
  readonly onQuality = new Set<(q: QualitySettings) => void>();
  /** Per drawn frame, before rendering (after animators). */
  readonly beforeRender = new Set<(dt: number) => void>();
  /** Frames drawn (tests check the loop sleeps). */
  frames = 0;
  time = 0;
  readonly gpu: string;
  readonly stats: EngineStats;

  private animators = new Set<Animator>();
  private awake = false;
  private quiet = 0;
  private last = 0;
  private lastRaf = 0;
  /** Smoothed display frame interval (ms) and the next due time of a capped frame. */
  private rafMs = 16.7;
  private capDue = 0;
  private lastDrawn = 0;
  private probe = new FrameProbe();
  private probeCeiling: QualityTier;
  private fpsAcc = { frames: 0, t: 0 };
  private size = { w: 1, h: 1 };
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private shake = { amp: 0, t: 0 };
  readonly cameraShakeOffset = new THREE.Vector3();
  private disposed = false;
  private ro: ResizeObserver;

  readonly container: HTMLElement;
  constructor(container: HTMLElement, opts: EngineOptions = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace; // only used by passes that use the output chunk
    r.toneMapping = THREE.NoToneMapping; // the grade pass does ACES
    r.autoClear = false; // the post stack clears explicitly (shared depth across passes)
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false; // redrawn only when something moved (see shadowsDirty)
    r.info.autoReset = false;
    this.canvas = r.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);
    this.gpu = gpuName(r);

    this.camera.layers.set(LAYER_WORLD);
    this.sun = new Sun(this.scene, this.camera);
    this.sky = new Sky(this.sun.direction, this.sun.color);
    this.scene.add(this.sky.mesh);
    // aerial perspective: a warm haze matching the sky's horizon band
    this.scene.fog = new THREE.FogExp2(new THREE.Color('#b4baa6'), 0.0019);
    this.scene.environment = this.sky.buildEnvironment(r);
    this.scene.environmentIntensity = 0.85;
    this.post = new PostStack(r, this.scene, this.camera);

    const stored = opts.quality ?? storedTier();
    const guess = guessTier(r);
    this.probeCeiling = guess;
    this.auto = stored === 'auto';
    this.choice = stored;
    this.quality = TIERS[this.auto ? guess : (stored as QualityTier)];
    this.idleFps = Math.min(10, opts.idleFps ?? 0);
    this.pauseOnBlur = opts.pauseOnBlur ?? true;
    this.batterySaver = opts.batterySaver ?? readStr(SAVER_KEY) === '1';
    this.fpsCap = opts.fpsCap ?? (Number(readStr(FPS_CAP_KEY)) || 0);
    if (this.batterySaver) this.quality = BATTERY_SAVER;
    this.stats = { fps: 0, frameMs: 0, gpuMs: -1, batterySaver: this.batterySaver, fpsCap: this.fpsCap, drawCalls: 0, triangles: 0, tier: this.quality.tier, auto: this.auto, gpu: this.gpu, width: 0, height: 0 };
    const gl = r.getContext() as WebGL2RenderingContext;
    this.timer.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as EngineTimerExt | null;
    this.applyQuality();
    // power: never draw while the tab is hidden; optionally not while the window is blurred
    const onVis = () => {
      this.hidden = document.hidden;
      if (this.hidden) this.sleep();
      else this.wake();
    };
    const onBlur = () => {
      if (!this.pauseOnBlur) return;
      this.hidden = true;
      this.sleep();
    };
    const onFocus = () => {
      this.hidden = document.hidden;
      this.wake();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    this.unbind = () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.wake();
  }

  // ------------------------------------------------------------------ quality

  /** Pick a tier ('auto' re-enables the probe). Stored under `oathbound.render.quality`. */
  setQuality(t: QualityTier | 'auto', persist = true): void {
    if (persist) storeTier(t);
    this.auto = t === 'auto';
    this.choice = t;
    this.batterySaver = false;
    writeStr(SAVER_KEY, '0');
    this.quality = this.resolveQuality();
    this.probe.reset();
    this.applyQuality();
  }

  /**
   * A fixed tier, render scale and frame cap that win over the player's tier and the battery saver until
   * cleared with null (the title backdrop: cheap whatever the settings say). Nothing is stored, the player's
   * choice stays in `choice` / `batterySaver`, and the auto probe rests meanwhile.
   */
  setOverride(o: QualityOverride | null): void {
    const same = o && this.override && o.tier === this.override.tier && o.renderScale === this.override.renderScale && o.maxFps === this.override.maxFps;
    if (same || (!o && !this.override)) return;
    this.override = o;
    this.quality = this.resolveQuality();
    this.probe.reset();
    this.applyQuality();
  }
  get overridden(): boolean {
    return !!this.override;
  }
  /**
   * The tier the player's own settings give (an override aside). Models pick their detail by it, so a backdrop
   * drawn cheaply loads the same files the match will draw (nothing is fetched twice, nothing stays low-detail).
   */
  get assetTier(): QualityTier {
    if (this.batterySaver) return BATTERY_SAVER.tier;
    return TIERS[this.choice === 'auto' ? this.probeCeiling : this.choice].tier;
  }

  private resolveQuality(): QualitySettings {
    const o = this.override;
    if (o) return { ...TIERS[o.tier], pixelRatioCap: 1, renderScale: o.renderScale, maxFps: o.maxFps };
    if (this.batterySaver) return BATTERY_SAVER;
    return TIERS[this.choice === 'auto' ? this.probeCeiling : this.choice];
  }

  /** Battery saver: low tier (no post, AO, DOF or bloom), DPR 1, 30 fps cap. Off restores the tier setting. */
  setBatterySaver(on: boolean): void {
    this.batterySaver = on;
    writeStr(SAVER_KEY, on ? '1' : '0');
    this.auto = !on && this.choice === 'auto';
    this.quality = this.resolveQuality();
    this.probe.reset();
    this.applyQuality();
  }

  /** Frame cap: 0 = display refresh, 30 or 60 (stored). */
  setFpsCap(fps: number): void {
    this.fpsCap = fps;
    writeStr(FPS_CAP_KEY, String(fps));
    this.stats.fpsCap = fps;
  }

  /** Mark shadow casters as moved (the shadow maps redraw on the next frame). */
  markShadows(): void {
    this.shadowsDirty = true;
  }

  private applyQuality(): void {
    const q = this.quality;
    this.sun.configure(q.shadows);
    if (q.post) this.post.configure(q);
    this.renderer.toneMapping = q.post ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.post.grade.exposure;
    this.shadowsDirty = true;
    this.stats.tier = q.tier;
    this.stats.auto = this.auto;
    this.stats.batterySaver = this.batterySaver;
    this.resize();
    for (const f of this.onQuality) f(q);
    this.wake();
  }

  get pixelRatio(): number {
    const cap = Math.min(this.quality.pixelRatioCap, isMobile() ? mobilePixelRatioCap : 99);
    return Math.min(window.devicePixelRatio || 1, cap) * this.quality.renderScale;
  }

  // ------------------------------------------------------------------ materials

  /**
   * Register a lit material with the shadow system, with an optional shader patch. `key` must be
   * unique per distinct patch (it is the program cache key).
   */
  patch(mat: THREE.Material, key = '', hook: ShaderHook | null = null): void {
    this.sun.register(mat, key, hook);
  }

  /** Register every material under `obj` (idempotent) and set shadow flags on meshes. */
  prepare(obj: THREE.Object3D, opts: { cast?: boolean; receive?: boolean } = {}): void {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (opts.cast !== undefined) m.castShadow = opts.cast;
      if (opts.receive !== undefined) m.receiveShadow = opts.receive;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) if (!this.sun.isRegistered(mat)) this.sun.register(mat, (mat.userData.patchKey as string) ?? mat.type, (mat.userData.patchHook as ShaderHook) ?? null);
    });
  }

  // ------------------------------------------------------------------ size

  setInsets(i: Partial<{ left: number; right: number; top: number; bottom: number }>): void {
    this.insets = { left: 0, right: 0, top: 0, bottom: 0, ...i };
    this.resize();
  }

  /** Called after every viewport / HUD-inset change (the camera rig re-fits its home framing). */
  readonly onResize = new Set<() => void>();

  resize(): void {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.size = { w, h };
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    this.post.setSize(w, h, pr);
    const { left, right, top, bottom } = this.insets;
    const vw = Math.max(1, w - left - right);
    const vh = Math.max(1, h - top - bottom);
    this.camera.aspect = vw / vh;
    if (left || right || top || bottom) this.camera.setViewOffset(vw, vh, -left, -top, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.sun.updateFrustums();
    this.stats.width = Math.round(w * pr);
    this.stats.height = Math.round(h * pr);
    for (const f of this.onResize) f();
    this.wake();
  }

  /** Free-area aspect (after insets). */
  get viewSize(): { w: number; h: number } {
    return { w: this.size.w - this.insets.left - this.insets.right, h: this.size.h - this.insets.top - this.insets.bottom };
  }

  // ------------------------------------------------------------------ effects on the camera

  /** Camera shake (decays); amplitude in metres. */
  addShake(amp: number): void {
    this.shake.amp = Math.max(this.shake.amp, amp);
    this.wake();
  }
  /** A brief HDR screen flash (meteor impacts, keep collapse). */
  addFlash(amount: number): void {
    this.post.flash = Math.max(this.post.flash, amount);
    this.wake();
  }

  // ------------------------------------------------------------------ picking

  private ray = new THREE.Raycaster();
  /** A world ray under a client (CSS px) position. */
  rayAt(clientX: number, clientY: number): THREE.Ray {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray.clone();
  }
  /** Client position (CSS px) of a world point; null if behind the camera. */
  toScreen(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  // ------------------------------------------------------------------ loop

  animate(a: Animator): void {
    this.animators.add(a);
    this.wake();
  }
  cancel(a: Animator): void {
    this.animators.delete(a);
  }
  wake(): void {
    this.quiet = 0;
    if (this.awake || this.disposed || this.hidden) return;
    this.awake = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop(() => this.tick());
  }
  get isAwake(): boolean {
    return this.awake;
  }
  private sleep(): void {
    this.awake = false;
    this.renderer.setAnimationLoop(null);
  }

  private tick(): void {
    const now = performance.now();
    const idle = this.animators.size === 0 && this.quiet > 2;
    // frame caps: ambient idle <= 10 fps, backdrops 30, battery saver / user cap 30-60
    let cap = this.quality.maxFps || 0;
    if (this.fpsCap > 0) cap = cap > 0 ? Math.min(cap, this.fpsCap) : this.fpsCap;
    if (this.backdrop) cap = cap > 0 ? Math.min(cap, this.backdropFps) : this.backdropFps;
    if (idle && this.idleFps > 0) cap = cap > 0 ? Math.min(cap, this.idleFps) : this.idleFps;
    // pacing: an accumulator of due times, tested against the display's own frame interval, so a
    // 60 fps cap gives 60 on a 165 Hz (or 144 / 120 Hz) display instead of every 3rd refresh (55)
    const raf = now - this.lastRaf;
    this.lastRaf = now;
    if (raf > 2 && raf < 50) this.rafMs += (raf - this.rafMs) * 0.1;
    if (cap > 0) {
      const interval = 1000 / cap;
      if (now < this.capDue - this.rafMs * 0.5) return;
      this.capDue = now - this.capDue > interval ? now + interval : this.capDue + interval;
    }
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    if (!idle) this.probe.push(now - this.lastDrawn);
    this.lastDrawn = now;
    const dt = Math.min(0.05, rawDt);
    this.time += dt;
    globalUniforms.uTime.value = this.time;
    this.sky.setTime(this.time);

    let busy = false;
    for (const a of this.animators) {
      if (a(dt, now)) busy = true;
      else this.animators.delete(a);
    }
    // camera shake is applied on top of whatever the camera controller set this frame
    this.cameraShakeOffset.set(0, 0, 0);
    if (this.shake.amp > 0.002) {
      this.shake.t += dt;
      const s = this.shake.amp;
      const t = this.shake.t;
      this.cameraShakeOffset.set(Math.sin(t * 61) * s, Math.sin(t * 47 + 1.3) * s * 0.7, Math.sin(t * 53 + 2.1) * s * 0.5);
      this.shake.amp *= Math.exp(-dt * 5.5);
      busy = true;
    } else this.shake.amp = 0;
    if (this.post.flash > 0.002) {
      this.post.flash *= Math.exp(-dt * 7);
      busy = true;
    } else this.post.flash = 0;
    for (const f of this.beforeRender) f(dt);
    this.camera.position.add(this.cameraShakeOffset);
    this.camera.updateMatrixWorld();

    this.draw(dt);
    this.camera.position.sub(this.cameraShakeOffset);
    this.frames++;
    this.updateStats(rawDt);

    if (busy) this.quiet = 0;
    else if (++this.quiet > 2 && this.idleFps <= 0) this.sleep();
  }

  /**
   * Draw the scene as it stands, now, and hand back the frame as a JPEG blob (null if the canvas cannot be
   * read). For a still of a backdrop: the drawing buffer is only readable in the task that drew it.
   */
  snapshot(quality = 0.82): Promise<Blob | null> {
    if (this.disposed) return Promise.resolve(null);
    try {
      this.draw(0);
      return new Promise((res) => this.canvas.toBlob((b) => res(b), 'image/jpeg', quality));
    } catch {
      return Promise.resolve(null);
    }
  }

  private draw(dt: number): void {
    this.renderer.info.reset();
    // shadows: redraw only when the camera moved (cascades refit) or a caster moved
    const e = this.camera.matrixWorld.elements;
    let camMoved = false;
    for (let i = 0; i < 16; i++) {
      if (this.lastCam[i] !== e[i]) {
        camMoved = true;
        this.lastCam[i] = e[i];
      }
    }
    if (camMoved || this.shadowsDirty) {
      this.sun.update();
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    this.gpuBegin();
    if (this.quality.post) this.post.render(dt, this.time);
    else {
      // low tier: straight to the canvas (three's ACES + sRGB), world + VFX layers in one pass
      const r = this.renderer;
      r.setRenderTarget(null);
      r.clear();
      this.camera.layers.enable(LAYER_VFX);
      r.render(this.scene, this.camera);
      this.camera.layers.disable(LAYER_VFX);
    }
    this.gpuEnd();
  }

  private gpuBegin(): void {
    const t = this.timer;
    if (!t.ext || t.query) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    t.query = gl.createQuery();
    if (t.query) gl.beginQuery(t.ext.TIME_ELAPSED_EXT, t.query);
    this.timerActive = !!t.query;
  }
  private gpuEnd(): void {
    const t = this.timer;
    if (!t.ext) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (this.timerActive) {
      gl.endQuery(t.ext.TIME_ELAPSED_EXT);
      this.timerActive = false;
      return;
    }
    // poll the in-flight query (results arrive a few frames later)
    if (t.query && gl.getQueryParameter(t.query, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(t.ext.GPU_DISJOINT_EXT)) {
        const ns = gl.getQueryParameter(t.query, gl.QUERY_RESULT) as number;
        t.ms = t.ms < 0 ? ns / 1e6 : t.ms * 0.85 + (ns / 1e6) * 0.15;
        this.stats.gpuMs = t.ms;
      }
      gl.deleteQuery(t.query);
      t.query = null;
    }
  }

  private updateStats(rawDt: number): void {
    const info = this.renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.fpsAcc.frames++;
    this.fpsAcc.t += rawDt;
    if (this.fpsAcc.t >= 0.5) {
      this.stats.fps = this.fpsAcc.frames / this.fpsAcc.t;
      this.stats.frameMs = (this.fpsAcc.t / this.fpsAcc.frames) * 1000;
      this.fpsAcc.frames = 0;
      this.fpsAcc.t = 0;
    }
    if (this.auto && !this.override && this.probe.ready) {
      const v = this.probe.verdict();
      const i = TIER_ORDER.indexOf(this.quality.tier);
      if (v < 0 && i > 0) {
        this.probeCeiling = TIER_ORDER[i - 1];
        this.quality = TIERS[this.probeCeiling];
        this.probe.reset();
        this.applyQuality();
      } else this.probe.reset();
    }
  }

  dispose(): void {
    this.unbind();
    this.disposed = true;
    this.sleep();
    this.ro.disconnect();
    this.post.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

type EngineTimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
function readStr(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeStr(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
}
