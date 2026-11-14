// UX checks that need the server: a PvP room with a spectator. Lobby at 1024x768, viewer-relative
// team colours for seat 1, the spectator HUD on every screen, concede (and no rejoin after a
// reload), stop watching. Screenshots: e2e/shots/ux-pvp-*.png.
//   PORT=3047 node server/index.ts &  BASE=http://127.0.0.1:3047/ node e2e/ux/pvp.mjs
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3047/';
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
async function page(tag, w, h, url = '') {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.__tag = tag; p.__w = w; p.__h = h;
  p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join('e2e/shots', `ux-pvp-${name}.png`) });
const rect = (p, sel) => p.evaluate((sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, shown: cs.display !== 'none' && r.width > 0 }; }, sel);
const inView = (p, r) => !!r && r.x >= -1 && r.y >= -1 && r.r <= p.__w + 1 && r.b <= p.__h + 1;
// names and chat arrive raw from the server: they must render as text on every screen
const EVIL_NAME = '<img src=x>';
const EVIL_CHAT = '<img src=x onerror="window.__xss=1"><b>bold</b>';
async function noInjection(p, where) {
  const r = await p.evaluate(() => ({ img: document.querySelectorAll('#ui img, #ui [onerror]').length, xss: window.__xss ?? null, shown: document.getElementById('ui').textContent.includes('<img src=x>') }));
  check(r.img === 0 && r.xss === null, `${where} (${p.__tag}): the hostile name / chat is text, not markup${r.shown ? ' (shown literally)' : ''}`);
}
const phaseIs = (p, ph, ms = 20000) => waitFor(p, (ph) => window.__ob.app.room?.phase === ph, ph, ms);

