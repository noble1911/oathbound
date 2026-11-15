// Faction line-ups in the engine: every unit of the Ashen Covenant / the Sun Caliphate, both teams, at RTS
// distance (own army from behind, the enemy's from the front) and closer, plus one mid-move frame.
//   node e2e/faction-shots.mjs [ashen,caliphate]
// Starts its own vite dev server (no HMR, no file watching: a rebuild elsewhere must not reload the page mid-shot)
// unless BASE is set.
// Env: BASE, CHROME, W/H (1920x1080), TIER (high). Writes e2e/shots/faction-<id>-{own,enemy,close-a,close-b,enemy-close-a,enemy-close-b}.png.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);
const want = (process.argv[2] ?? 'ashen,caliphate').split(',');
const SHOTS = 'e2e/shots';
fs.mkdirSync(SHOTS, { recursive: true });
// [type, squad size, lord?]: front row = squads, back row = the Lord and the single big units
const FACTIONS = {
  ashen: {
    front: [['skeleton', 10], ['grave_knight', 4], ['bone_archer', 9], ['wraith_rider', 4], ['grave_acolyte', 3]],
    back: [['lord', 1, 'lich'], ['bone_golem', 1], ['bone_drake', 1], ['corpse_catapult', 1]],
  },
  caliphate: {
    front: [['spear_levy', 10], ['scimitar', 6], ['camel_archer', 4], ['mamluk', 4], ['djinn_binder', 4], ['sun_priest', 3]],
    back: [['lord', 1, 'sultana'], ['djinn', 2], ['war_elephant', 1], ['sand_golem', 1]],
  },
};
let server = null;
let BASE = process.env.BASE;
if (!BASE) {
  const { createServer } = await import('vite');
  server = await createServer({ logLevel: 'error', server: { port: 5188, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
  await server.listen();
  BASE = `http://127.0.0.1:${server.config.server.port}/`;
}
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (const fid of want) {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`[page ${m.type()}]`, m.text().slice(0, 200)); });
    await page.setViewport({ width: W, height: H });
    await page.goto(`${BASE}render-test.html?real=all&tier=${process.env.TIER || 'high'}&ui=0&blur=0&mode=planning`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
    await sleep(2500);
    const shots = await page.evaluate((f) => {
      const v = window.__rt.view;
      v.setPlanning({ visible: false });
      const army = [];
      let id = 1;
      for (const owner of [0, 1]) {
        const y0 = owner === 0 ? 4300 : 7700;
        const dy = owner === 0 ? -1100 : 1100;
        const place = (row, y) => row.forEach(([type, size, lord], i) => {
          const x = 4000 + (i - (row.length - 1) / 2) * (7000 / Math.max(row.length, 5));
          army.push({ id: id++, owner, type, size, lord, modelId: lord ? `lord_${lord}` : type, pos: [x, y], facing: owner === 0 ? 64 : 192 });
        });
        place(f.front, y0); place(f.back, y0 + dy);
      }
      v.showArmy(army);
      v.camera.setMode('rts');
      v.camera.setObstacles(() => -1e3);
      for (const o of v.field.foliage?.group.children ?? []) if (o.name !== 'grass') o.visible = false;
      return [
        ['own', 0, 22, 0, 50, 0.78], ['enemy', 0, -22, 0, 50, 0.78],
        ['close-a', -16, 21, 0, 28, 0.7], ['close-b', 16, 21, 0, 28, 0.7],
        ['enemy-close-a', -16, -21, 0, 28, 0.7], ['enemy-close-b', 16, -21, 0, 28, 0.7],
      ];
    }, FACTIONS[fid]);
    let prev = -1;
    for (let i = 0; i < 40; i++) {       // wait for every art model of the line-up to stream in
      const n = await page.evaluate(() => window.__rt.view.artLoads.length);
      if (n === prev && n > 0 && i > 3) break;
      prev = n;
      await sleep(1500);
    }
    console.log(fid, 'art loads:', JSON.stringify(await page.evaluate(() => window.__rt.view.artLoads.map((l) => l.model))));
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
      const out = `${SHOTS}/faction-${fid}-${name}.png`;
      await page.screenshot({ path: out });
      console.log('wrote', out);
    }
    await page.close();
  }
} finally {
  await browser.close();
  if (server) await server.close();
}
