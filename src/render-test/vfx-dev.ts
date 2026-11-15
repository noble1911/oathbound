// VFX dev harness (flat ground, stand-in blocks). /src/render-test/vfx-dev.html?fx=meteor
import * as THREE from 'three';
import { Engine } from '../render/core/engine.ts';
import { Vfx } from '../render/vfx/index.ts';

const engine = new Engine(document.getElementById('app')!, { quality: 'high', preserveDrawingBuffer: true });
const ground = (x: number, z: number) => 0.4 * Math.sin(x * 0.08) * Math.cos(z * 0.07);
const geo = new THREE.PlaneGeometry(200, 200, 100, 100).rotateX(-Math.PI / 2);
const pos = geo.attributes.position;
for (let i = 0; i < pos.count; i++) pos.setY(i, ground(pos.getX(i), pos.getZ(i)));
geo.computeVertexNormals();
const floor = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#4f6b34', roughness: 0.95 }));
floor.receiveShadow = true;
engine.scene.add(floor);
const blockMat = new THREE.MeshStandardMaterial({ color: '#8a3030', roughness: 0.6 });
for (let i = 0; i < 24; i++) {
  const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 4, 8), blockMat);
  b.position.set((i % 6) * 1.6 - 4, 0.85, Math.floor(i / 6) * 1.6 - 2);
  b.castShadow = b.receiveShadow = true;
  engine.scene.add(b);
}
engine.prepare(engine.scene, {});
engine.camera.position.set(0, 14, 26);
engine.camera.lookAt(0, 1, 0);
const vfx = new Vfx(engine, ground);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const fx: Record<string, () => void> = {
  arrows: () => { for (let i = 0; i < 30; i++) vfx.projectile('arrow', V(-20 + Math.random() * 4, 1.5, 10 + Math.random() * 4), V(Math.random() * 8 - 4, 1, Math.random() * 6 - 3), 1.4, 'arc'); },
  bolt: () => vfx.projectile('bolt', V(-25, 1.6, 6), V(2, 1, 0), 0.7, 'line'),
  stone: () => vfx.projectile('stone', V(-40, 3, -20), V(0, 0, 0), 2.2, 'high_arc', () => vfx.impact('stone', V(0, 0, 0), 6)),
  fireball: () => vfx.projectile('fireball', V(-14, 2, 8), V(1, 1, 0), 0.9, 'line', () => vfx.impact('fireball', V(1, 1, 0), 3)),
  hits: () => { for (let i = 0; i < 6; i++) vfx.hitSpark(V(i * 1.6 - 4, 1.2, -2), { crit: i === 2, magic: i === 4 }); },
  heal: () => vfx.heal(V(-2, 0, 0)),
  lightning: () => { vfx.lightning(V(-6, 1.2, 0), V(0, 1.2, 1)); vfx.lightning(V(0, 1.2, 1), V(4, 1.2, -2)); },
  burn: () => vfx.burn(V(2, 0, 2), 3),
  frost: () => vfx.frost(V(-3, 0, 2), 3),
  meteor: () => vfx.meteor(V(0, 0, 0), 10),
  rally: () => vfx.rally(V(0, 0, 0), 10, 6),
  bulwark: () => vfx.bulwark(V(0, 0, 0), 9, 6),
  skyfall: () => vfx.skyfall(V(-10, 40, -20), V(0, 0, 0)),
  // the newer Lords
  soulReap: () => vfx.soulReap(V(0, 0, 0), 12, 6),
  graveTaunt: () => {
    vfx.graveTaunt(V(0, 0, 0), 10, 5);
    for (let i = 0; i < 6; i++) { const p = V(Math.cos(i) * 7, 0, Math.sin(i) * 7); vfx.tauntMark(() => V(0, 2.4, 0), () => p, 5); }
  },
  plagueBreath: () => vfx.plagueBreath(V(-14, 18, -10), V(0, 0, 0), 4.5, 0.7),
  whirlwind: () => vfx.djinnWhirlwind(V(0, 0, 0), 5, 4.5),
  stampede: () => vfx.stampede(V(-8, 0, 6), V(4, 0, -3), 2.8),
  talon: () => vfx.talon(V(-12, 14, -8), () => V(0, 0, 0), V(0, 0, 8), 0.6),
  breath: () => vfx.breath(V(-12, 5, 4), V(1, -0.35, -0.3), 14, 0.35, 2.5),
  stomp: () => vfx.stomp(V(0, 0, 0), 5),
  dust: () => { for (let i = 0; i < 40; i++) vfx.marchDust(V(Math.random() * 10 - 5, 0, Math.random() * 6 - 3)); },
  keep: () => vfx.keepHit(V(0, 4, 0), true),
  collapse: () => vfx.keepCollapse(V(0, 0, 0)),
  level: () => vfx.levelUp(V(0, 0, 0)),
  loot: () => { (['common', 'magic', 'rare', 'legendary'] as const).forEach((r, i) => vfx.lootBeam(V(i * 4 - 6, 0, 0), r)); },
  numbers: () => { vfx.damageNumber(V(-3, 2, 0), 42); vfx.damageNumber(V(0, 2.5, 0), 187, 'crit'); vfx.damageNumber(V(3, 2, 0), 25, 'heal'); vfx.damageNumber(V(-1, 2, 2), 0, 'miss'); vfx.damageNumber(V(2, 2, 2), 64, 'effective'); },
};
(window as unknown as { __vfx: unknown }).__vfx = { engine, vfx, fx, V };
const hud = document.getElementById('hud')!;
setInterval(() => { const s = engine.stats; hud.textContent = `${s.tier} ${s.fps.toFixed(0)} fps ${s.drawCalls} calls`; }, 500);
const q = new URLSearchParams(location.search).get('fx');
if (q) for (const k of q.split(',')) fx[k]?.();
