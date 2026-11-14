// Procedural rigged stand-ins: a tiny builder for skinned meshes made of rigid primitive parts
// (each part 100% weighted to one bone), plus pose-function → AnimationClip conversion. The same
// clips drive heroes through an AnimationMixer and are baked into VATs for the crowd, so the
// procedural path exercises exactly the code the real GLBs will use.
//
// Conventions (match the art contract): +Y up, the figure faces +Z, origin at the feet, metres.
// Vertex attributes: `color` (albedo), `surf` (roughness, metalness, emissive), `tint` (0..1 team
// colour mask), skinIndex/skinWeight.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type V3 = [number, number, number];

export interface PartOpts {
  /** Team-colour mask 0..1 (the albedo is multiplied by the team colour). */
  tint?: number;
  rough?: number;
  metal?: number;
  /** Emissive strength (× albedo, HDR). */
  emissive?: number;
}

interface BoneInfo {
  index: number;
  name: string;
  parent: string | null;
  world: THREE.Vector3;
}

export class RigBuilder {
  readonly bones = new Map<string, BoneInfo>();
  private parts: THREE.BufferGeometry[] = [];
  private readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }

  bone(name: string, parent: string | null, world: V3): this {
    if (this.bones.has(name)) throw new Error(`rig: duplicate bone ${name}`);
    if (parent && !this.bones.has(parent)) throw new Error(`rig: unknown parent ${parent}`);
    this.bones.set(name, { index: this.bones.size, name, parent, world: new THREE.Vector3(...world) });
    return this;
  }
  has(name: string): boolean {
    return this.bones.has(name);
  }
  pos(name: string): THREE.Vector3 {
    const b = this.bones.get(name);
    if (!b) throw new Error(`rig: unknown bone ${name}`);
    return b.world.clone();
  }

  /** Add a geometry (already placed in bind/world space) bound to `bone`. */
  part(bone: string, geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, o: PartOpts = {}): this {
    const b = this.bones.get(bone);
    if (!b) throw new Error(`rig: unknown bone ${bone}`);
    let g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g = g.clone();
    const n = g.getAttribute('position').count;
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3);
    const surf = new Float32Array(n * 3);
    const tint = new Float32Array(n);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      surf[i * 3] = o.rough ?? 0.75;
      surf[i * 3 + 1] = o.metal ?? 0;
      surf[i * 3 + 2] = o.emissive ?? 0;
      tint[i] = o.tint ?? 0;
      si[i * 4] = b.index;
      sw[i * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('surf', new THREE.BufferAttribute(surf, 3));
    g.setAttribute('tint', new THREE.BufferAttribute(tint, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    this.parts.push(g);
    return this;
  }

  build(material: THREE.Material): { root: THREE.Group; mesh: THREE.SkinnedMesh; skeleton: THREE.Skeleton; boneNames: string[] } {
    const geo = mergeGeometries(this.parts, false);
    if (!geo) throw new Error('rig: merge failed');
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const bones: THREE.Bone[] = [];
    const names: string[] = [];
    for (const b of this.bones.values()) {
      const bone = new THREE.Bone();
      bone.name = `${this.prefix}_${b.name}`;
      const pw = b.parent ? this.bones.get(b.parent)!.world : new THREE.Vector3();
      bone.position.copy(b.world).sub(pw);
      bones.push(bone);
      names.push(b.name);
    }
    for (const b of this.bones.values()) if (b.parent) bones[this.bones.get(b.parent)!.index].add(bones[b.index]);
    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.name = `${this.prefix}_mesh`;
    const root = new THREE.Group();
    root.name = this.prefix;
    const rootBones = bones.filter((_, i) => ![...this.bones.values()][i].parent);
    for (const rb of rootBones) root.add(rb);
    root.add(mesh);
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { root, mesh, skeleton, boneNames: names };
  }
}

// ------------------------------------------------------------------ primitive helpers

const UP = new THREE.Vector3(0, 1, 0);

export function box(w: number, h: number, d: number, at: V3, rot?: V3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)));
  return g.translate(...at);
}
export function ball(r: number, at: V3, scale: V3 = [1, 1, 1], seg = 10): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, seg, Math.max(6, seg - 3)).scale(...scale).translate(...at);
}
/** A capsule / cylinder / cone between two points. */
export function limb(a: V3, b: V3, r0: number, r1 = r0, kind: 'capsule' | 'cyl' = 'capsule', seg = 8): THREE.BufferGeometry {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  let g: THREE.BufferGeometry;
  if (kind === 'capsule' && Math.abs(r0 - r1) < 1e-4) g = new THREE.CapsuleGeometry(r0, Math.max(0.001, len), 3, seg);
  else g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  const dir = B.clone().sub(A).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir));
  const mid = A.add(B).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}
