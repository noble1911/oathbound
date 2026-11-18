// Relocation and Muster (DESIGN §2) on the planning screen, offline on ?dev=planning (no server):
//   - squads from earlier rounds carry a lock and refuse a drag with the reason; their formation is free (and undoable);
//   - the recruit picker offers Muster; taking it (two presses) shows "Moves left 3/3";
//   - three relocations, the fourth refused, Undo frees one;
//   - the enemy's ghosts carry "Moved" / "New" intel marks;
//   - with nothing left to unlock, a free Muster notice.
// Screenshots (jpg) go to SHOTS (default docs/reviews/shots-2026-11-18/relocation).
//   npx vite --port 5193 &   BASE=http://127.0.0.1:5193/ W=1366 H=768 node e2e/ux/relocation.mjs
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5193/';
const W = +(process.env.W || 1366), H = +(process.env.H || 768);
const ROUND = +(process.env.ROUND || 6);
const SHOTS = process.env.SHOTS || 'docs/reviews/shots-2026-11-18/relocation';
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}] ${what}`); if (!ok) fails++; };
const ctx = await browser.createBrowserContext();
const p = await ctx.newPage();
await p.setViewport({ width: W, height: H });
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (name) => p.screenshot({ path: path.join(SHOTS, `${W}x${H}-${name}.jpg`), type: 'jpeg', quality: 85 });
const me = () => p.evaluate(() => {
  const { app } = window.__ob;
  const v = app.room.view;
  return { round: v.round, muster: !!v.you.muster, moveLimit: v.you.moveLimit ?? 0, squads: v.you.squads.map((s) => ({ id: s.id, type: s.type, pos: [...s.pos], formation: window.__ob.sim.formationOf(s), dr: s.deployedRound, scr: app.scene.toScreen(s.pos, 0) })) };
});
const scr = (pos, h = 0) => p.evaluate((pos, h) => window.__ob.app.scene.toScreen(pos, h), pos, h);
const toasts = () => p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
const clearToasts = () => p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
const tags = () => p.evaluate(() => window.__ob.app.scene.timing?.tags ?? []);
const chip = () => p.evaluate(() => document.querySelector('.notice.lock-n')?.textContent.replace(/\s+/g, ' ').trim() ?? '');
const undo = async () => { await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); await sleep(600); };
async function drag(a, b, steps = 12) {
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await p.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await sleep(16);
  }
  await p.mouse.up();
  await sleep(400);
}
/** Close the modals that open on their own (loot, then the recruit draft). */
async function closeModals() {
  for (let i = 0, quiet = 0; i < 12 && quiet < 3; i++) {
    if (await p.$('.modal')) { await p.keyboard.press('Escape'); quiet = 0; } else quiet++;
    await sleep(700);
  }
}
/** A free spot for squad `q` about 6 m from where it stands (towards the zone's middle), clear of every other squad. */
async function freeSpot(q, all) {
  for (const [dx, dy] of [[0, -700], [0, 700], [700, 0], [-700, 0], [700, -700], [-700, -700], [700, 700], [-700, 700]]) {
    const t = [q.pos[0] + dx, q.pos[1] + dy];
    if (t[0] < 700 || t[0] > 7300 || t[1] < 900 || t[1] > 3600) continue;
    if (all.some((o) => o.id !== q.id && Math.hypot(o.pos[0] - t[0], o.pos[1] - t[1]) < 800)) continue;
    const c = await scr(t);
    const ok = await p.evaluate((x, y) => document.elementFromPoint(x, y) === window.__ob.app.scene.canvas, c.x, c.y);
    if (ok && q.scr && await p.evaluate((x, y) => document.elementFromPoint(x, y) === window.__ob.app.scene.canvas, q.scr.x, q.scr.y - 4)) return { t, c };
  }
  return null;
}

try {
  await p.goto(`${BASE}?dev=planning&lord=marshal&round=${ROUND}&timer=0`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob?.app.scene && !!window.__ob.app.room?.view?.you, null, 60000);
  await sleep(3000);
  // a relic "of the March" worn by the pre-rolled army would give relocations without Muster: none here
  await p.evaluate(() => { const l = window.__ob.app.local; l.s.players[0].moveLimit = 0; l.emit(); });

  // ---- the recruit picker offers Muster, distinct from the unit cards
  for (let i = 0; i < 10 && !(await p.$('.modal.draft')); i++) {
    if (await p.$('.modal.loot .later')) await p.click('.modal.loot .later');
    else if (await p.$('.notice.draft-n')) await p.click('.notice.draft-n');
    await sleep(800);
  }
  check(!!(await p.$('.modal.draft .mcard')), 'the recruit picker offers Muster');
  check(!(await p.$('.modal.draft .dcard .mc-go')) && !(await p.$('.modal.draft .mcard .crest')), 'Muster is not a unit card');
  const fit = await p.evaluate(() => {
    const m = document.querySelector('.modal.draft');
    const cards = [...m.querySelectorAll('.dcard, .mcard')].map((n) => n.getBoundingClientRect());
    return cards.every((r) => r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight) && m.scrollHeight <= m.clientHeight + 2;
  });
  check(fit, 'the unit cards and the Muster choice all fit on one screen');
  await sleep(900);
  await shot('muster-card');
  await closeModals();
  await clearToasts();
  await sleep(1200);

  // ---- locked squads read as locked
  let m = await me();
  check(m.round === ROUND, `round ${m.round}`);
  const locked = m.squads.filter((q) => q.type !== 'lord' && q.dr < m.round);
  check(locked.length >= 4, `${locked.length} squads locked in place`);
  check(/locked in place/.test(await chip()), `the HUD counts them: "${await chip()}"`);
  let t = await tags();
  check(locked.every((q) => t.some((x) => x.id === q.id && x.badge === 'lock')), 'every locked squad wears a lock badge');
  check(!t.some((x) => m.squads.find((q) => q.id === x.id && q.type === 'lord') && x.badge), 'the Lord wears none');
  await shot('locked-badges');

  // pick a locked squad with free ground beside it
  let pick = null;
  for (const q of locked) { const f = await freeSpot(q, m.squads); if (f) { pick = { q, ...f }; break; } }
  check(!!pick, 'found a locked squad with free ground beside it');
  const q0 = pick.q;
  await p.mouse.move(q0.scr.x, q0.scr.y - 4);
  await sleep(700);
  const tipText = await p.evaluate(() => document.querySelector('.tip-layer.on')?.textContent ?? '');
  check(/Locked in place since round \d+\. Its formation is still free to change; take Muster/.test(tipText), 'the hover tooltip explains the lock');
  await shot('locked-tooltip');
  await drag({ x: q0.scr.x, y: q0.scr.y - 4 }, pick.c);
  m = await me();
  check(m.squads.find((q) => q.id === q0.id).pos.join() === q0.pos.join(), 'a locked squad cannot be dragged in a later round');
  check(/Locked in place/.test(await toasts()), `the drag is refused with the reason (${(await toasts()).slice(0, 80)})`);
  check(await p.evaluate((id) => window.__ob.app.screen.selected === id, q0.id), 'the refused squad is selected');
  check(/Locked in place since round/.test(await p.$eval('.sqpanel', (n) => n.textContent)), 'its panel says it is locked');
  await sleep(300);
  await shot('locked-panel');
  await clearToasts();
  // its formation is free, and undoable (R on the selected squad; it never moves)
  const formable = await p.evaluate((t) => window.__ob.sim.hasFormation(t), q0.type);
  let q1 = q0;
  if (formable) {
    const f0 = q0.formation;
    await p.keyboard.press('r');
    await sleep(600);
    m = await me();
    q1 = m.squads.find((q) => q.id === q0.id);
    check(q1.formation !== f0 && q1.pos.join() === q0.pos.join(), `R changes a locked squad's formation in place (${f0} → ${q1.formation})`);
    check(!/Locked in place/.test(await toasts()), 'and is not refused as a move');
    await undo();
    q1 = (await me()).squads.find((q) => q.id === q0.id);
    check(q1.formation === f0 && q1.pos.join() === q0.pos.join(), 'Undo sets it back');
  }
  // Mirror leaves the locked squads where they are
  await p.click('.ptools .pt-mirror');
  await sleep(700);
  const mir = await me();
  check(locked.every((q) => mir.squads.find((x) => x.id === q.id).pos.join() === q.pos.join()), 'Mirror leaves locked squads in place');
  await undo();
  await clearToasts();
  await p.keyboard.press('Escape');

  // ---- take Muster from the recruit picker: two presses
  if (!(await p.$('.modal.draft'))) await p.click('.notice.draft-n');
  await sleep(900);
  await p.click('.modal.draft .mcard');
  await sleep(300);
  check(!(await me()).muster && /Confirm/.test(await p.$eval('.modal.draft .mcard', (n) => n.textContent)), 'the first press arms Muster (Confirm)');
  await p.click('.modal.draft .mcard');
  await sleep(900);
  m = await me();
  check(m.muster && m.moveLimit >= 3, `Muster taken (moveLimit ${m.moveLimit})`);
  check(!(await p.$('.modal.draft')), 'the recruit picker closes');
  check(/Moves left 3\/3/.test(await chip()), `the HUD shows "${await chip()}"`);
  await clearToasts();
  t = await tags();
  check(locked.every((q) => t.some((x) => x.id === q.id && x.badge === 'open')), 'locked squads show an open lock while moves are left');

  // ---- three relocations, the fourth refused
  const moved = [];
  for (const q of locked) {
    if (moved.length >= 4) break;
    const cur = await me();
    const qq = cur.squads.find((x) => x.id === q.id);
    const f = await freeSpot(qq, cur.squads);
    if (!f) continue;
    await drag({ x: qq.scr.x, y: qq.scr.y - 4 }, f.c);
    const after = (await me()).squads.find((x) => x.id === q.id);
    moved.push({ id: q.id, ok: after.pos.join() !== qq.pos.join(), from: qq.pos });
    if (moved.length === 1) {
      await sleep(500);
      await shot('moves-left');
    }
    if (moved.length === 3) check(/Moves left 0\/3/.test(await chip()), `after three relocations: "${await chip()}"`);
    if (moved.length < 4) await clearToasts();
  }
  check(moved.length === 4, `tried four relocations (${moved.length})`);
  check(moved.slice(0, 3).every((x) => x.ok), 'the first three relocations are made');
  check(moved[3] && !moved[3].ok, 'the fourth is refused');
  check(/All 3 relocations used/.test(await toasts()), `with the reason (${(await toasts()).slice(0, 80)})`);
  t = await tags();
  check(moved.slice(0, 3).every((x) => t.some((g) => g.id === x.id && g.badge === 'reloc')), 'relocated squads wear the relocation badge');
  await clearToasts();
  await undo();
  check(/Moves left 1\/3/.test(await chip()), `Undo puts the last one back and frees its move: "${await chip()}"`);
  const back = (await me()).squads.find((x) => x.id === moved[2].id);
  check(back.pos.join() === moved[2].from.join(), 'it stands where it stood');
  await p.keyboard.press('Escape');

  // ---- enemy intel: moved and new marks on the ghosts
  const ghosts = await p.evaluate(() => (window.__ob.app.room.view.enemy.lastArmy ?? []).map((s) => ({ id: s.id, type: s.type, dr: s.deployedRound })));
  const old = ghosts.filter((g) => g.type !== 'lord' && g.dr < ROUND - 1).slice(0, 2).map((g) => g.id);
  // the bot moved two squads last round (its Muster): the intel the server would hand over
  await p.evaluate((ids) => { const l = window.__ob.app.local; l.s.players[1].lastMoved = ids; l.emit(); }, old);
  await sleep(800);
  t = await tags();
  check(old.length > 0 && old.every((id) => t.some((x) => x.id === id && x.badge === 'moved')), 'moved enemy squads carry a Moved mark');
  const fresh = ghosts.filter((g) => g.type !== 'lord' && g.dr === ROUND - 1);
  check(fresh.every((g) => t.some((x) => x.id === g.id && x.badge === 'new')), `squads new last round carry a New mark (${fresh.length})`);
  const g0 = await p.evaluate((id) => window.__ob.app.room.view.enemy.lastArmy.find((s) => s.id === id).pos, old[0]);
  const gs = await scr(g0);
  await p.mouse.click(gs.x, gs.y - 4);
  await sleep(600);
  check(/Moved since the round before/.test(await p.$eval('.sqpanel', (n) => n.textContent)), 'the ghost inspector says it moved');
  await shot('enemy-intel');
  await p.keyboard.press('Escape');

  // ---- nothing left to unlock: Muster is free, from a notice
  await p.evaluate(() => { const l = window.__ob.app.local; const pl = l.s.players[0]; pl.draftOptions = []; pl.draftPicks = 0; pl.musterOffer = true; pl.muster = false; pl.moveLimit = 0; l.emit(); });
  await sleep(800);
  check(!!(await p.$('.notice.muster-n')) && /nothing left to unlock/.test(await p.$eval('.notice.muster-n', (n) => n.textContent)), 'a free Muster notice when nothing is left to unlock');
  await shot('free-muster');
  await p.click('.notice.muster-n');
  await sleep(800);
  check((await me()).muster, 'the notice takes Muster');
  check(!(await p.$('.notice.muster-n')), 'and goes away');
} catch (e) {
  check(false, 'exception: ' + (e?.stack ?? e));
} finally {
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
}
