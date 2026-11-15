// The six newer Lords in a real sim battle (render-test.html?real=all&lords=a,b: every unit type on both
// sides plus the two Lords). For each Lord: a close-up of its model (its own GLB once the remodel ships it,
// else the fallback it borrows), then its ability: seek to just before the first cast, frame it, let it
// play and capture two moments. Writes e2e/shots/new-lords/<lord>-model.png and fx-<ability>-a/b.png.
//   npx vite --port 5291 &   BASE=http://127.0.0.1:5291/ node e2e/new-lords-fx.mjs
// Env: BASE, CHROME, TIER=high, SEED=5, ONLY=talon,stampede
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5291/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const TIER = process.env.TIER || 'high';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const OUT = 'e2e/shots/new-lords';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// [lord seat 0, lord seat 1]: each battle shows two abilities
const PAIRS = [['deathknight', 'vizier'], ['ossuary', 'rocrider'], ['drakerider', 'rajah']];
// ability: [camera distance, pitch, ms after the cast for shot a, for shot b]
const PLAN = {
  soul_reap: [30, 0.55, 500, 2500],
  grave_taunt: [22, 0.45, 300, 1500],
  plague_breath: [26, 0.42, 650, 1300],
  whirlwind: [26, 0.45, 900, 2600],
  stampede: [22, 0.42, 250, 700],
  talon: [22, 0.4, 450, 1000],
};
const ABIL = { deathknight: 'soul_reap', ossuary: 'grave_taunt', drakerider: 'plague_breath', vizier: 'whirlwind', rajah: 'stampede', rocrider: 'talon' };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
const report = [];
try {
  for (const pair of PAIRS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
    await page.goto(`${BASE}render-test.html?real=all&lords=${pair.join(',')}&seed=${process.env.SEED || 5}&tier=${TIER}&ui=0&cam=free&blur=0`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
    await sleep(8000); // art models stream in
    for (const [seat, lord] of pair.entries()) {
      if (ONLY && !ONLY.includes(ABIL[lord]) && !ONLY.includes(lord)) continue;
      // the model: a close-up at the start of the battle
      const model = await page.evaluate((seat) => {
        const v = window.__rt.view;
        const pb = v.battle;
        pb.playing = true; // keep frames coming while the camera moves (render on demand)
        pb.speed = 0.05;
        pb.seek(200);
        const i = v.units.slots.findIndex((s) => s.header.type === 'lord' && s.header.side === seat);
        const s = v.units.slots[i];
        v.camera.setMode('free');
        v.camera.goal.target.set(s.pos.x, s.pos.y + 1.2, s.pos.z);
        v.camera.goal.dist = s.arch.flyHeight ? 16 : 10;
        v.camera.goal.pitch = 0.3;
        v.camera.goal.yaw = seat ? 3.5 : 0.4;
        v.camera.snap();
        const h = s.hero;
        // which model it wears: its own GLB, a borrowed one (Archetype.fallback) or the procedural stand-in
        const asset = v.units.assets?.heroCache?.get?.(s.arch.key);
        const e = v.units.assets?.entry?.(s.header.modelId, s.arch.key, ...(s.arch.fallback ?? []));
        return { i, key: s.arch.key, art: !!asset?.art, glb: asset?.art ? e?.glb ?? '?' : 'procedural', y: +s.pos.y.toFixed(1), h: !!h };
      }, seat);
      await sleep(1500);
      await page.evaluate(() => { window.__rt.view.battle.playing = false; window.__rt.view.battle.speed = 1; });
      await sleep(150);
      await page.screenshot({ path: `${OUT}/${lord}-model.png` });
      // the ability
      const id = ABIL[lord];
      const casts = await page.evaluate((id, seat) => {
        const v = window.__rt.view;
        return v.battle.source.events
          .filter((e) => e.k === 'ability' && e.ability === id && !(id === 'grave_taunt' && e.radius === 0) && v.units.slots[e.src]?.header.type === 'lord' && v.units.slots[e.src].header.side === seat)
          .map((e) => ({ tick: e.tick, pos: e.pos, src: e.src, tgt: e.tgt, radius: e.radius, dur: e.dur }));
      }, id, seat);
      report.push(`${lord}: model ${model.key} wears ${model.glb}; ${id} cast ${casts.length}x${casts.length ? ` first at ${(casts[0].tick / 20).toFixed(1)} s` : ''}`);
      if (!casts.length) continue;
      const e = casts[0];
      const [dist, pitch, a, b] = PLAN[id];
      for (const [tag, wait] of [['a', a], ['b', b]]) {
        await page.evaluate((e, dist, pitch) => {
          const v = window.__rt.view;
          const pb = v.battle;
          pb.playing = true;
          pb.speed = 1;
          pb.seek(Math.max(0, e.tick * 50 - 400));
          const s = v.units.slots[e.src];
          const wx = e.pos[0] / 100 - 40;
          const wz = 60 - e.pos[1] / 100;
          v.camera.setMode('free');
          const tx = s ? (wx + s.pos.x) / 2 : wx;
          const tz = s ? (wz + s.pos.z) / 2 : wz;
          const far = s ? Math.hypot(wx - s.pos.x, wz - s.pos.z) : 0;
          v.camera.goal.target.set(far > 16 ? wx : tx, v.field.heightAt(tx, tz) + 1, far > 16 ? wz : tz);
          v.camera.goal.dist = dist;
          v.camera.goal.pitch = pitch;
          v.camera.goal.yaw = 0.35;
          v.camera.snap();
        }, e, dist, pitch);
        try {
          await page.waitForFunction((ms) => window.__rt.view.battle.timeMs >= ms || window.__rt.view.battle.ended, { timeout: 90000, polling: 30 }, e.tick * 50 + wait);
        } catch (err) {
          console.log('stuck', id, tag, await page.evaluate(() => { const b = window.__rt.view.battle; return JSON.stringify({ t: b.timeMs, d: b.durationMs, playing: b.playing, ended: b.ended }); }));
          throw err;
        }
        await page.evaluate(() => (window.__rt.view.battle.playing = false));
        await sleep(150);
        await page.screenshot({ path: `${OUT}/fx-${id}-${tag}.png` });
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(report.join('\n'));
console.log(errors.length ? 'PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 12).join('\n') : 'no page errors');
