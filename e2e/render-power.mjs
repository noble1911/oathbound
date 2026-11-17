// Power / efficiency measurements of the renderer on an emulated laptop (vsync'd rAF, CPU
// throttled 4x via CDP, 1440x900 @ DPR 1.5). For each tier (+ battery saver):
//   - battle: frames drawn per second, GPU ms/frame (EXT_disjoint_timer_query_webgl2), draws, tris
//   - planning idle: frames drawn per second once settled (must be 0)
//   - hidden tab: frames drawn while another tab is in front (must be 0)
// and the `title` case: the real page (index.html), where a battle plays behind the menu on its own budget (low
// tier, 3/4 resolution, 30 fps, whatever the player's settings: src/ui/title-battle.ts). Measured with the stored
// tier at low, high and ultra (the cost must not follow it): fps and GPU ms/frame mid-battle; then every state in
// which it must not draw at all: the tab hidden, the window blurred, idle on the title, the battery saver,
// prefers-reduced-motion; and the renderer's GPU memory and the page's listeners over repeated title -> Lord pick
// -> title round trips (no growth). Any breach of those rules exits 1.
//   npx vite --port 5180 &   node e2e/render-power.mjs      (TIERS=low,medium to limit)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const THROTTLE = Number(process.env.THROTTLE || 4);
const TIERS = (process.env.TIERS || 'low,medium,high,ultra,saver,title').split(',');
/** REAL=big runs a real sim battle (fixture, ~250 soldiers) with the art pipeline's models. */
/** KF=ashen,caliphate picks each seat's faction Keep (default: the Kingdom castle on both sides). */
/** MANIFEST=models/v2-old/manifest.json measures another model set (served by e2e/remodel-lib.mjs: e2e/power-ab.mjs). */
const EXTRA = (process.env.REAL ? `&real=${process.env.REAL}` : '') + (process.env.KF ? `&kf=${process.env.KF}` : '') + (process.env.MANIFEST ? `&manifest=${process.env.MANIFEST}` : '') + (process.env.LORDS ? `&lords=${process.env.LORDS}` : '');   // LORDS=lich,sultana: the two seats' Lords (REAL=all fields each Lord's faction)
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

