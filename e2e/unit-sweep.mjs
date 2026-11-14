// Albedo / team-colour sweep: every unit type of both teams lined up on the field at RTS distance, seen the way
// a player sees their own army (from behind) and the enemy's (from the front). For checking that each unit reads
// clearly and shows its team colour -- no blown-out, near-black or untinted units.
//   npx vite --port 5180 &   node e2e/unit-sweep.mjs [tag]
// Env: BASE, CHROME, W/H (1920x1080), TIER (high). Writes e2e/shots/sweep-<tag>-{own,enemy,own-close-a,...}.png.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);
const tag = process.argv[2] ?? 'after';
const SHOTS = 'e2e/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.goto(`${BASE}render-test.html?real=all&tier=${process.env.TIER || 'high'}&ui=0&blur=0&mode=planning`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await sleep(3000);
  const shots = await page.evaluate(() => {
    const v = window.__rt.view;
    v.setPlanning({ visible: false });
    const rowA = ['militia', 'pikemen', 'berserkers', 'archers', 'knights', 'mages', 'clerics', 'cavaliers', 'pegasus'];
    const rowB = [['lord', 'marshal'], ['lord', 'archmage'], ['lord', 'warden'], ['lord', 'skylady'], ['golem'], ['wyvern'], ['dragon'], ['ballista'], ['trebuchet']];
    const army = [];
    let id = 1;
    for (const owner of [0, 1]) {
      const y0 = owner === 0 ? 4300 : 7700;
      const dy = owner === 0 ? -1000 : 1000;
      rowA.forEach((type, i) => army.push({ id: id++, owner, type, pos: [700 + i * 825, y0], facing: owner === 0 ? 64 : 192 }));
      rowB.forEach(([type, lord], i) => army.push({ id: id++, owner, type, lord, modelId: lord ? `lord_${lord}` : undefined, pos: [700 + i * 825, y0 + dy], facing: owner === 0 ? 64 : 192 }));
    }
    v.showArmy(army);
    v.camera.setMode('rts');
    v.camera.setObstacles(() => -1e3);
    for (const o of v.field.foliage?.group.children ?? []) if (o.name !== 'grass') o.visible = false;
    // [name, target x, target z, yaw, dist, pitch]: own army from behind, enemy from the front, then closer halves
    return [
      ['own', 0, 22, 0, 52, 0.78], ['enemy', 0, -22, 0, 52, 0.78],
      ['own-close-a', -17, 21, 0, 30, 0.7], ['own-close-b', 17, 21, 0, 30, 0.7],
      ['enemy-close-a', -17, -21, 0, 30, 0.7], ['enemy-close-b', 17, -21, 0, 30, 0.7],
    ];
  });
  // wait for every art model of the line-up to stream in
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => window.__rt.view.artLoads.length);
    if (n === prev && n > 0 && i > 3) break;
    prev = n;
    await sleep(1500);
  }
  for (const [name, x, z, yaw, dist, pitch] of shots) {
    await page.evaluate((x, z, yaw, dist, pitch) => {
      const v = window.__rt.view;
      v.camera.goal.target.set(x, 0, z);
      v.camera.goal.yaw = yaw;
      v.camera.goal.dist = dist;
      v.camera.goal.pitch = pitch;
      v.camera.snap();
    }, x, z, yaw, dist, pitch);
    await sleep(1800);
    const out = `${SHOTS}/sweep-${tag}-${name}.png`;
    await page.screenshot({ path: out });
    console.log('wrote', out);
  }
} finally {
  await browser.close();
}
