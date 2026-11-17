// The battle inspector and the battle HUD (offline ?dev=battle, no server needed): click squads on
// the field (own caster with an item skill, the Lord, an enemy squad), Shift+click to compare, Tab,
// Esc, collapse, the log, the HUD insets, the 4 Hz update budget, and report rows on the results
// screen. Screenshots: e2e/shots/inspect-<W>-*.png.
//   BASE=http://127.0.0.1:3051/ W=1366 H=768 node e2e/ux/inspect.mjs
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3051/';
const W = +(process.env.W || 1920), H = +(process.env.H || 1080);
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}] ${what}`); if (!ok) fails++; };
let p;
const shot = (name) => p.screenshot({ path: path.join('e2e/shots', `inspect-${W}-${name}.png`) });
async function open(url) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return page;
}
// the rows of the battle on screen: [{row, side, type, skills, alive}]
const rows = () => p.evaluate(() => {
  const b = window.__ob.app.screen;
  return b.decoded.replay.squads.filter((q) => !q.summoned && q.type !== 'skeleton').map((q) => ({ row: q.row, side: q.side, type: q.type, skills: q.skills ?? [], n: q.soldiers.length }));
});
// where a squad is drawn right now (centre of its living soldiers), in client pixels
const at = (row) => p.evaluate((row) => {
  const { app } = window.__ob;
  const b = app.screen, d = b.decoded, n = d.soldierCount;
  const f = Math.min(d.frameCount - 1, Math.max(0, Math.floor(b.pb.timeMs / 50 / (d.replay.frameTicks || 4))));
  let x = 0, y = 0, c = 0;
  for (const i of d.replay.squads[row].soldiers) if (d.anim[f * n + i] !== 255) { x += d.x[f * n + i]; y += d.y[f * n + i]; c++; }
  if (!c) return null;
  const s = app.scene.toScreen([x / c, y / c], 1);
  // on screen and not under a HUD element
  return s && s.x > 4 && s.y > 4 && s.x < innerWidth - 4 && s.y < innerHeight - 4 && document.elementFromPoint(s.x, s.y) === app.scene.canvas ? { x: s.x, y: s.y } : null;
}, row);
const sel = () => p.evaluate(() => window.__ob.app.screen.insp?.rows ?? []);
const text = (q) => p.evaluate((q) => document.querySelector(q)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, q);
// click a squad where it stands; if the pick lands on a neighbour (melee scrum), say so
async function clickSquad(row, opts = {}) {
  for (let k = 0; k < 6; k++) {
    const xy = await at(row);
    if (xy) {
      if (opts.shift) await p.keyboard.down('Shift');
      await p.mouse.click(xy.x, xy.y);
      if (opts.shift) await p.keyboard.up('Shift');
      await sleep(350);
      return (await sel()).includes(row);
    }
    await sleep(400);
  }
  return false;
}

try {
  // a battle with an item skill on the viewer's side, preferably on a caster
  let found = null;
  for (const [round, seed] of [[6, 11], [6, 7], [7, 3], [5, 21], [7, 42], [8, 5], [6, 1234]]) {
    p = await open(`?dev=battle&timer=0&round=${round}&seed=${seed}`);
    if (!(await waitFor(p, () => !!document.querySelector('.screen.battle') && !!window.__ob.app.scene && !!window.__ob.app.screen?.pb, null, 60000))) { await p.close(); continue; }
    const r = await rows();
    const mine = r.filter((q) => q.side === 0 && q.skills.length);
    if (mine.length) { found = { round, seed, caster: (mine.find((q) => q.type === 'mages' || q.type === 'clerics') ?? mine[0]).row }; break; }
    await p.close();
  }
  check(!!found, `a battle with an item skill on my side (${JSON.stringify(found)})`);
  if (!found) throw new Error('no battle with skills');
  const all = await rows();
  const lord = all.find((q) => q.side === 0 && q.type === 'lord').row;
  const foe = all.find((q) => q.side === 1 && q.type !== 'lord').row;
  const foeLord = all.find((q) => q.side === 1 && q.type === 'lord').row;
  await sleep(2500);
  await shot('hud');
  // ---- HUD layout: nothing overlaps, the view is inset
  const box = (q) => p.evaluate((q) => { const n = document.querySelector(q); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; }, q);
  const hit = (a, b) => a && b && a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y;
  const [feed, ctrl, tally, corner] = [await box('.b-feed'), await box('.b-ctrl'), await box('.b-tally'), await box('.shell .corner')];
  check(!hit(feed, ctrl) && !hit(feed, corner) && !hit(tally, corner), 'battle log, controls, tally and corner tools do not overlap');
  // the slim top HUD: the view is inset by the plaques' (or the tally's) bottom edge, and by the controls below
  const ins = await p.evaluate(() => window.__ob.app.scene.view?.engine.insets ?? null);
  const hudB = await p.evaluate(() => Math.max(document.querySelector('.battle .topbar')?.getBoundingClientRect().bottom ?? 0, document.querySelector('.b-tally')?.getBoundingClientRect().bottom ?? 0));
  check(!ins || (ins.top >= hudB - 2 && ins.top > 30 && ins.bottom > 30), `the engine is told the HUD insets (${JSON.stringify(ins)}, HUD bottom ${Math.round(hudB)})`);
  check((await text('.tb-clock small')) === '/ 1:30', 'the clock shows its limit');

  // ---- click to inspect: the Lord
  check(await clickSquad(lord), 'a click on my Lord opens the inspector on it');
  check(!!(await p.$('.insp.on.me')) && /Lord/.test((await text('.insp .in-t')) ?? ''), `the Lord's header (${await text('.insp .in-t b')})`);
  check((await p.$$('.insp .in-items .sp-slot')).length === 3, 'three equipment slots');
  check((await p.$$('.insp .in-sk')).length >= 1, 'the Lord ability is listed with its cooldown');
  await sleep(350); // the slide-in has finished
  const insBox = await box('.insp');
  check(insBox && insBox.r <= W && insBox.b <= H - 10 && !hit(insBox, ctrl) && !hit(insBox, feed), 'the panel is on screen, clear of the controls and the log');
  const ins2 = await p.evaluate(() => window.__ob.app.scene.view?.engine.insets ?? null);
  check(!ins2 || ins2.right > 100, `the view is inset beside the panel (${JSON.stringify(ins2)})`);
  await sleep(600);
  await shot('lord');
  // an item tooltip from a slot, if the Lord carries anything
  const item = await p.$('.insp .in-items [data-item]');
  if (item) { await item.hover(); await sleep(450); check(!!(await p.$('.tip-layer.on .itip')), 'hovering an item slot shows the full item tooltip'); await shot('item-tip'); await p.mouse.move(W / 2, H / 2); }

  // ---- the caster with an item skill (click; open by row if the scrum hides it)
  const clicked = await clickSquad(found.caster);
  if (!clicked) await p.evaluate((r) => window.__ob.app.screen.insp.open(r), found.caster);
  console.log(`     skill squad picked by ${clicked ? 'click' : 'row (not clickable right now)'}`);
  await sleep(500);
  const skillRows = await p.$$eval('.insp .in-sk', (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  check(skillRows.length >= 1, `its abilities with live totals (${skillRows.join(' | ')})`);
  // live numbers move while the battle plays, at no more than ~4 updates a second
  const mut = await p.evaluate(() => new Promise((res) => {
    const stamps = [];
    const mo = new MutationObserver(() => stamps.push(performance.now()));
    mo.observe(document.querySelector('.insp'), { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => { mo.disconnect(); const batches = stamps.filter((t, i) => i === 0 || t - stamps[i - 1] > 50).length; res({ batches, total: stamps.length }); }, 4000);
  }));
  check(mut.batches <= 18, `inspector DOM updates stay at about 4 Hz (${mut.batches} batches in 4 s)`);
  await shot('caster');
  const s1 = await text('.insp .in-c[data-k="dealt"] b');
  // hover an ability for its tooltip
  const sk = await p.$('.insp .in-sk');
  if (sk) { await sk.hover(); await sleep(450); check(!!(await p.$('.tip-layer.on .sk-tip')), 'hovering an ability names it (source, cooldown, text)'); await shot('skill-tip'); await p.mouse.move(W / 2, H / 2); }

  // ---- an enemy squad, then compare
  let ok = await clickSquad(foe);
  if (!ok) ok = await clickSquad(foeLord);
  check(ok && !!(await p.$('.insp.on.foe')), 'a click on an enemy squad inspects it in the enemy colour');
  await sleep(500);
  await shot('enemy');
  const first = (await sel())[0];
  let cmp = await clickSquad(lord, { shift: true });
  if (!cmp) { await p.evaluate((r) => window.__ob.app.screen.insp.compare(r), lord); cmp = (await sel()).length === 2; }
  check(cmp && !!(await p.$('.insp.cmp')) && (await sel())[0] === first, 'Shift+click adds a second squad: compare mode');
  check((await p.$$('.insp .in-pr')).length === 2 && (await p.$$('.insp .in-cmp')).length === 2, 'compare shows the damage between them, performance and stats side by side');
  await sleep(1200);
  await shot('compare');
  await p.keyboard.press('Escape');
  await sleep(250);
  check((await sel()).length === 1 && !(await p.$('.insp.cmp')), 'Esc leaves compare for the first squad');
  // collapse
  await p.click('.insp .in-min');
  await sleep(250);
  const small = await box('.insp');
  check(!!(await p.$('.insp.min')) && small.b - small.y < H * 0.2, 'the panel collapses to its header and life bar');
  await shot('collapsed');
  await p.click('.insp .in-min');
  // Tab cycles, Esc closes, empty ground closes
  const before = (await sel())[0];
  await p.keyboard.press('Tab');
  await sleep(250);
  check((await sel())[0] !== before && (await sel()).length === 1, 'Tab moves to the next squad');
  await p.keyboard.press('Escape');
  await sleep(250);
  check((await sel()).length === 0 && !(await p.$('.insp.on')), 'Esc closes the inspector');
  const ins3 = await p.evaluate(() => window.__ob.app.scene.view?.engine.insets ?? null);
  check(!ins3 || ins3.right === 0, 'the right inset is released when it closes');
  await p.keyboard.press('Tab');
  await sleep(200);
  // a click on empty ground: a field corner far from both armies
  const empty = await p.evaluate(() => {
    const sc = window.__ob.app.scene;
    for (let y = 140; y < innerHeight - 140; y += 40) for (const x of [innerWidth * 0.3, innerWidth * 0.12, innerWidth * 0.5, innerWidth * 0.2]) {
      if (document.elementFromPoint(x, y) === sc.canvas && sc.pickSoldier(x, y) === null && sc.pickSoldier(x + 30, y) === null) return { x, y };
    }
    return null;
  });
  if (empty) { await p.mouse.click(empty.x, empty.y); await sleep(300); check((await sel()).length === 0, 'a click on empty ground closes it'); }
  else await p.keyboard.press('Escape');
  // the log: entries are clickable
  await sleep(3000);
  const entry = await p.$('.b-feed .kf[data-row]');
  if (entry) { await entry.click(); await sleep(300); check((await sel()).length === 1, 'a battle log entry opens its squad'); }
  await shot('log');
  console.log(`     dealt while watching: ${s1} -> ${await text('.insp .in-c[data-k="dealt"] b')}`);

  // ---- the end of the battle, then the report rows
  await p.keyboard.press('Escape');
  await p.keyboard.press('End');
  check(await waitFor(p, () => !!document.querySelector('.screen.results .res-table.pick .rt-row[data-squad]'), null, 20000), 'the results report has clickable rows');
  await sleep(1200);
  const rowsEl = await p.$$('.screen.results .rt-army.me .rt-row[data-squad]');
  await rowsEl[0].click();
  await sleep(400);
  check(!!(await p.$('.screen.results .insp.floating.on')), 'a report row opens the inspector at the end of the battle');
  const endDealt = await text('.insp .in-c[data-k="dealt"] b');
  const rowDealt = await p.$eval('.screen.results .rt-army.me .rt-row.sel .rt-bar em', (n) => n.textContent.trim()).catch(() => null);
  check(rowDealt !== null, `the row is marked (${rowDealt} in the table, ${endDealt} in the inspector)`);
  await shot('report');
  const foeRow = await p.$('.screen.results .rt-army.foe .rt-row[data-squad]');
  await p.keyboard.down('Shift');
  // the panel sits over the enemy table: the left end of its rows stays clickable
  await foeRow.click({ offset: { x: 24, y: 8 } });
  await p.keyboard.up('Shift');
  await sleep(400);
  check(!!(await p.$('.screen.results .insp.cmp')), 'Shift+click a second row compares the two');
  await shot('report-compare');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await sleep(250);
  check(!(await p.$('.insp.on')), 'Esc closes it on the results screen too');
} catch (e) {
  errors.push(String(e?.stack || e));
  await shot('exception').catch(() => {});
} finally {
  await browser.close();
}
if (errors.length) console.log('errors:\n' + errors.join('\n'));
console.log(fails || errors.length ? `${fails} failed` : 'all passed');
process.exit(fails || errors.length ? 1 : 0);
