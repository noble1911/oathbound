// Team-colour check for the Wraith Riders (spectre shader): blue and red wraith squads side by side with other
// Ashen Covenant / mounted squads for reference, at the default battle camera distance and closer, per tier.
//   npx vite --port 5187 &   BASE=http://127.0.0.1:5187/ node e2e/wraith-team.mjs <tag> [tiers=low,medium,high,ultra]
// Writes e2e/shots/wraith-<tag>-<tier>-{far,mid,close}.png.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const tag = process.argv[2] ?? 'after';
const tiers = (process.argv[3] ?? 'low,medium,high,ultra').split(',');
const SHOTS = 'e2e/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  for (let ti = 0, tries = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    page.on('pageerror', (e) => console.log('page error:', e.message));
    await page.goto(`${BASE}render-test.html?real=all&tier=${tier}&ui=0&blur=0&mode=planning`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
    await sleep(2000);
    await page.evaluate(() => {
      const v = window.__rt.view;
      v.setPlanning({ visible: false });
      // left to right: wraith (blue), wraith (red), grave knights (blue / red), skeletons (blue / red)
      const row = [['wraith_rider', 0], ['wraith_rider', 1], ['grave_knight', 0], ['grave_knight', 1], ['skeleton', 0, 'militia'], ['skeleton', 1, 'militia']];
      const army = row.map(([m, owner, type], i) => ({ id: i + 1, owner, type: type ?? m, modelId: m, pos: [1500 + i * 1000, 3800], facing: 64 }));
      v.showArmy(army);
      window.__wraithSet = true;
      v.setSquadPlates?.(false);
      if (v.plates) v.plates.enabled = false;
      v.camera.setMode('rts');
      v.camera.setObstacles(() => -1e3, () => -1e3);
      for (const o of v.field.foliage?.group.children ?? []) if (o.name !== 'grass') o.visible = false;
    });
    let prev = -1;
    for (let i = 0; i < 40; i++) {
      const n = await page.evaluate(() => window.__rt.view.artLoads.length);
      if (n === prev && n > 0 && i > 3) break;
      prev = n;
      await sleep(1500);
    }
    let reloaded = false;
    // [name, dist, pitch(NaN = rig default tilt)]: the default battle distance (95 m), mid and close
    for (const [name, dist, pitch, x] of [['far', 95, NaN, 0], ['mid', 55, NaN, 0], ['close', 26, 0.75, -20]]) {
      await page.evaluate((dist, pitch, x) => {
        const v = window.__rt.view;
        v.camera.goal.target.set(x, 0, 22);
        v.camera.goal.yaw = 0;
        v.camera.goal.dist = dist;
        v.camera.goal.pitch = pitch === null ? NaN : pitch;
        v.camera.snap();
        v.engine.wake?.();
      }, dist, Number.isNaN(pitch) ? null : pitch, x);
      await sleep(1500);
      // a dev-server hot reload (other edits in the tree) drops the line-up: redo this tier
      if (!(await page.evaluate(() => !!window.__wraithSet))) { reloaded = true; break; }
      const out = `${SHOTS}/wraith-${tag}-${tier}-${name}.png`;
      await page.screenshot({ path: out });
      console.log('wrote', out);
    }
    await page.close();
    if (reloaded && ++tries < 4) { console.log(`page reloaded during ${tier}; again`); ti--; }
  }
} finally {
  await browser.close();
}
