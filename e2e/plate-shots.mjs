// Squad-plate readability shots: (1) line-ups of every unit of one faction against every unit of another
// (each faction appears as "yours" and as "the enemy"), (2) frames of a real all-units battle.
//   node e2e/plate-shots.mjs            (starts its own vite dev server on 5189 unless BASE is set)
// Env: BASE, CHROME, SIZES=1920x1080,3440x1440, TIER (high), OUT (e2e/shots), TIMES=4000,14000,26000 (battle ms)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const SIZES = (process.env.SIZES || '1920x1080,3440x1440').split(',').map((s) => s.split('x').map(Number));
const TIER = process.env.TIER || 'high';
const OUT = process.env.OUT || 'e2e/shots';
const TIMES = (process.env.TIMES || '4000,14000,26000').split(',').map(Number);
fs.mkdirSync(OUT, { recursive: true });
// [type, squad size, lord?]
const F = {
  kingdom: [['militia', 12], ['pikemen', 8], ['berserkers', 6], ['archers', 9], ['knights', 4], ['cavaliers', 4], ['mages', 4], ['clerics', 3], ['lord', 1, 'marshal'], ['pegasus', 3], ['ballista', 1], ['trebuchet', 1], ['golem', 1], ['wyvern', 2], ['dragon', 1]],
  ashen: [['skeleton', 10], ['grave_knight', 4], ['bone_archer', 9], ['wraith_rider', 4], ['grave_acolyte', 3], ['lord', 1, 'lich'], ['bone_golem', 1], ['bone_drake', 1], ['corpse_catapult', 1]],
  caliphate: [['spear_levy', 10], ['scimitar', 6], ['camel_archer', 4], ['mamluk', 4], ['djinn_binder', 4], ['sun_priest', 3], ['lord', 1, 'sultana'], ['djinn', 2], ['war_elephant', 1], ['sand_golem', 1]],
};
const PAIRS = (process.env.PAIRS || 'kingdom-ashen,ashen-caliphate,caliphate-kingdom').split(',').map((p) => p.split('-'));
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
const errors = [];
async function settle(page) {
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => window.__rt.view.artLoads.length);
    if (n === prev && n > 0 && i > 2) break;
    prev = n;
    await sleep(1500);
  }
}
try {
  for (const [W, H] of SIZES) {
    const tag = `${W}x${H}`;
    if (process.env.LINEUPS !== '0') {
      for (const [mine, theirs] of PAIRS) {
        const page = await browser.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.setViewport({ width: W, height: H });
        await page.goto(`${BASE}render-test.html?real=all&tier=${TIER}&ui=0&blur=0&mode=planning&kf=${mine},${theirs}`, { waitUntil: 'load', timeout: 180000 });
        await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
        await sleep(2000);
        await page.evaluate((rows) => {
          const v = window.__rt.view;
          v.setPlanning({ visible: false });
          const army = [];
          let id = 1;
          rows.forEach((row, owner) => {
            const per = Math.ceil(row.length / 2);
            row.forEach(([type, size, lord], i) => {
              const r = Math.floor(i / per);
              const n = r === 0 ? per : row.length - per;
              const x = 4000 + ((i % per) - (n - 1) / 2) * (7200 / Math.max(per, 5));
              const y = owner === 0 ? 4700 - r * 1300 : 7300 + r * 1300;
              army.push({ id: id++, owner, type, size, lord, modelId: lord ? `lord_${lord}` : type, pos: [x, y], facing: owner === 0 ? 64 : 192, level: 1 + (i % 3) });
            });
          });
          v.showArmy(army);
          v.camera.setMode('rts');
          v.camera.goal.target.set(0, 0, 0);
          v.camera.goal.yaw = 0;
          v.camera.goal.dist = 88;
          v.camera.goal.pitch = 0.95;
          v.camera.snap();
        }, [F[mine], F[theirs]]);
        await settle(page);
        await sleep(2500);
        const out = `${OUT}/plates-${tag}-${mine}-vs-${theirs}.png`;
        await page.screenshot({ path: out });
        console.log('wrote', out);
        await page.close();
      }
    }
    if (process.env.BATTLE !== '0') {
      const page = await browser.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewport({ width: W, height: H });
      await page.goto(`${BASE}render-test.html?real=all&tier=${TIER}&ui=0&blur=0&mode=battle&cam=free&paused=1&lords=${process.env.LORDS || 'lich,sultana'}`, { waitUntil: 'load', timeout: 180000 });
      await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
      await settle(page);
      for (const t of TIMES) {
        await page.evaluate((t) => {
          const v = window.__rt.view;
          const pb = v.playback ?? window.__rt.pb;
          pb?.seek(t);
          v.camera.setMode('rts');
          v.camera.goal.target.set(0, 0, 0);
          v.camera.goal.yaw = 0;
          v.camera.goal.dist = 88;
          v.camera.goal.pitch = 0.95;
          v.camera.snap();
          v.engine.wake();
        }, t);
        await sleep(2500);
        const out = `${OUT}/plates-${tag}-battle-${t}.png`;
        await page.screenshot({ path: out });
        console.log('wrote', out);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  if (server) await server.close();
}
if (errors.length) {
  console.error('page errors:', errors);
  process.exit(1);
}
