// Plays the Tutorial as a brand-new player would: do exactly (and only) what the coach says.
// env: W H TAG. Logs every coach step, whether a target is ringed, and overlaps of the coach card.
import { launch, newPage, shot, sleep, fps, log, waitFor, state } from './lib.mjs';
import fs from 'node:fs';
const W = +(process.env.W || 1024), H = +(process.env.H || 768), TAG = process.env.TAG || `tut-${W}`;
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync(`e2e/qa2/out-${TAG}.txt`, out.join('\n')); };
const browser = await launch();
const p = await newPage(browser, TAG, { w: W, h: H });
const S = (n) => shot(p, `${TAG}-${n}`);
await sleep(1500);
await S('title');
say('title: tutorial button', await p.evaluate(() => { const b = document.querySelector('.btn.tutorial'); const r = b.getBoundingClientRect(); return { cls: b.className, text: b.innerText.replace(/\n/g, ' | '), rect: [r.left | 0, r.top | 0, r.right | 0, r.bottom | 0], menu: (() => { const m = document.querySelector('.title-menu').getBoundingClientRect(); return [m.left | 0, m.top | 0, m.right | 0, m.bottom | 0]; })() }; }));
say('title fps', await fps(p, 2000));
await p.click('.btn.tutorial');
await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick', null, 30000);
const coach = () => p.evaluate(() => {
  const c = document.querySelector('.coach');
  if (!c || !c.classList.contains('on')) return null;
  const r = c.getBoundingClientRect();
  const tg = [...document.querySelectorAll('.coach-target')].map((n) => { const b = n.getBoundingClientRect(); return { cls: n.className.split(' ').slice(0, 2).join('.'), r: [b.left | 0, b.top | 0, b.right | 0, b.bottom | 0], vis: b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth }; });
  const ov = (sel) => [...document.querySelectorAll(sel)].some((n) => { const b = n.getBoundingClientRect(); if (!b.width || getComputedStyle(n).display === 'none') return false; return Math.min(b.right, r.right) - Math.max(b.left, r.left) > 6 && Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > 6; });
  const covers = ['.dcard', '.drop', '.lcard', '.sqpanel', '.stash', '.ucard', '.ready-box', '.res-card', '.b-ctrl', '.b-tally', '.b-feed', '.topbar', '.res', '.notices', '.deploy-badge', '.over-card', '.modal .loot-head', '.coach-target'].filter(ov);
  return { n: c.querySelector('.coach-n').textContent, t: c.querySelector('.coach-t').textContent, x: c.querySelector('.coach-x').textContent, slot: c.dataset.slot, rect: [r.left | 0, r.top | 0, r.right | 0, r.bottom | 0], off: r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight, targets: tg.length, targetsVisible: tg.filter((x) => x.vis).length, tg: tg.slice(0, 3), covers };
});
const toScreen = (pos) => p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), pos);
const seen = [];
let stepNo = 0, lastKey = '', stuck = 0, acted = {};
const t0 = Date.now();
const SLOTS = [[4000, 3200], [2800, 3200], [5200, 3200], [1600, 3200], [6400, 3200], [4000, 2300], [2800, 2300], [5200, 2300], [1600, 2300], [6400, 2300], [800, 2300], [7200, 2300], [3400, 1500], [4600, 1500]];
let slot = 0;
async function act(c) {
  const st = await state(p);
  const t = c?.t ?? '';
  if (/Choose your Lord/.test(t)) { await sleep(700); await p.click('.lcard[data-lord="marshal"]'); return 'picked marshal'; }
  if (/Raise your companies|New recruits/.test(t)) {
    const card = await p.$('.modal.draft .dcard:not(.chosen)');
    if (card) { await card.hover(); await sleep(700); if (!acted.drafthover) { acted.drafthover = 1; await S('draft-hover'); } await p.evaluate(() => document.querySelector('.modal.draft .dcard:not(.chosen)')?.click()); await sleep(900); return 'draft pick'; }
    return 'no dcard';
  }
  if (/Recruits are waiting/.test(t)) { const n = await p.$('.draft-n'); if (n) { await n.click(); return 'clicked draft notice'; } return 'no .draft-n'; }
  if (/Spoils are waiting/.test(t)) { const n = await p.$('.loot-n'); if (n) { await n.click(); return 'clicked loot notice'; } return 'no .loot-n'; }
  if (/Spoils of War/.test(t)) {
    await sleep(2800); if (!acted.loot) { acted.loot = 1; await S('loot'); const d = await p.$('.modal.loot .drop'); if (d) { await d.hover(); await sleep(700); await S('loot-hover'); } }
    const tk = await p.$('.modal.loot .drop .take'); if (tk) { await tk.click(); return 'took loot'; } return 'no take';
  }
  if (/Equip your loot|Drop it on a squad/.test(t)) {
    const it = await p.$('.stash-grid [data-item]'); if (!it) return 'no stash item';
    const bb = await it.boundingBox();
    const sq = st.squads.find((s) => s.type !== 'lord') ?? st.squads[0];
    const xy = await toScreen(sq.pos);
    await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(500);
    if (!acted.equiptip) { acted.equiptip = 1; await S('equip-item-hover'); }
    await p.mouse.down(); await p.mouse.move(bb.x + 40, bb.y - 40, { steps: 5 }); await p.mouse.move(xy.x, xy.y, { steps: 12 }); await sleep(500);
    if (!acted.equipdrag) { acted.equipdrag = 1; await S('equip-dragging'); say('   coach while dragging:', await coach()); }
    await p.mouse.up(); await sleep(500);
    const after = (await state(p)).stash;
    return `dragged item onto ${sq.type} -> stash ${st.stash}->${after}`;
  }
  if (/Deploy a squad|deploys? left/.test(t)) {
    const cards = await p.$$('.ucard:not(.off)'); if (!cards.length) return 'no affordable card';
    const card = cards[Math.min(cards.length - 1, slot % cards.length)];
    const bb = await card.boundingBox(); const pos = SLOTS[slot++ % SLOTS.length]; const xy = await toScreen(pos);
    await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(600);
    if (!acted.cardtip) { acted.cardtip = 1; await S('ucard-hover'); }
    await p.mouse.down(); await p.mouse.move(xy.x, xy.y + 30, { steps: 10 }); await p.mouse.move(xy.x, xy.y, { steps: 3 }); await sleep(300);
    if (!acted.dragshot) { acted.dragshot = 1; await S('deploy-drag'); }
    await p.mouse.up(); await sleep(500);
    const st2 = await state(p);
    return `deploy drag to ${pos} -> squads ${st.squads.length}->${st2.squads.length} gold ${st.gold}->${st2.gold}`;
  }
  if (/Spend what is left/.test(t)) {
    const sq = st.squads.filter((s) => s.type !== 'lord').sort((a, b) => a.level - b.level)[0]; const xy = await toScreen(sq.pos);
    await p.mouse.click(xy.x, xy.y); await sleep(300);
    return 'clicked squad ' + sq.type + ' selected=' + (await p.evaluate(() => document.querySelector('.planning')?.classList.contains('has-sel')));
  }
  if (/^Level up/.test(t)) { const b = await p.$('.sqpanel .lvl:not([disabled])'); if (b) { await b.click(); await sleep(300); return 'level up'; } await p.keyboard.press('Escape'); return 'lvl disabled; deselect'; }
  if (/Know your enemy/.test(t)) {
    const g = await p.evaluate(() => { const { app } = window.__ob; const a = app.room.view.enemy.lastArmy?.[0]; return a ? app.scene.toScreen(a.pos, 0) : null; });
    if (g && !acted.ghost) { acted.ghost = 1; await p.mouse.move(g.x, g.y, { steps: 4 }); await sleep(800); await S('ghost-hover'); }
    await p.keyboard.press('Escape'); await sleep(200); await p.keyboard.press('Space'); return 'hovered ghost, pressed Ready';
  }
  if (/^Ready/.test(t)) { await p.keyboard.press('Escape'); await sleep(150); const b = await p.$('.ready-btn'); if (b) await b.click(); return 'ready'; }
  if (/The battle/.test(t)) {
    if (!acted['b' + st.round]) { acted['b' + st.round] = 1; await sleep(6000); await S(`battle-r${st.round}`); say('   battle fps', await fps(p, 3000)); if (st.round > 1) { await p.keyboard.press('End'); return 'End (skip)'; } return 'watching'; }
    return 'watching';
  }
  if (/Read the round/.test(t)) { await sleep(1500); return 'reading results'; }
  if (/You have the basics/.test(t)) { await sleep(3000); return 'wrap'; }
  if (/That is the war/.test(t)) return 'over';
  return null;
}
let quiet = 0;
while (Date.now() - t0 < 420000) {
  const c = await coach();
  const st = await state(p);
  if (!st) break;
  const key = c ? `${c.t}` : `(quiet:${st.phase})`;
  if (key !== lastKey) {
    stuck = 0; lastKey = key; stepNo++;
    if (c) {
      await sleep(450);
      const c2 = (await coach()) ?? c;
      say(`STEP ${stepNo} [${c2.n}] "${c2.t}" slot=${c2.slot} phase=${st.phase} r${st.round} :: ${c2.x}`);
      say(`   rect ${c2.rect} offscreen=${c2.off} targets=${c2.targets} visible=${c2.targetsVisible} ${JSON.stringify(c2.tg)} coachCovers=${JSON.stringify(c2.covers)}`);
      seen.push(c2.t);
      await S(`s${String(stepNo).padStart(2, '0')}-${c2.t.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`);
    } else say(`(coach quiet) phase=${st.phase} r${st.round} modal=${await p.evaluate(() => document.querySelector('.modal')?.className ?? null)} screen=${await p.evaluate(() => document.querySelector('.screen')?.className)}`);
  } else stuck++;
  if (st.phase === 'over') { await sleep(3000); await S('over'); break; }
  if (c) { quiet = 0; let r; try { r = await act(c); } catch (e) { r = 'ACT ERROR ' + e.message; } if (r && r !== 'watching' && r !== 'reading results') say(`   -> ${r}`); if (r === null) say(`   !! no scripted action for "${c.t}"`); }
  else {
    quiet++;
    // the coach said nothing: a new player would be on their own here
    if (quiet === 12) { say(`   !! coach silent for ~8s in phase ${st.phase}; state`, { gold: st.gold, deploys: st.deploys, stash: st.stash, squads: st.squads?.length }); await S(`silent-${stepNo}`); }
    if (quiet > 12 && st.phase === 'planning') { for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(300); } const b = await p.$('.ready-btn'); if (b) { await b.click(); say('   -> (uncoached) pressed Ready'); } quiet = 0; }
    if (quiet > 12 && st.phase === 'battle') { await p.keyboard.press('End'); quiet = 0; }
  }
  if (stuck === 25) { say(`   !! stuck on "${key}" for ~20 s`, { phase: st.phase, gold: st.gold, deploys: st.deploys, stash: st.stash }); await S(`stuck-${stepNo}`); if (st.phase === 'planning') { await p.keyboard.press('Escape'); await p.keyboard.press('Space'); } }
  await sleep(650);
}
say('coach steps seen in order:', seen);
say('tutorial.done flag', await p.evaluate(() => localStorage.getItem('oathbound.tutorial.done')), 'keys', await p.evaluate(() => Object.keys(localStorage)));
say('state at end of coached part', await state(p));
// after the coach leaves: is the player left in an untimed match? can they leave?
await S('after-coach');
say('untimed clock text', await p.evaluate(() => document.querySelector('.clock, .tb-clock, .timer')?.textContent ?? null), 'leave btn', await p.evaluate(() => document.querySelector('.leave-btn')?.dataset.tip ?? null));
const lb = await p.$('.leave-btn');
if (lb) { await lb.click(); await sleep(400); await S('leave-confirm'); say('leave dialog', await p.evaluate(() => document.querySelector('.dialog')?.innerText.replace(/\n+/g, ' | ') ?? null)); const y = await p.$('.dialog .yes'); if (y) await y.click(); await sleep(1200); say('back at title', await p.evaluate(() => !!document.querySelector('.title-menu')), 'tutorial btn now', await p.evaluate(() => document.querySelector('.btn.tutorial')?.innerText.replace(/\n/g, ' | '))); await S('title-after'); }
say('LOG\n' + [...new Set(log)].join('\n'));
await browser.close();
