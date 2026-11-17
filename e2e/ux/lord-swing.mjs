// Does a Lord swing before the sim's blow lands? Plays a real sim battle on render-test.html, finds the Lord's
// first melee attack events, and captures close-up frames from half a second before the swing to just after the
// hit, logging the clip the renderer plays, how far into it the blow is, and the distance to the target.
//   npx vite --port 5193 &   LORD=marshal TAG=before node e2e/ux/lord-swing.mjs
import { launch, sleep } from '../qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5193/';
const TAG = process.env.TAG || 'x';
const OUT = process.env.OUT || 'docs/reviews/shots-2026-11-17';
const SIDE = +(process.env.SIDE || 0);
const URL = process.env.URL || `render-test.html?real=1&seed=${process.env.SEED || 5}&rounds=${process.env.ROUNDS || 4}&tier=high&ui=0&blur=0&paused=1`;
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 720 });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(BASE + URL, { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await sleep(6000);
  const info = await p.evaluate((side) => {
    const v = window.__rt.view;
    const ev = v.battle.source.events;
    const lord = v.units.slots.find((s) => s.header.type === 'lord' && s.header.side === side);
    if (!lord) return null;
    const i = lord.index;
    const atk = ev.filter((e) => e.k === 'attack' && e.src === i).slice(0, 3).map((e) => ({ tick: e.tick, hit: e.hitTick, tgt: e.tgt, proj: e.projectile }));
    const hits = ev.filter((e) => e.k === 'hit' && e.src === i).slice(0, 3).map((e) => ({ tick: e.tick, dmg: e.dmg, tgt: e.tgt }));
    const casts = ev.filter((e) => e.k === 'ability' && e.src === i).slice(0, 3).map((e) => ({ tick: e.tick, ability: e.ability }));
    return { i, lord: lord.header.lord, atk, hits, casts, durationMs: v.battle.durationMs ?? null };
  }, SIDE);
  console.log(JSON.stringify(info));
  if (!info?.atk.length) throw new Error('no lord attack');
  const a0 = info.atk[0];
  const t0 = process.env.AT ? +process.env.AT : a0.tick * 50 - 700;
  await p.evaluate((t0) => { const pb = window.__rt.view.battle; pb.playing = false; pb.seek(t0); }, t0);
  await sleep(400);
  await p.evaluate(() => { const pb = window.__rt.view.battle; pb.speed = 0.25; pb.playing = true; });
  const rows = [];
  for (let k = 0; k < 14; k++) {
    const want = t0 + k * 100;
    await p.waitForFunction((ms) => window.__rt.view.battle.timeMs >= ms, { timeout: 60000, polling: 10 }, want);
    const st = await p.evaluate((i, tgt) => {
      const v = window.__rt.view;
      const s = v.units.slots[i];
      const e = v.units.slots[tgt];
      v.camera.setMode('free');
      v.camera.goal.target.set(s.pos.x, s.pos.y + 1.2, s.pos.z);
      v.camera.goal.dist = 9; v.camera.goal.pitch = 0.3; v.camera.goal.yaw = 1.2;
      v.camera.snap();
      const a = s.anim;
      const t = v.battle.timeMs / 1000;
      return { t: +t.toFixed(2), clip: a.oneShot ?? a.clip, into: a.oneShot ? +((t - a.oneShotAt) * a.oneShotRate).toFixed(2) : null, at: a.oneShot ? +a.oneShotAt.toFixed(2) : null, rate: +a.oneShotRate.toFixed(2), dist: e ? +s.pos.distanceTo(e.pos).toFixed(2) : null };
    }, info.i, a0.tgt);
    const f = path.join(OUT, `${TAG}-lordswing-${String(k).padStart(2, '0')}.jpg`);
    await p.screenshot({ path: f, type: 'jpeg', quality: 60 });
    rows.push(st);
    console.log(path.basename(f), JSON.stringify(st));
  }
  console.log(`first attack event ${(a0.tick / 20).toFixed(2)} s, blow lands ${(a0.hit / 20).toFixed(2)} s; first hit event ${info.hits[0] ? (info.hits[0].tick / 20).toFixed(2) : '-'} s`);
} finally {
  await browser.close();
}
