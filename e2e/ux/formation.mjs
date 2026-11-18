// A squad's formation (DESIGN §3, src/ui/formation.ts) on the planning screen, offline on ?dev=planning (a local match
// against the AI, no server). It replaced turning a squad:
//   - a squad deployed from the shop stands wide; its panel carries the two-way Wide / Deep control and a line built
//     from the sim's numbers; Deep reaches the sim, re-forms the squad on the field (a column) once, tags its plate,
//     keeps its ground ring, and is undoable; idle planning with a deep squad selected draws 0 frames;
//   - the group panel sets every selected squad at once (buttons and R); nothing turns any more (no Turn button, no
//     facing, Shift+E / Q / right-drag change nothing);
//   - a squad of one soldier and the Lord show no control, and R says why;
//   - an enemy ghost stands in the formation it fought in, says so on its panel and tags a deep one;
//   - Ready, the battle, the next round: the formation survived, and it still toggles on the now-locked squad;
//   - nothing overflows at this size.
// Screenshots (png) go to SHOTS (default docs/reviews/shots-2026-11-18/stance-formation): formation-<name>-<W>.png.
//   npx vite --port 5251 &   BASE=http://127.0.0.1:5251/ W=1366 H=768 node e2e/ux/formation.mjs [cases...]
//   SCENE=standin ... runs it on the stand-in renderer. Cases (default all, in order): deploy wide other group gone
//   small intel layout locked. "wide" checks the default formation, "other" the one it toggles to (the script reads
//   which is the default from the game: src/ui/formation.ts DEFAULT_FORMATION); screenshots are named by formation.
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5251/';
const W = +(process.env.W || 1366), H = +(process.env.H || 768);
const ROUND = +(process.env.ROUND || 3);
const SCENE = process.env.SCENE || '';
const SHOTS = process.env.SHOTS || 'docs/reviews/shots-2026-11-18/stance-formation';
const only = process.argv.slice(2);
if (SHOTS !== '0') fs.mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}${SCENE ? ' ' + SCENE : ''}] ${what}`); if (!ok) fails++; return ok; };
const ctx = await browser.createBrowserContext();
const p = await ctx.newPage();
await p.setViewport({ width: W, height: H });
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (name) => SHOTS !== '0' && p.screenshot({ path: path.join(SHOTS, `formation-${name}-${W}${SCENE ? '-' + SCENE : ''}.png`) });

// ---------------------------------------------------------------- helpers
const me = () => p.evaluate(() => {
  const { app } = window.__ob;
  const v = app.room.view;
  return { round: v.round, ready: v.you.ready, squads: v.you.squads.map((s) => ({ id: s.id, type: s.type, pos: [...s.pos], formation: window.__ob.sim.formationOf(s), dr: s.deployedRound, facing: 'facing' in s, scr: app.scene.toScreen(s.pos, 0) })) };
});
const squad = async (id) => (await me()).squads.find((q) => q.id === id);
const able = (type) => p.evaluate((t) => window.__ob.sim.hasFormation(t), type);
/** The control as drawn on the panel (single or group). */
const control = () => p.evaluate(() => {
  const seg = document.querySelector('.sqpanel .seg.formation');
  if (!seg) return null;
  const b = [...seg.querySelectorAll('button[data-fm]')];
  return {
    n: b.length,
    on: b.filter((x) => x.classList.contains('on')).map((x) => x.dataset.fm),
    disabled: b.filter((x) => x.disabled).length,
    line: seg.parentElement.querySelector('.stc-line')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    tips: b.map((x) => x.dataset.tip),
  };
});
/**
 * How squad `id` stands on the field as drawn: the spread of its soldiers across the field (x) and along it (depth).
 * Engine: the soldier models placed for it; stand-in: the formation the scene was handed (its soldiers are instances).
 */
const layout = (id) => p.evaluate((id) => {
  const s = window.__ob.app.scene;
  if (s.kind !== 'engine') { const q = [...(s.army ?? []), ...(s.ghostArmy ?? [])].find((x) => x.id === id); return q ? { formation: q.formation ?? window.__ob.sim.DEFAULT_FORMATION, across: null, deep: null } : null; }
  const pts = s.view.units.slots.filter((x) => x.visible && x.header.squad === id).map((x) => [x.pos.x, x.pos.z]);
  if (!pts.length) return null;
  const span = (i) => Math.max(...pts.map((q) => q[i])) - Math.min(...pts.map((q) => q[i]));
  return { n: pts.length, across: +span(0).toFixed(2), deep: +span(1).toFixed(2) };
}, id);
const tags = () => p.evaluate(() => window.__ob.app.scene.timing?.tags ?? []);
const rings = () => p.evaluate(() => { const s = window.__ob.app.scene; return s.kind === 'engine' ? s.overlay.rings.count : null; });
const ringR = () => p.evaluate(() => { const s = window.__ob.app.scene; if (s.kind !== 'engine' || !s.overlay.rings.count) return null; const m = new (s.overlay.rings.instanceMatrix.array.constructor)(16); for (let i = 0; i < 16; i++) m[i] = s.overlay.rings.instanceMatrix.array[i]; return +Math.hypot(m[0], m[1], m[2]).toFixed(3); });
const toasts = () => p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
const clearToasts = () => p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
const press = async (k) => { await p.keyboard.press(k); await sleep(450); };
const undo = async () => { await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); await sleep(600); };
const click = async (sel) => { await p.click(sel); await sleep(550); };
const frames = async (ms) => {
  await sleep(1500);
  const a = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
  await sleep(ms);
  return (await p.evaluate(() => window.__ob.app.scene.framesDrawn)) - a;
};
async function closeModals() {
  for (let i = 0, quiet = 0; i < 12 && quiet < 3; i++) {
    if (await p.$('.modal')) { await p.keyboard.press('Escape'); quiet = 0; } else quiet++;
    await sleep(600);
  }
}
/** A screen point over squad `q` (mine or a ghost) that the scene picks as that squad (not under a panel). */
async function squadPoint(q) {
  if (!q?.scr) return null;
  for (const dy of [-4, 0, -14, 6, -24, 12]) for (const dx of [0, 10, -10, 20, -20]) {
    const x = q.scr.x + dx, y = q.scr.y + dy;
    const ok = await p.evaluate((x, y, id) => document.elementFromPoint(x, y) === window.__ob.app.scene.canvas && window.__ob.app.scene.squadAt(x, y)?.id === id, x, y, q.id);
    if (ok) return { x, y };
  }
  return null;
}
async function select(id) {
  await press('Escape');
  const at = await squadPoint(await squad(id));
  if (at) await p.mouse.click(at.x, at.y);
  else await p.evaluate((id) => window.__ob.app.screen.select(id), id);
  await sleep(600);
  return p.evaluate((id) => window.__ob.app.screen.selected === id, id);
}
/** Free ground in my zone for a `type` squad, in front, on screen and over the canvas. */
async function freeSpot(type) {
  return p.evaluate((type) => {
    const { app } = window.__ob;
    const sc = app.screen;
    // open ground left or right of the centre first, clear of the plates that crowd round the Lord
    for (const y of [2500, 2000, 3000, 1600, 3400]) for (const x of [2300, 5700, 1500, 6500, 3300, 4700, 4000]) {
      const at = sc.spot(type, [x, y], -1);
      if (!at || at[0] !== x || at[1] !== y) continue;
      const c = app.scene.toScreen(at, 0);
      if (c && document.elementFromPoint(c.x, c.y) === app.scene.canvas) return { pos: at, c };
    }
    return null;
  }, type);
}
/** Deploy a `type` squad from the shop (click the card, then the field); returns its id. */
async function deployFromShop(type) {
  const before = new Set((await me()).squads.map((q) => q.id));
  const at = await freeSpot(type);
  if (!at) return null;
  await p.click(`.ucard[data-u="${type}"]`);
  await sleep(300);
  await p.mouse.move(at.c.x, at.c.y);
  await sleep(300);
  await p.mouse.click(at.c.x, at.c.y);
  await sleep(900);
  return (await me()).squads.find((q) => !before.has(q.id) && q.type === type)?.id ?? null;
}

let sid = null; // the squad this test deploys (a formation unit)
// The default formation (absent on a Squad) and the other one: the script never assumes which is which
// (src/ui/formation.ts DEFAULT_FORMATION), so the rule may flip without touching it.
let D = 'wide', O = 'deep';
const NAME = { wide: 'Wide', deep: 'Deep' };
/** Did the soldiers re-form from layout `a` into formation `f` (deep: a column, narrower and longer; wide: a line)? */
const reformed = (a, b, f) => !!a && !!b && b.n === a.n && (f === 'deep' ? b.deep > a.deep && b.across < a.across : b.across > a.across && b.deep < a.deep);

// ---------------------------------------------------------------- cases
const CASES = {
  async deploy() {
    // room to deploy whatever the AI army left: gold and points (the rule under test is the formation, not the budget)
    await p.evaluate(() => { const l = window.__ob.app.local; const q = l.s.players[0]; q.gold = 5000; q.deployLimit = 99; l.emit(); });
    await sleep(500);
    // the biggest squad on offer (a line of six against a column of three reads at a glance; four would be a 2 x 2 block)
    const type = await p.evaluate(() => [...document.querySelectorAll('.ucard:not(.off)')]
      .map((c) => ({ u: c.dataset.u, n: parseInt(c.querySelector('.uc-size')?.textContent.replace(/\D/g, '') ?? '0', 10) }))
      .filter((x) => window.__ob.sim.hasFormation(x.u))
      .sort((a, b) => b.n - a.n)[0]?.u);
    if (!check(!!type, `a formation unit in the shop (${type})`)) return;
    sid = await deployFromShop(type);
    if (!check(sid !== null, `deployed ${type} from the shop`)) return;
    const q = await squad(sid);
    check(q.formation === D, `a deploy from the shop stands ${D}, the default`);
    check(!q.facing, 'and has no facing');
  },

  async wide() {
    if (sid === null) return;
    check(await select(sid), 'the new squad is selected');
    const c = await control();
    check(c?.n === 2, `its panel has the two-way control (${c?.n})`);
    check(c?.on.join() === D && c.disabled === 0, `${NAME[D]} is on, the control is live`);
    check((c?.line ?? '').length > 10, `the line says what it does: "${c?.line}"`);
    check((c?.tips ?? []).every((t) => /\[R\]/.test(t)) && (c?.tips ?? []).some((t) => /\d+%/.test(t)) && (c?.tips ?? []).some((t) => /the default/.test(t)), 'the tooltips name the hotkey, the numbers and the default');
    const l = await layout(sid);
    if (l?.across !== null) check(l && (D === 'wide' ? l.across > l.deep : l.deep >= l.across), `on the field it stands ${D} (${JSON.stringify(l)})`);
    check((await rings()) === null || (await rings()) === 1, 'one ground ring under it');
    await p.mouse.move(W / 2, 30);
    await sleep(400);
    await shot(D);
  },

  async other() {
    if (sid === null) return;
    const r0 = await ringR();
    const l0 = await layout(sid);
    const line0 = (await control())?.line;
    await click(`.sqpanel .seg.formation button[data-fm="${O}"]`);
    let q = await squad(sid);
    check(q.formation === O, `${NAME[O]} reaches the sim (${q.formation})`);
    const c = await control();
    check(c?.on.join() === O, `${NAME[O]} sits pressed`);
    check(!!c?.line && c.line !== line0, `the line changes: "${c?.line}"`);
    const l1 = await layout(sid);
    if (l1?.across !== null) check(reformed(l0, l1, O), `the squad re-forms ${O} (${JSON.stringify(l0)} -> ${JSON.stringify(l1)})`);
    else check(l1?.formation === O, `the stand-in draws it ${O}`);
    check((await ringR()) === r0, `its ground ring keeps its size (${r0})`);
    if ((await p.evaluate(() => window.__ob.app.scene.kind)) === 'engine') {
      const t = (await tags()).find((x) => x.id === sid);
      check(t?.form === O, `its plate tag carries the ${O} mark (${JSON.stringify(t)})`);
    }
    // the march preview counts the speed: the panel's march line is faster than wide
    const speed = () => p.evaluate(() => parseFloat(document.querySelector('.sqpanel .sp-march span')?.textContent ?? 'NaN'));
    const sOther = await speed();
    // the speed the sim gives each formation (buildStats): the march line must follow it
    const simSpeed = await p.evaluate((id) => { const q = window.__ob.app.room.view.you.squads.find((s) => s.id === id); return window.__ob.app.screen.march(q).speed; }, sid);
    await undo();
    q = await squad(sid);
    check(q.formation === D && (await control())?.on.join() === D, `Undo stands it ${D} again`);
    const sDefault = await speed();
    check(Math.abs(sOther - simSpeed) < 0.06, `the march line reads the formation's speed (${sDefault} -> ${sOther} m/s; sim ${simSpeed.toFixed(2)})`);
    await press('r');
    check((await squad(sid)).formation === O, `R on the selected squad sets it ${O}`);
    const f = await frames(2000);
    check(f === 0, `idle planning with a ${O} squad selected draws 0 frames (${f} in 2 s)`);
    await p.mouse.move(W / 2, 30);
    await sleep(400);
    await shot(O);
  },

  async group() {
    await press('Escape');
    await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control');
    await sleep(700);
    const m = await me();
    const ids = [];
    for (const q of m.squads) if (await able(q.type)) ids.push(q.id);
    check(await p.evaluate(() => window.__ob.app.screen.sel.size > 1), 'Ctrl+A selects the army');
    check(!(await p.$('.sqpanel .g-turn')), 'the group panel has no Turn button');
    const c = await control();
    if (!check(c?.n === 2, `the group panel has the Wide / Deep pair (${c?.n})`)) return;
    const mixed = new Set(m.squads.filter((q) => ids.includes(q.id)).map((q) => q.formation)).size > 1;
    check(mixed ? c.on.length === 0 && /Mixed/.test(c.line) : c.on.length === 1, `it shows the selection's state (${mixed ? 'mixed' : c.on}): "${c.line}"`);
    await click(`.sqpanel .seg.formation button[data-fm="${O}"]`);
    let m2 = await me();
    check(m2.squads.filter((q) => ids.includes(q.id)).every((q) => q.formation === O), `${NAME[O]} sets all ${ids.length} that have a formation`);
    check(m2.squads.every((q) => m.squads.find((o) => o.id === q.id).pos.join() === q.pos.join()), 'locked or not, nothing moved');
    check(!/Locked in place/.test(await toasts()), 'no lock refusal');
    await p.mouse.move(W / 2, 30);
    await sleep(400);
    await shot('group');
    await press('r');
    m2 = await me();
    check(m2.squads.filter((q) => ids.includes(q.id)).every((q) => q.formation === D), `R on an all-${O} selection sets them all ${D}`);
    await undo();
    await undo();
    m2 = await me();
    check(m2.squads.every((q) => m.squads.find((o) => o.id === q.id).formation === q.formation), 'two undos put every formation back');
    await press('Escape');
  },

  async gone() {
    // nothing turns any more: no facing, no Turn control, and the old keys and right-drag change nothing
    const m0 = await me();
    check(m0.squads.every((q) => !q.facing), 'no squad carries a facing');
    const texts = await p.evaluate(() => [...document.querySelectorAll('.planning [data-tip], .planning .sp-hint, .phint')].map((n) => `${n.dataset?.tip ?? ''} ${n.textContent}`).join(' | '));
    check(!/\bturn (the|it|a|freely)|right-drag turn|Shift\+[QE]/i.test(texts), 'no planning tooltip or hint mentions turning a squad');
    if (sid !== null) {
      await select(sid);
      await p.keyboard.down('Shift'); await p.keyboard.press('e'); await p.keyboard.press('q'); await p.keyboard.up('Shift');
      await sleep(500);
      const q = await squad(sid);
      const at = await squadPoint(q);
      if (at) {
        await p.mouse.move(at.x, at.y);
        await p.mouse.down({ button: 'right' });
        await p.mouse.move(at.x + 120, at.y + 40, { steps: 8 });
        await p.mouse.up({ button: 'right' });
        await sleep(500);
      }
      const m1 = await me();
      check(m1.squads.every((s) => { const o = m0.squads.find((x) => x.id === s.id); return o.pos.join() === s.pos.join() && o.formation === s.formation; }), 'Shift+E, Shift+Q and a right-drag on the squad change nothing');
    }
    await p.keyboard.press('F1');
    await sleep(700);
    const keys = await p.evaluate(async () => {
      const tab = document.querySelector('.rules-veil [data-tab="keys"]');
      tab?.click();
      await new Promise((r) => setTimeout(r, 300));
      return document.querySelector('.rules-veil')?.textContent ?? '';
    });
    check(/Formation of the selected squads/.test(keys) && !/turn the squad/i.test(keys), 'the keys help lists R for the formation and no squad turning');
    const field = await p.evaluate(async () => {
      const tab = document.querySelector('.rules-veil [data-tab="match"]');
      tab?.click();
      await new Promise((r) => setTimeout(r, 300));
      return document.querySelector('.rules-veil')?.textContent ?? '';
    });
    check(/Formation: wide or deep/.test(field) && /even for a squad locked in place/.test(field), 'the codex explains wide and deep, free even when locked');
    await p.keyboard.press('Escape');
    await sleep(500);
  },

  async small() {
    // a squad of one soldier (and the Lord) has no formation: no control, and R says why
    const lord = (await me()).squads.find((q) => q.type === 'lord');
    await select(lord.id);
    check(!(await p.$('.sqpanel .seg.formation')), 'the Lord has no formation control');
    let one = null;
    for (const q of (await me()).squads) if (q.type !== 'lord' && !(await able(q.type))) { one = q; break; }
    if (!one) {
      const id = await p.evaluate(async () => {
        const { app } = window.__ob;
        const l = app.local; const pl = l.s.players[0];
        // the Marshal's faction (the Kingdom): unlock a one-soldier unit and deploy it
        const cand = ['ballista', 'trebuchet', 'golem'];
        for (const u of cand) {
          if (!pl.unlocked.includes(u)) pl.unlocked.push(u);
          l.emit();
          await new Promise((r) => setTimeout(r, 300));
          for (const y of [3300, 2800, 2300, 1800]) for (const x of [1500, 6500, 4000, 2600, 5400]) {
            const at = app.screen.spot(u, [x, y], -1);
            if (!at) continue;
            const n = pl.squads.length;
            app.backend.intent({ t: 'deploy', unit: u, pos: at });
            await new Promise((r) => setTimeout(r, 400));
            if (pl.squads.length > n || app.room.view.you.squads.length > n) return app.room.view.you.squads.at(-1).id;
          }
        }
        return null;
      });
      if (id !== null) one = await squad(id);
    }
    if (!check(!!one, `a one-soldier squad to try (${one?.type})`)) return;
    await select(one.id);
    check(!(await p.$('.sqpanel .seg.formation')), `${one.type} shows no formation control`);
    await clearToasts();
    await press('r');
    check(/no formation/i.test(await toasts()) && (await squad(one.id)).formation === D, `R says why: "${await toasts()}"`);
    await press('Escape');
  },

  async intel() {
    await press('Home');
    // an enemy squad fought the last battle deep: the server hands that over in lastArmy
    const gid0 = await p.evaluate(() => (window.__ob.app.local.s.players[1].lastArmy ?? []).find((q) => q.type !== 'lord' && window.__ob.sim.hasFormation(q.type) && window.__ob.sim.formationOf(q) === window.__ob.sim.DEFAULT_FORMATION)?.id ?? null);
    const l0 = gid0 === null ? null : await layout(gid0);
    const gid = await p.evaluate((id, O) => {
      const l = window.__ob.app.local;
      const la = l.s.players[1].lastArmy ?? [];
      const g = la.find((q) => q.id === id);
      if (!g) return null;
      g.formation = O;
      l.emit();
      return g.id;
    }, gid0, O);
    if (!check(gid !== null, 'an enemy ghost with a formation')) return;
    await sleep(800);
    const g = await p.evaluate((id) => { const v = window.__ob.app.room.view; const q = v.enemy.lastArmy.find((s) => s.id === id); return { id, type: q.type, formation: window.__ob.sim.formationOf(q), scr: window.__ob.app.scene.toScreen(q.pos, 0) }; }, gid);
    check(g.formation === O && !(await p.evaluate(() => !!window.__ob.app.room.view.enemy.squads)), 'the ghost carries last battle\'s formation, and nothing of this round');
    const l = await layout(gid);
    if (l?.across !== null) check(reformed(l0, l, O), `the ghost stands ${O} (${JSON.stringify(l0)} -> ${JSON.stringify(l)})`);
    if ((await p.evaluate(() => window.__ob.app.scene.kind)) === 'engine') {
      const t = (await tags()).find((x) => x.id === gid);
      check(t?.form === O, `its tag carries the ${O} mark (${JSON.stringify(t)})`);
    }
    const at = await squadPoint(g);
    if (!check(!!at, 'the ghost is clickable')) return;
    await p.mouse.click(at.x, at.y);
    await sleep(700);
    const txt = await p.$eval('.sqpanel', (n) => n.textContent);
    check(new RegExp(`Stood ${O} last battle`).test(txt), 'the ghost inspector says how it stood last battle');
    check(!(await p.$('.sqpanel .seg.formation')), 'and has no control');
    await p.mouse.move(W / 2, 30);
    await sleep(400);
    await shot('intel');
    await press('Escape');
  },

  async layout() {
    if (sid === null) return;
    await select(sid);
    const r = await p.evaluate(() => {
      const out = [];
      const panel = document.querySelector('.sqpanel');
      const pr = panel?.getBoundingClientRect();
      if (pr && (pr.left < 0 || pr.right > innerWidth + 0.5 || pr.top < 0 || pr.bottom > innerHeight + 0.5)) out.push(`panel off screen ${JSON.stringify(pr)}`);
      for (const n of document.querySelectorAll('.sqpanel .fm *, .sqpanel .fm')) {
        if (n instanceof SVGElement) continue;
        if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'auto') out.push(`${n.className || n.tagName}: ${n.scrollWidth} > ${n.clientWidth}`);
        const b = n.getBoundingClientRect();
        if (pr && b.width && (b.right > pr.right + 0.5 || b.left < pr.left - 0.5)) out.push(`${n.className || n.tagName} leaves the panel`);
      }
      const d = document.documentElement;
      if (d.scrollWidth > innerWidth || d.scrollHeight > innerHeight) out.push(`page scrolls ${d.scrollWidth}x${d.scrollHeight}`);
      const seg = document.querySelector('.sqpanel .seg.formation')?.getBoundingClientRect();
      if (seg) for (const sel of ['.ptools', '.stash', '.bottom', '.res', '.notices']) for (const o of document.querySelectorAll(sel)) {
        const b = o.getBoundingClientRect();
        if (b.width && b.height && seg.left < b.right && seg.right > b.left && seg.top < b.bottom && seg.bottom > b.top) out.push(`control overlaps ${sel}`);
      }
      return out;
    });
    check(r.length === 0, `no overflow or overlap${r.length ? ': ' + r.join(' | ') : ''}`);
  },

  async locked() {
    if (sid === null) return;
    const q0 = await squad(sid);
    if (q0.formation !== O) { await select(sid); await click(`.sqpanel .seg.formation button[data-fm="${O}"]`); }
    const m0 = await me();
    // Ready locks the control (held here: the AI is ready already, so a real Ready starts the battle at once)
    await select(sid);
    await p.evaluate(() => { const l = window.__ob.app.local; l.s.players[0].ready = true; l.emit(); });
    await sleep(500);
    check((await control())?.disabled === 2, 'Ready locks the control');
    await p.evaluate(() => { const l = window.__ob.app.local; l.s.players[0].ready = false; l.emit(); });
    await sleep(500);
    await press('Escape');
    // the hand-over: the battle starts the soldiers where planning drew them (no jump for a deep squad)
    const drawn = await p.evaluate((id) => { const s = window.__ob.app.scene; return s.kind === 'engine' ? s.view.units.slots.filter((x) => x.visible && x.header.squad === id).map((x) => [+x.pos.x.toFixed(2), +x.pos.z.toFixed(2)]) : null; }, sid);
    await click('.ready-btn');
    check(await waitFor(p, () => !!document.querySelector('.battle'), null, 60000), 'the battle starts');
    if (drawn) {
      const start = await p.evaluate((id) => {
        const s = window.__ob.app.scene;
        void s;
        // the first replay frame of the squad's soldiers, in world metres (engine frame = sim frame for seat 0)
        const r = window.__ob.app.screen?.decoded ?? null;
        if (!r) return null;
        const out = [];
        r.replay.soldiers.forEach((o, k) => { if (o.side === 0 && o.squad === id) out.push([+(r.x[k] / 100 - 40).toFixed(2), +(60 - r.y[k] / 100).toFixed(2)]); });
        return out;
      }, sid);
      if (start) {
        const near = drawn.every(([x, z]) => start.some(([a, b]) => Math.hypot(a - x, b - z) < 0.05));
        check(near && start.length === drawn.length, `the battle's first frame puts every soldier where planning drew it (${drawn.length})`);
      } else console.log('     (no decoded replay hook on the battle screen: the hand-over is checked in tests/client.test.ts)');
    }
    await sleep(1200);
    await p.keyboard.press('End');
    check(await waitFor(p, () => window.__ob.app.room?.phase === 'results', null, 60000), 'the battle is skipped to the results');
    check(await waitFor(p, (r) => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === r, m0.round + 1, 90000), `planning round ${m0.round + 1}`);
    await sleep(1500);
    await closeModals();
    await clearToasts();
    const q1 = await squad(sid);
    if (!check(!!q1, 'the squad survived the battle')) return;
    check(q1.formation === O, `its formation survived into the next round (${q1.formation})`);
    check(q1.dr < m0.round + 1, 'and it is now locked in place');
    check(await select(sid), 'it is selected');
    check(/Locked in place/.test(await p.$eval('.sqpanel', (n) => n.textContent)), 'its panel says it is locked');
    const c = await control();
    check(c?.on.join() === O && c.disabled === 0, `the control shows ${NAME[O]}, live (${c?.on})`);
    await click(`.sqpanel .seg.formation button[data-fm="${D}"]`);
    let q2 = await squad(sid);
    check(q2.formation === D && q2.pos.join() === q1.pos.join(), `${NAME[D]} on the locked squad: accepted, in place`);
    check(!/Locked in place|refused/i.test(await toasts()), 'no lock refusal');
    await press('r');
    q2 = await squad(sid);
    check(q2.formation === O, 'R works on it too');
    await press('Home');
    await p.mouse.move(W / 2, 30);
    await sleep(400);
    await shot('locked');
  },
};

try {
  await p.goto(`${BASE}?dev=planning&lord=marshal&round=${ROUND}&timer=0${SCENE ? `&scene=${SCENE}` : ''}`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob?.app.scene && !!window.__ob.app.room?.view?.you, null, 90000);
  await sleep(3000);
  D = await p.evaluate(() => window.__ob.sim.DEFAULT_FORMATION);
  O = D === 'wide' ? 'deep' : 'wide';
  console.log(`     default formation: ${D}`);
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