try {
  const a = await page('A', 1366, 768);
  await a.type('.name', EVIL_NAME);
  await a.click('.create');
  check(await phaseIs(a, 'lobby'), 'A in the lobby');
  const code = await a.evaluate(() => window.__ob.app.room.code);
  const b = await page('B', 1024, 768, `?room=${code}`);
  await sleep(600);
  await shot(b, 'B-invite-title-1024');
  const menu = await rect(b, '.title-menu');
  check(inView(b, menu) && Math.abs(menu.x + menu.w / 2 - 512) < 3, 'B (1024x768): title menu centred and on screen');
  await b.type('.name', 'Brann');
  await b.click('.join');
  check(await waitFor(a, () => !!window.__ob.app.room?.seats[1]), 'B took seat 1');
  const s = await page('S', 1920, 1080, `?room=${code}`);
  await s.click('.spectate');
  check(await waitFor(a, () => window.__ob.app.room?.spectators.length === 1), 'spectator joined');
  await sleep(500);
  await a.keyboard.press('Enter');
  await a.type('.chat-in', EVIL_CHAT);
  await a.keyboard.press('Enter');
  await sleep(500);
  for (const p of [a, b, s]) await noInjection(p, 'lobby + chat');
  await shot(b, 'B-lobby-1024');
  await shot(s, 'S-lobby');
  const leave = await rect(b, '.lobby .leave');
  check(inView(b, leave) && inView(b, await rect(b, '.lobby-card')), 'B (1024x768): lobby card and Leave room on screen');
  check((await s.$eval('.lobby .leave', (n) => n.textContent.trim())) === 'Stop watching', 'spectator lobby says "Stop watching"');
  const nameShown = await b.evaluate(() => document.querySelector('.vs-seat b').textContent);
  console.log(`     host name as shown to B: ${JSON.stringify(nameShown)}`);
  await a.click('.start');
  check(await phaseIs(a, 'lordPick'), 'lord pick');
  await waitFor(b, () => !!document.querySelector('.lcard'));
  await sleep(1000);
  for (const p of [a, b, s]) await noInjection(p, 'lord pick');
  await shot(b, 'B-lordpick-1024');
  await shot(s, 'S-lordpick');
  const cards = await b.$$eval('.lcard', (ns) => ns.map((n) => { const r = n.getBoundingClientRect(); const ab = n.querySelector('.lc-block.abil p').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && ab.height > 8 && ab.bottom <= innerHeight; }));
  check(cards.length === 4 && cards.every(Boolean), 'B (1024x768): four lord cards with ability text on screen');
  await a.click('.lcard[data-lord="marshal"]');
  await b.click('.lcard[data-lord="skylady"]');
  check(await phaseIs(a, 'planning'), 'planning');
  await waitFor(s, () => !!document.querySelector('.planning'), null, 20000);
  await sleep(4200);
  for (const p of [a, b]) {
    await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u }); });
    await sleep(700);
    for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(300); }
  }
  // deploy two squads each through the UI
  for (const p of [a, b]) {
    for (const x of [2600, 5400]) {
      const card = await p.$('.ucard:not(.off)');
      if (!card) break;
      await card.click();
      await sleep(200);
      const xy = await p.evaluate((x) => { const { app } = window.__ob; const seat = app.room.view.seat; return app.scene.toScreen([x, seat === 0 ? 2800 : 12000 - 2800], 0); }, x);
      await p.mouse.move(xy.x, xy.y, { steps: 3 });
      await p.mouse.click(xy.x, xy.y);
      await sleep(500);
    }
  }
  await sleep(800);
  for (const p of [a, b, s]) await noInjection(p, 'planning HUD');
  await shot(a, 'A-plan');
  await shot(b, 'B-plan-1024');
  await shot(s, 'S-plan');
  // ---- viewer-relative colours: seat 1 sees its own army as the engine's blue side, near the bottom
  const rel = await b.evaluate(() => {
    const { app } = window.__ob;
    const me = app.room.view.you;
    const lord = me.squads[0];
    const sc = app.scene.toScreen(lord.pos, 0);
    const slots = app.scene.view.units.slots.filter((x) => x.header.squad === lord.id);
    return { seat: app.room.view.seat, n: me.squads.length, y: sc.y, h: innerHeight, side: slots[0]?.header.side, team: slots[0] ? '#' + slots[0].team.getHexString() : null };
  });
  console.log(`     B: ${JSON.stringify(rel)}`);
  check(rel.seat === 1 && rel.side === 0 && rel.y > rel.h * 0.45, 'seat 1: own army is the blue side and sits at the bottom of the screen');
  check(rel.n >= 3, `seat 1 deployed through the UI (${rel.n} squads)`);
  const pick = await b.evaluate(() => { const { app } = window.__ob; return app.room.view.you.squads.map((q) => { const c = app.scene.toScreen(q.pos, 0); return app.scene.squadAt(c.x, c.y)?.id === q.id; }); });
  check(pick.every(Boolean), 'seat 1: squads pick where they are drawn');
  // ---- spectator planning HUD
  const sp = await s.evaluate(() => {
    const vis = (sel) => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); return getComputedStyle(n).display !== 'none' && r.width > 0; };
    const sides = [...document.querySelectorAll('.tb-side')].map((n) => ({ name: n.querySelector('.tb-name b')?.textContent, lord: n.querySelector('.tb-lord')?.textContent, hp: n.querySelector('.keepbar span')?.textContent.trim() }));
    return { badge: vis('.deploy-badge'), res: vis('.res'), stash: vis('.stash'), ready: vis('.ready-btn'), stop: vis('.stop-watch'), note: vis('.spect-note'), sides };
  });
  console.log(`     S: ${JSON.stringify(sp)}`);
  check(!sp.badge && !sp.res && !sp.stash && !sp.ready && sp.stop && sp.note, 'spectator planning: no deploy badge / gold / stash / Ready; a Stop watching button');
  check(sp.sides.length === 2 && sp.sides.every((x) => x.lord && /4,\d{3}\s*\/\s*4,\d{3}/.test(x.hp)), 'spectator top bar: both Lords and both Keeps at full life');
  // ---- battle
  await a.keyboard.press('Space');
  await b.click('.ready-btn');
  check(await waitFor(a, () => !!document.querySelector('.battle')), 'battle');
  await waitFor(b, () => !!document.querySelector('.battle'));
  await waitFor(s, () => !!document.querySelector('.battle'));
  await sleep(5000);
  for (const p of [a, b, s]) await noInjection(p, 'battle HUD + kill feed');
  await shot(a, 'A-battle');
  await shot(b, 'B-battle-1024');
  await shot(s, 'S-battle');
  const bb = await b.evaluate(() => {
    const { app } = window.__ob;
    const mineIds = new Set(app.room.view.you.squads.map((q) => q.id));
    const slots = app.scene.view.units.slots.filter((x) => mineIds.has(x.header.squad));
    return { n: slots.length, blue: slots.every((x) => x.header.side === 0) };
  });
  check(bb.n > 0 && bb.blue, `seat 1 battle: own soldiers are the blue side (${bb.n})`);
  await s.keyboard.press('End'); // a spectator who keeps watching goes straight to the next planning phase
  await a.keyboard.press('End');
  await b.keyboard.press('End');
  check(await waitFor(a, () => ['results', 'over'].includes(window.__ob.app.room?.phase)), 'results');
  await waitFor(s, () => !!document.querySelector('.results'), null, 90000);
  await sleep(1200);
  for (const p of [a, b, s]) await noInjection(p, 'results');
  await shot(b, 'B-results-1024');
  await shot(s, 'S-results');
  check(inView(b, await rect(b, '.res-card')), 'B (1024x768): results card on screen');
  const st = await s.evaluate(() => ({ title: document.querySelector('.res-title')?.textContent, rows: document.querySelectorAll('.rt-row').length, gold: !!document.querySelector('.res-gold') }));
  console.log(`     S results: ${JSON.stringify(st)}`);
  check(st.rows >= 4 && !st.gold, 'spectator results: the report for both armies, no war chest');
  // ---- round 2, then B concedes
  check(await waitFor(b, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 2, null, 30000), 'round 2');
  await sleep(2500);
  for (let i = 0; i < 4 && (await b.$('.modal')); i++) { await b.keyboard.press('Escape'); await sleep(400); }
  await shot(b, 'B-plan-r2-1024');
  await shot(s, 'S-plan-r2');
  const tip = await b.$eval('.leave-btn', (n) => n.dataset.tip);
  check(tip === 'Concede', `PvP leave button says "Concede" (${tip})`);
  await b.click('.leave-btn');
  await sleep(300);
  await shot(b, 'B-concede-confirm-1024');
  await b.click('.dialog .yes');
  check(await waitFor(b, () => !!document.querySelector('.title-menu') && !window.__ob.app.room), 'conceding returns to the title');
  const saved = await b.evaluate(() => sessionStorage.getItem('oathbound.v2.seat'));
  check(saved === null && !new URL(b.url()).search, 'the saved seat and ?room are cleared');
  await b.reload({ waitUntil: 'domcontentloaded' });
  await b.waitForFunction(() => document.body.classList.contains('booted'));
  await sleep(1500);
  check(await b.evaluate(() => !window.__ob.app.room && !!document.querySelector('.title-menu')), 'a reload after conceding does not rejoin');
  check(await waitFor(a, () => { const s1 = window.__ob.app.room?.seats[1]; return !!s1 && (s1.botControlled || !s1.connected || s1.isBot); }, null, 15000), 'A sees seat 1 handed over');
  // ---- spectator stops watching
  await s.click('.stop-watch');
  await sleep(300);
  check(!!(await s.$('.dialog-veil')), 'Stop watching asks first');
  await s.click('.dialog .yes');
  check(await waitFor(s, () => !!document.querySelector('.title-menu') && !window.__ob.app.room), 'spectator back at the title');
} catch (e) {
  console.log('EXCEPTION', e);
  fails++;
} finally {
  await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails || errors.length ? 1 : 0);
