// The sun: a directional light split into cascaded shadow maps (three's CSM addon, which keeps
// cascades stable by sizing each one from its frustum's bounding diagonal and snapping the light
// to shadow texels). CSM replaces the global `lights_*` chunks, so EVERY lit material in the
// scene must be registered here (Engine.prepare does it), or it would be lit once per cascade.
// Registered materials keep their own onBeforeCompile patch, chained after CSM's.
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

export type ShaderHook = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;

interface Entry {
  hook: ShaderHook | null;
  key: string;
}

export class Sun {
  csm: CSM | null = null;
  readonly direction = new THREE.Vector3(-0.55, -0.62, -0.56).normalize();
  readonly color = new THREE.Color('#fff0dc');
  intensity = 3.4;
  private materials = new Map<THREE.Material, Entry>();
  private cfg = { cascades: 3, mapSize: 2048, maxFar: 220, fade: true };

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
  }

  configure(cfg: { cascades: number; mapSize: number; maxFar: number; fade: boolean }): void {
    this.cfg = { ...cfg };
    if (this.csm) {
      for (const l of this.csm.lights) {
        l.shadow.map?.dispose();
        l.dispose();
        this.scene.remove(l, l.target);
      }
      this.csm.lights.length = 0;
    }
    const csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: cfg.cascades,
      maxFar: cfg.maxFar,
      mode: 'practical',
      shadowMapSize: cfg.mapSize,
      lightDirection: this.direction,
      lightIntensity: this.intensity,
      lightNear: 1,
      lightFar: 600,
      lightMargin: 120,
      shadowBias: -0.00012,
    });
    csm.fade = cfg.fade;
    for (const l of csm.lights) {
      l.color.copy(this.color);
      l.shadow.normalBias = 0.035;
      l.shadow.radius = 2;
    }
    this.csm = csm;
    for (const [m, e] of this.materials) this.apply(m, e);
    csm.updateFrustums();
  }

  /** Register a material for CSM; `hook` is the material's own shader patch (if any). */
  register(mat: THREE.Material, key = '', hook: ShaderHook | null = null): void {
    if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(mat as THREE.MeshLambertMaterial).isMeshLambertMaterial && !(mat as THREE.MeshPhongMaterial).isMeshPhongMaterial) {
      // unlit / shader materials don't read the light chunks; still allow their own hook
      if (hook) {
        mat.onBeforeCompile = hook;
        mat.customProgramCacheKey = () => key;
      }
      return;
    }
    const prev = this.materials.get(mat);
    const e: Entry = { hook: hook ?? prev?.hook ?? null, key: key || prev?.key || '' };
    this.materials.set(mat, e);
    this.apply(mat, e);
  }
  unregister(mat: THREE.Material): void {
    this.materials.delete(mat);
    this.csm?.shaders.delete(mat);
  }
  isRegistered(mat: THREE.Material): boolean {
    return this.materials.has(mat);
  }

  private apply(mat: THREE.Material, e: Entry): void {
    const csm = this.csm;
    if (!csm) return;
    csm.setupMaterial(mat);
    const csmHook = mat.onBeforeCompile as ShaderHook;
    const own = e.hook;
    mat.onBeforeCompile = (shader, renderer) => {
      csmHook.call(mat, shader, renderer);
      own?.(shader, renderer);
    };
    const n = this.cfg.cascades;
    const fade = this.cfg.fade ? 'f' : '';
    mat.customProgramCacheKey = () => `${e.key}|csm${n}${fade}`;
    mat.needsUpdate = true;
  }

  setDirection(dir: THREE.Vector3): void {
    this.direction.copy(dir).normalize();
    if (this.csm) this.csm.lightDirection.copy(this.direction);
  }
  setColor(c: THREE.ColorRepresentation, intensity = this.intensity): void {
    this.color.set(c);
    this.intensity = intensity;
    for (const l of this.csm?.lights ?? []) {
      l.color.copy(this.color);
      l.intensity = intensity;
    }
  }
  /** Call when the camera's projection (fov/aspect/near/far) changes. */
  updateFrustums(): void {
    this.csm?.updateFrustums();
  }
  update(): void {
    this.csm?.update();
  }
}
