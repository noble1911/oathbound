// VFX polish review: effects captured INSIDE a real battle (render-test.html?real=all&skills=1),
// each framed on the first matching event. TAG=before|after names the files, so the same script
// gives before / after pairs:  e2e/shots/vfx2-<name>-<TAG>.png
//   npx vite --port 5180 &   TAG=after node e2e/render-vfx2.mjs
// Env: BASE, CHROME, TAG (default after), ONLY=breath,numbers,...  TIER=high  SEED=5
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const TAG = process.env.TAG || 'after';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
fs.mkdirSync('e2e/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
await page.goto(`${BASE}render-test.html?real=all&skills=1&seed=${process.env.SEED || 5}&tier=${process.env.TIER || 'high'}&ui=0&cam=free&blur=0`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
await sleep(7000);

// name, what to find (runs in the page, returns { tick, x, z } in world metres or null), camera, ms after the event
const find = {
  skill: (id, nth = 0) => `(() => { const e = window.__rt.skills.filter((s) => s.skill === '${id}')[${nth}] ?? window.__rt.skills.find((s) => s.skill === '${id}'); if (!e) return null; const s = window.__rt.view.battle.source.soldiers[e.src]; return { tick: e.tick, x: e.pos[0] / 100 - 40, z: 60 - e.pos[1] / 100, src: e.src }; })()`,
  event: (pred, nth = 0) => `(() => { const ev = window.__rt.view.battle.source.events.filter((e) => ${pred}); const e = ev[Math.min(ev.length - 1, ${nth})]; if (!e) return null; const p = e.to ?? e.pos ?? null; return { tick: e.tick, x: p ? p[0] / 100 - 40 : 0, z: p ? 60 - p[1] / 100 : 0, src: e.src, seat: e.seat }; })()`,
};
const SHOTS = [
  ['frost', find.skill('frost_nova'), { dist: 20, pitch: 0.5 }, [350, 1500, 3600]],
  ['warcry', find.skill('war_cry', 2), { dist: 22, pitch: 0.48 }, [200, 450]],
  ['shieldwall', find.skill('shield_wall', 2), { dist: 15, pitch: 0.36, onSrc: true }, [500, 2000]],
  ['pinning', find.skill('pinning_shot'), { dist: 15, pitch: 0.42 }, [1300, 2500]],
  ['trample', find.skill('trample'), { dist: 14, pitch: 0.45 }, [400, 1200]],
  ['breath', find.event("e.k === 'projectile' && e.kind === 'firebreath'", 1), { dist: 24, pitch: 0.36, between: true }, [350, 800]],
  ['breath-close', find.event("e.k === 'projectile' && e.kind === 'firebreath'", 2), { dist: 13, pitch: 0.3, onSrc: true }, [450]],
  ['numbers', find.event("e.k === 'hit' && e.tick > 260", 0), { dist: 34, pitch: 0.6, front: true }, [1500, 4000]],
  ['keepfire', find.event("e.k === 'keepStage' && e.stage >= 1", 0), { dist: 44, pitch: 0.3, keep: true }, [2500, 6000]],
  ['keepfire-close', find.event("e.k === 'keepStage' && e.stage >= 1", 0), { dist: 22, pitch: 0.22, keep: true }, [4500]],
];

for (const [name, finder, cam, waits] of SHOTS) {
  if (ONLY && !ONLY.includes(name)) continue;
  const hit = await page.evaluate(finder);
  if (!hit) {
    console.log('not in this battle:', name);
    continue;
  }
  for (let i = 0; i < waits.length; i++) {
    await page.evaluate((hit, cam) => {
      const v = window.__rt.view;
      // a fresh playback per shot (also works on builds where a paused playback could not resume)
      window.__rt.startBattle(Math.max(1, hit.tick * 50 - 500));
      const pb = v.battle;
      pb.speed = 1;
      v.camera.setMode('free');
      let x = hit.x;
      let z = hit.z;
      const s = v.units.slots[hit.src];
      if (cam.onSrc && s) { x = s.pos.x; z = s.pos.z; }
      if (cam.between && s) { x = (x + s.pos.x) / 2; z = (z + s.pos.z) / 2; }
      if (cam.keep) { const k = v.field.keep(hit.seat).position; x = k.x; z = k.z; }
      if (cam.front) {
        // the thick of the fight: centroid of every living soldier
        let n = 0; x = 0; z = 0;
        for (const q of v.units.slots) if (q.visible && q.deadAt < 0) { x += q.pos.x; z += q.pos.z; n++; }
        x /= n || 1; z /= n || 1;
      }
      v.camera.goal.target.set(x, v.field.heightAt(x, z) + (cam.keep ? 5 : 1), z);
      v.camera.goal.dist = cam.dist;
      v.camera.goal.pitch = cam.pitch;
      v.camera.goal.yaw = cam.keep ? (hit.seat === 0 ? 3.6 : 0.5) : 0.35;
      v.camera.snap();
    }, hit, cam);
    // wait in BATTLE time (the page may run slower than real time on a busy GPU)
    await page.waitForFunction((ms) => window.__rt.view.battle.timeMs >= ms || window.__rt.view.battle.ended, { timeout: 90000, polling: 30 }, hit.tick * 50 + waits[i]);
    await page.evaluate(() => (window.__rt.view.battle.playing = false));
    await sleep(150);
    const file = `e2e/shots/vfx2-${name}${waits.length > 1 ? '-' + (i + 1) : ''}-${TAG}.png`;
    await page.screenshot({ path: file });
    console.log('shot', file);
  }
}
console.log(errors.length ? 'PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 12).join('\n') : 'no page errors');
await browser.close();
