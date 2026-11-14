// Terrain-only dev harness (worker tool): /src/render-test/terrain-dev.html?tier=high
import * as THREE from 'three';
import { Engine } from '../render/core/engine.ts';
import { Battlefield, defaultTerrain } from '../render/terrain/index.ts';
import type { QualityTier } from '../render/core/quality.ts';

const qs = new URLSearchParams(location.search);
const engine = new Engine(document.getElementById('app')!, { quality: (qs.get('tier') as QualityTier) ?? 'high', preserveDrawingBuffer: true, idleFps: 0 });
const t0 = performance.now();
const bf = new Battlefield(engine, defaultTerrain(7));
const buildMs = performance.now() - t0;
const cam = engine.camera;
const view = { target: new THREE.Vector3(0, 0, 20), yaw: 0, pitch: 0.75, dist: 95 };
function place() {
  const cp = Math.cos(view.pitch);
  cam.position.set(view.target.x + Math.sin(view.yaw) * cp * view.dist, view.target.y + Math.sin(view.pitch) * view.dist, view.target.z + Math.cos(view.yaw) * cp * view.dist);
  cam.lookAt(view.target);
}
engine.beforeRender.add(() => place());
engine.animate((dt) => {
  bf.update(dt);
  return true;
});
const s = document.getElementById('s')!;
setInterval(() => {
  const st = engine.stats;
  s.textContent = `${st.tier} ${st.fps.toFixed(0)}fps ${st.frameMs.toFixed(1)}ms calls ${st.drawCalls} tris ${(st.triangles / 1e6).toFixed(2)}M build ${buildMs.toFixed(0)}ms ${st.gpu}`;
}, 500);
(window as unknown as Record<string, unknown>).__tdev = {
  engine, bf, view, buildMs,
  set(v: { x?: number; y?: number; z?: number; yaw?: number; pitch?: number; dist?: number }) {
    if (v.x !== undefined) view.target.x = v.x;
    if (v.y !== undefined) view.target.y = v.y;
    if (v.z !== undefined) view.target.z = v.z;
    if (v.yaw !== undefined) view.yaw = v.yaw;
    if (v.pitch !== undefined) view.pitch = v.pitch;
    if (v.dist !== undefined) view.dist = v.dist;
    engine.wake();
  },
};
