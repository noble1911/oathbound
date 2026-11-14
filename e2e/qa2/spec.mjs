// Spectator follow-up: does a spectator reach the match-over screen and follow a rematch?
// SKIP=1: the spectator presses End every battle; SKIP=0: the spectator just watches.
import { launch, newPage, shot, sleep, fps, log, waitFor, state } from './lib.mjs';
import fs from 'node:fs';
const SKIP = process.env.SKIP !== '0'; const TAG = SKIP ? 'spec-skip' : 'spec-watch';
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync(`e2e/qa2/out-${TAG}.txt`, out.join('\n')); };
const browser = await launch();
const a = await newPage(browser, 'A', { w: 1366, h: 768 });
await a.type('.name', 'Alda'); await a.click('.create');
await waitFor(a, () => window.__ob.app.room?.phase === 'lobby');
const code = await a.evaluate(() => window.__ob.app.room.code);
const b = await newPage(browser, 'B', { w: 1024, h: 768, url: `?room=${code}` });
await b.type('.name', 'Brann'); await b.click('.join');
await waitFor(a, () => !!window.__ob.app.room?.seats[1]);
const s = await newPage(browser, 'S', { w: 1920, h: 1080, url: `?room=${code}` });
await s.type('.name', 'Sova'); await s.click('.spectate');
await waitFor(a, () => window.__ob.app.room?.spectators.length === 1);
await a.click('.start');
await waitFor(a, () => window.__ob.app.room?.phase === 'lordPick');
await sleep(800);
await a.click('.lcard[data-lord="marshal"]'); await b.click('.lcard[data-lord="archmage"]');
await waitFor(a, () => window.__ob.app.room?.phase === 'planning');
const sa = await a.evaluate(() => window.__ob.app.room.view.seat);
const fpos = (x, y) => (sa === 0 ? [x, y] : [8000 - x, 12000 - y]);
const SL = []; for (const y of [3300, 2500, 1700, 900]) for (const x of [4000, 2800, 5200, 1600, 6400, 800, 7200]) SL.push([x, y]);
let slot = 0;
const sview = () => s.evaluate(() => ({ phase: window.__ob.app.room?.phase, round: window.__ob.app.room?.view?.round, screen: document.querySelector('.screen')?.className, battleOver: !!document.querySelector('.battle.over'), word: document.querySelector('.over-word')?.innerText?.replace(/\n+/g, ' | ') ?? null, acts: [...document.querySelectorAll('.ov-acts button')].map((n) => n.textContent.trim()), banner: document.querySelector('.b-end, .battle .end-banner, .battle h2')?.textContent ?? null }));
let over = false; const lag = [];
for (let r = 1; r <= 40 && !over; r++) {
  await waitFor(a, (r) => { const ap = window.__ob.app; return ap.room?.phase === 'over' || (ap.room?.phase === 'planning' && ap.room.view.round === r && !!document.querySelector('.screen.planning')); }, r, 120000);
  if ((await state(a)).phase === 'over') break;
  await sleep(1200);
  const sv = await sview();
  lag.push(`r${r}:${sv.screen?.replace('screen ', '')}`);
  for (const p of [a, b]) { await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u }); if (me.lootOffer) app.backend.intent({ t: 'pickLoot', index: 0 }); }); }
  await sleep(700);
  for (let k = 0; k < 4; k++) { const pick = await a.evaluate(() => { const me = window.__ob.app.room.view.you; if (me.deployLimit - me.deploysUsed <= 0) return null; const cs = [...document.querySelectorAll('.ucard:not(.off)')].map((c) => ({ u: c.dataset.u, cost: +c.querySelector('.uc-cost').textContent })); cs.sort((x, y) => y.cost - x.cost); return cs[0]?.u ?? null; }); if (!pick) break; const pos = SL[slot++ % SL.length]; await a.evaluate((i) => window.__ob.app.backend.intent(i), { t: 'deploy', unit: pick, pos: fpos(pos[0], pos[1]) }); await sleep(300); }
  await a.evaluate(() => { const { app } = window.__ob; for (const q of app.room.view.you.squads) if (q.type !== 'lord') app.backend.intent({ t: 'levelUp', squad: q.id }); });
  await sleep(300);
  await a.evaluate(() => window.__ob.app.backend.intent({ t: 'ready' })); await b.evaluate(() => window.__ob.app.backend.intent({ t: 'ready' }));
  await waitFor(a, () => !!document.querySelector('.battle'), null, 90000);
  await sleep(2500);
  await a.keyboard.press('End'); await b.keyboard.press('End'); if (SKIP) await s.keyboard.press('End');
  await waitFor(a, () => ['results', 'over'].includes(window.__ob.app.room?.phase), null, 120000);
  if (r === 2) { await sleep(1500); say('r2 just after players reached results: S', await sview()); await shot(s, `${TAG}-S-r2-results-time`); }
  if ((await state(a)).phase === 'over') over = true;
}
say('spectator screen at the start of each planning round (players\' clock):', lag.join(' '));
say('match over', over);
const t0 = Date.now();
for (const t of [1, 4, 8, 15, 25, 40, 60]) { await sleep(Math.max(0, t * 1000 - (Date.now() - t0))); const v = await sview(); say(`S +${t}s after match over:`, v, 'fps', await fps(s, 1000)); if (t === 4 || t === 25 || t === 60) await shot(s, `${TAG}-S-over-${t}s`); }
say('A over fps', await fps(a, 2000));
await a.click('.rematch'); await sleep(500); await b.click('.rematch');
say('rematch lordPick A', await waitFor(a, () => window.__ob.app.room?.phase === 'lordPick', null, 15000));
const t1 = Date.now();
for (const t of [1, 4, 10, 20]) { await sleep(Math.max(0, t * 1000 - (Date.now() - t1))); say(`S +${t}s after rematch began:`, await sview(), 'lcards', await s.evaluate(() => document.querySelectorAll('.lcard').length)); if (t === 4) await shot(s, `${TAG}-S-rematch-4s`); }
say('LOG\n' + [...new Set(log)].filter((l) => !/X4122|X3595|X4000|^\(/.test(l)).join('\n'));
await browser.close();
