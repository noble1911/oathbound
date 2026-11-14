// Post-processing stack on three's EffectComposer (HDR half-float targets):
//
//   scene (layer WORLD) → GTAO (depth-only, normals from depth) → VFX (layer VFX, after AO so
//   additive effects aren't darkened) → bloom (HDR threshold, so effectively selective for
//   emissive/VFX values > 1) → DOF (director close-ups) → grade (ACES, curves, split-tone,
//   vignette, grain, sRGB) → SMAA / FXAA.
//
// Both composer targets share ONE depth texture, so the depth written by the scene pass survives
// the ping-pong: the VFX pass depth-tests against it and GTAO/DOF read it (from their own
// targets, never while it is attached for writing). `renderer.autoClear` must stay false.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { QualitySettings } from './quality.ts';

export const LAYER_WORLD = 0;
export const LAYER_VFX = 1;

/** Renders only the VFX layer on top of the current buffer (no clear, shared depth). */
class LayerPass extends RenderPass {
  private readonly layer: number;
  constructor(scene: THREE.Scene, camera: THREE.Camera, layer: number) {
    super(scene, camera);
    this.layer = layer;
    this.clear = false;
    this.needsSwap = false;
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, dt: number, mask: boolean): void {
    const cam = this.camera;
    const saved = cam.layers.mask;
    cam.layers.set(this.layer);
    const bg = this.scene.background;
    this.scene.background = null;
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
    this.scene.background = bg;
    cam.layers.mask = saved;
  }
}

/** The main scene pass: clears colour+depth itself, renders only the WORLD layer. */
class WorldPass extends RenderPass {
  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super(scene, camera);
    this.clear = true;
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, dt: number, mask: boolean): void {
    const cam = this.camera;
    const saved = cam.layers.mask;
    cam.layers.set(LAYER_WORLD);
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
    cam.layers.mask = saved;
  }
}

class HalfResGTAO extends GTAOPass {
  half = true;
  override setSize(w: number, h: number): void {
    super.setSize(this.half ? Math.max(1, w >> 1) : w, this.half ? Math.max(1, h >> 1) : h);
  }
}

const DOF_COC = /* glsl */ `
uniform sampler2D tDepth;
uniform float cameraNear;
uniform float cameraFar;
uniform float focusDist;
uniform float focusRange;
uniform float aperture;
varying vec2 vUv;
float viewZ(float d) { return (cameraNear * cameraFar) / ((cameraFar - cameraNear) * d - cameraFar); }
void main() {
  float d = texture2D(tDepth, vUv).x;
  float z = -viewZ(d);
  if (d >= 1.0) z = cameraFar;
  float coc = (z - focusDist) / max(z, 0.001) * aperture;
  float band = focusRange / max(focusDist, 1.0);
  coc = sign(coc) * max(abs(coc) - band * aperture, 0.0);
  gl_FragColor = vec4(clamp(coc, -1.0, 1.0), 0.0, 0.0, 1.0);
}`;

