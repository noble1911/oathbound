// Camera stability check: castles / towers / trees must never push a player camera (rts / free) up.
//   1. planning home, both seats: no lift (camera height = orbit maths).
//   2. pan along the back line past both arrow towers and the Keep at three zooms: prints the camera
//      height over the path; at overview zooms it must be flat, close in only the smoothed floor over
//      solid geometry may move it, and never by more than 0.5 m per frame.
//   3. zoom in on the own Keep from the field side and look past it: pitch = tilt curve, the Keep ghosts.
//   4. battle, free camera behind the enemy Keep: same, no lift.
// Writes e2e/shots/cam-*.png.   npx vite --port 5180 &   node e2e/render-campath.mjs   (BASE, CHROME)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
fs.mkdirSync('e2e/shots', { recursive: true });

async function open(query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('pageerror', (e) => fails.push(`${query}: ${e.message}`));
  await page.goto(`${BASE}render-test.html?real=all&ui=0&blur=0&${query}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await page.waitForFunction(() => window.__rt.view.artLoads.some((l) => l.model.startsWith('props')) && window.__rt.view.artLoads.some((l) => l.model === 'keep'), { timeout: 60000 }).catch(() => {});
  await sleep(2500);
  return page;
}

/** Camera state: height, how far the real pitch is above the rig's own pitch (= lift), fades. */
const state = () => {
  const v = window.__rt.view;
  const c = v.camera;
  const p = v.engine.camera.position;
  const look = c.lookPoint;
  const real = Math.asin(Math.min(1, Math.max(-1, (p.y - look.y) / Math.max(1e-3, p.distanceTo(look)))));
  return { y: +p.y.toFixed(2), lift: +(real - c.pitch).toFixed(3), pitch: +c.pitch.toFixed(3), dist: +c.dist.toFixed(1), fades: v.field.fadeNow.map((a) => a.map((x) => +x.toFixed(2))) };
};

/** Pan the target from x0 to x1 at depth z, one step per frame; returns the camera height per frame. */
const pan = async ({ z, dist, yaw, x0, x1, steps }) => {
  const v = window.__rt.view;
  const c = v.camera;
  c.setMode(v.battle ? 'free' : 'rts');
  c.goal.target.set(x0, 0, z);
  c.goal.yaw = yaw;
  c.goal.dist = dist;
  c.goal.pitch = NaN;
  c.snap();
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  for (let i = 0; i < 30; i++) await frame();
  const ys = [];
  const lifts = [];
  for (let i = 0; i <= steps; i++) {
    c.goal.target.x = x0 + ((x1 - x0) * i) / steps;
    c.target.x = c.goal.target.x;
    v.engine.wake();
    await frame();
    const p = v.engine.camera.position;
    const look = c.lookPoint;
    ys.push(p.y);
    lifts.push(Math.asin((p.y - look.y) / p.distanceTo(look)) - c.pitch);
  }
  return { ys, lifts };
};

try {
  // 1. planning home, both seats
  const page = await open('tier=high&mode=planning');
  for (const seat of [0, 1]) {
    await page.evaluate((seat) => {
      const v = window.__rt.view;
      v.setSeat(seat);
      v.setPlanning({ visible: true, seat, grid: true });
      v.resetCamera();
    }, seat);
    await sleep(1800);
    const s = await page.evaluate(state);
    console.log(`home seat ${seat}: height ${s.y} m, dist ${s.dist}, lift ${s.lift} rad`);
    if (Math.abs(s.lift) > 0.005) fails.push(`home seat ${seat}: camera lifted by ${s.lift} rad`);
    await page.screenshot({ path: `e2e/shots/cam-home-seat${seat}.png` });
  }
  // 2. pan along the back line (seat 0: the Keep at z = +60, arrow towers in front of it)
  await page.evaluate(() => {
    const v = window.__rt.view;
    v.setSeat(0);
    v.setPlanning({ visible: true, seat: 0, grid: true });
  });
  for (const [name, z, dist, flat] of [['overview', 46, 70, true], ['mid', 46, 36, true], ['close', 44, 16, false], ['closest', 50, 10, false]]) {
    const r = await page.evaluate(pan, { z, dist, yaw: 0, x0: -38, x1: 38, steps: 240 });
    const min = Math.min(...r.ys);
    const max = Math.max(...r.ys);
    let step = 0;
    for (let i = 1; i < r.ys.length; i++) step = Math.max(step, Math.abs(r.ys[i] - r.ys[i - 1]));
    const lift = Math.max(...r.lifts.map(Math.abs));
    const sample = r.ys.filter((_, i) => i % 30 === 0).map((y) => y.toFixed(1)).join(' ');
    console.log(`pan ${name} (dist ${dist}, z ${z}): height ${min.toFixed(2)} .. ${max.toFixed(2)} m, max step ${step.toFixed(3)} m/frame | every 30th: ${sample}`);
    if (flat && max - min > 1.2) fails.push(`pan ${name}: camera height varies by ${(max - min).toFixed(2)} m`);
    if (flat && lift > 0.01) fails.push(`pan ${name}: pitch lifted by ${lift.toFixed(3)} rad`);
    if (step > 0.35) fails.push(`pan ${name}: camera pops ${step.toFixed(2)} m in one frame`);
  }
  // 3. zoomed in, the Keep between the lens and the focus (camera on the far side of the Keep)
  for (const dist of [60, 34, 20]) {
    await page.evaluate((dist) => {
      const c = window.__rt.view.camera;
      c.setMode('rts');
      c.goal.target.set(0, 0, 44);
      c.goal.yaw = 0;
      c.goal.dist = dist;
      c.goal.pitch = NaN;
      c.snap();
    }, dist);
    await sleep(1200);
    const s = await page.evaluate(state);
    console.log(`keep zoom dist ${dist}: height ${s.y} m, lift ${s.lift} rad, keep fades ${JSON.stringify(s.fades[0])}`);
    if (Math.abs(s.lift) > 0.02 && dist > 20) fails.push(`keep zoom ${dist}: lifted ${s.lift} rad`);
    await page.screenshot({ path: `e2e/shots/cam-keep-zoom-${dist}.png` });
  }
  // looking straight past a tower: it must ghost, not lift
  await page.evaluate(() => {
    const v = window.__rt.view;
    const t = v.field.keep(0).towers[0];
    const c = v.camera;
    c.goal.target.set(t.x, 0, t.z - 6);
    c.goal.yaw = 0;
    c.goal.dist = 16;
    c.goal.pitch = 0.42;
    c.snap();
  });
  await sleep(1200);
  const st = await page.evaluate(state);
  console.log(`behind a tower: height ${st.y} m, lift ${st.lift}, fades ${JSON.stringify(st.fades[0])}`);
  if (!(st.fades[0].slice(1).some((a) => a < 0.5))) fails.push('a tower between the lens and the focus did not fade');
  if (Math.abs(st.lift) > 0.02) fails.push(`behind a tower: lifted ${st.lift} rad`);
  await page.screenshot({ path: 'e2e/shots/cam-tower-ghost.png' });
  await page.close();

  // 4. battle, free camera behind the enemy Keep looking back at the field
  const b = await open('tier=high&t=9000&cam=free&paused=1');
  await b.evaluate(() => {
    const v = window.__rt.view;
    const c = v.camera;
    c.setMode('free');
    c.goal.target.set(0, 0, -44);
    c.goal.yaw = Math.PI;
    c.goal.dist = 30;
    c.goal.pitch = NaN;
    c.snap();
  });
  await sleep(1500);
  const sb = await b.evaluate(state);
  console.log(`battle free cam behind the enemy keep: height ${sb.y} m, lift ${sb.lift} rad, fades ${JSON.stringify(sb.fades[1])}`);
  if (Math.abs(sb.lift) > 0.02) fails.push(`battle free camera lifted ${sb.lift} rad near the enemy keep`);
  if (!(sb.fades[1][0] < 0.5)) fails.push('the enemy keep between the lens and the focus did not fade');
  await b.screenshot({ path: 'e2e/shots/cam-battle-enemy-keep.png' });
  const r = await b.evaluate(pan, { z: -46, dist: 30, yaw: Math.PI, x0: -38, x1: 38, steps: 240 });
  let step = 0;
  for (let i = 1; i < r.ys.length; i++) step = Math.max(step, Math.abs(r.ys[i] - r.ys[i - 1]));
  console.log(`battle pan past the enemy keep (dist 30): height ${Math.min(...r.ys).toFixed(2)} .. ${Math.max(...r.ys).toFixed(2)} m, max step ${step.toFixed(3)} m/frame`);
  if (Math.max(...r.ys) - Math.min(...r.ys) > 1.2) fails.push('battle pan: camera height not flat');
  await b.close();
} finally {
  await browser.close();
}
if (fails.length) {
  console.log('FAIL\n' + fails.join('\n'));
  process.exit(1);
}
console.log('camera path OK');
