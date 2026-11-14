// A procedural HDR sky (gradient + Mie sun glow + sun disk + two layers of drifting fbm cloud)
// drawn on a camera-centred dome, and a PMREM environment map rendered from the same shader so
// PBR materials get matching image-based light. No external HDR files.
import * as THREE from 'three';
import { NOISE_GLSL } from './glsl.ts';

export interface SkyParams {
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sunGlow: THREE.Color;
  cloudCover: number;
  exposure: number;
}

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // on the far plane
}
`;

const frag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunGlow;
uniform vec3 uSunColor;
uniform float uCloud;
uniform float uTime;
uniform float uExposure;
uniform float uSunDisk;
varying vec3 vDir;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float sd = max(dot(d, uSunDir), 0.0);
  // base gradient with a hazy horizon band
  float up = clamp(h, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, 0.45));
  sky = mix(sky, uHorizon * 1.08, exp(-abs(h) * 14.0) * 0.6);
  // below the horizon: fade into a hazy ground colour
  sky = mix(sky, uGround, smoothstep(0.0, -0.12, h));
  // sun: wide Mie glow + tight halo + disk
  sky += uSunGlow * (pow(sd, 6.0) * 0.55 + pow(sd, 48.0) * 1.2);
  sky += uSunColor * smoothstep(0.9993, 0.99965, sd) * uSunDisk;
  // clouds on a virtual plane
  if (h > 0.0 && uCloud > 0.0) {
    vec2 uv = d.xz / (h + 0.08);
    vec2 drift = vec2(uTime * 0.004, uTime * 0.0015);
    float n = ob_fbm(uv * 1.3 + drift);
    float n2 = ob_fbm(uv * 3.7 - drift * 2.0 + 7.3);
    float c = smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.32, n * 0.75 + n2 * 0.35);
    float thick = smoothstep(0.35, 0.9, n);
    vec3 lit = mix(vec3(1.0, 0.97, 0.93), uSunGlow * 1.3, pow(sd, 4.0) * 0.6);
    vec3 shade = mix(uHorizon * 0.78, uZenith * 0.6, 0.35);
    vec3 cloud = mix(lit, shade, thick * 0.55) * (1.1 + pow(sd, 10.0) * 1.5);
    float fadeH = smoothstep(0.0, 0.18, h);
    sky = mix(sky, cloud, c * fadeH * 0.85);
  }
  gl_FragColor = vec4(sky * uExposure, 1.0);
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly params: SkyParams = {
    zenith: new THREE.Color('#3d6fb8'),
    horizon: new THREE.Color('#d9d2c0'),
    ground: new THREE.Color('#77775f'),
    sunGlow: new THREE.Color('#ffbe7a'),
    cloudCover: 0.5,
    exposure: 1.25,
  };
  private envRT: THREE.WebGLRenderTarget | null = null;

  constructor(sunDir: THREE.Vector3, sunColor: THREE.Color) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uSunDir: { value: sunDir.clone().negate() },
        uZenith: { value: this.params.zenith },
        uHorizon: { value: this.params.horizon },
        uGround: { value: this.params.ground },
        uSunGlow: { value: this.params.sunGlow },
        uSunColor: { value: sunColor.clone().multiplyScalar(60) },
        uCloud: { value: this.params.cloudCover },
        uTime: { value: 0 },
        uExposure: { value: this.params.exposure },
        uSunDisk: { value: 1 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.mesh.scale.setScalar(1000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.name = 'sky';
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      this.mesh.position.copy(cam.position);
      this.mesh.updateMatrixWorld();
    };
  }

  setSun(lightDir: THREE.Vector3, color: THREE.Color): void {
    (this.material.uniforms.uSunDir.value as THREE.Vector3).copy(lightDir).negate().normalize();
    (this.material.uniforms.uSunColor.value as THREE.Color).copy(color).multiplyScalar(60);
  }
  setTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  /** Render the sky into a PMREM environment map (call again after changing the sun/sky). */
  buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const scene = new THREE.Scene();
    const m = this.material.clone();
    m.uniforms.uSunDisk.value = 0.02; // the disk would make speculars sparkle unrealistically
    m.uniforms.uTime.value = 0;
    m.depthTest = false;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), m);
    scene.add(dome);
    // a warm ground bounce under the horizon so undersides aren't sky-blue
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(90, 32).rotateX(-Math.PI / 2).translate(0, -8, 0),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#5c5a44').multiplyScalar(0.9), side: THREE.DoubleSide }),
    );
    scene.add(ground);
    this.envRT?.dispose();
    this.envRT = pmrem.fromScene(scene, 0.02, 0.1, 400);
    pmrem.dispose();
    dome.geometry.dispose();
    m.dispose();
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
    return this.envRT.texture;
  }
}
