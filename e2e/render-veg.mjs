// Environment / vegetation review shots (render-test.html?real=all) on the real GPU.
//   npx vite --port 5180 &   TAG=after node e2e/render-veg.mjs
// Env: BASE, CHROME, TAG (file prefix: e2e/shots/veg-<TAG>-<name>.png), ONLY=name,name
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

// name, query, [w, h], camera goal (null = whatever the view opens with)
const LIST = [
  ['planning', 'tier=high&mode=planning', [1600, 900], null],
  ['planning-ultrawide', 'tier=high&mode=planning', [3440, 1392], null],
  ['planning-43', 'tier=medium&mode=planning', [1200, 900], null],
  ['planning-seat1', 'tier=high&mode=planning&seat=1', [1600, 900], null],
  ['battle', 'tier=high&t=14000&cam=free', [1600, 900], { t: [0, 0, 6], yaw: 0.35, dist: 80, pitch: 0.7 }],
  ['director', 'tier=high&t=14000', [1600, 900], null],
  ['forest-close', 'tier=ultra&t=3000&cam=free&paused=1', [1600, 900], { forest: true, yaw: 2.3, dist: 32, pitch: 0.34 }],
  ['forest-mid', 'tier=high&t=3000&cam=free&paused=1', [1600, 900], { forest: true, yaw: -0.4, dist: 48, pitch: 0.55 }],
  ['river', 'tier=high&t=3000&cam=free&paused=1', [1600, 900], { t: [-6, 0, 0], yaw: 1.0, dist: 30, pitch: 0.33 }],
  ['ground', 'tier=ultra&t=3000&cam=free&paused=1', [1600, 900], { t: [6, 0, 24], yaw: 0.3, dist: 12, pitch: 0.35 }],
  ['outskirts', 'tier=high&t=3000&cam=free&paused=1', [1600, 900], { t: [0, 0, 0], yaw: 0.35, dist: 120, pitch: 0.42 }],
  ['bridge', 'tier=high&mode=loot', [1600, 900], { t: [-21, 0, 0], yaw: 1.25, dist: 19, pitch: 0.2 }],
  ['bridge-top', 'tier=medium&mode=loot', [1600, 900], { t: [-21, 0, 0], yaw: 0.5, dist: 26, pitch: 0.6 }],
  ['zoomout', 'tier=medium&t=3000&cam=free&paused=1', [1600, 900], { t: [0, 0, 0], yaw: 0, dist: 999, pitch: 1.12 }],
  ['keep', 'tier=high&t=3000&cam=free&paused=1', [1600, 900], { t: [0, 0, 46], yaw: 2.6, dist: 36, pitch: 0.36 }],
  ['low', 'tier=low&t=14000&cam=free', [1600, 900], { t: [0, 0, 6], yaw: 0.35, dist: 70, pitch: 0.6 }],
  ['low-planning', 'tier=low&mode=planning', [1600, 900], null],
  ['medium', 'tier=medium&t=14000&cam=free', [1600, 900], { forest: true, yaw: -0.4, dist: 48, pitch: 0.55 }],
];

try {
  for (const [name, query, [w, h], cam] of LIST) {
    if (ONLY && !ONLY.includes(name)) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
    await page.goto(`${BASE}render-test.html?real=all&ui=0&blur=0&${query}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
    await sleep(6000);
    if (cam) {
      await page.evaluate((c) => {
        const v = window.__rt.view;
        if (v.camera.mode === 'orbit') v.camera.setMode('rts');
        let t = c.t;
        if (c.forest) {
          const f = v.field.hf.layout.features.filter((f) => f.kind === 'forest').filter((f) => f.cz > 0).sort((a, b) => a.cz - b.cz)[0];
          t = [f.cx + (c.off?.[0] ?? 0), 0, f.cz + (c.off?.[2] ?? 0)];
        }
        v.camera.goal.target.set(t[0], t[1], t[2]);
        v.camera.goal.yaw = c.yaw;
        v.camera.goal.dist = Math.min(c.dist, 140); // the rig's zoom-out limit
        v.camera.goal.pitch = c.pitch;
        v.camera.snap();
      }, cam);
    }
    await sleep(2500);
    await page.screenshot({ path: `e2e/shots/veg-${TAG}-${name}.png` });
    const s = await page.evaluate(() => window.__rt.view.stats);
    console.log(`${name}: ${s.drawCalls} draws, ${(s.triangles / 1e6).toFixed(2)}M tris, gpu ${s.gpuMs.toFixed(1)} ms, tier ${s.tier}`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length) console.log('ERRORS\n' + [...new Set(errors)].join('\n'));
