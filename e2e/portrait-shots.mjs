// Portrait surfaces that e2e/ui-shots.mjs does not reach, for all three factions: the shop and the recruit picker,
// the squad inspector (planning and battle), the codex (F1) tabs, the Lord pick for each faction, the report.
//   node e2e/portrait-shots.mjs
// Env: BASE, CHROME, SHOTS (e2e/shots), W/H (1920x1080)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

// its own vite server (no HMR, no file watching: an edit elsewhere must not reload the page mid-shot) unless BASE is set
let server = null;
let BASE = process.env.BASE;
if (!BASE) {
  const { createServer } = await import('vite');
  server = await createServer({ logLevel: 'error', server: { port: 5186, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
  await server.listen();
  BASE = `http://127.0.0.1:${server.config.server.port}/`;
}
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const SHOTS = process.env.SHOTS || 'e2e/shots';
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `portraits-${name}.png`) });
async function open(url) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  await page.goto(BASE + url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 20000 });
  return page;
}
const squadXY = (p, i) => p.evaluate((i) => {
  const { app } = window.__ob;
  const sq = app.room.view.you.squads[i];
  return sq ? app.scene.toScreen(sq.pos, 0.5) : null;
}, i);
const closeModals = async (p) => {
  for (let i = 0; i < 3 && (await p.$('.modal')); i++) {
    await p.keyboard.press('Escape');
    await sleep(700);
  }
};

try {
  for (const [lord, enemy, tag] of [['lich', 'sultana', 'ashen'], ['sultana', 'marshal', 'caliphate'], ['warden', 'lich', 'kingdom']]) {
    const p = await open(`?dev=planning&timer=0&lord=${lord}&enemy=${enemy}`);
    await sleep(4500);
    await shot(p, `${tag}-recruit`);
    await closeModals(p);
    await sleep(1500);
    await shot(p, `${tag}-planning`);
    const xy = await squadXY(p, 0);
    if (xy) {
      await p.mouse.click(xy.x, xy.y);
      await sleep(700);
      await shot(p, `${tag}-inspector`);
      await p.keyboard.press('Escape');
    }
    const uc = await p.$('.ucard');
    if (uc) {
      await uc.hover();
      await sleep(400);
      await shot(p, `${tag}-shoptip`);
    }
    await p.mouse.move(W / 2, H / 3);
    await p.keyboard.press('F1');
    await sleep(900);
    const tabs = await p.$$eval('.rl-tabs button', (bs) => bs.map((b) => b.dataset.tab));
    for (const t of tabs) {
      await p.click(`.rl-tabs button[data-tab="${t}"]`);
      await sleep(500);
      await shot(p, `${tag}-codex-${t}`);
    }
    await p.close();
  }
  {
    const p = await open('?dev=match&timer=0');
    await sleep(1500);
    for (const f of await p.$$('.fbanner, [data-faction]')) {
      const id = await f.evaluate((e) => e.dataset.faction ?? '');
      if (!id) continue;
      await f.click();
      await sleep(700);
      await shot(p, `lordpick-${id}`);
    }
    await p.close();
  }
  {
    const p = await open('?dev=battle&lord=lich&enemy=sultana');
    await sleep(9000);
    const at = await p.evaluate(() => {
      const { app } = window.__ob;
      const v = app.scene.view;
      const s = v?.units?.slots?.find((x) => x.visible && x.deadAt < 0 && x.header.side === 1);
      return s ? v.engine.toScreen(s.pos) : null;
    }).catch(() => null);
    if (at) {
      await p.mouse.click(at.x, at.y);
      await sleep(900);
    }
    await shot(p, 'battle-inspector');
    await p.close();
  }
  {
    const p = await open('?dev=results&lord=sultana&enemy=lich');
    await sleep(3500);
    await shot(p, 'results');
    await p.close();
  }
} finally {
  await browser.close();
  if (server) await server.close();
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
process.exit(errors.length ? 1 : 0);
