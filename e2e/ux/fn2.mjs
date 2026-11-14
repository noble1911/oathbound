// Skill items and the squad sheet in planning (offline dev route, served from a side build):
//   - a skill item's tooltip reads as an ability (icon, name, cooldown, effect, "Usable by"), and
//     says in red why the selected squad cannot use it;
//   - dragging it onto a squad of the wrong class is refused with the reason, nothing is sent;
//   - the squad panel shows ability tokens (innate, Lord, item) with tooltips and "base → now" stats,
//     and still fits 1366x768 and 1024x768 with "Countered by" on screen (levelled, equipped squad
//     and the Lord);
//   - the battle report at 1024x768.
// Screenshots: e2e/shots/fn2-*.png.
//   npx vite build --outDir dist-fn --emptyOutDir
//   DIST=dist-fn PORT=3058 node server/index.ts &  BASE=http://127.0.0.1:3058/ node e2e/ux/fn2.mjs
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3058/';
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
async function page(tag, w, h, url = '') {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join('e2e/shots', `fn2-${name}.png`) });
const center = (p, sel) => p.evaluate((sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
const hover = async (p, sel) => { const c = await center(p, sel); if (!c) return false; await p.mouse.move(c.x - 3, c.y - 3); await p.mouse.move(c.x, c.y, { steps: 3 }); await sleep(350); return true; };
const tipText = (p) => p.evaluate(() => { const t = document.querySelector('.tip-layer.on'); return t ? t.textContent.replace(/\s+/g, ' ').trim() : ''; });
const sceneUp = (p) => waitFor(p, () => !!window.__ob.app.scene && !!document.querySelector('.planning'), null, 60000);

/** Round 3 planning with a levelled, equipped infantry squad and skill items in the stash. */
async function setup(p) {
  await sceneUp(p);
  await sleep(3000);
  await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (let i = 0; i < me.draftPicks; i++) app.backend.intent({ t: 'draft', unit: me.draftOptions[i] }); });
  await sleep(500);
  await p.evaluate(() => { const { app } = window.__ob; if (app.room.view.you.lootOffer) app.backend.intent({ t: 'pickLoot', index: 0 }); });
  await waitFor(p, () => !document.querySelector('.modal'));
  return p.evaluate(() => {
    const { app } = window.__ob;
    const s = app.local.s;
    const me = s.players[0];
    const INF = ['militia', 'pikemen', 'berserkers', 'knights'];
    const inf = me.squads.find((q) => INF.includes(q.type));
    const mk = (base, slot, rarity, implicit, affixes, skill) => ({ id: s.nextId++, base, slot, rarity, ilvl: 3, implicit, affixes, legendary: null, ...(skill ? { skill } : {}) });
    inf.level = 3;
    inf.items.weapon = mk('steel_blade', 'weapon', 'magic', { id: 'vicious', value: 12 }, [{ id: 'keen', value: 8 }]);
    inf.items.armor = mk('mail_hauberk', 'armor', 'rare', { id: 'stalwart', value: 12 }, [], 'shield_wall');
    inf.items.relic = mk('war_banner', 'relic', 'rare', { id: 'vicious', value: 7 }, [{ id: 'stalwart', value: 8 }], 'war_cry');
    me.stash.length = 0;
    me.stash.push(mk('grimoire', 'weapon', 'rare', { id: 'vicious', value: 10 }, [{ id: 'keen', value: 9 }], 'fireball'));
    me.stash.push(mk('war_banner', 'relic', 'magic', { id: 'vicious', value: 6 }, [], 'war_cry'));
    me.stash.push(mk('steel_blade', 'weapon', 'magic', { id: 'vicious', value: 9 }, [], 'cleave'));
    const mage = me.squads.find((q) => q.type === 'mages' || q.type === 'clerics');
    if (mage) mage.items.weapon = mk('grimoire', 'weapon', 'rare', { id: 'vicious', value: 10 }, [], 'chain_lightning');
    app.local.emit();
    return { inf: inf.id, type: inf.type, lord: me.squads.find((q) => q.type === 'lord').id, fireball: me.stash[0].id, warcry: me.stash[1].id, squads: me.squads.map((q) => q.type + q.level) };
  });
}
const select = (p, id) => p.evaluate((id) => window.__ob.app.screen.select(id), id);
const panelFit = (p) => p.evaluate(() => {
  const pn = document.querySelector('.sqpanel');
  const r = pn.getBoundingClientRect();
  const c = pn.querySelector('.ctr-row.bad') ?? pn.querySelector('.ctr-d') ?? pn.querySelector('.sp-hint') ?? pn.lastElementChild;
  const cr = c.getBoundingClientRect();
  const wide = [...pn.querySelectorAll('.st')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent);
  return { name: pn.querySelector('.sp-t b').textContent, over: pn.scrollHeight - pn.clientHeight, cut: Math.round(cr.bottom - r.bottom), chips: pn.querySelectorAll('.sk-chip').length, wide, bottom: Math.round(r.bottom), bar: Math.round(document.querySelector('.bottom').getBoundingClientRect().top) };
});

