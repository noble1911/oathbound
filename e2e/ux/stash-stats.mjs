// The stash and the formation toolbar (Undo/Mirror/Sync/Routes/Snap) must never cover the player's deploy zone, the
// toolbar must not run into the left button column (rail buttons and the stash bag), and every stat display (shop tooltip, squad hover card,
// squad panel) must show the same, sim-derived numbers. Offline on ?dev=planning (no server).
// Screenshots: docs/reviews/shots-2026-11-17/after-<W>-stash.jpg and after-<W>-stats-*.jpg.
//   npx vite --port 5193 &   BASE=http://127.0.0.1:5193/ W=1024 H=768 node e2e/ux/stash-stats.mjs
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5193/';
const W = +(process.env.W || 1920), H = +(process.env.H || 1080);
const ROUND = +(process.env.ROUND || 5);
const OUT = process.env.OUT || 'docs/reviews/shots-2026-11-17';
const SHOTS = process.env.SHOTS !== '0';
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}x${H}] ${what}`); if (!ok) fails++; };
const p = await (await browser.createBrowserContext()).newPage();
await p.setViewport({ width: W, height: H });
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (name) => SHOTS && p.screenshot({ path: path.join(OUT, `after-${W}-${name}.jpg`), type: 'jpeg', quality: 85 });

try {
  await p.goto(`${BASE}?dev=planning&round=${ROUND}&timer=0`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob?.app.scene && !!window.__ob.app.room?.view?.you, null, 60000);
  await sleep(4000);
  for (let i = 0, quiet = 0; i < 12 && quiet < 3; i++) {
    if (await p.$('.modal')) { await p.keyboard.press('Escape'); quiet = 0; } else quiet++;
    await sleep(700);
  }
  await p.mouse.move(W / 2, 40);
  await sleep(500);

  // ---- the stash against the deploy zone: sample the zone on screen, none of it may fall under the stash (the bag,
  // and the flyout when it is open), closed and open, empty and full
  const overlap = (what) => p.evaluate((what) => {
    const { app } = window.__ob;
    const seat = app.screen.seat ?? 0;
    const z = seat === 0 ? { x0: 200, x1: 7799, y0: 400, y1: 3999 } : { x0: 200, x1: 7799, y0: 8000, y1: 11599 };
    const rects = [...document.querySelectorAll('.stash, .stash.open .stash-fly')].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
    let hit = 0, n = 0;
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
      const pos = [Math.round(z.x0 + ((z.x1 - z.x0) * i) / 40), Math.round(z.y0 + ((z.y1 - z.y0) * j) / 40)];
      const s = app.scene.toScreen(pos, 0);
      if (!s || s.x < 0 || s.y < 0 || s.x > innerWidth || s.y > innerHeight) continue;
      n++;
      if (rects.some((r) => s.x >= r.left && s.x <= r.right && s.y >= r.top && s.y <= r.bottom)) hit++;
    }
    // the open flyout must not hide the notices either, nor run under the top HUD
    const fly = document.querySelector('.stash.open .stash-fly')?.getBoundingClientRect();
    const notes = [...document.querySelectorAll('.notices > *')].map((x) => x.getBoundingClientRect());
    const onNotice = fly ? notes.some((r) => r.left < fly.right && r.right > fly.left && r.top < fly.bottom && r.bottom > fly.top) : false;
    const hud = document.querySelector('.topbar')?.getBoundingClientRect();
    // the formation toolbar: none of the zone under it, and clear of the left button column
    const tools = document.querySelector('.ptools')?.getBoundingClientRect();
    let toolHit = 0;
    if (tools && tools.width > 0) for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
      const pos = [Math.round(z.x0 + ((z.x1 - z.x0) * i) / 40), Math.round(z.y0 + ((z.y1 - z.y0) * j) / 40)];
      const s = app.scene.toScreen(pos, 0);
      if (s && s.x >= tools.left && s.x <= tools.right && s.y >= tools.top && s.y <= tools.bottom) toolHit++;
    }
    const tl = tools ? [tools.left, tools.top, tools.right, tools.bottom].map(Math.round) : null;
    const column = [...document.querySelectorAll('.shell .corner button.icon, .stash-tab')].map((n) => n.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.left < innerWidth / 4 && r.top > 0);
    const onColumn = tools ? column.some((r) => r.left < tools.right && r.right > tools.left && r.top < tools.bottom && r.bottom > tools.top) : false;
    const onNoticeT = tools ? notes.some((r) => r.left < tools.right && r.right > tools.left && r.top < tools.bottom && r.bottom > tools.top) : false;
    const badge = document.querySelector('.deploy-badge')?.getBoundingClientRect();
    const onBadge = !!(tools && badge && tools.bottom > badge.top);
    const offScreen = !!(tools && (tools.left < 0 || tools.bottom > innerHeight));
    return { what, tools: tl, toolHit, onColumn, onNoticeT, onBadge, offScreen, columnN: column.length, rects: rects.map((r) => [r.left, r.top, r.right, r.bottom].map(Math.round)), hit, n, onNotice, underHud: !!(fly && hud && fly.top < hud.bottom - 2), items: app.room.view.you.stash.length };
  }, what);
  const stashCheck = async (what) => {
    const m = await overlap(what);
    console.log(JSON.stringify(m));
    check(m.hit === 0, `${what}: the stash covers none of the deploy zone (${m.hit}/${m.n} points)`);
    check(!m.onNotice, `${what}: the open stash does not hide a notice`);
    check(!m.underHud, `${what}: the open stash stays under the top HUD`);
    check(!!m.tools, `${what}: the formation toolbar is shown`);
    check(m.toolHit === 0, `${what}: the formation toolbar covers none of the deploy zone (${m.toolHit}/${m.n} points)`);
    check(m.columnN > 0 && !m.onColumn, `${what}: the formation toolbar clears the left button column (${m.columnN} buttons)`);
    check(!m.onNoticeT && !m.onBadge && !m.offScreen, `${what}: the formation toolbar clears the notices and the deploy badge, on screen`);
  };
  await stashCheck('closed, empty');
  await p.click('.stash-tab');
  await sleep(300);
  await stashCheck('open, empty');
  await p.click('.stash-tab');
  // a full stash: twelve items, as after a long match
  await p.evaluate(() => {
    const { app } = window.__ob;
    const s = app.local.s;
    const me = s.players[app.screen.seat ?? 0];
    const bases = [['steel_blade', 'weapon'], ['mail_hauberk', 'armor'], ['war_banner', 'relic'], ['grimoire', 'weapon']];
    for (let i = 0; i < 12; i++) {
      const [base, slot] = bases[i % 4];
      me.stash.push({ id: s.nextId++, base, slot, rarity: ['common', 'magic', 'rare', 'legendary'][i % 3], ilvl: 3, implicit: { id: 'vicious', value: 6 }, affixes: [], legendary: null });
    }
    app.local.emit();
  });
  await sleep(500);
  check(await p.evaluate(() => document.querySelector('.stash').classList.contains('open')), 'new loot opens the stash');
  await stashCheck('open, 12 items');
  await shot('stash');
  await p.click('.stash-tab');
  await sleep(300);
  await stashCheck('closed, 12 items');
  await shot('stash-closed');

  // ---- stats: the shop tooltip, the squad hover card and the squad panel agree with the sim
  const card = await p.$('.ucard');
  const u = await p.evaluate((c) => c.dataset.u, card);
  await card.hover();
  await sleep(600);
  const tipLife = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.utip .stats .st')];
    const life = rows.find((r) => /Life/.test(r.textContent));
    return life ? life.querySelector('b').textContent.trim() : null;
  });
  const want = await p.evaluate(async (u, lord) => {
    const g = await import('/src/ui/gamedata.ts');
    return g.soldierStats(u, 1, lord);
  }, u, await p.evaluate(() => window.__ob.app.room.view.you.lord));
  check(tipLife === String(want.hp), `shop tooltip of ${u}: life ${tipLife} = sim ${want.hp}`);
  await shot('stats-shop');

  // a squad of mine on the field: hover card, then the panel
  const sq = await p.evaluate(() => {
    const { app } = window.__ob;
    // a squad in the open (not under the shop or a panel), so the pointer reaches the field
    const all = app.room.view.you.squads.filter((s) => s.type !== 'lord').map((q) => ({ id: q.id, scr: app.scene.toScreen(q.pos, 0) }));
    return all.find((q) => document.elementFromPoint(q.scr.x, q.scr.y) === app.scene.canvas && app.scene.squadAt(q.scr.x, q.scr.y)?.id === q.id);
  });
  if (sq) {
    await p.mouse.move(W / 2, 40);
    await sleep(300);
    for (let i = 1; i <= 6; i++) { await p.mouse.move(W / 2 + ((sq.scr.x - W / 2) * i) / 6, 40 + ((sq.scr.y - 40) * i) / 6); await sleep(30); }
    await sleep(700);
    const hover = await p.evaluate(() => [...document.querySelectorAll('.sqtip .sqtip-st > span')].map((n) => n.textContent.trim()).join(' ') || null);
    await shot('stats-hover');
    await p.evaluate((id) => window.__ob.app.screen.select(id), sq.id);
    await sleep(600);
    const panel = await p.evaluate(() => document.querySelector('.sp-brief')?.textContent.trim() ?? null);
    console.log('hover:', hover, '| panel brief:', panel);
    const num = (s) => (s ?? '').match(/[\d.]+/g)?.slice(0, 2).join(' ');
    check(!!hover && !!panel && num(hover) === num(panel), `hover card and squad panel agree (${num(hover)} / ${num(panel)})`);
    await shot('stats-panel');
  } else check(false, 'no squad on the field');
} catch (e) {
  console.log('ERROR', e.stack);
  fails++;
}
for (const e of errors) console.log(e);
await browser.close();
process.exit(fails || errors.length ? 1 : 0);
