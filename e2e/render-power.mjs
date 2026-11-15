// Power / efficiency measurements of the renderer on an emulated laptop (vsync'd rAF, CPU
// throttled 4x via CDP, 1440x900 @ DPR 1.5). For each tier (+ battery saver):
//   - battle: frames drawn per second, GPU ms/frame (EXT_disjoint_timer_query_webgl2), draws, tris
//   - planning idle: frames drawn per second once settled (must be 0)
//   - hidden tab: frames drawn while another tab is in front (must be 0)
//   npx vite --port 5180 &   node e2e/render-power.mjs      (TIERS=low,medium to limit)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const THROTTLE = Number(process.env.THROTTLE || 4);
const TIERS = (process.env.TIERS || 'low,medium,high,ultra,saver').split(',');
/** REAL=big runs a real sim battle (fixture, ~250 soldiers) with the art pipeline's models. */
/** KF=ashen,caliphate picks each seat's faction Keep (default: the Kingdom castle on both sides). */
/** MANIFEST=models/v2-old/manifest.json measures another model set (served by e2e/remodel-lib.mjs: e2e/power-ab.mjs). */
const EXTRA = (process.env.REAL ? `&real=${process.env.REAL}` : '') + (process.env.KF ? `&kf=${process.env.KF}` : '') + (process.env.MANIFEST ? `&manifest=${process.env.MANIFEST}` : '');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function open(query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await page.goto(`${BASE}render-test.html?${query}&ui=0&blur=0`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  return page;
}
const frames = (p) => p.evaluate(() => window.__rt.view.engine.frames);
async function drawnFps(p, ms) {
  const f0 = await frames(p);
  const t0 = Date.now();
  await sleep(ms);
  return ((await frames(p)) - f0) / ((Date.now() - t0) / 1000);
}

const rows = [];
try {
  for (const t of TIERS) {
    const q = (t === 'saver' ? 'tier=low&saver=1' : `tier=${t}`) + EXTRA;
    // battle (director camera, mid-fight)
    const b = await open(`${q}&t=${process.env.REAL ? 13000 : 15000}`);
    await sleep(process.env.REAL ? 9000 : 2500);
    const bf = await drawnFps(b, 4000);
    const s = await b.evaluate(() => window.__rt.view.stats);
    // hidden tab: bring another page to the front
    const other = await browser.newPage();
    await other.bringToFront();
    await sleep(600);
    const hf = await drawnFps(b, 2000);
    await other.close();
    await b.close();
    // planning idle (on demand: no ambient)
    const pl = await open(`${q}&mode=planning`);
    await sleep(process.env.REAL ? 9000 : 3500);
    const pf = await drawnFps(pl, 3000);
    await pl.close();
    rows.push({ tier: t, battleFps: bf.toFixed(1), gpuMs: s.gpuMs >= 0 ? s.gpuMs.toFixed(2) : 'n/a', draws: s.drawCalls, tris: (s.triangles / 1e6).toFixed(2) + 'M', px: `${s.width}x${s.height}`, planningIdleFps: pf.toFixed(1), hiddenFps: hf.toFixed(1) });
    console.log(JSON.stringify(rows.at(-1)));
  }
  console.table(rows);
} finally {
  await browser.close();
  if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
}
