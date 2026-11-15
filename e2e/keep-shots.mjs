// Keep review shots: every faction's Keep at every damage stage, from the planning camera (behind the own
// Keep, as the player sees it while deploying) and from a battle camera (in front of it, the director's
// keep shot), at 1920x1080 and 3440x1440.
//   node e2e/keep-shots.mjs [tag] [factions]   -> e2e/shots/keep-<tag>-<faction>-<cam>-s<stage>-<w>x<h>.png
//   FACTIONS via argv[3] (default kingdom,ashen,caliphate), TIER=high, SIZES=1920x1080,3440x1440, STAGES=0,1,2,4
// Starts and closes its own vite server.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const tag = process.argv[2] ?? 'after';
const factions = (process.argv[3] ?? 'kingdom,ashen,caliphate').split(',');
const tier = process.env.TIER ?? 'high';
const sizes = (process.env.SIZES ?? '1920x1080,3440x1440').split(',').map((s) => s.split('x').map(Number));
const stages = (process.env.STAGES ?? '0,1,2,4').split(',').map(Number);
const cams = (process.env.CAMS ?? 'plan,battle').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createServer } = await import('vite');
const server = await createServer({ logLevel: 'error', server: { port: Number(process.env.PORT ?? 5188), host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
fs.mkdirSync('e2e/shots', { recursive: true });
const errors = [];
try {
  for (const f of factions) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.setViewport({ width: sizes[0][0], height: sizes[0][1] });
    await page.goto(`http://127.0.0.1:${server.config.server.port}/render-test.html?real=all&tier=${tier}&ui=0&blur=0&mode=planning&kf=${f},${f}`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
    await sleep(7000);
    for (const [w, h] of sizes) {
      await page.setViewport({ width: w, height: h });
      await sleep(400);
      for (const cam of cams) {
        for (const st of stages) {
          for (let i = 0; i < 6; i++) {
            await page.evaluate((st, cam) => {
              const v = window.__rt.view;
              if (!window.__keepArmy) {
                v.setPlanning({ visible: false });
                v.showArmy([]);
              }
              const k = v.field.keep(0);
              k.setStage(st);
              v.camera.setMode('rts');
              v.camera.setObstacles(() => -1e3);
              const p = k.position;
              const g = v.camera.goal;
              if (cam === 'plan') {
                // behind and above the own Keep, a quarter turn off axis (the user's screenshot)
                g.target.set(p.x + 1, p.y + 4, p.z - 2);
                g.yaw = 0.62;
                g.dist = 50;
                g.pitch = 0.9;
              } else if (cam === 'tower') {
                const t = k.towers[0];
                g.target.set(t.x, t.y - 3, t.z);
                g.yaw = Math.PI - 0.5;
                g.dist = 20;
                g.pitch = 0.5;
              } else {
                // out on the field in front of the gate (the director's keep shot)
                g.target.set(p.x, p.y + 5, p.z);
                g.yaw = Math.PI - 0.55;
                g.dist = 40;
                g.pitch = 0.42;
              }
              v.camera.snap();
              v.engine.wake?.();
            }, st, cam);
            await sleep(220);
          }
          const sn = [0, 1, 2, 2, 3][st];
          await page.screenshot({ path: `e2e/shots/keep-${tag}-${f}-${cam}-s${sn}-${w}x${h}.png` });
        }
      }
    }
    await page.close();
    console.log(`shots: ${f}`);
  }
} finally {
  await browser.close();
  await server.close();
  if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
}
