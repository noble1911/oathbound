// Siege check: after a won battle the survivors march on the loser's Keep. Melee must stand at the
// wall (not metres short of it, swinging at air), ranged within range of it, all facing it.
// For several seeds: seek to the end of the march, measure every living soldier's distance to the
// nearest wall / tower face, and save a close screenshot per losing seat (e2e/shots/siege-seat<N>-*.png).
//   npx vite --port 5180 &   node e2e/render-siege.mjs     (BASE, CHROME, SEEDS=1,2,...)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const SEEDS = (process.env.SEEDS || '1,2,3,4,5,6,7,8').split(',').map(Number);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const shot = { 0: 0, 1: 0 };
fs.mkdirSync('e2e/shots', { recursive: true });

try {
  for (const seed of SEEDS) {
    if (shot[0] >= 2 && shot[1] >= 2) break;
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    page.on('pageerror', (e) => fails.push(`seed ${seed}: ${e.message}`));
    await page.goto(`${BASE}render-test.html?real=all&seed=${seed}&tier=high&ui=0&blur=0&cam=free&paused=1`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
    await sleep(7000);
    const r = await page.evaluate(async () => {
      const v = window.__rt.view;
      const pb = v.battle;
      // the last strikes of the march
      pb.seek(pb.durationMs - 1200);
      await new Promise((res) => setTimeout(res, 600));
      const alive = v.units.slots.filter((s) => s.visible && s.deadAt < 0);
      const sides = new Set(alive.map((s) => s.header.side));
      if (sides.size !== 1) return { winner: null };
      const winner = [...sides][0];
      const keep = v.field.keep(1 - winner);
      const out = { winner, melee: [], ranged: [], fliers: [], facing: 0, n: alive.length };
      for (const s of alive) {
        const w = keep.hitPointNear(s.pos);
        const d = Math.hypot(w.x - s.pos.x, w.z - s.pos.z);
        const rangedUnit = /archers|mages|ballista|trebuchet|clerics/.test(s.header.modelId) || s.header.flags?.includes?.('ranged');
        (s.arch.flyHeight > 0 ? out.fliers : rangedUnit ? out.ranged : out.melee).push(+d.toFixed(1));
      }
      const c = v.camera;
      c.setMode('free');
      c.goal.target.set(0, 0, keep.position.z > 0 ? 50 : -50);
      c.goal.yaw = (keep.position.z > 0 ? Math.PI : 0) + 0.45;
      c.goal.dist = 34;
      c.goal.pitch = 0.42;
      c.snap();
      return out;
    });
    if (r.winner === null) {
      console.log(`seed ${seed}: no winner (timeout / draw), skipped`);
      await page.close();
      continue;
    }
    const loser = 1 - r.winner;
    const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
    console.log(`seed ${seed}: seat ${r.winner} wins, ${r.n} alive | melee to wall: median ${med(r.melee)} m, max ${Math.max(...r.melee, 0)} m (${r.melee.length}) | ranged median ${med(r.ranged)} m (${r.ranged.length}) | fliers median ${med(r.fliers)} m (${r.fliers.length})`);
    if (r.melee.length >= 4 && med(r.melee) > 3) fails.push(`seed ${seed}: melee stand ${med(r.melee)} m (median) from the wall`);
    // (the march ends as soon as the damage is dealt: slow engines / healers may still be on their way)
    if (r.ranged.length >= 3 && Math.min(...r.ranged) > 18.5) fails.push(`seed ${seed}: no ranged unit within range of the wall (nearest ${Math.min(...r.ranged)} m)`);
    if (shot[loser] < 2) {
      await sleep(1500);
      await page.screenshot({ path: `e2e/shots/siege-seat${loser}-seed${seed}.png` });
      // a moment earlier, playing: strikes landing on the wall
      await page.evaluate(() => {
        const pb = window.__rt.view.battle;
        pb.seek(Math.max(0, pb.durationMs - 5000));
        pb.playing = true;
      });
      await sleep(2200);
      await page.screenshot({ path: `e2e/shots/siege-seat${loser}-seed${seed}-strikes.png` });
      shot[loser]++;
    }
    await page.close();
  }
} finally {
  await browser.close();
}
if (!shot[0] || !shot[1]) console.log(`note: sieges seen for seat 0: ${shot[0]}, seat 1: ${shot[1]} (add SEEDS for the missing seat)`);
if (fails.length) {
  console.log('FAIL\n' + fails.join('\n'));
  process.exit(1);
}
console.log('siege OK');
