// Screenshots of every client screen on the local dev harness (no server needed): title, the
// ?dev= routes (planning with a selection / deploy ghost / item compare, loot, draft, battle,
// results, lord pick, match over) and tablet/4K sizes. Writes e2e/shots/ui-*.png and fails on
// page errors.
//   npx vite --port 5174 &   node e2e/ui-shots.mjs      (BASE=…, CHROME=…, ONLY=title,planning…)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5174/';
const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = process.env.SHOTS || 'e2e/shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
fs.mkdirSync(SHOTS, { recursive: true });
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const want = (n) => !ONLY || ONLY.some((o) => n.startsWith(o));
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `ui-${name}.png`) });

async function open(url, w = 1280, h = 720, dpr = 1) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${url}: ${m.text()}`));
  await page.goto(BASE + url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 20000 });
  return page;
}
/** Screen point of one of my squads (by index in my army). */
const squadXY = (p, i) => p.evaluate((i) => {
  const { app } = window.__ob;
  const sq = app.room.view.you.squads[i];
  return sq ? app.scene.toScreen(sq.pos, 0.5) : null;
}, i);

try {
  if (want('title')) {
    const p = await open('?room=ABCD');
    await sleep(2500);
    await shot(p, 'title');
    await p.close();
  }
  if (want('planning')) {
    const p = await open('?dev=planning&timer=0');
    await sleep(4500); // round banner, draft modal auto-opens
    await shot(p, 'planning-draft');
    const card = await p.$('.dcard');
    if (card) {
      await card.hover();
      await sleep(300);
      await shot(p, 'planning-draft-tip');
      await card.click();
      await sleep(600);
    }
    await p.keyboard.press('Escape');
    await sleep(2000);
    if (await p.$('.modal')) {
      await p.keyboard.press('Escape');
      await sleep(400);
    }
    await shot(p, 'planning');
    // power: idle planning must draw nothing
    await sleep(1500);
    const f0 = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
    await sleep(3000);
    const f1 = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
    console.log(`idle planning: ${((f1 - f0) / 3).toFixed(1)} frames/s`);
    if (f1 !== f0) errors.push(`idle planning drew ${f1 - f0} frames in 3 s (want 0)`);
    // select a squad (the second one: a unit, not the Lord)
    const xy = await squadXY(p, 1);
    if (xy) {
      await p.mouse.click(xy.x, xy.y);
      await sleep(500);
      await shot(p, 'planning-select');
    }
    // shop tooltip
    const uc = await p.$('.ucard');
    await uc.hover();
    await sleep(350);
    await shot(p, 'planning-shoptip');
    // drag a unit from the shop onto the field (ghost preview)
    const b = await uc.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(640, 470, { steps: 12 });
    await p.keyboard.press('q');
    await sleep(300);
    await shot(p, 'planning-deploy');
    await p.mouse.up();
    await sleep(500);
    await shot(p, 'planning-after-deploy');
    // stash item compare
    const it = await p.$('.stash [data-item]');
    const x2 = await squadXY(p, 0);
    if (x2) await p.mouse.click(x2.x, x2.y);
    await sleep(300);
    if (it) {
      await it.hover();
      await sleep(350);
      await shot(p, 'planning-compare');
    }
    await p.close();
  }
  if (want('loot')) {
    const p = await open('?dev=loot&timer=0');
    await sleep(2400);
    // close the draft if it came first
    if (await p.$('.modal.draft')) {
      await p.click('.modal.draft .later');
      await sleep(600);
    }
    await sleep(700);
    await shot(p, 'loot-reveal');
    await sleep(2600);
    await shot(p, 'loot');
    await p.close();
  }
  if (want('battle')) {
    const p = await open('?dev=battle');
    await sleep(2500);
    await shot(p, 'battle-start');
    await sleep(9000);
    await shot(p, 'battle');
    await p.click('.speed button[data-s="2"]');
    await sleep(8000);
    await shot(p, 'battle-late');
    await p.close();
  }
  if (want('results')) {
    const p = await open('?dev=results');
    await sleep(3000);
    await shot(p, 'results');
    await p.close();
  }
  if (want('lordpick')) {
    const p = await open('?dev=match&timer=0');
    await sleep(1500);
    await shot(p, 'lordpick');
    await p.click('.lcard[data-lord="archmage"]');
    await sleep(800);
    await shot(p, 'lordpick-reveal');
    await sleep(3500);
    await shot(p, 'match-round1');
    await p.close();
  }
  if (want('over')) {
    const p = await open('?dev=results&round=7');
    await sleep(2500);
    // force a finished match view: end it by draining the enemy keep in the local sim
    await p.evaluate(() => {
      const { app } = window.__ob;
      const s = app.local.s;
      s.phase = 'over';
      s.winner = 0;
      app.local.setPhase('over', 0);
      app.local.emit();
    });
    await sleep(2500);
    await shot(p, 'over');
    await p.close();
  }
  if (want('tablet')) {
    const p = await open('?dev=planning&timer=0', 1024, 768);
    await sleep(4000);
    await p.keyboard.press('Escape');
    await sleep(1500);
    await p.keyboard.press('Escape');
    await sleep(500);
    await shot(p, 'tablet-planning');
    await p.close();
  }
  if (want('4k')) {
    const p = await open('?dev=loot&timer=0', 1920, 1080, 2);
    await sleep(2400);
    if (await p.$('.modal.draft')) await p.click('.modal.draft .later');
    await sleep(3500);
    await shot(p, '4k-loot');
    await p.close();
  }
} finally {
  await browser.close();
}
if (errors.length) console.log('errors:\n' + [...new Set(errors)].join('\n'));
console.log(errors.length ? `${errors.length} page errors` : 'no page errors');
process.exit(errors.length ? 1 : 0);