const DOF_BLUR = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tCoc;
uniform vec2 texel;
uniform float maxRadius;
varying vec2 vUv;
const float GOLDEN = 2.39996323;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float c0 = texture2D(tCoc, vUv).x;
  float r0 = abs(c0) * maxRadius;
  if (r0 < 0.5) { gl_FragColor = base; return; }
  vec3 acc = base.rgb;
  float wsum = 1.0;
  for (int i = 1; i < 40; i++) {
    float fi = float(i);
    float r = sqrt(fi / 40.0) * r0;
    float a = fi * GOLDEN;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r * texel;
    float c = texture2D(tCoc, uv).x;
    // background samples can't bleed over sharper foreground
    float w = (c0 > 0.0) ? smoothstep(0.0, 1.0, abs(c) * maxRadius - r + 1.5) : 1.0;
    vec3 s = texture2D(tDiffuse, uv).rgb;
    acc += s * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, base.a);
}`;

const FSQ_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

class DofPass extends Pass {
  private cocRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RedFormat });
  private cocMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  focus = 40;
  range = 6;
  aperture = 0.0;
  maxRadius = 9;
  private readonly camera: THREE.PerspectiveCamera;
  constructor(camera: THREE.PerspectiveCamera, depth: THREE.DepthTexture) {
    super();
    this.camera = camera;
    this.cocMat = new THREE.ShaderMaterial({
      vertexShader: FSQ_VERT,
      fragmentShader: DOF_COC,
      uniforms: { tDepth: { value: depth }, cameraNear: { value: 1 }, cameraFar: { value: 100 }, focusDist: { value: 40 }, focusRange: { value: 6 }, aperture: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FSQ_VERT,
      fragmentShader: DOF_BLUR,
      uniforms: { tDiffuse: { value: null }, tCoc: { value: this.cocRT.texture }, texel: { value: new THREE.Vector2() }, maxRadius: { value: 8 } },
      depthTest: false,
      depthWrite: false,
    });
  }
  override setSize(w: number, h: number): void {
    this.cocRT.setSize(w, h);
    (this.blurMat.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h);
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const u = this.cocMat.uniforms;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    u.focusDist.value = this.focus;
    u.focusRange.value = this.range;
    u.aperture.value = this.aperture;
    this.quad.material = this.cocMat;
    renderer.setRenderTarget(this.cocRT);
    this.quad.render(renderer);
    this.blurMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.blurMat.uniforms.maxRadius.value = this.maxRadius * Math.min(2, readBuffer.height / 1080);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  override dispose(): void {
    this.cocRT.dispose();
    this.cocMat.dispose();
    this.blurMat.dispose();
    this.quad.dispose();
  }
}

const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uExposure;
uniform float uTime;
uniform float uGrain;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec2 uRes;
uniform float uFlash;
uniform vec3 uFlashColor;
varying vec2 vUv;
// ACES fitted (Stephen Hill), as three's ACESFilmicToneMapping
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 hdr = texture2D(tDiffuse, vUv).rgb;
  hdr += uFlashColor * uFlash;
  vec3 c = aces(hdr * uExposure / 0.6);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // split toning: cool shadows, warm highlights (energy-neutral-ish)
  vec3 tint = mix(uShadowTint, uHighTint, smoothstep(0.05, 0.75, l));
  c *= tint;
  // lift / gain
  c = uGain * (c + uLift * (1.0 - c));
  // contrast S-curve around mid grey
  vec3 s = clamp(c, 0.0, 1.0);
  vec3 curve = s * s * (3.0 - 2.0 * s);
  c = mix(c, curve, uContrast);
  // saturation
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  // vignette
  vec2 q = vUv - 0.5;
  q.x *= uRes.x / uRes.y * 0.75;
  float v = smoothstep(0.85, 0.18, length(q));
  c *= mix(1.0 - uVignette, 1.0, v);
  c = toSRGB(clamp(c, 0.0, 1.0));
  // film grain (luminance-weighted, in display space)
  float g = hash(vUv * uRes + fract(uTime * 13.7) * 431.0) - 0.5;
  c += g * uGrain * (1.0 - 0.6 * l);
  gl_FragColor = vec4(c, 1.0);
}`;

export interface GradeParams {
  exposure: number;
  saturation: number;
  contrast: number;
  vignette: number;
  grain: number;
  lift: THREE.Color;
  gain: THREE.Color;
  shadowTint: THREE.Color;
  highTint: THREE.Color;
}

