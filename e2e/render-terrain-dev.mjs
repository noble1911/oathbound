// Terrain worker screenshots: npx vite --port 5181 &  node e2e/render-terrain-dev.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:5181/';
const TIER = process.env.TIER || 'high';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
fs.mkdirSync('e2e/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
await page.goto(BASE + 'src/render-test/terrain-dev.html?tier=' + TIER, { waitUntil: 'networkidle0', timeout: 120000 });
await new Promise((r) => setTimeout(r, 3000));
const views = {
  overview: { x: 0, y: 0, z: 8, yaw: 0, pitch: 0.82, dist: 150 },
  rts: { x: 0, y: 0, z: 22, yaw: 0, pitch: 0.72, dist: 70 },
  river: { x: -24, y: 0, z: 2, yaw: 0.6, pitch: 0.4, dist: 32 },
  keep: { x: 0, y: 4, z: 62, yaw: 2.6, pitch: 0.32, dist: 50 },
  low: { x: 10, y: 1, z: 30, yaw: -0.5, pitch: 0.18, dist: 26 },
  planning: { x: 0, y: 0, z: 30, yaw: 0, pitch: 0.9, dist: 85, plan: true },
  ruin: { x: 7, y: 1, z: 13, yaw: 0.8, pitch: 0.35, dist: 20 },
  keep3: { x: 0, y: 4, z: -62, yaw: 0.3, pitch: 0.35, dist: 50, stage: 3 },
};
for (const [name, v] of Object.entries(views)) {
  if (ONLY && !ONLY.includes(name)) continue;
  await page.evaluate((v) => {
    const d = window.__tdev;
    d.set(v);
    d.bf.setPlanning({ visible: !!v.plan, seat: 0, grid: true, bothSides: true });
    d.bf.keep(1).setStage(v.stage ?? 0);
  }, v);
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `e2e/shots/dev-terrain-${name}.png` });
  console.log(name, await page.evaluate(() => document.getElementById('s').textContent));
}
if (!ONLY || ONLY.includes('reseed')) {
  const ms = await page.evaluate(async () => {
    const d = window.__tdev;
    const { defaultTerrain } = await import('/src/render/terrain/index.ts');
    const t = performance.now();
    d.bf.setTerrain(defaultTerrain(3));
    d.set({ x: 0, y: 0, z: 8, yaw: 0, pitch: 0.82, dist: 150 });
    return performance.now() - t;
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: 'e2e/shots/dev-terrain-reseed.png' });
  console.log('reseed ms', ms.toFixed(0));
}
console.log('errors:', errs.slice(0, 10));
await browser.close();
