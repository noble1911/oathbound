// The Sun Mirror firing in a real sim battle: Sun Mirrors behind a spear screen against Kingdom casters. For the first
// sunbeams it seeks to just before the shot, plays at speed 1 and captures the beam, the flare on the target and the
// burn, at the default battle camera (home) and at a closer RTS framing.
//   node e2e/with-gpu-lock.mjs "sun-mirror" -- node e2e/sun-mirror-shots.mjs [outDir]
// Starts its own vite dev server unless BASE is set. Env: BASE, CHROME, W/H (1920x1080), TIER (high), SHOTS (3).
// Writes <outDir>/battle-<n>-<view>-<phase>.jpg (default docs/reviews/shots-2026-11-17/sun-mirror).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);
const OUT = process.argv[2] || 'docs/reviews/shots-2026-11-17/sun-mirror';
const N = Number(process.env.SHOTS || 3);
fs.mkdirSync(OUT, { recursive: true });
// seat 0's half (cm); seat 1's squads are mirrored by the page
const MINE = 'sun_mirror:2@3000:1600,sun_mirror:2@5000:1600,spear_levy:3@4000:3600,sun_priest:1@4000:2600';
const THEIRS = 'militia:2@4000:3600,mages:2@3000:2400,mages:2@5000:2400,clerics:1@4000:2000';
let server = null;
let BASE = process.env.BASE;
if (!BASE) {
  const { createServer } = await import('vite');
  server = await createServer({ logLevel: 'error', server: { port: 5189, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
  await server.listen();
  BASE = `http://127.0.0.1:${server.config.server.port}/`;
}
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 200)); });
  await page.setViewport({ width: W, height: H });
  await page.goto(`${BASE}render-test.html?real=custom&lords=sultana,archmage&mine=${MINE}&theirs=${THEIRS}&tier=${process.env.TIER || 'high'}&ui=0&cam=free&blur=0&paused=1`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => window.__rt.view.artLoads.length);
    if (n === prev && n > 0 && i > 3) break;
    prev = n;
    await sleep(1500);
  }
  const info = await page.evaluate(() => {
    const v = window.__rt.view;
    const mirrors = v.units.slots.filter((s) => s.header.type === 'sun_mirror').map((s) => s.index);
    const shots = v.battle.source.events.filter((e) => e.k === 'projectile' && mirrors.includes(e.src));
    return { mirrors, art: v.artLoads.map((l) => l.model), shots: shots.map((e) => ({ tick: e.tick, src: e.src, tgt: e.tgt, kind: e.kind, from: e.from, to: e.to })) };
  });
  console.log('mirrors', info.mirrors, 'shots', info.shots.length, 'art', info.art.filter((m) => m.includes('mirror')));
  // the mirror on the right (seat 0's x = 5000) stands in the open: frame its shots
  const right = info.shots.reduce((m, e) => Math.max(m, e.from[0]), -1);
  const mine = info.shots.filter((e) => Math.abs(e.from[0] - right) < 600);
  const picked = mine.filter((e, i) => i === 0 || e.tick - mine[i - 1].tick > 30).slice(0, N);
  for (const [n, e] of picked.entries()) {
    const t = (e.tick * 1000) / 20;
    for (const view of ['home', 'near']) {
      await page.evaluate((t0) => { const pb = window.__rt.view.battle; pb.playing = false; pb.seek(t0); }, Math.max(0, t - 1500));
      await sleep(300);
      await page.evaluate((view, e) => {
        const v = window.__rt.view;
        v.camera.setMode('rts');
        v.camera.home(0);
        if (view === 'near') {
          const s = v.units.slots[e.src];
          const tg = v.units.slots[e.tgt];
          const mid = s.pos.clone().lerp(tg ? tg.pos : s.pos, 0.18);
          v.camera.goal.target.set(mid.x, 0, mid.z);
          v.camera.goal.dist = 30;
        }
        v.camera.snap();
        const pb = v.battle;
        pb.speed = 1;
        pb.playing = true;
      }, view, e);
      for (const [phase, dt] of [['aim', -250], ['beam', 150], ['flare', 380], ['burn', 1300]]) {
        await page.waitForFunction((ms) => window.__rt.view.battle.timeMs >= ms, { timeout: 60000, polling: 'raf' }, t + dt);
        const f = `${OUT}/battle-${n + 1}-${view}-${phase}.jpg`;
        await page.screenshot({ path: f, type: 'jpeg', quality: 86 });
        console.log(f);
      }
    }
  }
} finally {
  await browser.close();
  if (server) await server.close();
}
