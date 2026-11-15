// Keep damage stages in the engine (stage0..3 of the faction keep_<faction>.glb), to check the cut caps / rubble shading.
//   node e2e/anim-keep.mjs [tag]   -> e2e/shots/anim-audit/keep-<tag>.jpg   (starts and closes its own vite server)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const tag = process.argv[2] ?? 'after';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createServer } = await import('vite');
const server = await createServer({ logLevel: 'error', server: { port: 5187, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 480 });
  await page.goto(`http://127.0.0.1:${server.config.server.port}/render-test.html?real=all&tier=high&ui=0&blur=0&mode=planning`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
  await sleep(6000);
  const tiles = [];
  for (let st = 0; st < 4; st++) {
    for (let i = 0; i < 8; i++) {
      await page.evaluate((st) => {
        const v = window.__rt.view;
        v.setPlanning({ visible: false });
        v.showArmy([]);
        const k = v.field.keep(1);
        k.setStage(st);
        v.camera.setMode('rts');
        v.camera.setObstacles(() => -1e3);
        const p = k.position;
        v.camera.goal.target.set(p.x, 4, p.z);
        v.camera.goal.yaw = 0.5;
        v.camera.goal.dist = 46;
        v.camera.goal.pitch = 0.55;
        v.camera.snap();
        v.engine.wake?.();
      }, st);
      await sleep(250);
    }
    tiles.push(await page.screenshot({ encoding: 'base64' }));
  }
  const jpg = await page.evaluate(async (tiles) => {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 960;
    const g = c.getContext('2d');
    for (let i = 0; i < tiles.length; i++) {
      const im = new Image();
      im.src = 'data:image/png;base64,' + tiles[i];
      await im.decode();
      g.drawImage(im, (i % 2) * 640, Math.floor(i / 2) * 480);
    }
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, tiles);
  fs.mkdirSync('e2e/shots/anim-audit', { recursive: true });
  fs.writeFileSync(`e2e/shots/anim-audit/keep-${tag}.jpg`, Buffer.from(jpg, 'base64'));
  console.log(`wrote e2e/shots/anim-audit/keep-${tag}.jpg`);
} finally {
  await browser.close();
  await server.close();
}