// ---------------------------------------------------------------- the title backdrop (the real page)
const SEED = process.env.TITLESEED || '11';
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
async function openTitle({ query = '', storage = {}, reducedMotion = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  page.on('pageerror', (e) => errors.push(e.message));
  if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument((st) => { for (const k in st) localStorage.setItem(k, st[k]); localStorage.setItem('oathbound.tutorial.done', '1'); }, storage);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const t0 = Date.now();
  await page.goto(`${BASE}?titleseed=${SEED}${query}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 120000 });
  page.__menuMs = Date.now() - t0;
  page.__cdp = cdp;
  return page;
}
const tb = (p) => p.evaluate(() => { const b = window.__ob.titleBattle(); return b ? { state: b.state, t: b.timeMs, live: document.querySelector('.title')?.classList.contains('tb-live') } : null; });
const titleShown = (p, state) => p.waitForFunction((state) => { const b = window.__ob.titleBattle(); return b?.state === state && document.querySelector('.title')?.classList.contains('tb-live'); }, { timeout: 120000 }, state);
const appFrames = (p) => p.evaluate(() => window.__ob.app.scene?.framesDrawn ?? 0);
async function appFps(p, ms) {
  const f0 = await appFrames(p);
  const t0 = Date.now();
  await sleep(ms);
  return ((await appFrames(p)) - f0) / ((Date.now() - t0) / 1000);
}
const appStats = (p) => p.evaluate(() => window.__ob.app.scene.view.stats);
/** GPU memory of the renderer, and the listeners the page holds on window and document. */
async function footprint(p) {
  const mem = await p.evaluate(() => { const r = window.__ob.app.scene.view.engine.renderer; return { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs.length, sceneNodes: (() => { let n = 0; window.__ob.app.scene.view.engine.scene.traverse(() => n++); return n; })() }; });
  let listeners = 0;
  for (const expr of ['window', 'document']) {
    const { result } = await p.__cdp.send('Runtime.evaluate', { expression: expr });
    listeners += (await p.__cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.length;
  }
  return { ...mem, listeners };
}

async function titleCase() {
  const out = [];
  // mid-battle, whatever tier the player stored
  for (const stored of ['low', 'high', 'ultra']) {
    const p = await openTitle({ storage: { 'oathbound.render.quality': stored } });
    const interactive = await p.evaluate(() => !!document.querySelector('.title-menu .vsai') && !window.__ob.app.scene);
    await titleShown(p, 'live');
    await p.waitForFunction(() => window.__ob.titleBattle().timeMs > 12000, { timeout: 120000 });
    const fps = await appFps(p, 5000);
    const s = await appStats(p);
    const row = { stored, menuMs: p.__menuMs, menuBeforeRenderer: interactive, fps: fps.toFixed(1), gpuMs: s.gpuMs >= 0 ? s.gpuMs.toFixed(2) : 'n/a', draws: s.drawCalls, tris: (s.triangles / 1e6).toFixed(2) + 'M', px: `${s.width}x${s.height}`, tier: s.tier };
    check(fps <= 30.5 && fps > 15, `title, stored tier ${stored}: ${row.fps} fps (cap 30), GPU ${row.gpuMs} ms/frame, ${row.px}, drawn on ${row.tier}`);
    check(s.tier === 'low' && s.width <= 1440 * 0.75 + 1, `title, stored tier ${stored}: low tier at 3/4 resolution whatever the setting`);
    if (stored === 'high') {
      // hidden tab
      const other = await p.browserContext().newPage();
      await other.bringToFront();
      await sleep(700);
      row.hiddenFps = (await appFps(p, 2500)).toFixed(1);
      await other.close();
      await p.bringToFront();
      await sleep(500);
      check((await appFps(p, 1500)) > 15, 'title: the battle moves again when the tab is back');
      // the window loses focus
      await p.evaluate(() => window.dispatchEvent(new Event('blur')));
      await sleep(400);
      row.blurFps = (await appFps(p, 2500)).toFixed(1);
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      check(+row.hiddenFps === 0 && +row.blurFps === 0, `title: hidden tab ${row.hiddenFps} fps, unfocused window ${row.blurFps} fps (must be 0)`);
    }
    out.push(row);
    await p.browserContext().close();
  }
  // idle on the title: a still frame, 0 fps; any input brings it back
  {
    const p = await openTitle({ query: '&titleidle=6' });
    await titleShown(p, 'still');
    await sleep(2500); // the camera comes to rest
    const idle = await appFps(p, 3000);
    await p.mouse.move(700, 500);
    await p.mouse.move(720, 520);
    await sleep(600);
    const back = await appFps(p, 2000);
    check(idle === 0 && back > 15, `title idle (6 s here; 3 min by default): ${idle.toFixed(1)} fps at rest (must be 0), ${back.toFixed(1)} fps after the pointer moves`);
    out.push({ stored: 'idle', fps: idle.toFixed(1) });
    await p.browserContext().close();
  }
  // battery saver and prefers-reduced-motion: one still frame of the fight, then nothing
  for (const [name, opts] of [['battery saver', { storage: { 'oathbound.render.batterySaver': '1' } }], ['reduced motion', { reducedMotion: true }]]) {
    const p = await openTitle(opts);
    await titleShown(p, 'still');
    await sleep(2500);
    const f = await appFps(p, 3000);
    const t = (await tb(p)).t;
    check(f === 0 && t > 5000, `title, ${name}: ${f.toFixed(1)} fps (must be 0), a still from ${(t / 1000).toFixed(0)} s into the battle`);
    out.push({ stored: name, fps: f.toFixed(1) });
    await p.browserContext().close();
  }
  // no renderer: the woodcut backdrop stays, nothing is simulated or drawn
  {
    const p = await openTitle({ query: '&scene=standin' });
    await p.waitForFunction(() => window.__ob.titleBattle()?.state !== 'loading', { timeout: 90000 }).catch(() => undefined);
    await sleep(1500);
    const st = await tb(p);
    check(st.state === 'static' && !st.live, `title on the stand-in renderer: static backdrop (${st.state})`);
    await p.browserContext().close();
  }
  // title -> Lord pick -> title, six times: the same battle each time, so what the renderer holds must not grow
  {
    const p = await openTitle({ storage: { 'oathbound.render.quality': 'medium' } });
    const marks = [];
    for (let i = 0; i < 6; i++) {
      await titleShown(p, 'live');
      await p.waitForFunction(() => window.__ob.titleBattle().timeMs > 4000, { timeout: 60000 });
      if (i === 1 || i === 5) marks.push(await footprint(p));
      await p.click('.title-menu .offline');
      await p.waitForFunction(() => !!document.querySelector('.lordpick'), { timeout: 30000 });
      await sleep(i === 0 ? 2500 : 900);
      if (i === 0) {
        const s = await appStats(p);
        const idle = await appFps(p, 1500);
        check(s.tier === 'medium' && s.width === 1440 * 1.25 && idle === 0, `leaving the title restores the player's settings (${s.tier}, ${s.width}x${s.height}) and stops drawing (${idle.toFixed(1)} fps); still backdrop: ${await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--still').slice(0, 9))}`);
      }
      await p.evaluate(() => window.__ob.app.backend.leave());
      await p.waitForFunction(() => !!document.querySelector('.title-menu') && !window.__ob.app.room, { timeout: 30000 });
    }
    const [a, b] = marks;
    check(a.geometries === b.geometries && a.textures === b.textures && a.programs === b.programs && a.sceneNodes === b.sceneNodes && a.listeners === b.listeners, `title <-> match x6: nothing grows (round 2 ${JSON.stringify(a)}, round 6 ${JSON.stringify(b)})`);
    await p.browserContext().close();
  }
  console.table(out);
}

const rows = [];
try {
  for (const t of TIERS) {
    if (t === 'title') {
      await titleCase();
      continue;
    }
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
  if (fails) {
    console.log(`${fails} title check(s) FAILED`);
    process.exitCode = 1;
  }
}
