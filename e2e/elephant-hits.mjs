// Hit density on the big single units, then a real-time capture at the busiest second.
//   BASE=http://127.0.0.1:5291/ TYPES=war_elephant TAG=before node e2e/elephant-hits.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:5291/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const TYPES = (process.env.TYPES || 'war_elephant').split(',');
const TAG = process.env.TAG || 'x';
const LORDS = process.env.LORDS || 'sultana,sultana';
fs.mkdirSync('e2e/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 800 });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${BASE}render-test.html?real=all&lords=${LORDS}&seed=${process.env.SEED || 5}&tier=high&ui=0&cam=free&blur=0&paused=1`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await sleep(9000);
  const targets = await page.evaluate((types) => {
    const v = window.__rt.view;
    const ev = v.battle.source.events;
    const out = [];
    const seen = new Set();
    for (const s of v.units.slots) {
      if (!types.includes(s.header.type) || seen.has(s.header.type + s.header.side)) continue;
      seen.add(s.header.type + s.header.side);
      const per = new Map();
      let bless = 0;
      for (const e of ev) {
        if (e.k === 'hit' && e.tgt === s.index && !e.miss) per.set(Math.floor(e.tick / 20), (per.get(Math.floor(e.tick / 20)) ?? 0) + 1);
        if (e.k === 'ability' && e.tgt === s.index) bless++;
      }
      let best = 0, bestN = 0;
      for (const [k, n] of per) if (n > bestN) { best = k; bestN = n; }
      out.push({ i: s.index, type: s.header.type, side: s.header.side, busiest: best, hitsThatSec: bestN, abilityOn: bless });
    }
    return out;
  }, TYPES);
  console.log(JSON.stringify(targets));
  for (const u of targets) {
    if (!u.hitsThatSec) continue;
    const t0 = Math.max(0, u.busiest - 1) * 1000;
    await page.evaluate((i, t0) => {
      const v = window.__rt.view;
      v.battle.playing = false;
      v.battle.seek(t0);
    }, u.i, t0);
    await sleep(300);
    await page.evaluate(() => { const pb = window.__rt.view.battle; pb.speed = 1; pb.playing = true; });
    for (let k = 0; k < 4; k++) {
      await page.waitForFunction((ms) => window.__rt.view.battle.timeMs >= ms, { timeout: 60000, polling: 20 }, t0 + 1000 + k * 250);
      const st = await page.evaluate((i) => {
        const v = window.__rt.view;
        const s = v.units.slots[i];
        v.camera.setMode('free');
        v.camera.goal.target.set(s.pos.x, s.pos.y + 1.5, s.pos.z);
        v.camera.goal.dist = 14 * s.arch.scale; v.camera.goal.pitch = 0.35; v.camera.goal.yaw = 0.6;
        v.camera.snap();
        const u = s.hero?.uniforms[0];
        return { t: v.battle.timeMs, flash: s.flash, uFlash: u?.uFlash.value, uFade: u?.uFade.value, dead: s.deadAt };
      }, u.i);
      const f = `e2e/shots/hits-${TAG}-${u.type}-s${u.side}-${k}.png`;
      await page.screenshot({ path: f });
      console.log(f, JSON.stringify(st));
    }
  }
} finally {
  await browser.close();
}
