// Home-camera framing check (render-test.html?mode=planning): at each viewport (4:3 .. 32:9, with and
// without HUD insets) the planning home view must show the deploy zone from its front line back to 8 m
// short of the own Keep (the last strip and the Keep are cropped by design), the river and the enemy
// front line inside the HUD-free area (the nearest zone corners may run off the sides on narrow screens), and the camera must be clear of
// tree crowns / props. Also checks: resetCamera() undoes rotation + zoom, the free battle camera starts
// from the planning yaw, wheel zoom keeps the ground point under the cursor, and nothing draws when idle.
//   npx vite --port 5180 &   node e2e/render-home.mjs        (BASE, CHROME; SHOTS=1 writes e2e/shots/veg-home-*.png)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const VIEWS = [
  [1200, 900, 0, 0], [1200, 900, 160, 130], [1600, 900, 160, 130], [1920, 1080, 160, 130], [1600, 900, 0, 0], [2560, 1080, 160, 130], [3440, 1392, 160, 130], [3840, 1080, 160, 130], [3840, 1080, 0, 0],
];

/** Screen positions (CSS px) of the points the home view must contain, for a seat. */
const probe = (seat) => {
  const v = window.__rt.view;
  const sgn = seat === 0 ? 1 : -1;
  const cm = (wx, wz) => [(wx + 40) * 100, (60 - wz) * 100];
  const pts = { zoneBack: [0, 48 * sgn], zoneBackL: [-30, 48 * sgn], zoneBackR: [30, 48 * sgn], zoneFrontL: [-40, 20 * sgn], zoneFrontR: [40, 20 * sgn], river: [0, 0], enemyFrontL: [-40, -20 * sgn], enemyFrontR: [40, -20 * sgn] };
  const out = {};
  for (const [k, [x, z]] of Object.entries(pts)) out[k] = v.fieldToScreen(...cm(x, z), 0);
  const c = v.camera;
  const cam = v.engine.camera.position;
  return { out, yaw: c.yaw, dist: c.dist, clear: cam.y - v.field.canopyAt(cam.x, cam.z), frames: v.engine.frames };
};

try {
  for (const [w, h, top, bottom] of VIEWS) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    page.on('pageerror', (e) => fails.push(`${w}x${h}: ${e.message}`));
    await page.goto(`${BASE}render-test.html?real=all&tier=low&mode=planning&ui=0&blur=0`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
    await sleep(3000);
    for (const seat of [0, 1]) {
      const tag = `${w}x${h} insets ${top}/${bottom} seat ${seat}`;
      await page.evaluate((seat, top, bottom) => {
        const v = window.__rt.view;
        v.setSeat(seat);
        v.setPlanning({ visible: true, seat, grid: true });
        v.resetCamera();
        // the HUD lays out after the mode switch: the fit must follow the insets
        v.engine.setInsets({ top, bottom });
      }, seat, top, bottom);
      await sleep(1200); // a seat switch turns the camera half-way round: let it settle
      await sleep(1800);
      const r = await page.evaluate(probe, seat);
      for (const [k, p] of Object.entries(r.out)) {
        if (!p || p.x < 0 || p.x > w || p.y < top || p.y > h - bottom) fails.push(`${tag}: ${k} off the free area (${p ? `${p.x.toFixed(0)},${p.y.toFixed(0)}` : 'behind camera'})`);
      }
      if (r.clear < 2.5) fails.push(`${tag}: camera only ${r.clear.toFixed(1)} m above the canopy`);
      if (process.env.SHOTS && seat === 0) await page.screenshot({ path: `e2e/shots/veg-home-${w}x${h}-${top}.png` });
      // idle: nothing may be drawn once the view has settled
      await sleep(1200);
      const f0 = (await page.evaluate(probe, seat)).frames;
      await sleep(1200);
      const f1 = (await page.evaluate(probe, seat)).frames;
      if (f1 !== f0) fails.push(`${tag}: ${f1 - f0} frames drawn while idle`);
      console.log(`${tag}: dist ${r.dist.toFixed(0)} m, zone back y ${r.out.zoneBack?.y.toFixed(0)}, enemy front y ${r.out.enemyFrontL?.y.toFixed(0)}`);
    }
    // rotate + zoom, then reset: back to the home rotation and distance
    const before = await page.evaluate(() => ({ yaw: window.__rt.view.camera.goal.yaw, dist: window.__rt.view.camera.goal.dist }));
    await page.evaluate(() => {
      const c = window.__rt.view.camera;
      c.rotateBy(0.9);
      c.zoomBy(0.4);
    });
    await sleep(900);
    await page.evaluate(() => window.__rt.view.resetCamera());
    await sleep(1500);
    const after = await page.evaluate(() => ({ yaw: window.__rt.view.camera.yaw, dist: window.__rt.view.camera.dist }));
    if (Math.abs(after.yaw - before.yaw) > 0.02 || Math.abs(after.dist - before.dist) > 1) fails.push(`${w}x${h}: resetCamera left yaw ${after.yaw.toFixed(2)} / dist ${after.dist.toFixed(0)} (home ${before.yaw.toFixed(2)} / ${before.dist.toFixed(0)})`);
    // wheel zoom towards the cursor: the ground point under it stays within a few px
    const cx = Math.round(w * 0.3);
    const cy = Math.round(top + (h - top - bottom) * 0.4);
    const g0 = await page.evaluate((x, y) => window.__rt.view.pickGround(x, y), cx, cy);
    await page.mouse.move(cx, cy);
    await page.mouse.wheel({ deltaY: -400 });
    await sleep(1500);
    const s1 = g0 ? await page.evaluate((g) => window.__rt.view.fieldToScreen(g[0], g[1], 0), g0) : null;
    if (!s1 || Math.hypot(s1.x - cx, s1.y - cy) > 40) fails.push(`${w}x${h}: wheel zoom moved the cursor's ground point to ${s1 ? `${s1.x.toFixed(0)},${s1.y.toFixed(0)}` : 'nowhere'} (cursor ${cx},${cy})`);
    await page.close();
  }
  // battle: free camera starts from the planning yaw; setCameraMode cycles both ways
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`${BASE}render-test.html?real=all&tier=low&t=9000&ui=0&blur=0`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await sleep(6000);
  const m = await page.evaluate(async () => {
    const v = window.__rt.view;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const out = { start: v.camera.mode };
    v.setCameraMode('free');
    await new Promise((r) => setTimeout(r, 1500));
    out.free = v.camera.mode;
    out.freeYawOff = Math.abs(wrap(v.camera.yaw - v.camera.planYaw));
    v.setCameraMode('director');
    out.back = v.camera.mode;
    v.setCameraMode('free');
    v.resetCamera();
    out.reset = v.camera.mode;
    return out;
  });
  if (m.start !== 'director' || m.free !== 'free' || m.back !== 'director' || m.reset !== 'director') fails.push(`mode cycling: ${JSON.stringify(m)}`);
  if (m.freeYawOff > 0.05) fails.push(`free camera is ${m.freeYawOff.toFixed(2)} rad off the planning yaw`);
  console.log('battle modes', JSON.stringify(m));
  await page.close();
} finally {
  await browser.close();
}
if (fails.length) {
  console.log('FAIL\n' + fails.join('\n'));
  process.exit(1);
}
console.log('home framing OK');
