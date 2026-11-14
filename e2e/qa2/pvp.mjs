// PvP with a spectator on the live site, to the end of the match, then a rematch and a concede.
// A = host 1920x1080 (plays to win), B = 1024x768 (weak army), S = spectator 1366x768.
import { launch, newPage, shot, sleep, fps, log, layoutAudit, waitFor, state } from './lib.mjs';
import fs from 'node:fs';
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync('e2e/qa2/out-pvp.txt', out.join('\n')); };
const browser = await launch();
const a = await newPage(browser, 'A', { w: 1920, h: 1080 });
await a.type('.name', 'Alda');
await a.click('.create');
await waitFor(a, () => window.__ob.app.room?.phase === 'lobby');
const code = await a.evaluate(() => window.__ob.app.room.code);
say('room', code);
const b = await newPage(browser, 'B', { w: 1024, h: 768, url: `?room=${code}` });
await sleep(500); await shot(b, 'pvp-B-title-invite');
await b.type('.name', 'Brann'); await b.click('.join');
await waitFor(a, () => !!window.__ob.app.room?.seats[1]);
const s = await newPage(browser, 'S', { w: 1366, h: 768, url: `?room=${code}` });
await s.type('.name', 'Sova'); await s.click('.spectate');
await waitFor(a, () => window.__ob.app.room?.spectators.length === 1);
await sleep(600);
await shot(a, 'pvp-A-lobby'); await shot(b, 'pvp-B-lobby'); await shot(s, 'pvp-S-lobby');
const HUD = ['.topbar', '.res', '.sqpanel', '.stash', '.shop', '.ready-box', '.deploy-badge', '.notices', '.shell .corner', '.b-ctrl', '.b-feed', '.b-tally', '.res-card', '.over-card', '.lobby-card', '.leave', '.spect-note', '.stop-watch', '.lp-head', '.lcard'];
const audit = async (p, where) => { const r = (await layoutAudit(p, HUD)).filter((x) => /OFFSCREEN|HSCROLL/.test(x) || /corner|topbar x|res x|notices x|b-feed x|b-tally x|spect-note|stop-watch/.test(x)); if (r.length) say(`AUDIT ${p.__tag} ${where}:`, [...new Set(r)].slice(0, 10)); };
for (const p of [a, b, s]) await audit(p, 'lobby');
say('lobby fps A/B/S', await fps(a, 1500), await fps(b, 1500), await fps(s, 1500));
await a.click('.start');
await waitFor(a, () => window.__ob.app.room?.phase === 'lordPick');
await waitFor(s, () => !!document.querySelector('.lcard'), null, 10000);
await sleep(1000);
await shot(b, 'pvp-B-lordpick'); await shot(s, 'pvp-S-lordpick');
for (const p of [a, b, s]) await audit(p, 'lordpick');
await a.click('.lcard[data-lord="marshal"]'); await sleep(500);
say('S lord pick foot while A has picked', await s.evaluate(() => document.querySelector('.lp-foot')?.textContent), 'S sees chosen cards', await s.evaluate(() => document.querySelectorAll('.lcard.chosen').length));
await b.click('.lcard[data-lord="warden"]');
await waitFor(a, () => window.__ob.app.room?.phase === 'planning');
await sleep(4500);
const intent = (p, i) => p.evaluate((i) => window.__ob.app.backend.intent(i), i);
const seatOf = (p) => p.evaluate(() => window.__ob.app.room.view.seat);
const sa = await seatOf(a), sb = await seatOf(b);
say('seats A/B', sa, sb);
const fpos = (seat, x, y) => (seat === 0 ? [x, y] : [8000 - x, 12000 - y]);
const SL = []; for (const y of [3300, 2500, 1700, 900]) for (const x of [4000, 2800, 5200, 1600, 6400, 800, 7200]) SL.push([x, y]);
let slotA = 0;
async function planA(r) {
  let st = await state(a);
  await a.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u }); if (me.lootOffer) { const rk = { common: 0, magic: 1, rare: 2, legendary: 3 }; let bi = 0; me.lootOffer.forEach((it, i) => { if (rk[it.rarity] > rk[me.lootOffer[bi].rarity]) bi = i; }); app.backend.intent({ t: 'pickLoot', index: bi }); } });
  await sleep(900);
  for (let i = 0; i < 4 && (await a.$('.modal')); i++) { await a.keyboard.press('Escape'); await sleep(300); }
  st = await state(a);
  for (let k = 0; k < 4 && st.deploys > 0; k++) {
    const pick = await a.evaluate(() => { const cs = [...document.querySelectorAll('.ucard:not(.off)')].map((c) => ({ u: c.dataset.u, cost: +c.querySelector('.uc-cost').textContent })); cs.sort((x, y) => y.cost - x.cost); return cs[0]?.u ?? null; });
    if (!pick) break;
    const pos = SL[slotA++ % SL.length];
    await intent(a, { t: 'deploy', unit: pick, pos: fpos(sa, pos[0], pos[1]) }); await sleep(350);
    st = await state(a);
  }
  // level and equip with what is left
  await a.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const it of me.stash) { const q = me.squads[me.squads.length - 1]; app.backend.intent({ t: 'equip', item: it.id, squad: q.id }); } for (const q of me.squads) if (q.type !== 'lord') app.backend.intent({ t: 'levelUp', squad: q.id }); });
  await sleep(500);
}
async function planB(r) {
  await b.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u }); if (me.lootOffer) app.backend.intent({ t: 'pickLoot', index: 0 }); });
  await sleep(700);
  for (let i = 0; i < 4 && (await b.$('.modal')); i++) { await b.keyboard.press('Escape'); await sleep(300); }
  if (r === 1) {
    // through the UI at 1024x768
    const card = await b.$('.ucard:not(.off)');
    if (card) { await card.click(); await sleep(200); const xy = await b.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), fpos(sb, 4000, 2800)); await b.mouse.move(xy.x, xy.y, { steps: 3 }); await b.mouse.click(xy.x, xy.y); await sleep(500); }
    say('B deployed through UI: squads', (await state(b)).squads.map((q) => q.type));
  }
}
const sig = (p) => p.evaluate(() => { const r = window.__ob.app.lastBattle?.replay; if (!r) return null; let h = 0; const f = r.frames; const u8 = f instanceof Uint8Array ? f : new Uint8Array(f.buffer ?? f); for (let i = 0; i < u8.length; i += 7) h = (h * 31 + u8[i]) | 0; return { h, ticks: r.ticks, w: r.result.winner, round: r.round }; });
let over = false; const t0 = Date.now(); const rounds = [];
for (let r = 1; r <= 40 && !over; r++) {
  const ok = await waitFor(a, (r) => { const ap = window.__ob.app; return ap.room?.phase === 'over' || (ap.room?.phase === 'planning' && ap.room.view.round === r && !!document.querySelector('.screen.planning')); }, r, 120000);
  if (!ok) { say(`FAIL stuck before r${r}`, await state(a)); await shot(a, `pvp-A-stuck-r${r}`); break; }
  if ((await state(a)).phase === 'over') break;
  await sleep(r === 1 ? 500 : 1500);
  await planA(r); await planB(r);
  if (r <= 2 || r === 5) {
    await sleep(600);
    await shot(a, `pvp-A-plan-r${r}`); await shot(b, `pvp-B-plan-r${r}`); await shot(s, `pvp-S-plan-r${r}`);
    for (const p of [a, b, s]) await audit(p, `plan r${r}`);
    say(`r${r} planning: S HUD`, await s.evaluate(() => ({ note: document.querySelector('.spect-note')?.innerText ?? null, armies: window.__ob.app.room.view.players?.map?.((pl) => pl.squads?.length) ?? null, keys: Object.keys(window.__ob.app.room.view), clock: document.querySelector('.clock b, .tb-clock b, .timer b')?.textContent ?? null })));
    say(`r${r} planning idle fps A/B/S`, await fps(a, 1500), await fps(b, 1500), await fps(s, 1500));
    say(`r${r} colours: B own-squad side`, await b.evaluate(() => { const { app } = window.__ob; const mine = new Set(app.room.view.you.squads.map((q) => q.id)); const sl = app.scene.view.units.slots.filter((x) => mine.has(x.header.squad)); return { n: sl.length, sides: [...new Set(sl.map((x) => x.header.side))] }; }));
  }
  const tR = Date.now();
  await a.keyboard.press('Space'); await sleep(400);
  if (r === 1) { await shot(a, 'pvp-A-ready-waiting'); say('A ready, B not: A note', await a.evaluate(() => document.querySelector('.ready-box')?.innerText.replace(/\n+/g, ' | ')), 'B sees', await b.evaluate(() => document.querySelector('.ready-box')?.innerText.replace(/\n+/g, ' | '))); }
  await b.click('.ready-btn').catch(() => b.keyboard.press('Space'));
  const gb = await waitFor(a, () => !!document.querySelector('.battle'), null, 90000);
  await waitFor(b, () => !!document.querySelector('.battle'), null, 10000);
  const sB = await waitFor(s, () => !!document.querySelector('.battle'), null, 10000);
  if (!gb) { say(`FAIL r${r} no battle`); break; }
  await sleep(2500);
  const sg = [await sig(a), await sig(b), await sig(s)];
  const same = sg.every((x) => x && x.h === sg[0].h && x.ticks === sg[0].ticks);
  if (!same || r <= 2) say(`r${r} replay sigs same=${same}`, sg, 'S in battle', sB);
  if (r <= 2 || r === 5) {
    await sleep(3000);
    await shot(a, `pvp-A-battle-r${r}`); await shot(b, `pvp-B-battle-r${r}`); await shot(s, `pvp-S-battle-r${r}`);
    for (const p of [a, b, s]) await audit(p, `battle r${r}`);
    say(`r${r} battle fps A/B/S`, await fps(a, 1500), await fps(b, 1500), await fps(s, 1500), 'clocks', await Promise.all([a, b, s].map((p) => p.evaluate(() => document.querySelector('.clock b, .b-clock, .tb-clock b')?.textContent ?? document.querySelector('.topbar')?.innerText.match(/\d:\d\d/)?.[0] ?? null))));
    say(`r${r} S battle controls`, await s.evaluate(() => [...document.querySelectorAll('.b-ctrl button')].map((n) => n.textContent.trim())), 'S feed sample', await s.evaluate(() => [...document.querySelectorAll('.b-feed > *')].slice(0, 3).map((n) => n.textContent.trim())));
  }
  const tSkip = Date.now();
  await a.keyboard.press('End');
  if (r === 1) { await sleep(1500); await shot(a, 'pvp-A-skip-waiting'); say('A skipped, B watching: A sees', await a.evaluate(() => (document.querySelector('.b-wait, .wait-note, .battle .note')?.textContent ?? document.querySelector('.battle')?.innerText.match(/Waiting[^\n]*/)?.[0] ?? null))); }
  await b.keyboard.press('End');
  const gr = await waitFor(a, () => ['results', 'over'].includes(window.__ob.app.room?.phase), null, 120000);
  if (r === 1) say('both skipped -> results after', Date.now() - tSkip, 'ms; S phase/screen now', await s.evaluate(() => ({ phase: window.__ob.app.room.phase, battle: !!document.querySelector('.battle:not(.over)'), results: !!document.querySelector('.results') })));
  if (r === 1) { await sleep(3000); say('3 s later S', await s.evaluate(() => ({ phase: window.__ob.app.room.phase, battle: !!document.querySelector('.battle:not(.over)'), results: !!document.querySelector('.results'), planning: !!document.querySelector('.planning') }))); await shot(s, 'pvp-S-after-players-skip'); }
  await sleep(1200);
  const st = await state(a);
  if (r <= 2 || st.phase === 'over') { await shot(a, `pvp-A-results-r${r}`); await shot(b, `pvp-B-results-r${r}`); await shot(s, `pvp-S-results-r${r}`); for (const p of [a, b, s]) await audit(p, `results r${r}`); }
  const bs = await state(b);
  rounds.push({ r, ms: Date.now() - tR, keepA: st.keep, keepB: bs.keep, goldB: bs.gold, bDeploys: bs.deploys });
  say(`r${r}`, rounds.at(-1), 'B result title', await b.evaluate(() => document.querySelector('.res-title')?.textContent ?? null), 'B catch-up', await b.evaluate(() => [...document.querySelectorAll('.rg-row.catch')].map((n) => n.innerText.replace(/\n/g, ' '))));
  if (st.phase === 'over') over = true;
}
say(`match over=${over} after ${rounds.length} rounds, ${((Date.now() - t0) / 1000) | 0}s`);
await sleep(3500);
await shot(a, 'pvp-A-over'); await shot(b, 'pvp-B-over'); await shot(s, 'pvp-S-over');
for (const p of [a, b, s]) { await audit(p, 'over'); say(`${p.__tag} over:`, await p.evaluate(() => ({ cls: document.querySelector('.screen.over')?.className, word: document.querySelector('.over-word')?.innerText.replace(/\n+/g, ' | '), acts: [...document.querySelectorAll('.ov-acts button')].map((n) => n.textContent.trim() + (n.disabled ? ' [disabled]' : '')) })), 'fps', await fps(p, 2000)); }
// rematch
await a.click('.rematch'); await sleep(900);
say('A asked rematch: A btn', await a.evaluate(() => document.querySelector('.rematch')?.textContent.trim()), '| B btn', await b.evaluate(() => document.querySelector('.rematch')?.textContent.trim()), '| S sees', await s.evaluate(() => document.querySelector('.ov-acts')?.innerText.replace(/\n+/g, ' | ')), '| chat B', await b.evaluate(() => [...document.querySelectorAll('.chat-log .cl, .chat-peek > *')].slice(-2).map((n) => n.textContent)));
await shot(b, 'pvp-B-rematch-offered');
await b.click('.rematch');
const rm = await waitFor(a, () => window.__ob.app.room?.phase === 'lordPick', null, 15000);
say('rematch started (lordPick):', rm, 'S follows:', await waitFor(s, () => window.__ob.app.room?.phase === 'lordPick' && !!document.querySelector('.lcard'), null, 8000));
await sleep(800); await shot(s, 'pvp-S-rematch-lordpick');
await a.click('.lcard[data-lord="skylady"]'); await b.click('.lcard[data-lord="archmage"]');
await waitFor(a, () => window.__ob.app.room?.phase === 'planning'); await sleep(4500);
say('rematch fresh state A', await a.evaluate(() => { const v = window.__ob.app.room.view; return { round: v.round, gold: v.you.gold, keep: v.you.keepHp, squads: v.you.squads.length, stash: v.you.stash.length, unlocked: v.you.unlocked, lastArmy: v.enemy.lastArmy }; }), 'seats swapped?', await seatOf(a), await seatOf(b));
say('rematch: report panel / old state leaks A', await a.evaluate(() => ({ reportBtn: !!document.querySelector('.report-n, .notice.report'), feed: document.querySelectorAll('.b-feed > *').length })));
await shot(a, 'pvp-A-rematch-plan');
// B reloads mid-planning: rejoin?
await b.reload({ waitUntil: 'load' }); await b.waitForFunction(() => document.body.classList.contains('booted'));
say('B reload mid-planning: rejoined', await waitFor(b, () => window.__ob.app.room?.phase === 'planning' && !!document.querySelector('.planning'), null, 15000));
await sleep(2500); for (let i = 0; i < 4 && (await b.$('.modal')); i++) { await b.keyboard.press('Escape'); await sleep(300); }
// concede
say('B leave tip', await b.$eval('.leave-btn', (n) => n.dataset.tip));
await b.click('.leave-btn'); await sleep(400); await shot(b, 'pvp-B-concede-dialog');
say('concede dialog', await b.evaluate(() => document.querySelector('.dialog')?.innerText.replace(/\n+/g, ' | ')));
await b.click('.dialog .yes');
await sleep(2500);
say('after B conceded: A', await a.evaluate(() => ({ phase: window.__ob.app.room?.phase, winner: window.__ob.app.room?.view?.winner, seat1: window.__ob.app.room?.seats[1] && { name: window.__ob.app.room.seats[1].name, bot: window.__ob.app.room.seats[1].isBot, botCtl: window.__ob.app.room.seats[1].botControlled, conn: window.__ob.app.room.seats[1].connected }, over: document.querySelector('.over-word')?.innerText ?? null, toast: [...document.querySelectorAll('.toast')].map((n) => n.textContent), chat: [...document.querySelectorAll('.chat-log .cl')].slice(-2).map((n) => n.textContent) })));
await shot(a, 'pvp-A-after-concede'); await shot(s, 'pvp-S-after-concede');
say('S after concede', await s.evaluate(() => ({ phase: window.__ob.app.room?.phase, over: document.querySelector('.over-word')?.innerText ?? null })));
say('LOG\n' + [...new Set(log)].join('\n'));
await browser.close();