class GradePass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  constructor(params: GradeParams) {
    super();
    this.material = new THREE.ShaderMaterial({
      vertexShader: FSQ_VERT,
      fragmentShader: GRADE_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: params.exposure },
        uTime: { value: 0 },
        uGrain: { value: params.grain },
        uVignette: { value: params.vignette },
        uSaturation: { value: params.saturation },
        uContrast: { value: params.contrast },
        uLift: { value: params.lift },
        uGain: { value: params.gain },
        uShadowTint: { value: params.shadowTint },
        uHighTint: { value: params.highTint },
        uRes: { value: new THREE.Vector2(1, 1) },
        uFlash: { value: 0 },
        uFlashColor: { value: new THREE.Color(1, 0.9, 0.75) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  override setSize(w: number, h: number): void {
    (this.material.uniforms.uRes.value as THREE.Vector2).set(w, h);
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

export class PostStack {
  readonly composer: EffectComposer;
  readonly depth: THREE.DepthTexture;
  readonly grade: GradeParams = {
    exposure: 0.95,
    saturation: 0.98,
    contrast: 0.3,
    vignette: 0.34,
    grain: 0.028,
    lift: new THREE.Color(0.012, 0.012, 0.022),
    gain: new THREE.Color(1.02, 1.0, 0.97),
    shadowTint: new THREE.Color(0.9, 0.98, 1.1),
    highTint: new THREE.Color(1.07, 1.0, 0.9),
  };
  private world: WorldPass;
  private gtao: HalfResGTAO | null = null;
  private vfx: LayerPass;
  private bloom: UnrealBloomPass | null = null;
  private dof: DofPass | null = null;
  private gradePass: GradePass;
  private aa: Pass | null = null;
  private w = 1;
  private h = 1;
  private pr = 1;
  /** DOF strength 0..1 (the director animates it); only applied on tiers with DOF. */
  dofAmount = 0;
  dofFocus = 40;
  dofRange = 8;
  /** Full-screen flash added in HDR (big impacts), decays in Engine. */
  flash = 0;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.depth = depth;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    rt.texture.name = 'ob.rt1';
    rt.depthTexture = depth;
    this.composer = new EffectComposer(renderer, rt);
    this.composer.renderTarget2.depthTexture = depth;
    this.world = new WorldPass(scene, camera);
    this.vfx = new LayerPass(scene, camera, LAYER_VFX);
    this.gradePass = new GradePass(this.grade);
  }

  configure(q: QualitySettings): void {
    const c = this.composer;
    while (c.passes.length) c.removePass(c.passes[0]);
    this.gtao?.dispose();
    this.bloom?.dispose();
    this.dof?.dispose();
    this.aa?.dispose();
    this.gtao = this.bloom = this.dof = this.aa = null;

    c.addPass(this.world);
    if (q.ao !== 'off') {
      const g = new HalfResGTAO(this.scene, this.camera, this.w, this.h);
      g.updateGtaoMaterial({
        radius: 1.6,
        distanceExponent: 1.4,
        thickness: 3,
        scale: 1.15,
        samples: q.ao === 'full' ? 16 : 12,
        distanceFallOff: 1,
        screenSpaceRadius: false,
      });
      g.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      g.half = q.ao === 'half';
      g.setGBuffer(this.depth);
      g.blendIntensity = 0.9;
      this.gtao = g;
      c.addPass(g);
    }
    c.addPass(this.vfx);
    if (q.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(this.w, this.h), 0.55, 0.62, 1.35);
      c.addPass(this.bloom);
    }
    if (q.dof) {
      this.dof = new DofPass(this.camera, this.depth);
      c.addPass(this.dof);
    }
    this.gradePass.material.uniforms.uGrain.value = q.grain ? this.grade.grain : 0;
    c.addPass(this.gradePass);
    if (q.aa === 'smaa') this.aa = new SMAAPass();
    else if (q.aa === 'fxaa') this.aa = new FXAAPass();
    if (this.aa) c.addPass(this.aa);
    this.setSize(this.w, this.h, this.pr);
  }

  setSize(w: number, h: number, pr: number): void {
    this.w = w;
    this.h = h;
    this.pr = pr;
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
  }

  get dofActive(): boolean {
    return !!this.dof && this.dofAmount > 0.01;
  }

  render(dt: number, time: number): void {
    const u = this.gradePass.material.uniforms;
    u.uExposure.value = this.grade.exposure;
    u.uSaturation.value = this.grade.saturation;
    u.uContrast.value = this.grade.contrast;
    u.uVignette.value = this.grade.vignette;
    u.uTime.value = time;
    u.uFlash.value = this.flash;
    if (this.dof) {
      this.dof.enabled = this.dofAmount > 0.01;
      this.dof.aperture = this.dofAmount * 0.9;
      this.dof.focus = this.dofFocus;
      this.dof.range = this.dofRange;
    }
    this.composer.render(dt);
  }

  dispose(): void {
    this.gtao?.dispose();
    this.bloom?.dispose();
    this.dof?.dispose();
    this.aa?.dispose();
    this.composer.dispose();
  }
}
