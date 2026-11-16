// Quality tiers. One is picked automatically from the GPU string and then confirmed with a
// frame-time probe (`FrameProbe`); the player can override it (stored as `oathbound.render.quality`).
import type * as THREE from 'three';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  tier: QualityTier;
  /** Max device pixel ratio used (mobile is capped further by `mobilePixelRatioCap`). */
  pixelRatioCap: number;
  /** Multiplies the drawing-buffer size (ultra supersamples a little). */
  renderScale: number;
  shadows: { cascades: number; mapSize: number; maxFar: number; fade: boolean };
  /** Ambient occlusion: off, half-resolution GTAO, or full. */
  ao: 'off' | 'half' | 'full';
  bloom: boolean;
  aa: 'none' | 'fxaa' | 'smaa';
  /** Depth of field in director close-ups. */
  dof: boolean;
  grain: boolean;
  /** 0..2 multiplier on grass clumps. */
  grassDensity: number;
  /** 0..1 multiplier on decorative trees outside the battlefield. */
  treeDensity: number;
  /** Planar water reflection resolution scale, 0 = environment map only. */
  waterReflection: number;
  /** Max live particles. */
  particleBudget: number;
  anisotropy: number;
  /** Post-processing stack at all (low draws straight to the canvas with three's ACES). */
  post: boolean;
  /** Trees / rocks / ruins cast shadow-map shadows (else only units and keeps do). */
  propShadows: boolean;
  /** Frame cap (0 = display refresh). */
  maxFps: number;
}

export const TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low', pixelRatioCap: 1, renderScale: 1,
    shadows: { cascades: 1, mapSize: 1024, maxFar: 120, fade: false },
    ao: 'off', bloom: false, aa: 'none', dof: false, grain: false,
    grassDensity: 0, treeDensity: 0.35, waterReflection: 0, particleBudget: 2500, anisotropy: 2,
    post: false, propShadows: false, maxFps: 0,
  },
  medium: {
    tier: 'medium', pixelRatioCap: 1.25, renderScale: 1,
    shadows: { cascades: 1, mapSize: 2048, maxFar: 150, fade: false },
    ao: 'off', bloom: true, aa: 'fxaa', dof: false, grain: false,
    grassDensity: 0.35, treeDensity: 0.6, waterReflection: 0, particleBudget: 6000, anisotropy: 4,
    post: true, propShadows: false, maxFps: 0,
  },
  high: {
    tier: 'high', pixelRatioCap: 1.5, renderScale: 1,
    shadows: { cascades: 3, mapSize: 2048, maxFar: 220, fade: true },
    ao: 'half', bloom: true, aa: 'smaa', dof: true, grain: true,
    grassDensity: 1, treeDensity: 1, waterReflection: 0.5, particleBudget: 12000, anisotropy: 8,
    post: true, propShadows: true, maxFps: 0,
  },
  ultra: {
    tier: 'ultra', pixelRatioCap: 2, renderScale: 1,
    shadows: { cascades: 4, mapSize: 4096, maxFar: 260, fade: true },
    ao: 'full', bloom: true, aa: 'smaa', dof: true, grain: true,
    grassDensity: 1.6, treeDensity: 1, waterReflection: 1, particleBudget: 20000, anisotropy: 16,
    post: true, propShadows: true, maxFps: 0,
  },
};

/** Battery saver: low tier, DPR 1, 30 fps cap (no AO / DOF / bloom / post). */
export const BATTERY_SAVER: QualitySettings = { ...TIERS.low, pixelRatioCap: 1, maxFps: 30 };

export const STORAGE_KEY = 'oathbound.render.quality';
export const SAVER_KEY = 'oathbound.render.batterySaver';
export const FPS_CAP_KEY = 'oathbound.render.fpsCap';
export const mobilePixelRatioCap = 1.5;

export function isMobile(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}

export function storedTier(): QualityTier | 'auto' {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && (TIER_ORDER as string[]).includes(v)) return v as QualityTier;
  } catch {
    /* storage blocked */
  }
  return 'auto';
}
export function storeTier(t: QualityTier | 'auto'): void {
  try {
    if (t === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* storage blocked */
  }
}

/** The GPU's name as WebGL reports it (may be empty or generic). */
export function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return String(s ?? '');
}

/** CPU / memory hints the browser gives (`deviceMemory` is Chromium-only and capped at 8; either may be missing). */
export interface DeviceHints {
  mobile: boolean;
  cores?: number;
  memoryGb?: number;
}

export function deviceHints(): DeviceHints {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number });
  return { mobile: isMobile(), cores: nav?.hardwareConcurrency || undefined, memoryGb: nav?.deviceMemory || undefined };
}

/**
 * First guess from the GPU string (power-aware): strong discrete GPUs get 'high' (ultra is opt-in),
 * integrated / mobile / software / entry-level discrete GPUs get 'low', everything unknown gets
 * 'medium'. A weak CPU or little memory lowers the guess (an unknown GPU on a 4-thread / 4 GB machine
 * is most likely integrated), because the frame probe only ever lowers it and takes a while to do so.
 */
export function guessTierFrom(gpu: string, hints: DeviceHints): QualityTier {
  const g = gpu.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(g)) return 'low';
  if (hints.mobile) return /apple gpu|adreno \(tm\) 7[4-9]|immortalis/.test(g) ? 'medium' : 'low';
  if (/intel|uhd|iris|vega \d|radeon\(tm\) graphics|radeon graphics|780m|680m|mali|adreno/.test(g)) return 'low';
  // entry-level / old discrete: GeForce MX / GT, GTX 9xx and older, Radeon R5-R9 / HD
  if (/geforce (mx|gt )|gtx [4-9]\d0(?!\d)|radeon (r[5-9] |hd )/.test(g)) return 'low';
  const weak = (hints.cores !== undefined && hints.cores <= 2) || (hints.memoryGb !== undefined && hints.memoryGb <= 2);
  const modest = (hints.cores !== undefined && hints.cores <= 4) || (hints.memoryGb !== undefined && hints.memoryGb <= 4);
  if (weak) return 'low';
  let t: QualityTier = 'medium';
  if (/apple m\d (pro|max|ultra)/.test(g)) t = 'medium';
  else if (/rtx [2-5]0[6-9]0|rtx 50|rx [679][6-9]\d\d|radeon pro w7/.test(g)) t = 'high';
  else if (modest) return 'low'; // unknown GPU on a small machine
  return modest && t === 'high' ? 'medium' : t;
}

export function guessTier(renderer: THREE.WebGLRenderer): QualityTier {
  return guessTierFrom(gpuName(renderer), deviceHints());
}

/**
 * Collects frame intervals while busy and recommends a tier change: drop if the median frame
 * is slower than ~52 fps, raise (only up to the guess ceiling) if comfortably above 100 fps.
 */
export class FrameProbe {
  private samples: number[] = [];
  private readonly windowSize: number;
  constructor(windowSize = 90) {
    this.windowSize = windowSize;
  }
  push(ms: number): void {
    if (ms <= 0 || ms > 250) return; // tab switches, first frames
    this.samples.push(ms);
    if (this.samples.length > this.windowSize) this.samples.shift();
  }
  get ready(): boolean {
    return this.samples.length >= this.windowSize;
  }
  median(): number {
    const s = [...this.samples].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  }
  reset(): void {
    this.samples.length = 0;
  }
  /** -1 drop a tier, +1 can afford more, 0 keep. */
  verdict(): -1 | 0 | 1 {
    if (!this.ready) return 0;
    const m = this.median();
    if (m > 19.5) return -1;
    if (m < 9) return 1;
    return 0;
  }
}
