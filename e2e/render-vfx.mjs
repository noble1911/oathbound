// VFX review shots on the real battlefield (render-test.html, full roster, real art).
//   npx vite --port 5180 &   node e2e/render-vfx.mjs
// Part 1: each effect triggered next to the deployed army and captured mid-play (close camera).
// Part 2: a full-roster battle at several moments (director + a low-tier frame).
// Env: BASE, CHROME, ONLY=fireball,meteor,...  TIER=high  W/H. Writes e2e/shots/vfx-*.png.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const TIER = process.env.TIER || 'high';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (n) => !ONLY || ONLY.includes(n);
fs.mkdirSync('e2e/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function open(query) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
  await page.goto(`${BASE}render-test.html?${query}&blur=0`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  return page;
}

// name, camera {x, z, dist, pitch, yaw}, ms after the trigger, trigger (runs in the page; P = ground point under the camera target)
const C = { x: Number(process.env.CX ?? 4), z: Number(process.env.CZ ?? 15) };
const FX = [
  ['arrows', { dist: 20, pitch: 0.42, yaw: 0.5 }, 1250, (v, T, P) => {
    for (let i = 0; i < 40; i++) {
      const from = P.clone().add(new T.Vector3(-30 + Math.random() * 6, 1.5, -14 + Math.random() * 6));
      const to = P.clone().add(new T.Vector3((Math.random() - 0.5) * 9, 0, (Math.random() - 0.5) * 7));
      v.vfx.projectile('arrow', from, to, 1.2 + Math.random() * 0.5, 'arc');
    }
  }],
  ['arrows-stuck', { dist: 9, pitch: 0.3, yaw: 0.5 }, 2600, (v, T, P) => {
    for (let i = 0; i < 40; i++) {
      const from = P.clone().add(new T.Vector3(-30 + Math.random() * 6, 1.5, -14 + Math.random() * 6));
      const to = P.clone().add(new T.Vector3((Math.random() - 0.5) * 7, 0, (Math.random() - 0.5) * 5));
      v.vfx.projectile('arrow', from, to, 1.2 + Math.random() * 0.5, 'arc');
    }
  }],
  ['bolt', { dist: 14, pitch: 0.3, yaw: 0.4 }, 760, (v, T, P) => v.vfx.projectile('bolt', P.clone().add(new T.Vector3(-30, 1.6, -6)), P.clone().setY(P.y + 0.2), 0.6, 'line')],
  ['stone-flight', { dist: 30, pitch: 0.3, yaw: 0.4 }, 1300, (v, T, P) => v.vfx.projectile('stone', P.clone().add(new T.Vector3(-36, 3, -22)), P.clone(), 2.2, 'high_arc', () => v.vfx.impact('stone', P, 6))],
  ['stone', { dist: 24, pitch: 0.34, yaw: 0.4 }, 2480, (v, T, P) => v.vfx.projectile('stone', P.clone().add(new T.Vector3(-36, 3, -22)), P.clone(), 2.2, 'high_arc', () => v.vfx.impact('stone', P, 6))],
  ['stone-after', { dist: 24, pitch: 0.34, yaw: 0.4 }, 3600, (v, T, P) => v.vfx.projectile('stone', P.clone().add(new T.Vector3(-36, 3, -22)), P.clone(), 2.2, 'high_arc', () => v.vfx.impact('stone', P, 6))],
  ['fireball-flight', { dist: 12, pitch: 0.25, yaw: 0.3 }, 620, (v, T, P) => v.vfx.projectile('fireball', P.clone().add(new T.Vector3(-14, 2, 5)), P.clone().setY(P.y + 0.6), 0.9, 'line', () => v.vfx.impact('fireball', P, 3))],
  ['fireball', { dist: 12, pitch: 0.25, yaw: 0.3 }, 1060, (v, T, P) => v.vfx.projectile('fireball', P.clone().add(new T.Vector3(-14, 2, 5)), P.clone().setY(P.y + 0.6), 0.9, 'line', () => v.vfx.impact('fireball', P, 3))],
  ['fireball-late', { dist: 12, pitch: 0.25, yaw: 0.3 }, 1450, (v, T, P) => v.vfx.projectile('fireball', P.clone().add(new T.Vector3(-14, 2, 5)), P.clone().setY(P.y + 0.6), 0.9, 'line', () => v.vfx.impact('fireball', P, 3))],
  ['heal', { dist: 9, pitch: 0.4, yaw: 0.3 }, 650, (v, T, P) => { v.vfx.heal(P, 1.2); v.vfx.heal(P.clone().add(new T.Vector3(3, 0, -1)), 1); }],
  ['melee', { dist: 8, pitch: 0.3, yaw: 0.3 }, 130, (v, T, P) => { for (let i = 0; i < 5; i++) v.vfx.hitSpark(P.clone().add(new T.Vector3(i * 1.5 - 3, 1.2, (i % 2) * 0.8)), { crit: i === 2 }); }],
  ['death', { dist: 8, pitch: 0.35, yaw: 0.3 }, 900, (v, T, P) => { for (let i = 0; i < 5; i++) v.vfx.death(P.clone().add(new T.Vector3(i * 1.5 - 3, 0, (i % 2) * 0.8)), i === 2 ? 2.2 : 1); }],
  ['lightning', { dist: 12, pitch: 0.3, yaw: 0.3 }, 110, (v, T, P) => { v.vfx.lightning(P.clone().add(new T.Vector3(-6, 1.4, 0)), P.clone().add(new T.Vector3(0, 1.2, 1))); v.vfx.lightning(P.clone().add(new T.Vector3(0, 1.2, 1)), P.clone().add(new T.Vector3(4, 1.2, -2))); }],
  ['frost', { dist: 9, pitch: 0.4, yaw: 0.3 }, 700, (v, T, P) => v.vfx.frost(P, 3)],
  ['burn', { dist: 9, pitch: 0.3, yaw: 0.3 }, 1200, (v, T, P) => v.vfx.burn(P, 3)],
  ['rally', { dist: 30, pitch: 0.5, yaw: 0.3 }, 700, (v, T, P) => v.vfx.rally(P, 12, 6)],
  ['rally-hold', { dist: 30, pitch: 0.5, yaw: 0.3 }, 2600, (v, T, P) => v.vfx.rally(P, 12, 6)],
  ['bulwark', { dist: 30, pitch: 0.4, yaw: 0.3 }, 900, (v, T, P) => v.vfx.bulwark(P, 10, 6)],
  ['skyfall', { dist: 22, pitch: 0.35, yaw: 0.3 }, 250, (v, T, P) => v.vfx.skyfall(P.clone().add(new T.Vector3(-12, 30, -14)), P)],
  ['skyfall-hit', { dist: 22, pitch: 0.35, yaw: 0.3 }, 520, (v, T, P) => v.vfx.skyfall(P.clone().add(new T.Vector3(-12, 30, -14)), P)],
  ['meteor-fall', { dist: 34, pitch: 0.32, yaw: 0.3 }, 950, (v, T, P) => v.vfx.meteor(P, 10)],
  ['meteor', { dist: 34, pitch: 0.32, yaw: 0.3 }, 1420, (v, T, P) => v.vfx.meteor(P, 10)],
  ['meteor-after', { dist: 34, pitch: 0.32, yaw: 0.3 }, 3200, (v, T, P) => v.vfx.meteor(P, 10)],
  ['breath', { dist: 22, pitch: 0.3, yaw: 0.9 }, 1300, (v, T, P) => v.vfx.breath(P.clone().add(new T.Vector3(-9, 6, 3)), new T.Vector3(1, -0.42, -0.25), 14, 0.3, 2.4)],
  ['breath-after', { dist: 22, pitch: 0.3, yaw: 0.9 }, 3300, (v, T, P) => v.vfx.breath(P.clone().add(new T.Vector3(-9, 6, 3)), new T.Vector3(1, -0.42, -0.25), 14, 0.3, 2.4)],
  ['stomp', { dist: 16, pitch: 0.35, yaw: 0.3 }, 350, (v, T, P) => v.vfx.stomp(P, 4)],
  ['numbers', { dist: 16, pitch: 0.35, yaw: 0.3 }, 380, (v, T, P) => {
    const n = (dx, dz, val, st) => v.vfx.damageNumber(P.clone().add(new T.Vector3(dx, 1.8, dz)), val, st);
    n(-5, 0, 42, 'normal'); n(0, 0, 187, 'crit'); n(4.5, 0, 25, 'heal'); n(-2.5, 2, 0, 'miss'); n(2.5, 2, 64, 'effective'); n(-4.5, -2.5, 7, 'weak'); n(6, -2, 318, 'normal');
  }],
  ['levelup', { dist: 10, pitch: 0.3, yaw: 0.3 }, 350, (v, T, P) => v.vfx.levelUp(P)],
  ['loot', { dist: 22, pitch: 0.2, yaw: 0.25 }, 1500, (v, T, P) => { ['common', 'magic', 'rare', 'legendary'].forEach((r, i) => v.vfx.lootBeam(P.clone().add(new T.Vector3((i - 1.5) * 4.5, 0, 0)), r)); }],
  ['keep-hit', { keep: true, dist: 34, pitch: 0.25, yaw: 3.6 }, 300, (v) => { for (let i = 0; i < 3; i++) v.vfx.keepHit(v.field.keep(0).hitPoint(), i === 0); }],
  ['keep-collapse', { keep: true, dist: 46, pitch: 0.3, yaw: 3.6 }, 900, (v) => { const k = v.field.keep(0); k.setStage(2); v.vfx.keepCollapse(k.position.clone()); }],
  ['keep-fire', { keep: true, dist: 40, pitch: 0.25, yaw: 3.6 }, 5200, (v) => { const k = v.field.keep(0); k.setStage(3); v.vfx.keepFire([0, 1, 2, 3].map(() => k.hitPoint()), 45, 1.2); }],
];

try {
  if (FX.some(([n]) => want(n))) {
    const page = await open(`real=all&tier=${TIER}&ui=0&mode=planning`);
    await sleep(6000);
    await page.evaluate(() => window.__rt.view.setPlanning({ visible: false }));
    const shoot = async (name, cam, ms, fn) => {
      await page.evaluate((cam, C) => {
        const v = window.__rt.view;
        v.vfx.clear();
        v.setPlanning({ visible: false });
        v.camera.setMode('rts');
        const k = cam.keep ? v.field.keep(0).position : null;
        const x = k ? k.x : C.x;
        const z = k ? k.z : C.z;
        v.camera.goal.target.set(x, v.field.heightAt(x, z) + (k ? 5 : 1), z);
        v.camera.goal.yaw = cam.yaw;
        v.camera.goal.dist = cam.dist;
        v.camera.goal.pitch = cam.pitch;
        v.camera.snap();
      }, cam, C);
      await sleep(350);
      await page.evaluate(`(() => { const v = window.__rt.view, T = window.__rt.THREE; const P = new T.Vector3(${C.x}, v.field.heightAt(${C.x}, ${C.z}), ${C.z}); (${fn.toString()})(v, T, P); })()`);
      await sleep(ms);
      await page.screenshot({ path: `e2e/shots/vfx-${name}.png` });
    };
    for (const [name, cam, ms, fn] of FX) {
      if (!want(name)) continue;
      // the dev server may hot-reload the page under us (other work in the repo): wait and retry
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await shoot(name, cam, ms, fn);
          console.log('shot', name);
          break;
        } catch (e) {
          console.log('retry', name, String(e.message).slice(0, 60));
          await sleep(3000);
          await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 }).catch(() => {});
          await sleep(6000);
        }
      }
    }
    await page.close();
  }
  // full-roster battle
  const BATTLE = [
    ['battle-volley', `real=all&tier=${TIER}&ui=0&t=3000`, 6500],
    ['battle-clash', `real=all&tier=${TIER}&ui=0&t=11000`, 7000],
    ['battle-mid', `real=all&tier=${TIER}&ui=0&t=20000`, 7000],
    ['battle-late', `real=all&tier=${TIER}&ui=0&t=32000`, 7000],
    ['battle-low', 'real=all&tier=low&ui=0&t=11000', 7000],
    ['battle-medium', 'real=all&tier=medium&ui=0&t=11000', 7000],
  ];
  for (const [name, query, ms] of BATTLE) {
    if (!want(name)) continue;
    const page = await open(query);
    await sleep(ms);
    await page.screenshot({ path: `e2e/shots/vfx-${name}.png` });
    const s = await page.evaluate(() => window.__rt.view.stats);
    console.log('shot', name, `${s.tier} ${s.fps.toFixed(0)} fps, ${s.drawCalls} draws, gpu ${s.gpuMs.toFixed(1)} ms`);
    await page.close();
  }
} finally {
  await browser.close();
  console.log(errors.length ? 'PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 20).join('\n') : 'no page errors');
}
