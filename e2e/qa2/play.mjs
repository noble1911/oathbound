// Plays one full vs-AI match through the real UI on the live site.
// env: LVL=easy|normal|hard LORD=marshal|archmage|warden|skylady W H TAG STRAT=mixed|spam:<unit>|idle WATCH=1,2 MAXR=30
import { launch, newPage, shot, sleep, fps, log, layoutAudit, waitFor, state } from './lib.mjs';
import fs from 'node:fs';
const LVL = process.env.LVL || 'normal', LORD = process.env.LORD || 'marshal', W = +(process.env.W || 1920), H = +(process.env.H || 1080);
const TAG = process.env.TAG || `${LVL}-${W}`, STRAT = process.env.STRAT || 'mixed', WATCH = (process.env.WATCH || '1').split(',').map(Number), MAXR = +(process.env.MAXR || 30), MAXDEP = +(process.env.MAXDEP || 9);
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync(`e2e/qa2/out-${TAG}.txt`, out.join('\n')); };
const browser = await launch();
const t0 = Date.now();
const p = await newPage(browser, TAG, { w: W, h: H });
say(`boot ${Date.now() - t0}ms`);
const S = (n) => shot(p, `${TAG}-${n}`);
const HUD = ['.topbar', '.res', '.sqpanel', '.stash', '.bottom', '.shop', '.ready-box', '.deploy-badge', '.notices', '.shell .corner', '.b-ctrl', '.b-feed', '.b-tally', '.phint', '.res-card', '.over-card', '.modal .loot-row', '.modal .loot-head', '.modal .loot-foot', '.draft-row', '.lp-cards', '.lp-head', '.ucard', '.drop'];
const audit = async (where) => {
  const a = await layoutAudit(p, HUD);
  const f = a.filter((x) => !/OVERLAP \.bottom x \.(shop|ready-box|deploy-badge|ucard)|OVERLAP \.shop x \.ucard|OVERLAP .modal \.loot-row x \.drop/.test(x));
  if (f.length) say(`AUDIT ${where}:`, [...new Set(f)].slice(0, 12));
};
await p.type('.name', 'QA ' + TAG.slice(0, 10));
await p.click(`.diff button[data-lvl="${LVL}"]`);
const tClick = Date.now();
await p.click('.vsai');
await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick', null, 30000);
say(`to lordPick ${Date.now() - tClick}ms`);
await sleep(1200); await S('lordpick'); await audit('lordpick');
say('lordpick fps', await fps(p, 2000));
if (STRAT === 'idle') say('idle: waiting for lord pick timeout');
else {
  await p.hover(`.lcard[data-lord="${LORD}"]`); await sleep(500); await S('lordpick-hover');
  await p.click(`.lcard[data-lord="${LORD}"]`);
}
const tLP = Date.now();
if (!(await waitFor(p, () => window.__ob.app.room?.phase === 'planning', null, 45000))) say('FAIL: never reached planning');
say(`lordPick->planning ${Date.now() - tLP}ms`, await state(p));
await sleep(700); await S('reveal');
const mb = () => (p.__net.bytes / 1e6).toFixed(2);
const toScreen = (pos) => p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), pos);
const seat = await p.evaluate(() => window.__ob.app.room.view.seat);
const fy = (y) => (seat === 0 ? y : 12000 - y), fx = (x) => (seat === 0 ? x : 8000 - x);
const rounds = [];
let slotIdx = 0;
const SLOTS = [];
for (const y of [3300, 2500, 1700, 900]) for (const x of [4000, 2800, 5200, 1600, 6400, 800, 7200]) SLOTS.push([x, y]);
async function closeModals() { for (let i = 0; i < 3; i++) if (await p.$('.modal')) { await p.keyboard.press('Escape'); await sleep(250); } }
async function planRound(r) {
  const st0 = await state(p);
  say(`--- round ${r} plan`, { gold: st0.gold, keep: st0.keep, ekeep: st0.ekeep, left: st0.left, unlocked: st0.unlocked, draft: st0.draft, loot: st0.loot, last: st0.lastArmy });
  const shotThis = r <= 3 || r % 4 === 0;
  if (STRAT === 'idle') { await sleep(3000); await S(`r${r}-plan-idle`); await audit(`plan r${r}`); return; }
  if (st0.draftPicks > 0) {
    const ok = await waitFor(p, () => !!document.querySelector('.modal.draft .dcard'), null, 6000);
    if (!ok) say(`r${r}: draft modal did not auto-open`);
    else {
      await sleep(500);
      if (shotThis) { await S(`r${r}-draft`); await audit(`draft r${r}`); }
      if (r === 1) { await p.hover('.modal.draft .dcard'); await sleep(600); await S(`r${r}-draft-hover`); }
      for (let k = 0; k < st0.draftPicks; k++) { const c = await p.$('.modal.draft .dcard:not(.chosen)'); if (c) { await c.click(); await sleep(700); } }
    }
  }
  if (st0.loot) {
    const ok = await waitFor(p, () => !!document.querySelector('.modal.loot .drop'), null, 8000);
    if (!ok) { say(`r${r}: loot modal did not auto-open; clicking notice`); const n = await p.$('.notice.loot-n'); if (n) await n.click(); await sleep(500); }
    await sleep(2600);
    if (shotThis || st0.loot.some((l) => /legendary/.test(l))) { await S(`r${r}-loot`); await audit(`loot r${r}`); }
    const idx = await p.evaluate(() => { const o = window.__ob.app.room.view.you.lootOffer; const rk = { common: 0, magic: 1, rare: 2, legendary: 3 }; let b = 0; o.forEach((it, i) => { if (rk[it.rarity] > rk[o[b].rarity]) b = i; }); return b; });
    const takes = await p.$$('.modal.loot .drop .take');
    if (takes[idx]) await takes[idx].click();
    await sleep(1100);
  }
  await closeModals(); await sleep(300);
  if (await p.$('.modal')) say(`r${r}: modal still open after Escape`);
  let st = await state(p);
  let guard = 0;
  while (st.deploys > 0 && guard++ < Math.min(4, MAXDEP)) {
    const have = st.squads.map((s) => s.type);
    const costs = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.ucard')].map((c) => [c.dataset.u, { cost: +c.querySelector('.uc-cost').textContent, off: c.classList.contains('off') }])));
    let cand = Object.keys(costs).filter((u) => !costs[u].off);
    if (STRAT.startsWith('spam:')) { const w = STRAT.slice(5); cand = cand.filter((u) => u === w).concat(cand.filter((u) => u !== w).sort((a, b) => costs[b].cost - costs[a].cost)); }
    else cand.sort((a, b) => (have.includes(a) - have.includes(b)) || (costs[b].cost - costs[a].cost));
    if (!cand.length) break;
    const u = cand[0];
    const pos = SLOTS[slotIdx % SLOTS.length]; slotIdx++;
    const xy = await toScreen([fx(pos[0]), fy(pos[1])]);
    if (!xy) { say('toScreen null for', pos); continue; }
    if (guard === 1 && r <= 2) {
      const card = await p.$(`.ucard[data-u="${u}"]`); const bb = await card.boundingBox();
      await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(700);
      if (r === 1) await S(`r${r}-shop-tooltip`);
      await p.mouse.down(); await p.mouse.move(xy.x, xy.y + 40, { steps: 12 }); await p.mouse.move(xy.x, xy.y, { steps: 4 }); await sleep(300);
      if (r === 1) { await p.keyboard.press('q'); await p.keyboard.press('q'); await sleep(300); await S(`r${r}-deploy-drag-rot`); await p.keyboard.press('e'); await p.keyboard.press('e'); }
      await p.mouse.up();
    } else {
      await p.click(`.ucard[data-u="${u}"]`); await sleep(150);
      await p.mouse.move(xy.x, xy.y, { steps: 5 }); await sleep(150); await p.mouse.click(xy.x, xy.y);
    }
    await sleep(500);
    const st2 = await state(p);
    if (st2.squads.length === st.squads.length) say(`r${r}: deploy of ${u} at ${pos} (screen ${xy.x | 0},${xy.y | 0}) did not register (gold ${st.gold})`);
    st = st2;
  }
  st = await state(p);
  const nonLord = st.squads.filter((s) => s.type !== 'lord');
  let lv = 0;
  for (const sq of nonLord.sort((a, b) => a.level - b.level)) {
    if (lv >= 4) break;
    const xy = await toScreen(sq.pos); if (!xy) continue;
    await p.mouse.move(xy.x, xy.y, { steps: 3 }); await sleep(250);
    if (r === 1 && lv === 0) { await sleep(500); await S(`r${r}-squad-hover`); }
    await p.mouse.click(xy.x, xy.y); await sleep(300);
    let sel = await p.evaluate(() => document.querySelector('.planning')?.classList.contains('has-sel'));
    if (!sel) {
      say(`r${r}: click on CENTRE of squad ${sq.type}#${sq.id} at screen ${xy.x | 0},${xy.y | 0} did not select; trying offsets`);
      for (const [dx, dy] of [[-12, 0], [12, 0], [0, -12], [0, 12], [-22, -10], [22, 10], [-30, 0], [30, 0]]) {
        await p.mouse.click(xy.x + dx, xy.y + dy); await sleep(250);
        sel = await p.evaluate(() => document.querySelector('.planning')?.classList.contains('has-sel'));
        if (sel) { say(`   selected with offset ${dx},${dy}`); break; }
      }
    }
    if (!sel) { say(`r${r}: click on squad ${sq.type}#${sq.id} at screen ${xy.x | 0},${xy.y | 0} did not select`); continue; }
    if ((r === 1 || r === 3) && lv === 0) {
      await S(`r${r}-selected`); await audit(`selected r${r}`);
      const d = await p.$('.ctr-d summary');
      if (d) { await d.click(); await sleep(300); await S(`r${r}-counters`); await audit(`counters r${r}`); }
    }
    const can = await p.$('.sqpanel .lvl:not([disabled])');
    if (can && r >= 2) { await can.click(); await sleep(350); lv++; if (lv===1 && r<=4) await S(`r${r}-leveled`); } else continue;
  }
  st = await state(p);
  if (st.stash > 0) {
    for (const sq of st.squads) {
      const n = await p.$('.stash-grid [data-item]'); if (!n) break;
      const xy = await toScreen(sq.pos); await p.mouse.click(xy.x, xy.y); await sleep(250);
      if (r <= 3) { await n.hover(); await sleep(500); await S(`r${r}-stash-compare`); }
      const before = (await state(p)).stash;
      const n2 = await p.$('.stash-grid [data-item]'); if (!n2) break;
      await n2.click(); await sleep(400);
      const after = (await state(p)).stash;
      if (after < before && r <= 4) await S(`r${r}-equipped`);
      if (after === 0) break;
    }
    const left = (await state(p)).stash;
    if (left) say(`r${r}: ${left} item(s) left unequipped in stash`);
  }
  if (r === 2) {
    const sq = (await state(p)).squads.find((s) => s.type !== 'lord');
    if (sq) {
      const a = await toScreen(sq.pos); const b = await toScreen([sq.pos[0] + (sq.pos[0] > 4000 ? -500 : 500), sq.pos[1] + (seat === 0 ? 300 : -300)]);
      await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 }); await sleep(200); await S(`r${r}-move-drag`); await p.mouse.move(b.x, b.y, { steps: 6 }); await p.mouse.up(); await sleep(400);
      const s2 = (await state(p)).squads.find((s) => s.id === sq.id); say(`r2 move: ${sq.pos} -> ${s2.pos}`);
      await p.keyboard.press('q'); await sleep(400);
      const f = await p.evaluate((id) => window.__ob.app.room.view.you.squads.find((s) => s.id === id).facing, sq.id); say('r2 rotate Q facing', f);
    }
    await p.keyboard.press('Escape');
    await p.keyboard.press('Tab'); await sleep(400); await S(`r${r}-tab-select`); await p.keyboard.press('Escape'); await sleep(300); // Tab cycles through your own squads; the ghosts are always on
    const g = await p.evaluate(() => { const { app } = window.__ob; const a = app.room.view.enemy.lastArmy?.[0]; return a ? app.scene.toScreen(a.pos, 0) : null; });
    if (g) { await p.mouse.move(g.x, g.y, { steps: 3 }); await sleep(600); await S(`r${r}-ghost-hover`); await p.mouse.click(g.x, g.y); await sleep(400); await S(`r${r}-ghost-selected`); }
  }
  await p.keyboard.press('Escape'); await sleep(200);
  await p.mouse.move(W / 2, H * 0.45); await sleep(300);
  if (shotThis) { await S(`r${r}-plan`); await audit(`plan r${r}`); }
  if (r === 1 || r === 3) say(`plan idle fps r${r}:`, await fps(p, 3000));
  const st3 = await state(p);
  say(`r${r} planned:`, { gold: st3.gold, squads: st3.squads.map((s) => s.type + s.level + (s.items ? '*' + s.items : '')).join(','), leftMs: st3.left });
}
let over = false;
for (let r = 1; r <= MAXR && !over; r++) {
  if (!(await waitFor(p, (r) => { const a = window.__ob.app; return a.room?.phase === 'over' || (a.room?.phase === 'planning' && a.room.view.round === r && !!document.querySelector('.screen.planning')); }, r, 200000))) { say(`FAIL: stuck before round ${r}`, await state(p)); await S(`stuck-r${r}`); break; }
  if ((await state(p)).phase === 'over') break;
  if (r === 1) { await sleep(3600); say('first planning: MB downloaded so far', mb()); } else await sleep(1200);
  if (r === 2) await S('r2-plan-entry');
  const tPlan = Date.now();
  await planRound(r);
  const planMs = Date.now() - tPlan;
  if (STRAT !== 'idle') { await p.keyboard.press('Space'); await sleep(300); if (r === 1) await S('r1-ready'); }
  const tWait = Date.now();
  const gotBattle = await waitFor(p, () => !!document.querySelector('.battle'), null, 120000);
  if (!gotBattle) { say(`FAIL r${r}: no battle screen`, await state(p)); await S(`r${r}-nobattle`); break; }
  const waited = Date.now() - tWait;
  const info = await p.evaluate(() => { const r = window.__ob.app.lastBattle?.replay; return r ? { ticks: r.ticks, sec: r.ticks / 20, soldiers: r.soldiers.length, result: r.result, keeps: r.keeps } : null; });
  say(`r${r} battle: wait ${waited}ms`, info);
  const tB = Date.now();
  if (WATCH.includes(r)) {
    await p.evaluate(() => { const b = document.querySelector('.speed button[data-s="1"]'); b && b.click(); });
    await sleep(1500); await S(`r${r}-battle-01s`); await audit(`battle r${r}`);
    await sleep(5000); await S(`r${r}-battle-07s`);
    say(`r${r} battle fps:`, await fps(p, 4000));
    await sleep(3000); await S(`r${r}-battle-14s`);
    await p.keyboard.press('c'); await sleep(300); await p.mouse.move(W / 2, H / 2); await p.mouse.wheel({ deltaY: -600 }); await sleep(900); await S(`r${r}-battle-free-zoomin`);
    await p.mouse.wheel({ deltaY: 2400 }); await sleep(900); await S(`r${r}-battle-free-zoomout`);
    await p.keyboard.press('c'); await sleep(6000); await S(`r${r}-battle-25s`);
    const done = await waitFor(p, () => !document.querySelector('.battle') || document.querySelector('.battle.over'), null, 130000);
    await S(`r${r}-battle-end`);
    say(`r${r} watched battle wall ${Date.now() - tB}ms (sim ${info?.sec}s) done=${done}`);
    await sleep(2500); await S(`r${r}-battle-aftermath`);
  } else if (STRAT === 'idle') {
    await sleep(4000); await S(`r${r}-battle-04s`);
  } else {
    await sleep(2500); if (r % 3 === 0) await S(`r${r}-battle-02s`);
    await p.evaluate(() => document.querySelector('.skip')?.click());
  }
  await waitFor(p, () => ['results', 'over'].includes(window.__ob.app.room?.phase) && !document.querySelector('.battle:not(.over)') && (document.querySelector('.results') || document.querySelector('.over')), null, 200000);
  await sleep(1200);
  const resTxt = await p.evaluate(() => (document.querySelector('.res-card') || document.querySelector('.over-card'))?.innerText?.replace(/\n+/g, ' | ') ?? null);
  const st = await state(p);
  say(`r${r} result (${Date.now() - tB}ms after battle start):`, resTxt, { keep: st.keep, ekeep: st.ekeep, phase: st.phase });
  if (r <= 3 || st.phase === 'over') { await S(`r${r}-results`); await audit(`results r${r}`); }
  rounds.push({ r, planMs, sim: info?.sec, soldiers: info?.soldiers, keep: st.keep, ekeep: st.ekeep, res: info?.result });
  if (st.phase === 'over') over = true;
}
await sleep(2500);
const fin = await state(p);
say('FINAL', fin);
await S('over'); await audit('over');
say('over text:', await p.evaluate(() => document.querySelector('.over-card')?.innerText?.replace(/\n+/g, ' | ') ?? null));
say('over fps', await fps(p, 2500));
say(`match wall ${((Date.now() - t0) / 1000) | 0}s, bytes ${mb()}MB, reqs ${p.__net.reqs}, fails ${JSON.stringify(p.__net.fails)}`);
say('rounds', rounds);
say('LOG\n' + [...new Set(log)].filter((l) => !/X4122|X3595|X4000|^\(/.test(l)).join('\n'));
await browser.close();
