// Ground footprints under ghost squads (the enemy's last-round positions shown as intel while
// planning): one instanced quad per squad, a soft team-coloured formation outline with a faint fill
// and a chevron on its front edge, oriented to the squad's facing. One draw call, no dither.
import * as THREE from 'three';

export interface GhostMark {
  /** World position of the squad centre (y = ground). */
  x: number;
  y: number;
  z: number;
  /** Formation size in metres (across, deep) and the world yaw of its facing. */
  w: number;
  d: number;
  yaw: number;
  color: THREE.Color;
}

const VERT = /* glsl */ `
attribute vec3 iColor;
attribute vec2 iSize;
varying vec2 vP;
varying vec2 vHalf;
varying vec3 vCol;
#include <fog_pars_vertex>
void main() {
  vHalf = iSize * 0.5;
  vP = position.xz * iSize;
  vCol = iColor;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position.x * iSize.x, 0.0, position.z * iSize.y, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FRAG = /* glsl */ `
varying vec2 vP;
varying vec2 vHalf;
varying vec3 vCol;
#include <fog_pars_fragment>
void main() {
  // rounded box, 0.6 m inside the quad
  vec2 q = abs(vP) - (vHalf - 1.1);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.5;
  float line = 1.0 - smoothstep(0.0, 0.14, abs(sd));
  float glow = exp(-abs(sd) * 3.5) * 0.35;
  float fill = (1.0 - smoothstep(-0.05, 0.05, sd)) * 0.16;
  // chevron at the front edge (+z = facing)
  float cz = vP.y - (vHalf.y - 1.2);
  float chev = (1.0 - smoothstep(0.0, 0.12, abs(cz + abs(vP.x) * 0.7 - 0.25))) * step(abs(vP.x), 0.9) * step(sd, 0.6);
  float a = clamp(line * 0.9 + glow + fill + chev * 0.9, 0.0, 1.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * (1.0 + line * 0.6), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class GhostMarks {
  readonly mesh: THREE.InstancedMesh;
  private readonly max = 32;
  private color: THREE.InstancedBufferAttribute;
  private size: THREE.InstancedBufferAttribute;

  constructor() {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 2), 2);
    g.setAttribute('iColor', this.color);
    g.setAttribute('iSize', this.size);
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -8,
    });
    this.mesh = new THREE.InstancedMesh(g, m, this.max);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'ghost-marks';
  }

  set(marks: GhostMark[]): void {
    const n = Math.min(this.max, marks.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const k = marks[i];
      q.setFromAxisAngle(up, k.yaw);
      m.compose(new THREE.Vector3(k.x, k.y + 0.12, k.z), q, one);
      this.mesh.setMatrixAt(i, m);
      this.color.setXYZ(i, k.color.r, k.color.g, k.color.b);
      this.size.setXY(i, k.w + 2.2, k.d + 2.2);
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.color.needsUpdate = true;
    this.size.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
