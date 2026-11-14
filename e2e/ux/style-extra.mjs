// The screens the UX tour does not reach, for the style review (docs/UI-STYLE.md): the loot pick
// with one item of each rarity, an item compare tooltip, toasts, the squad panel with ghosts in
// view, the match-over screen (victory and defeat). Offline ?dev= routes, no server logic needed.
//   BASE=http://127.0.0.1:3051/ W=1920 H=1080 node e2e/ux/style-extra.mjs
// Screenshots: e2e/shots/<SHOT_PREFIX|style-after>-<W>-x-*.png
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3051/';
const W = +(process.env.W || 1920), H = +(process.env.H || 1080);
const PRE = process.env.SHOT_PREFIX || 'style-after';
const browser = await launch();
const errors = [];
async function open(url) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: W, height: H });
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join('e2e/shots', `${PRE}-${W}-x-${name}.png`) });
const closeDraft = async (p) => { if (await p.$('.modal.draft')) { await p.click('.modal.draft .later'); await sleep(600); } };

try {
  // loot: one of each rarity, landed
  let p = await open('?dev=loot&timer=0');
  await sleep(2400);
  await closeDraft(p);
  await sleep(3600);
  await shot(p, 'loot-rarities');
  const take = await p.$('.modal.loot .drop.r-legendary .take, .modal.loot .drop:last-child .take');
  if (take) { await take.click(); await sleep(1400); }
  await closeDraft(p);
  // planning with the enemy's last-round army in view, a squad selected, and an item compare tooltip
  await waitFor(p, () => !!window.__ob.app.scene && !!document.querySelector('.planning'), null, 30000);
  await sleep(1500);
  await shot(p, 'planning-ghosts');
  const xy = await p.evaluate(() => { const sq = window.__ob.app.room.view.you.squads.find((s) => s.type !== 'lord'); return sq ? window.__ob.app.scene.toScreen(sq.pos, 0) : null; });
  if (xy) { await p.mouse.click(xy.x, xy.y); await sleep(400); }
  const it = await p.$('.stash [data-item]');
  if (it) { await it.hover(); await sleep(450); }
  await shot(p, 'item-compare');
  await p.mouse.move(W / 2, H / 2);
  // toasts of each kind, and the chat panel if this match has one
  await p.evaluate(() => {
    let box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.getElementById('ui').appendChild(box); }
    for (const [k, t] of [['', 'Planning ends in 10 seconds'], ['good', 'Militia reached level 2'], ['bad', 'Not enough gold'], ['auto', 'Time ran out: Clerics and Mages were recruited for you']]) {
      const n = document.createElement('div'); n.className = `toast ${k}`; n.textContent = t; box.appendChild(n);
    }
  });
  await sleep(400);
  await shot(p, 'toasts');
  await p.close();

  // match over: victory, then defeat
  for (const [name, winner] of [['over-victory', 0], ['over-defeat', 1]]) {
    p = await open('?dev=results&round=7');
    await sleep(2500);
    await p.evaluate((winner) => {
      const { app } = window.__ob;
      const s = app.local.s;
      s.phase = 'over';
      s.winner = winner;
      app.local.setPhase('over', 0);
      app.local.emit();
    }, winner);
    await sleep(3200);
    await shot(p, name);
    await p.close();
  }
} catch (e) {
  errors.push(String(e?.stack || e));
} finally {
  await browser.close();
}
if (errors.length) console.log(errors.join('\n'));
console.log(errors.length ? 'FAILED' : 'all passed');
process.exit(errors.length ? 1 : 0);
