// The Lord's pre-battle orders (DESIGN §4) on the planning screen, offline on ?dev=planning (a local match against the
// AI, no server):
//   - the Lord's panel carries the three-way Advance / Hold / Follow control, Advance on by default;
//   - Hold: the sim holds the stance, the Lord's plate tag and the watch ring say so;
//   - Follow: pick mode (the control says so, Esc cancels), a click on a deployed squad sets it, the control names it,
//     the tether is drawn; Undo goes back; the list under the control picks too;
//   - the enemy Lord's ghost shows the stance he fought the last battle with (tag and panel);
//   - Ready locks the control; the stance survives the battle into the next round;
//   - idle planning with the markers up draws 0 fps; nothing overflows (the panel, the page) at this size.
// Screenshots (png) go to SHOTS (default docs/reviews/shots-2026-11-18/stance-formation): stance-<name>-<W>.png.
//   npx vite --port 5241 &   BASE=http://127.0.0.1:5241/ W=1366 H=768 node e2e/ux/stance.mjs [cases...]
//   SCENE=standin ... runs it on the stand-in renderer. Cases (default all, in order): control hold follow intel layout ready.
// The squad panel's formation toggle (Wide / Deep) has its own script next to this one: e2e/ux/formation.mjs.
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5241/';
const W = +(process.env.W || 1366), H = +(process.env.H || 768);
const ROUND = +(process.env.ROUND || 3);
const SCENE = process.env.SCENE || '';
const SHOTS = process.env.SHOTS || 'docs/reviews/shots-2026-11-18/stance-formation';
const only = process.argv.slice(2);
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}${SCENE ? ' ' + SCENE : ''}] ${what}`); if (!ok) fails++; return ok; };
const ctx = await browser.createBrowserContext();
const p = await ctx.newPage();
await p.setViewport({ width: W, height: H });
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (name) => SHOTS !== '0' && p.screenshot({ path: path.join(SHOTS, `stance-${name}-${W}${SCENE ? '-' + SCENE : ''}.png`) });

// ---------------------------------------------------------------- helpers
const me = () => p.evaluate(() => {
  const { app } = window.__ob;
  const v = app.room.view;
  return { round: v.round, ready: v.you.ready, phase: app.room.phase, squads: v.you.squads.map((s) => ({ id: s.id, type: s.type, pos: [...s.pos], stance: s.stance ?? null, scr: app.scene.toScreen(s.pos, 0) })) };
});
const lordOf = (m) => m.squads.find((q) => q.type === 'lord');
const stanceOf = async () => lordOf(await me()).stance ?? { t: 'advance' };
/** The control as drawn: which button is on, which are disabled, the line under it, pick mode. */
const control = () => p.evaluate(() => {
  const seg = document.querySelector('.sqpanel .seg.stance');
  if (!seg) return null;
  const b = [...seg.querySelectorAll('button[data-st]')];
  return {
    n: b.length,
    on: b.filter((x) => x.classList.contains('on')).map((x) => x.dataset.st),
    disabled: b.filter((x) => x.disabled).length,
    picking: !!seg.querySelector('button.picking'),
    line: document.querySelector('.sqpanel .stc-line')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    list: document.querySelectorAll('.sqpanel .stc-pick [data-id]').length,
  };
});
/** What the scene was handed for the stance markers (engine: its last spec; stand-in: the same key). */
const marker = () => p.evaluate(() => { const s = window.__ob.app.scene; const k = s.kind === 'engine' ? s.stance : s.stanceKey; return k ? JSON.parse(k) : null; });
const tags = () => p.evaluate(() => window.__ob.app.scene.timing?.tags ?? []);
const clearToasts = () => p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
const press = async (k) => { await p.keyboard.press(k); await sleep(400); };
const undo = async () => { await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); await sleep(600); };
async function closeModals() {
  for (let i = 0, quiet = 0; i < 12 && quiet < 3; i++) {
    if (await p.$('.modal')) { await p.keyboard.press('Escape'); quiet = 0; } else quiet++;
    await sleep(600);
  }
}
/** A screen point over squad `q` that the scene picks as that squad (not under a panel). */
async function squadPoint(q) {
  if (!q.scr) return null;
  for (const dy of [-4, 0, -14, 6, -24]) for (const dx of [0, 10, -10]) {
    const x = q.scr.x + dx, y = q.scr.y + dy;
    const ok = await p.evaluate((x, y, id) => document.elementFromPoint(x, y) === window.__ob.app.scene.canvas && window.__ob.app.scene.squadAt(x, y)?.id === id, x, y, q.id);
    if (ok) return { x, y };
  }
  return null;
}
async function selectLord() {
  const L = lordOf(await me());
  const at = await squadPoint(L);
  if (at) await p.mouse.click(at.x, at.y);
  else await press('Tab');
  await sleep(500);
  return p.evaluate((id) => window.__ob.app.screen.selected === id, L.id);
}
const click = async (sel) => { await p.click(sel); await sleep(500); };

// ---------------------------------------------------------------- cases
const CASES = {
  async control() {
    check(await selectLord(), 'the Lord is selected');
    const c = await control();
    check(c?.n === 3, `his panel has the three-way control (${c?.n})`);
    check(c?.on.join() === 'advance' && (await stanceOf()).t === 'advance', 'Advance is on by default, with no action');
    check(c?.disabled === 0, 'the control is live in planning');
    check(/nearest enemy/.test(c?.line ?? ''), `the line says what he will do: "${c?.line}"`);
    check((await marker()) === null, 'Advance draws no marker');
    await shot('advance');
  },

  async hold() {
    await click('.sqpanel .seg.stance button[data-st="hold"]');
    const st = await stanceOf();
    check(st.t === 'hold', `Hold reaches the sim (${JSON.stringify(st)})`);
    const c = await control();
    check(c?.on.join() === 'hold', 'Hold sits pressed');
    check(/Waits here until an enemy comes within \d+\s+m/.test(c?.line ?? ''), `the line: "${c?.line}"`);
    const mk = await marker();
    const L = lordOf(await me());
    check(mk?.kind === 'hold' && mk.post.join() === L.pos.join() && mk.leash >= 1400 && mk.focus, `a watch ring round his post (${JSON.stringify(mk)})`);
    if ((await p.evaluate(() => window.__ob.app.scene.kind)) === 'engine') {
      const t = (await tags()).find((x) => x.id === L.id);
      check(t?.badge === 'hold' && t.text === 'Hold', `his plate tag says Hold (${JSON.stringify(t)})`);
    }
    // the markers cost nothing once drawn
    await sleep(1500);
    const f0 = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
    await sleep(2000);
    const f1 = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
    check(f1 - f0 === 0, `idle planning with the watch ring up draws 0 frames (${f1 - f0} in 2 s)`);
    await shot('hold');
  },

  async follow() {
    await click('.sqpanel .seg.stance button[data-st="follow"]');
    let c = await control();
    check(c?.picking && /Click the squad he should follow/.test(c.line), `Follow enters pick mode: "${c?.line}"`);
    check(c?.list > 0, `with the squads to pick listed under it (${c?.list})`);
    check(await p.evaluate(() => document.querySelector('.phint.on')?.textContent.includes('follow') ?? false), 'the hint line says what to click');
    // Esc cancels: the stance stays Hold
    await press('Escape');
    c = await control();
    check(c && !c.picking && c.on.join() === 'hold' && (await stanceOf()).t === 'hold', 'Esc cancels the pick, Hold stays');
    check(await p.evaluate(() => window.__ob.app.screen.selected !== null), 'and the Lord stays selected');
    // pick a deployed squad on the field
    await click('.sqpanel .seg.stance button[data-st="follow"]');
    const m = await me();
    let lead = null, at = null;
    for (const q of m.squads.filter((q) => q.type !== 'lord')) { at = await squadPoint(q); if (at) { lead = q; break; } }
    if (!check(!!lead, 'found a deployed squad to click')) return;
    await p.mouse.click(at.x, at.y);
    await sleep(700);
    const st = await stanceOf();
    check(st.t === 'follow' && st.squad === lead.id, `a click on it sets Follow (${JSON.stringify(st)}, clicked ${lead.id})`);
    c = await control();
    check(c && !c.picking && c.on.join() === 'follow', 'the pick ends and Follow sits pressed');
    check(/^Follows .+, \d+\s+m behind it/.test(c?.line ?? ''), `the control names the squad followed: "${c?.line}"`);
    check(await p.evaluate(() => { const s = window.__ob.app.screen; return s.selected !== null && window.__ob.app.room.view.you.squads.find((q) => q.id === s.selected)?.type === 'lord'; }), 'the Lord is still the one selected');
    const mk = await marker();
    check(mk?.kind === 'follow' && mk.lead?.join() === lead.pos.join() && Math.abs(Math.abs(mk.post[1] - lead.pos[1]) - 600) <= 1, `the tether runs to the spot 6 m behind it (${JSON.stringify(mk)})`);
    if ((await p.evaluate(() => window.__ob.app.scene.kind)) === 'engine') {
      const t = (await tags()).find((x) => x.id === lordOf(m).id);
      check(t?.badge === 'follow', `his plate tag says Follow (${JSON.stringify(t)})`);
    }
    await clearToasts();
    await p.mouse.move(W / 2, 40);
    await sleep(500);
    await shot('follow');
    // Undo goes back to Hold; the list under the control picks too
    await undo();
    check((await stanceOf()).t === 'hold', 'Undo puts him back on Hold');
    await click('.sqpanel .seg.stance button[data-st="follow"]');
    await click(`.sqpanel .stc-pick [data-id="${lead.id}"]`);
    const st2 = await stanceOf();
    check(st2.t === 'follow' && st2.squad === lead.id, 'the list under the control picks the squad too');
    await clearToasts();
    // deselect: the tether stays, fainter; the plate tag still names his orders
    await press('Escape');
    const mk2 = await marker();
    check(mk2?.kind === 'follow' && !mk2.focus, 'with the Lord deselected the tether stays (unfocused)');
    await shot('follow-idle');
    await selectLord();
  },

  async intel() {
    // the enemy Lord fought the last battle holding his post: the server hands that over in lastArmy
    await p.evaluate(() => {
      const l = window.__ob.app.local;
      const la = l.s.players[1].lastArmy;
      const lord = la?.find((q) => q.type === 'lord');
      if (lord) lord.stance = { t: 'hold' };
      l.emit();
    });
    await sleep(700);
    const g = await p.evaluate(() => { const v = window.__ob.app.room.view; const q = v.enemy.lastArmy?.find((s) => s.type === 'lord'); return q ? { id: q.id, pos: q.pos, scr: window.__ob.app.scene.toScreen(q.pos, 0), stance: q.stance } : null; });
    if (!check(!!g && g.stance?.t === 'hold', `the enemy Lord's ghost carries last battle's stance (${JSON.stringify(g?.stance)})`)) return;
    check(await p.evaluate(() => window.__ob.app.room.view.enemy.lastArmy.find((s) => s.type === 'lord').stance?.t === 'hold' && !window.__ob.app.room.view.enemy.squads), 'and nothing of this round\'s enemy army is in the view');
    if ((await p.evaluate(() => window.__ob.app.scene.kind)) === 'engine') {
      const t = (await tags()).find((x) => x.id === g.id);
      check(t?.badge === 'hold' && t.foe && t.text === 'Held', `his ghost's tag says Held, in the enemy's colour (${JSON.stringify(t)})`);
    }
    // read it in the ghost's panel
    let at = null;
    for (const dy of [-4, 0, -14, 6]) {
      const ok = await p.evaluate((x, y, id) => document.elementFromPoint(x, y) === window.__ob.app.scene.canvas && window.__ob.app.scene.squadAt(x, y)?.id === id, g.scr.x, g.scr.y + dy, g.id);
      if (ok) { at = { x: g.scr.x, y: g.scr.y + dy }; break; }
    }
    if (at) {
      await p.mouse.click(at.x, at.y);
      await sleep(700);
      const txt = await p.$eval('.sqpanel', (n) => n.textContent);
      check(/Held his post last battle/.test(txt), 'the ghost inspector says how he fought last battle');
      check(!(await p.$('.sqpanel .seg.stance')), 'the enemy Lord has no control');
      await shot('intel');
      await press('Escape');
    } else check(false, 'the enemy Lord\'s ghost is clickable');
    await selectLord();
  },

  async layout() {
    // nothing on the page or in the Lord's panel spills out of its box at this size
    const r = await p.evaluate(() => {
      const out = [];
      const panel = document.querySelector('.sqpanel');
      const pr = panel?.getBoundingClientRect();
      if (pr && (pr.left < 0 || pr.right > innerWidth + 0.5 || pr.top < 0 || pr.bottom > innerHeight + 0.5)) out.push(`panel off screen ${JSON.stringify(pr)}`);
      for (const n of document.querySelectorAll('.sqpanel .stc *, .sqpanel .stc')) {
        if (n instanceof SVGElement) continue;
        if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'auto') out.push(`${n.className || n.tagName}: ${n.scrollWidth} > ${n.clientWidth}`);
        const b = n.getBoundingClientRect();
        if (pr && b.width && (b.right > pr.right + 0.5 || b.left < pr.left - 0.5)) out.push(`${n.className || n.tagName} leaves the panel`);
      }
      const d = document.documentElement;
      if (d.scrollWidth > innerWidth || d.scrollHeight > innerHeight) out.push(`page scrolls ${d.scrollWidth}x${d.scrollHeight}`);
      // the control does not sit under another HUD piece
      const seg = document.querySelector('.sqpanel .seg.stance')?.getBoundingClientRect();
      if (seg) for (const sel of ['.ptools', '.stash', '.bottom', '.res', '.notices']) {
        for (const o of document.querySelectorAll(sel)) {
          const b = o.getBoundingClientRect();
          if (b.width && b.height && seg.left < b.right && seg.right > b.left && seg.top < b.bottom && seg.bottom > b.top) out.push(`control overlaps ${sel}`);
        }
      }
      return out;
    });
    check(r.length === 0, `no overflow or overlap${r.length ? ': ' + r.join(' | ') : ''}`);
    // the same with the pick list open
    await click('.sqpanel .seg.stance button[data-st="follow"]');
    const r2 = await p.evaluate(() => {
      const pr = document.querySelector('.sqpanel').getBoundingClientRect();
      const l = document.querySelector('.sqpanel .stc-pick')?.getBoundingClientRect();
      return !l || (l.right <= pr.right + 0.5 && l.left >= pr.left - 0.5);
    });
    check(r2, 'the pick list stays inside the panel');
    await shot('pick');
    await press('Escape');
  },

  async ready() {
    const before = await stanceOf();
    const m0 = await me();
    // Ready (held here: the AI is ready already, so a real Ready starts the battle at once) locks the control
    await p.evaluate(() => { const l = window.__ob.app.local; l.s.players[0].ready = true; l.emit(); });
    await sleep(500);
    const locked = await control();
    check(locked?.disabled === 3, `Ready locks the control (${locked?.disabled} of 3 disabled)`);
    await p.evaluate(() => { const l = window.__ob.app.local; l.s.players[0].ready = false; l.emit(); });
    await sleep(500);
    check((await control())?.disabled === 0, 'un-ready frees it');
    await click('.ready-btn');
    check(await waitFor(p, () => !!document.querySelector('.battle'), null, 60000), 'the battle starts');
    await sleep(1200);
    await p.keyboard.press('End');
    check(await waitFor(p, () => window.__ob.app.room?.phase === 'results', null, 60000), 'the battle is skipped to the results');
    check(await waitFor(p, (r) => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === r, m0.round + 1, 90000), `planning round ${m0.round + 1}`);
    await sleep(1500);
    await closeModals();
    const after = await stanceOf();
    const leadAlive = before.t !== 'follow' || (await me()).squads.some((q) => q.id === before.squad);
    check(JSON.stringify(after) === JSON.stringify(before) && leadAlive, `the stance survived into the next round (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
    check(await selectLord(), 'the Lord is selected again');
    const c2 = await control();
    check(c2?.on.join() === before.t && c2.disabled === 0, `the control shows it, live again (${c2?.on})`);
    check((await marker())?.kind === before.t, 'and its marker is drawn');
    await shot('next-round');
  },
};

try {
  await p.goto(`${BASE}?dev=planning&lord=marshal&round=${ROUND}&timer=0${SCENE ? `&scene=${SCENE}` : ''}`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob?.app.scene && !!window.__ob.app.room?.view?.you, null, 90000);
  await sleep(3000);
  await closeModals();
  await clearToasts();
  await sleep(800);
  for (const [name, run] of Object.entries(CASES)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`-- ${name}`);
    await run();
  }
} catch (e) {
  check(false, 'exception: ' + (e?.stack ?? e));
} finally {
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
}
