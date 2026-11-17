// The title menu over the live battle, as a gallery (OUT_DIR/*.jpg): 1920x1080 and 1024x768, a later moment
// of the same battle, the static woodcut fallback (?titlebg=0), and the Lord pick / lobby backdrops that
// follow the title.
//   npx vite --port 5181 &   BASE=http://127.0.0.1:5181/ node e2e/menu-shots.mjs [OUT_DIR]
// SEED=11 picks the battle.
import { launch, sleep, waitFor } from './qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5181/';
const OUT = process.argv[2] || 'e2e/shots/menu';
const SEED = Number(process.env.SEED || 11);
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
const errors = [];

async function open(w, h, query) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.evaluateOnNewDocument(() => {
    localStorage.setItem('oathbound.name', 'Tester');
    localStorage.setItem('oathbound.tutorial.done', '1');
  });
  await p.goto(`${BASE}?${query}`, { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 });
const live = (p) => waitFor(p, () => window.__ob.titleBattle()?.state === 'live' && document.querySelector('.title').classList.contains('tb-live'), null, 90000);
const at = (p, ms) => waitFor(p, (ms) => (window.__ob.titleBattle()?.timeMs ?? 0) >= ms, ms, 120000);

try {
  {
    for (const [w, h] of [[1920, 1080], [1024, 768]]) {
      const p = await open(w, h, `titleseed=${SEED}`);
      await sleep(700);
      if (w === 1920) await shot(p, `title-${w}x${h}-0-loading`); // what is on screen before the battle is in
      console.log(w, 'live:', await live(p), JSON.stringify(await p.evaluate(() => { const m = window.__ob.titleBattle()?.matchup; return m && { lords: m.lords, round: m.round }; })));
      await at(p, 14000);
      await sleep(1500);
      await shot(p, `title-${w}x${h}`);
      if (w === 1920) {
        await at(p, 27000);
        await shot(p, `title-${w}x${h}-later`);
        // hover and focus states of the primary action and a field
        await p.hover('.title-menu .vsai');
        await p.focus('.title-menu .name');
        await sleep(300);
        await shot(p, `title-${w}x${h}-hover`);
      }
      await p.browserContext().close();
    }
  }
  // the static backdrop (no WebGL / stand-in renderer / before the battle has loaded)
  {
    const p = await open(1920, 1080, 'titlebg=0');
    await sleep(900);
    await shot(p, 'title-1920x1080-static');
    await p.browserContext().close();
  }
  // what follows the title: the Lord pick over the title's last frame (offline skirmish), and over the woodcut field
  {
    const p = await open(1920, 1080, `titleseed=${SEED}`);
    await live(p);
    await at(p, 16000);
    await p.click('.title-menu .offline');
    await waitFor(p, () => !!document.querySelector('.lordpick'), null, 20000);
    await sleep(1200);
    await shot(p, 'after-lordpick-over-battle-still-1920x1080');
    await p.browserContext().close();
    const q = await open(1920, 1080, 'titlebg=0');
    await q.click('.title-menu .offline');
    await waitFor(q, () => !!document.querySelector('.lordpick'), null, 20000);
    await sleep(1200);
    await shot(q, 'after-lordpick-over-woodcut-1920x1080');
    await q.browserContext().close();
  }
} finally {
  await browser.close();
  if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].join('\n'));
}
