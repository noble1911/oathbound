// Field (sim) ↔ world (three.js) coordinates.
//   Field: integer centimetres, x ∈ [0, 8000) across, y ∈ [0, 12000) along; seat 0's keep at y≈0.
//   World: metres, +Y up. X = x/100 − 40, Z = 60 − y/100. Seat 0's side is +Z (nearest the default
//   camera); seat 1's is −Z. Facing (sim radians, 0 = +x, π/2 = +y) → world yaw for a model whose
//   local front is +Z.
import * as THREE from 'three';

export const FIELD_W_M = 80;
export const FIELD_H_M = 120;

export function fieldToWorld(xcm: number, ycm: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(xcm / 100 - FIELD_W_M / 2, 0, FIELD_H_M / 2 - ycm / 100);
}
export function worldX(xcm: number): number {
  return xcm / 100 - FIELD_W_M / 2;
}
export function worldZ(ycm: number): number {
  return FIELD_H_M / 2 - ycm / 100;
}
export function worldToField(p: THREE.Vector3): [number, number] {
  return [(p.x + FIELD_W_M / 2) * 100, (FIELD_H_M / 2 - p.z) * 100];
}
/** World yaw (rotation about +Y) for a sim facing in radians. */
export function facingToYaw(rad: number): number {
  // field direction (cos, sin) → world (cos, 0, −sin); yaw so that local +Z points there
  return Math.atan2(Math.cos(rad), -Math.sin(rad));
}
/** Sim facing (radians) for a world yaw. */
export function yawToFacing(yaw: number): number {
  return Math.atan2(-Math.cos(yaw), Math.sin(yaw));
}