try {
  {
    const p = await page('A', 1366, 768, '?dev=planning&timer=0&round=3');
    const ids = await setup(p);
    console.log('     setup', JSON.stringify(ids));

    // ---- the squad panel: levelled, equipped infantry
    await select(p, ids.inf);
    await sleep(400);
    let m = await panelFit(p);
    check(m.chips >= 2, `ability chips shown for ${m.name} (${m.chips})`);
    check(m.over <= 0 && m.cut <= 0, `panel fits at 1366x768, stats closed (${JSON.stringify(m)})`);
    await shot(p, 'panel-1366');
    await hover(p, '.sk-chip.item');
    const chipTip = await tipText(p);
    check(/Active · from/.test(chipTip) && /\d s/.test(chipTip), `item ability chip tooltip: name, source, cooldown, text ("${chipTip.slice(0, 110)}")`);
    await shot(p, 'skill-chip-tip');
    await hover(p, '.sk-chip:not(.item)');
    console.log('     innate chip tip:', (await tipText(p)).slice(0, 110));
    await p.mouse.move(400, 300);
    await p.evaluate(() => { document.querySelector('.sqpanel .st-d').open = true; });
    await sleep(300);
    m = await panelFit(p);
    const stats = await p.evaluate(() => [...document.querySelectorAll('.sqpanel .st')].map((n) => ({ t: n.textContent, chg: n.classList.contains('chg'), cls: n.querySelector('em')?.className ?? '', color: n.querySelector('em') ? getComputedStyle(n.querySelector('em')).color : '' })));
    check(stats.some((x) => x.chg && x.cls === 'up') && stats.some((x) => !x.chg), `stats show base → now where they differ (${stats.filter((x) => x.chg).map((x) => x.t).join(' | ')})`);
    check(m.wide.length === 0, `no stat row overflows its cell (${JSON.stringify(m.wide)})`);
    console.log('     stats open:', JSON.stringify({ over: m.over, cut: m.cut }));
    await shot(p, 'panel-stats-1366');
    await p.evaluate(() => { document.querySelector('.sqpanel .st-d').open = false; });

    {
      const all = await p.evaluate(() => window.__ob.app.room.view.you.squads.map((q) => q.id));
      let worst = { over: -99, cut: -99 };
      for (const id of all) {
        await select(p, id);
        await sleep(150);
        const f = await panelFit(p);
        if (Math.max(f.over, f.cut) > Math.max(worst.over, worst.cut)) worst = f;
      }
      check(worst.over <= 0 && worst.cut <= 0, `every squad's panel fits at 1366x768 without scrolling (worst: ${JSON.stringify(worst)})`);
      await shot(p, 'panel-worst-1366');
      await select(p, ids.inf);
    }
    // ---- skill item tooltips
    await hover(p, `.stash [data-item="${ids.fireball}"]`);
    let t = await tipText(p);
    const bad = await p.evaluate(() => { const u = document.querySelector('.tip-layer .it-sk-u'); return u ? { bad: u.classList.contains('bad'), color: getComputedStyle(u).color, hint: document.querySelector('.tip-layer .it-hint')?.textContent } : null; });
    check(/Grants ability\s*Fireball/.test(t) && /10 s/.test(t) && /Usable by: Casters/.test(t), `skill block in the item tooltip ("${t.slice(0, 160)}")`);
    check(!!bad && bad.bad && /cannot use this/.test(bad.hint ?? ''), `"Usable by" is red and the hint says why for the selected squad (${JSON.stringify(bad)})`);
    await shot(p, 'item-tip-refused');
    await select(p, null);
    await p.mouse.move(400, 300);
    await hover(p, `.stash [data-item="${ids.fireball}"]`);
    const ok = await p.evaluate(() => { const u = document.querySelector('.tip-layer .it-sk-u'); return u ? { bad: u.classList.contains('bad'), color: getComputedStyle(u).color } : null; });
    check(!!ok && !ok.bad, `"Usable by" is muted with no squad selected (${JSON.stringify(ok)})`);
    await shot(p, 'item-tip');
    await hover(p, `.stash [data-item="${ids.warcry}"]`);
    await shot(p, 'item-tip-warcry');

    // ---- drag: refused on the wrong class
    await select(p, ids.inf);
    await sleep(300);
    const from = await center(p, `.stash [data-item="${ids.fireball}"]`);
    const slot = await center(p, '.sqpanel .sp-slot[data-sslot="weapon"]');
    const sent = await p.evaluate(() => { const b = window.__ob.app.backend; window.__sent = []; const f = b.intent; b.intent = (i) => { window.__sent.push(i.t); return f(i); }; return true; });
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move(from.x + 12, from.y - 12, { steps: 3 });
    await p.mouse.move(slot.x, slot.y, { steps: 6 });
    await sleep(350);
    const dragging = await p.evaluate(() => ({ no: !!document.querySelector('.sp-slot.drop-no'), ok: !!document.querySelector('.sp-slot.drop-ok'), tip: document.querySelector('.tip-layer.on')?.textContent ?? '', avatar: document.querySelector('.drag-avatar')?.className }));
    check(dragging.no && !dragging.ok && /cannot use this/.test(dragging.tip), `invalid slot is greyed and says why while dragging (${JSON.stringify(dragging)})`);
    await shot(p, 'drag-refused');
    await p.mouse.up();
    await sleep(400);
    const after = await p.evaluate((id) => ({ sent: window.__sent, inStash: window.__ob.app.room.view.you.stash.some((i) => i.id === id), toast: document.querySelector('.toasts')?.textContent ?? '' }), ids.fireball);
    check(after.sent.length === 0 && after.inStash && /cannot use this/i.test(after.toast), `drop refused locally with a toast, no equip sent (${JSON.stringify(after)})`);
    await shot(p, 'drop-toast');
    // the same over the squad on the field
    const pos = await p.evaluate((id) => { const { app } = window.__ob; const q = app.room.view.you.squads.find((x) => x.id === id); return app.scene.toScreen(q.pos, 0); }, ids.inf);
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move(from.x + 12, from.y - 12, { steps: 3 });
    await p.mouse.move(pos.x, pos.y, { steps: 8 });
    await sleep(400);
    const field = await p.evaluate(() => document.querySelector('.tip-layer.on')?.textContent ?? '');
    console.log('     over the squad on the field:', field.slice(0, 90));
    await shot(p, 'drag-field-refused');
    await p.mouse.up();
    await sleep(300);
    const after2 = await p.evaluate(() => window.__sent);
    check(after2.length === 0 && (!field || /cannot use this/.test(field)), `field drop on the wrong class sends nothing (${JSON.stringify(after2)})`);
    // a valid one still goes through: War Cry (Infantry and Lords) onto the Lord
    await select(p, ids.lord);
    await sleep(300);
    const w = await center(p, `.stash [data-item="${ids.warcry}"]`);
    const relic = await center(p, '.sqpanel .sp-slot[data-sslot="relic"]');
    await p.mouse.move(w.x, w.y);
    await p.mouse.down();
    await p.mouse.move(w.x + 12, w.y - 12, { steps: 3 });
    await p.mouse.move(relic.x, relic.y, { steps: 6 });
    await sleep(300);
    const okDrag = await p.evaluate(() => ({ ok: !!document.querySelector('.sp-slot.drop-ok'), no: !!document.querySelector('.sp-slot.drop-no') }));
    await shot(p, 'drag-ok');
    await p.mouse.up();
    await sleep(500);
    const eq = await p.evaluate((id) => ({ sent: window.__sent, worn: window.__ob.app.room.view.you.squads.find((q) => q.type === 'lord').items.relic?.id === id }), ids.warcry);
    check(okDrag.ok && !okDrag.no && eq.worn && eq.sent.includes('equip'), `a usable skill item still equips (${JSON.stringify({ okDrag, eq })})`);

    // ---- the Lord's panel
    await p.mouse.move(400, 300);
    await sleep(300);
    m = await panelFit(p);
    check(m.chips >= 3 && m.over <= 0 && m.cut <= 0, `Lord panel fits at 1366x768 with its abilities (${JSON.stringify(m)})`);
    await shot(p, 'panel-lord-1366');
    await hover(p, '.sk-chip.active');
    await shot(p, 'lord-chip-tip');
    await p.close();
  }
  {
    const p = await page('B', 1024, 768, '?dev=planning&timer=0&round=3');
    const ids = await setup(p);
    await select(p, ids.inf);
    await sleep(400);
    let m = await panelFit(p);
    check(m.cut <= 0, `panel shows "Countered by" unclipped at 1024x768, levelled and equipped (${JSON.stringify(m)})`);
    await shot(p, 'panel-1024');
    await select(p, ids.lord);
    await sleep(400);
    m = await panelFit(p);
    check(m.over <= 0 && m.cut <= 0, `Lord panel fits at 1024x768 (${JSON.stringify(m)})`);
    await shot(p, 'panel-lord-1024');
    // every squad of the army
    const all = await p.evaluate(() => window.__ob.app.room.view.you.squads.map((q) => q.id));
    let worst = { over: -99, cut: -99 };
    for (const id of all) {
      await select(p, id);
      await sleep(150);
      const f = await panelFit(p);
      if (Math.max(f.over, f.cut) > Math.max(worst.over, worst.cut)) worst = f;
    }
    check(worst.cut <= 0, `every squad's panel shows "Countered by" unclipped at 1024x768 (worst: ${JSON.stringify(worst)})`);
    await p.evaluate(() => { document.querySelector('.sqpanel .st-d').open = true; });
    await sleep(300);
    m = await panelFit(p);
    check(m.wide.length === 0, `no stat row overflows at 1024 (${JSON.stringify(m.wide)})`);
    await shot(p, 'panel-stats-1024');
    await p.close();
  }
  {
    const p = await page('C', 1024, 768, '?dev=results&timer=0&round=4');
    await waitFor(p, () => !!document.querySelector('.res-table'), null, 60000);
    await sleep(700);
    const r = await p.evaluate(() => {
      const c = document.querySelector('.res-card').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.rt-row')];
      const clipped = rows.filter((n) => n.scrollWidth > n.clientWidth + 1).length;
      return { heal: document.querySelector('.res-table').classList.contains('heal'), top: Math.round(c.top), bottom: Math.round(c.bottom), h: innerHeight, rows: rows.length, clipped, head: document.querySelector('.rt-head').textContent.replace(/\s+/g, ' ') };
    });
    check(r.rows > 0 && r.clipped === 0 && r.top >= 0 && r.bottom <= r.h, `battle report fits at 1024x768 (${JSON.stringify(r)})`);
    await shot(p, 'report-1024');
    await p.close();
  }
} catch (e) {
  console.log('ERROR', e);
  fails++;
} finally {
  await browser.close();
}
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
console.log(fails || errors.length ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails || errors.length ? 1 : 0);