export function cone(r: number, h: number, at: V3, rot?: V3, seg = 10): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  if (rot) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)));
  return g.translate(...at);
}
export function disc(r: number, thick: number, at: V3, normal: V3, seg = 16): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, thick, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...normal).normalize()));
  return g.translate(...at);
}
/** A flat, double-sided polygon (fan-triangulated from the first point), slightly thickened. */
export function fan(pts: V3[], thick = 0.01): THREE.BufferGeometry {
  const P = pts.map((p) => new THREE.Vector3(...p));
  const n = new THREE.Vector3();
  for (let i = 1; i < P.length - 1; i++) n.add(new THREE.Vector3().subVectors(P[i], P[0]).cross(new THREE.Vector3().subVectors(P[i + 1], P[0])));
  n.normalize().multiplyScalar(thick / 2);
  const pos: number[] = [];
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[0].clone().add(n);
    const b = P[i].clone().add(n);
    const c = P[i + 1].clone().add(n);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const a2 = P[0].clone().sub(n);
    const b2 = P[i].clone().sub(n);
    const c2 = P[i + 1].clone().sub(n);
    pos.push(a2.x, a2.y, a2.z, c2.x, c2.y, c2.z, b2.x, b2.y, b2.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function torus(r: number, tube: number, at: V3, rot: V3, arc = Math.PI * 2): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(r, tube, 6, 16, arc);
  g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)));
  return g.translate(...at);
}

// ------------------------------------------------------------------ poses → clips

/** A pose under construction: Euler rotations and position offsets (from bind) per bone. */
export class Pose {
  readonly rot = new Map<string, THREE.Euler>();
  readonly off = new Map<string, THREE.Vector3>();
  clear(): void {
    this.rot.clear();
    this.off.clear();
  }
  /** Rotate a bone (radians, XYZ order). Adds to any rotation already set. */
  r(bone: string, x: number, y = 0, z = 0): this {
    const e = this.rot.get(bone);
    if (e) e.set(e.x + x, e.y + y, e.z + z);
    else this.rot.set(bone, new THREE.Euler(x, y, z));
    return this;
  }
  /** Offset a bone's position from its bind position (metres). */
  p(bone: string, x: number, y: number, z: number): this {
    const v = this.off.get(bone);
    if (v) v.set(v.x + x, v.y + y, v.z + z);
    else this.off.set(bone, new THREE.Vector3(x, y, z));
    return this;
  }
}

export interface ClipSpec {
  name: string;
  duration: number;
  loop: boolean;
  pose: (t: number, p: Pose) => void;
}

/** Sample a pose function into an AnimationClip (quaternion + position tracks for every bone). */
export function clipFromPose(prefix: string, rig: RigBuilder, spec: ClipSpec, fps = 30): THREE.AnimationClip {
  const frames = Math.max(2, Math.round(spec.duration * fps) + 1);
  const names = [...rig.bones.keys()];
  const times = new Float32Array(frames);
  const quats = names.map(() => new Float32Array(frames * 4));
  const poss = names.map(() => new Float32Array(frames * 3));
  const pose = new Pose();
  const q = new THREE.Quaternion();
  const bindLocal = names.map((n) => {
    const b = rig.bones.get(n)!;
    const pw = b.parent ? rig.bones.get(b.parent)!.world : new THREE.Vector3();
    return b.world.clone().sub(pw);
  });
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * spec.duration;
    times[f] = t;
    pose.clear();
    spec.pose(spec.loop ? t % spec.duration : t, pose);
    names.forEach((n, i) => {
      const e = pose.rot.get(n);
      if (e) q.setFromEuler(e);
      else q.identity();
      q.toArray(quats[i], f * 4);
      const o = pose.off.get(n);
      const bp = bindLocal[i];
      poss[i][f * 3] = bp.x + (o?.x ?? 0);
      poss[i][f * 3 + 1] = bp.y + (o?.y ?? 0);
      poss[i][f * 3 + 2] = bp.z + (o?.z ?? 0);
    });
  }
  const tracks: THREE.KeyframeTrack[] = [];
  names.forEach((n, i) => {
    const bn = `${prefix}_${n}`;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bn}.quaternion`, times, quats[i]));
    tracks.push(new THREE.VectorKeyframeTrack(`${bn}.position`, times, poss[i]));
  });
  const clip = new THREE.AnimationClip(spec.name, spec.duration, tracks);
  clip.userData = { loop: spec.loop };
  return clip;
}

// ------------------------------------------------------------------ easing helpers for poses

export const smooth = (a: number, b: number, t: number): number => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
/** 0→1 over [a,b], then back to 0 over [c,d]. */
export const bump = (a: number, b: number, c: number, d: number, t: number): number => smooth(a, b, t) * (1 - smooth(c, d, t));
