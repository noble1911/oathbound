// PvP on the live site: A (1920x1080) hosts, B (1024x768) joins, S (1366x768) spectates.
import { launch, newPage, shot, sleep, log, waitFor, state, layoutAudit } from './lib.mjs';
import fs from 'node:fs';
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync('e2e/qa/out-pvp.txt', out.join('\n')); };
const browser = await launch();
const a = await newPage(browser, 'A', { w: 1920, h: 1080 });
await a.type('.name', '<b>Al</b>&"x');
await a.click('.create');
await waitFor(a, () => window.__ob.app.room?.phase === 'lobby');
const code = await a.evaluate(() => window.__ob.app.room.code);
say('room', code, a.url());
await sleep(600); await shot(a, 'pvp-lobby-alone-A');
// start disabled alone?
say('start disabled alone:', await a.$eval('.start', (b) => b.disabled));
// bad code join
const x = await newPage(browser, 'X', { w: 1024, h: 768, url: '?room=ZZZZ' });
await x.click('.join'); await sleep(1500);
say('join bad code error text:', await x.$eval('.err', (e) => e.textContent)); await shot(x, 'pvp-badcode-1024'); await x.close();
const b = await newPage(browser, 'B', { w: 1024, h: 768, url: `?room=${code}` });
await shot(b, 'pvp-invite-title-B-1024');
await b.type('.name', 'Brann the Long Name');
await b.click('.join');
await waitFor(a, () => !!window.__ob.app.room?.seats[1]);
const s = await newPage(browser, 'S', { w: 1366, h: 768, url: `?room=${code}` });
await s.click('.spectate');
await waitFor(a, () => window.__ob.app.room?.spectators.length === 1);
await sleep(700);
await shot(a, 'pvp-lobby-A'); await shot(b, 'pvp-lobby-B-1024'); await shot(s, 'pvp-lobby-S-1366');
say('lobby audit B', await layoutAudit(b, ['.lobby-card', '.shell .corner', '.vs-seat', '.start', '.leave']));
say('name rendered in B lobby (XSS check):', await b.evaluate(() => document.querySelector('.vs-seat.left b')?.innerHTML));
// chat
await a.keyboard.press('Enter'); await a.type('.chat-in', 'glhf <img src=x onerror=window.__xss=1>'); await a.keyboard.press('Enter');
await sleep(700);
say('B got chat:', await b.evaluate(() => [...document.querySelectorAll('.cl')].map((n) => n.textContent)), 'xss fired:', await b.evaluate(() => !!window.__xss));
await shot(b, 'pvp-chat-peek-B');
await a.click('.start');
await waitFor(a, () => window.__ob.app.room?.phase === 'lordPick');
await sleep(800);
await shot(b, 'pvp-lordpick-B-1024'); await shot(s, 'pvp-lordpick-S-1366');
say('lordpick audit B 1024', await layoutAudit(b, ['.lp-head', '.lp-cards', '.lcard', '.lp-foot', '.shell .corner', '.lp-timer']));
say('lordpick audit S 1366', await layoutAudit(s, ['.lp-head', '.lp-cards', '.lcard', '.lp-foot', '.shell .corner', '.lp-timer']));
await a.click('.lcard[data-lord="skylady"]');
await sleep(800); await shot(a, 'pvp-lordpick-A-picked');
// B lets the lord timer run out
const t0 = Date.now();
await waitFor(a, () => window.__ob.app.room?.phase === 'planning', null, 45000);
say(`B idle on lord pick: planning after ${Date.now() - t0}ms; B lord =`, await b.evaluate(() => window.__ob.app.room.view.you.lord));
await sleep(4200);
await shot(a, 'pvp-r1-plan-A'); await shot(b, 'pvp-r1-plan-B-1024'); await shot(s, 'pvp-r1-plan-S-1366');
const HUD = ['.topbar', '.res', '.sqpanel', '.stash', '.shop', '.ready-box', '.deploy-badge', '.notices', '.shell .corner', '.ucard', '.modal .loot-head', '.draft-row', '.dcard', '.loot-foot'];
say('r1 audit B 1024 (draft modal open)', await layoutAudit(b, HUD));
// timers across clients
const clocks = async () => Promise.all([a, b, s].map((p) => p.evaluate(() => document.querySelector('.tb-clock')?.textContent?.trim())));
say('clock text A/B/S:', await clocks());
// hidden info
say('A view of enemy keys:', await a.evaluate(() => Object.keys(window.__ob.app.room.view.enemy)));
say('S view keys:', await s.evaluate(() => { const v = window.__ob.app.room.view; return { you: !!v.you, enemies: v.enemies?.map((e) => Object.keys(e)) }; }));
async function quickPlan(p, n = 2) {
  await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u }); if (me.lootOffer) app.backend.intent({ t: 'pickLoot', index: 0 }); });
  await sleep(500); await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await sleep(300);
  for (let i = 0; i < n; i++) {
    const card = await p.$('.ucard:not(.off)'); if (!card) break;
    await card.click(); await sleep(150);
    const xy = await p.evaluate((i) => { const { app } = window.__ob; const seat = app.room.view.seat; const y = seat === 0 ? 3300 : 12000 - 3300; return app.scene.toScreen([2500 + i * 1500, y], 0); }, i + (await p.evaluate(() => window.__ob.app.room.view.you.squads.length)));
    await p.mouse.move(xy.x, xy.y, { steps: 4 }); await sleep(120); await p.mouse.click(xy.x, xy.y); await sleep(400);
  }
}
await quickPlan(a, 2);
await sleep(400); await shot(a, 'pvp-r1-planned-A');
await a.keyboard.press('Space'); await sleep(600);
await shot(a, 'pvp-r1-A-ready-waiting'); await shot(b, 'pvp-r1-B-sees-A-ready-1024');
// B does nothing: let planning time out (unpicked draft)
const t1 = Date.now();
const gotB = await waitFor(b, () => !!document.querySelector('.battle'), null, 90000);
say(`B idle in planning: battle after ${Date.now() - t1}ms got=${gotB}; B squads`, await b.evaluate(() => window.__ob.app.room.view.you.squads.map((q) => q.type)), 'B unlocked', await b.evaluate(() => window.__ob.app.room.view.you.unlocked));
await sleep(2500);
await shot(a, 'pvp-r1-battle-A'); await shot(b, 'pvp-r1-battle-B-1024'); await shot(s, 'pvp-r1-battle-S-1366');
say('battle audit B 1024', await layoutAudit(b, ['.topbar', '.b-ctrl', '.b-feed', '.b-tally', '.shell .corner', '.b-banner']));
say('battle audit S 1366', await layoutAudit(s, ['.topbar', '.b-ctrl', '.b-feed', '.b-tally', '.shell .corner', '.b-banner']));
// desync check: replay identity
const sig = (p) => p.evaluate(() => { const r = window.__ob.app.lastBattle?.replay; if (!r) return null; const j = JSON.stringify({ t: r.ticks, res: r.result, n: r.soldiers.length, seed: r.seed }); let h = 0; for (let i = 0; i < j.length; i++) h = (h * 31 + j.charCodeAt(i)) | 0; const f = r.frames ?? r.data ?? r.keyframes; return { h, ticks: r.ticks, winner: r.result.winner, kd: r.result.keepDamage, bytes: f?.length ?? f?.byteLength ?? null, keys: Object.keys(r) }; });
say('replay sig A', await sig(a)); say('replay sig B', await sig(b)); say('replay sig S', await sig(s));
// playback clock positions
const pbt = (p) => p.evaluate(() => document.querySelector('.tb-clock')?.textContent?.trim());
say('battle clocks A/B/S', [await pbt(a), await pbt(b), await pbt(s)]);
// A skips; B keeps watching: what does A see?
await a.click('.skip'); await sleep(1500);
await shot(a, 'pvp-r1-A-skipped-waiting');
say('A after skip: phase', await a.evaluate(() => window.__ob.app.room.phase), 'wait note:', await a.evaluate(() => document.querySelector('.wait-note, .b-wait')?.textContent ?? null));
// B reloads mid-battle
await b.reload({ waitUntil: 'load' });
await b.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
const rej = await waitFor(b, () => !!window.__ob.app.room, null, 15000);
await sleep(2500);
say('B reload mid-battle: rejoined', rej, 'phase', await b.evaluate(() => window.__ob.app.room?.phase), 'battle screen', await b.evaluate(() => !!document.querySelector('.battle')), 'clock', await pbt(b));
await shot(b, 'pvp-r1-B-after-reload-1024');
await b.evaluate(() => document.querySelector('.skip')?.click());
await waitFor(a, () => window.__ob.app.room?.phase === 'results', null, 120000);
await sleep(1500);
await shot(a, 'pvp-r1-results-A'); await shot(b, 'pvp-r1-results-B-1024'); await shot(s, 'pvp-r1-results-S-1366');
say('results audit B', await layoutAudit(b, ['.res-card', '.shell .corner']));
say('results text S:', await s.evaluate(() => document.querySelector('.res-card')?.innerText.replace(/\n+/g, ' | ')));
const keeps = (p) => p.evaluate(() => { const v = window.__ob.app.room.view; return v.you ? [v.seat, v.you.keepHp, v.enemy.keepHp] : v.enemies.map((e) => e.keepHp); });
say('keeps A', await keeps(a), 'B', await keeps(b), 'S', await keeps(s));
await waitFor(a, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 2, null, 30000);
await sleep(3500);
await shot(b, 'pvp-r2-loot-or-draft-B-1024');
say('r2 audit B 1024 (modal)', await layoutAudit(b, ['.modal .loot-head', '.modal .loot-row', '.drop', '.loot-foot', '.draft-row', '.dcard', '.take']));
await quickPlan(b, 2); await quickPlan(a, 2);
await sleep(500);
await shot(b, 'pvp-r2-plan-B-1024'); await shot(a, 'pvp-r2-plan-A'); await shot(s, 'pvp-r2-plan-S-1366');
say('r2 audit B 1024', await layoutAudit(b, HUD));
// B selects a squad at 1024 -> panel
const bsq = await b.evaluate(() => { const { app } = window.__ob; const q = app.room.view.you.squads.find((x) => x.type !== 'lord'); const xy = q && app.scene.toScreen(q.pos, 1); return xy; });
if (bsq) { await b.mouse.click(bsq.x, bsq.y - 6); await sleep(400); await shot(b, 'pvp-r2-selected-B-1024'); say('r2 selected audit B 1024', await layoutAudit(b, ['.topbar', '.res', '.sqpanel', '.stash', '.shop', '.ready-box', '.deploy-badge', '.shell .corner'])); await b.keyboard.press('Escape'); }
// disconnect B (close the page) during planning
await a.keyboard.press('Space');
await b.close();
await sleep(2500);
await shot(a, 'pvp-r2-B-disconnected-A');
say('A sees after B closed:', await a.evaluate(() => ({ status: document.querySelector('.tb-side.foe .tb-ready, .tb-side.foe')?.textContent?.trim().slice(0, 80), chat: [...document.querySelectorAll('.cl')].map((n) => n.textContent).slice(-3), seat: window.__ob.app.room.seats.map((q) => q && { c: q.connected, bot: q.botControlled, grace: q.graceEndsAt ? Math.round((q.graceEndsAt - window.__ob.app.room.serverNow) / 1000) : 0 }) })));
const t2 = Date.now();
await waitFor(a, () => !!document.querySelector('.battle'), null, 100000);
say(`with B gone, battle started after ${Date.now() - t2}ms`);
await sleep(3000); await a.click('.skip');
await waitFor(a, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 3, null, 150000);
await sleep(3000);
say('round 3 with B gone: seats', await a.evaluate(() => window.__ob.app.room.seats.map((q) => q && { c: q.connected, bot: q.botControlled })), 'chat', await a.evaluate(() => [...document.querySelectorAll('.cl')].map((n) => n.textContent).slice(-4)));
await a.keyboard.press('Escape'); await a.keyboard.press('Escape');
await shot(a, 'pvp-r3-A-vs-absent'); await shot(s, 'pvp-r3-S-1366');
// spectator leaves how? any leave button?
say('spectator buttons:', await s.evaluate(() => [...document.querySelectorAll('button')].filter((q) => q.offsetParent).map((q) => (q.textContent.trim() || q.className).slice(0, 30))));
say('LOG\n' + [...new Set(log)].filter((l) => !/X4122|X3595|X4000|^\(/.test(l)).join('\n'));
await browser.close();
