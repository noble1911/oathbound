// Squad-plate stability check: frames a unit's plate, nudges the camera a hair between frames
// (so every frame re-rasterises the plate) and counts the highlight-halo pixels in each frame.
// A stable plate gives the same count every frame; a flickering one swings between ~0 and many.
//   npx vite --port 5180 &   node e2e/render-plates.mjs
// Env: BASE, CHROME, TYPES=lord,golem,dragon,wyvern,militia  DISTS=30,60,100  SAVE=1 (write e2e/shots/plates-*.png)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const TYPES = (process.env.TYPES || 'lord,golem,dragon,wyvern,militia').split(',');
const DISTS = (process.env.DISTS || '30,60,100').split(',').map(Number);
const FRAMES = 10;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}render-test.html?real=all&tier=${process.env.TIER || 'high'}&ui=0&mode=${process.env.MODE || 'planning'}&blur=0`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
await sleep(7000);
let bad = 0;
async function measure(type, dist) {
  const counts = [];
  // frame the unit once and let the camera come to rest
  const ok = await page.evaluate((type, dist) => {
    const v = window.__rt.view;
    const s = v.units.slots.find((x) => x.header.type === type && x.header.side === 0 && x.visible);
    if (!s) return false;
    v.setPlanning({ visible: false });
    v.camera.setMode('rts');
    v.camera.goal.target.copy(s.pos);
    v.camera.goal.dist = dist;
    v.camera.goal.yaw = 0.2;
    v.camera.goal.pitch = NaN;
    v.camera.snap();
    v.engine.wake();
    return true;
  }, type, dist);
  if (!ok) return null;
  await sleep(4000);
  // where the unit's own plate is drawn: its instance anchor, projected with the live camera
  const at = await page.evaluate((type) => {
    const v = window.__rt.view;
    const s = v.units.slots.find((x) => x.header.type === type && x.header.side === 0 && x.visible);
    const T = window.__rt.THREE;
    const P = v.plates.mesh.geometry.attributes.aPos;
    let best = null;
    let bd = Infinity;
    for (let i = 0; i < v.plates.mesh.geometry.instanceCount; i++) {
      const p = new T.Vector3(P.getX(i), P.getY(i), P.getZ(i));
      const d = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best && v.engine.toScreen(best);
  }, type);
  if (!at) return null;
  const clip = { x: Math.max(0, Math.min(1300, at.x - 150)), y: Math.max(0, Math.min(740, at.y - 110)), width: 300, height: 160 };
  for (let f = 0; f < FRAMES; f++) {
    // a sub-pixel camera tremor: every frame re-rasterises the plate at a slightly different spot
    await page.evaluate(() => window.__rt.view.engine.addShake(0.012));
    await sleep(60 + f * 13);
    const png = await page.screenshot({ clip, ...(process.env.SAVE ? { path: `e2e/shots/plates-${type}-${dist}-${f}.png` } : {}) });
    // bright warm pixels: the gold rim / pips, and the hover / selected halo when it (wrongly) lights up
    counts.push(await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 215 && d[i + 1] > 165 && d[i + 2] < 190 && d[i] - d[i + 2] > 50) n++;
      return n;
    }, Buffer.from(png).toString('base64')));
  }
  return counts;
}
for (const type of TYPES) {
  for (const dist of DISTS) {
    let counts = null;
    // the dev server may hot-reload the page under us: wait for it and redo the case
    for (let attempt = 0; attempt < 4 && !counts; attempt++) {
      try {
        counts = await measure(type, dist);
        if (!counts) break;
      } catch {
        await sleep(3000);
        await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 }).catch(() => {});
        await sleep(7000);
      }
    }
    if (!counts) continue;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const flicker = max - min > Math.max(12, max * 0.25);
    if (flicker) bad++;
    console.log(`${type.padEnd(8)} dist ${String(dist).padStart(3)}  bright-gold px per frame: ${counts.join(' ')}  ${flicker ? 'FLICKER' : 'stable'}`);
  }
}
console.log(bad ? `${bad} unstable case(s)` : 'all plates stable');
if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].join('\n'));
await browser.close();
process.exit(bad ? 1 : 0);
