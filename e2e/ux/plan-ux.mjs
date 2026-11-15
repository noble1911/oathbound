// Planning UX: box select, Shift-click, group drag and turn, undo (Ctrl+Z) of moves and deploys,
// mirror, sync by speed, grid snap, the march preview (T) and the Lord's aura ring, offline on
// ?dev=planning (no server). Checks idle planning still draws 0 fps with the overlays up.
// Screenshots: e2e/shots/plan-ux-<W>-*.png.
//   npx vite --port 5193 &   BASE=http://127.0.0.1:5193/ W=1920 H=1080 node e2e/ux/plan-ux.mjs
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5193/';
const W = +(process.env.W || 1920), H = +(process.env.H || 1080);
const LORD = process.env.LORD || 'marshal';
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}] ${what}`); if (!ok) fails++; };
const ctx = await browser.createBrowserContext();
const p = await ctx.newPage();
await p.setViewport({ width: W, height: H });
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (name) => p.screenshot({ path: path.join('e2e/shots', `plan-ux-${W}-${name}.png`) });
const frames = async (ms) => {
  const a = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
  await sleep(ms);
  const b = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
  return +(((b - a) * 1000) / ms).toFixed(1);
};
// my squads (as the server has them) and where they are on screen
const army = () => p.evaluate(() => {
  const { app } = window.__ob;
  return app.room.view.you.squads.map((s) => ({ id: s.id, type: s.type, pos: [...s.pos], facing: s.facing, scr: app.scene.toScreen(s.pos, 0) }));
});
const scr = (pos, h = 0) => p.evaluate((pos, h) => window.__ob.app.scene.toScreen(pos, h), pos, h);
const sel = () => p.evaluate(() => [...window.__ob.app.screen.sel]);
const gold = () => p.evaluate(() => window.__ob.app.room.view.you.gold);
async function drag(a, b, { button = 'left', steps = 12, mid = null } = {}) {
  await p.mouse.move(a.x, a.y);
  await p.mouse.down({ button });
  for (let i = 1; i <= steps; i++) {
    await p.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await sleep(16);
  }
  if (mid) await mid();
  await p.mouse.up({ button });
  await sleep(250);
}

try {
  await p.goto(`${BASE}?dev=planning&lord=${LORD}&timer=0`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob?.app.scene && !!window.__ob.app.room?.view?.you, null, 60000);
  await sleep(4000);
  // the draft / loot modals open on their own: close them
  for (let i = 0; i < 3; i++) {
    if (await p.$('.modal')) await p.keyboard.press('Escape');
    await sleep(500);
  }
  await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await sleep(1500);
  const a0 = await army();
  check(a0.length >= 4, `round 3 army on the field (${a0.length} squads)`);
  check(!!(await p.$('.ptools .pt-undo')) && !!(await p.$('.ptools .pt-sync')), 'formation bar is on screen');

  // ---- timing tags are there, idle planning still draws nothing
  check((await frames(2500)) === 0, 'idle planning (tags up) draws 0 fps');

  // ---- box select: from empty ground at the front left of my zone to the back right
  const c0 = await scr([250, 3950]);
  const c1 = await scr([7750, 450]);
  const free = await p.evaluate((x, y) => window.__ob.app.scene.squadAt(x, y), c0.x + 4, c0.y + 4);
  check(!free, 'box starts on empty ground');
  await drag({ x: c0.x + 4, y: Math.max(c0.y + 4, 80) }, { x: Math.min(c1.x - 4, W - 30), y: Math.min(c1.y - 4, H - 200) }, {
    mid: async () => {
      check(!!(await p.$('.selbox')), 'the selection box is drawn while dragging');
      await shot('boxselect');
    },
  });
  let s = await sel();
  check(s.length >= 3, `box selected ${s.length} squads`);
  check(await p.evaluate(() => document.querySelectorAll('.sqpanel .sp-glist li').length) === s.length, 'the panel lists the selection');
  check(!(await p.$('.sqpanel .lvl')) && !(await p.$('.sqpanel .sell')), 'no level-up or sell buttons for a group');
  await sleep(400);
  await shot('multiselect');

  // ---- Shift-click takes one out and puts it back
  const first = (await army()).find((q) => q.id === s[0]);
  await p.keyboard.down('Shift');
  await p.mouse.click(first.scr.x, first.scr.y - 4);
  await p.keyboard.up('Shift');
  await sleep(200);
  check((await sel()).length === s.length - 1, 'Shift-click removes a squad from the selection');
  await p.keyboard.down('Shift');
  await p.mouse.click(first.scr.x, first.scr.y - 4);
  await p.keyboard.up('Shift');
  await sleep(200);
  s = await sel();
  check(s.includes(first.id), 'Shift-click adds it back');

  // ---- group drag keeps the shape (or clamps it into the zone), and undo puts it back
  const before = await army();
  const grabbed = before.find((q) => q.id === s[1]);
  const target = await scr([grabbed.pos[0] + 600, grabbed.pos[1] - 700]);
  await drag({ x: grabbed.scr.x, y: grabbed.scr.y - 4 }, target, {
    steps: 16,
    mid: async () => {
      await sleep(250);
      await shot('groupdrag');
    },
  });
  await sleep(500);
  const after = await army();
  const moved = after.filter((q) => s.includes(q.id) && before.find((b) => b.id === q.id).pos.join() !== q.pos.join());
  check(moved.length >= s.length - 1, `group drag moved ${moved.length}/${s.length} selected squads`);
  const deltas = after.filter((q) => s.includes(q.id)).map((q) => { const b = before.find((x) => x.id === q.id); return [q.pos[0] - b.pos[0], q.pos[1] - b.pos[1]]; });
  const same = deltas.filter((d) => Math.abs(d[0] - deltas[0][0]) <= 120 && Math.abs(d[1] - deltas[0][1]) <= 120).length;
  check(same >= deltas.length - 1, `relative positions kept (${same}/${deltas.length} share the offset ${deltas[0]})`);
  check(after.filter((q) => !s.includes(q.id)).every((q) => before.find((b) => b.id === q.id).pos.join() === q.pos.join()), 'squads outside the selection stay put');
  await p.keyboard.down('Control');
  await p.keyboard.press('z');
  await p.keyboard.up('Control');
  await sleep(600);
  const undone = await army();
  check(undone.every((q) => before.find((b) => b.id === q.id).pos.join() === q.pos.join()), 'Ctrl+Z puts the group back');

  // ---- group turn (Shift+E), then undo
  await p.keyboard.down('Shift');
  await p.keyboard.press('e');
  await p.keyboard.press('e');
  await p.keyboard.up('Shift');
  await sleep(500);
  const turned = await army();
  check(turned.filter((q) => s.includes(q.id)).some((q) => before.find((b) => b.id === q.id).facing !== q.facing), 'Shift+E turns the group');
  await p.click('.ptools .pt-undo');
  await sleep(600);
  check((await army()).every((q) => { const b = before.find((x) => x.id === q.id); return b.pos.join() === q.pos.join() && b.facing === q.facing; }), 'two quick turns undo in one step');

  // ---- routes (T) and sync by speed
  await p.keyboard.press('t');
  await sleep(700);
  await shot('timing');
  check((await frames(2000)) === 0, 'idle planning with every route drawn: 0 fps');
  await p.click('.ptools .pt-sync');
  await sleep(900);
  await shot('sync');
  const synced = await p.evaluate(() => {
    const scr = window.__ob.app.screen;
    const me = window.__ob.app.room.view.you;
    // a squad parked on the back edge is too fast to hold back any further: it is left out of the spread
    return me.squads.filter((q) => q.type !== 'lord').map((q) => { const m = scr.march(q); return m.ranged || q.pos[1] <= 700 ? null : m.river?.sec; }).filter((x) => x != null);
  });
  check(synced.length < 2 || Math.max(...synced) - Math.min(...synced) < 1, `sync: melee river times ${synced.map((x) => x.toFixed(1)).join(', ')}`);
  await p.keyboard.down('Control');
  await p.keyboard.press('z');
  await p.keyboard.up('Control');
  await sleep(600);
  check((await army()).every((q) => before.find((b) => b.id === q.id).pos.join() === q.pos.join()), 'sync undone');
  await p.keyboard.press('t');
  await sleep(300);

  // ---- mirror, then undo
  await p.click('.ptools .pt-mirror');
  await sleep(700);
  const mir = await army();
  check(mir.every((q) => { const b = before.find((x) => x.id === q.id); return q.pos[0] === 7999 - b.pos[0] && q.pos[1] === b.pos[1]; }), 'mirror flips every squad left to right');
  await p.keyboard.down('Control');
  await p.keyboard.press('z');
  await p.keyboard.up('Control');
  await sleep(700);
  check((await army()).every((q) => before.find((b) => b.id === q.id).pos.join() === q.pos.join()), 'mirror undone');

  // ---- the Lord: aura ring
  await p.keyboard.press('Escape');
  await p.keyboard.press('Tab'); // the Lord first
  await sleep(500);
  const lordSel = await p.evaluate(() => { const s = window.__ob.app.screen; const id = s.selected; return window.__ob.app.room.view.you.squads.find((q) => q.id === id)?.type; });
  check(lordSel === 'lord', 'Tab selects the Lord');
  check(await p.evaluate(() => window.__ob.app.scene.overlay?.aura.visible === true), 'the Lord shows its aura ring');
  await shot('aura');

  // ---- grid snap (G) and a single squad drag
  await p.keyboard.press('Escape');
  await p.keyboard.press('g');
  await sleep(200);
  const one = (await army()).find((q) => q.type !== 'lord');
  const to = await scr([one.pos[0] - 333, one.pos[1] - 271]);
  await drag({ x: one.scr.x, y: one.scr.y - 4 }, to, { steps: 10, mid: async () => { await sleep(200); await shot('drag-route'); } });
  await sleep(500);
  const snapped = (await army()).find((q) => q.id === one.id);
  check(snapped.pos[0] % 100 === 0 && snapped.pos[1] % 100 === 0, `snap: dropped on the 1 m grid (${snapped.pos})`);
  await p.keyboard.press('g');

  // ---- deploy, then undo (a same-round sell)
  const g0 = await gold();
  const n0 = (await army()).length;
  const canDeploy = await p.evaluate(() => { const me = window.__ob.app.room.view.you; return me.deploysUsed < me.deployLimit; });
  if (canDeploy) {
    await p.keyboard.press('1');
    const spot = await scr([1500, 1200]);
    await p.mouse.move(spot.x, spot.y);
    await sleep(200);
    await p.mouse.click(spot.x, spot.y);
    await sleep(600);
    const n1 = (await army()).length;
    check(n1 === n0 + 1, 'deployed a squad');
    await p.keyboard.down('Control');
    await p.keyboard.press('z');
    await p.keyboard.up('Control');
    await sleep(600);
    check((await army()).length === n0 && (await gold()) > g0 - 200, `undo deploy sells it again (gold ${g0} → ${await gold()})`);
  }

  await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await sleep(2500);
  check((await frames(2500)) === 0, 'idle planning afterwards: 0 fps');
} catch (e) {
  check(false, 'exception: ' + (e?.stack ?? e));
} finally {
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
}
