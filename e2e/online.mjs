// Online end-to-end through the real server: two browsers play PvP (create → invite link → join →
// start → lord pick → draft → deploy → ready → battle → skip → results → round 2 with the enemy's
// ghosts), a spectator watches, and a third browser plays a vs-AI match into round 2.
//   npm run server &  npx vite --port 5174 &  node e2e/online.mjs     (BASE=…, CHROME=…)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5174/';
const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = 'e2e/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `online-${name}.png`) });

async function page(tag, url = '') {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1280, height: 720 });
  p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`));
  p.on('response', (r) => r.status() >= 400 && !/favicon.ico$/.test(r.url()) && errors.push(`${tag}: ${r.status()} ${r.url()}`));
  await p.goto(BASE + url, { waitUntil: 'networkidle0' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return p;
}
async function waitFor(p, fn, arg = null, ms = 20000) {
  try {
    await p.waitForFunction(fn, { timeout: ms, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
}
const phase = (p) => p.evaluate(() => window.__ob.app.room?.phase ?? null);
/** Plan a turn through the UI's own backend: drafts, the loot pick, one deploy, then Ready. */
async function planTurn(p) {
  await p.evaluate(() => {
    const { app } = window.__ob;
    const v = app.room.view;
    const me = v.you;
    const b = app.backend;
    for (const u of me.draftOptions.slice(0, me.draftPicks)) b.intent({ t: 'draft', unit: u });
    if (me.lootOffer) b.intent({ t: 'pickLoot', index: 0 });
  });
  await sleep(600);
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await sleep(300);
  // deploy through the shop: click a card, click my half of the field
  const card = await p.$('.ucard:not(.off)');
  if (card) {
    await card.click();
    await sleep(200);
    const xy = await p.evaluate(() => {
      const { app } = window.__ob;
      const seat = app.room.view.seat;
      const y = seat === 0 ? 2600 : 12000 - 2600;
      return app.scene.toScreen([3000 + Math.floor(Math.random() * 2000), y], 0);
    });
    if (xy) {
      await p.mouse.move(xy.x, xy.y, { steps: 4 });
      await p.mouse.click(xy.x, xy.y);
    }
  }
  await sleep(500);
}

try {
  // ------------------------------------------------------------ PvP
  const a = await page('A');
  await a.type('.name', 'Aldra');
  await a.click('.create');
  check(await waitFor(a, () => window.__ob.app.room?.phase === 'lobby'), 'A created a PvP room (lobby)');
  const code = await a.evaluate(() => window.__ob.app.room.code);
  check(/^[A-Z0-9]{4}$/.test(code) && new URL(a.url()).search === `?room=${code}`, `URL carries ?room=${code}`);

  const b = await page('B', `?room=${code}`);
  check((await b.$eval('.code', (e) => e.value)) === code, 'invite link fills in the code');
  await b.type('.name', 'Brann');
  await b.click('.join');
  check(await waitFor(a, () => !!window.__ob.app.room?.seats[1]), 'A sees B take seat 1');
  const s = await page('S', `?room=${code}`);
  await s.click('.spectate');
  check(await waitFor(a, () => window.__ob.app.room?.spectators.length === 1), 'a spectator joins');
  await sleep(500);
  await shot(a, 'lobby');
  // host swaps seats and back
  await a.click('.swap');
  check(await waitFor(a, () => window.__ob.app.room?.me.seat === 1), 'host swaps sides');
  await a.click('.swap');
  check(await waitFor(a, () => window.__ob.app.room?.me.seat === 0), 'and back');
  await a.click('.start');
  check(await waitFor(a, () => window.__ob.app.room?.phase === 'lordPick'), 'lord pick');
  await waitFor(b, () => !!document.querySelector('.lcard'));
  // the faction step: three banners; B takes the Ashen Covenant (its one Lord), A stays with the Kingdom
  check((await a.$$('.fcard')).length === 3 && !!(await a.$('.fcard.on[data-faction="kingdom"]')) && (await a.$$('.lcard')).length === 4, 'three faction banners; the Kingdom shows its four Lords');
  await b.click('.fcard[data-faction="ashen"]');
  check(await waitFor(b, () => window.__ob.app.room.view.you.faction === 'ashen' && document.querySelectorAll('.lcard').length === 1), 'B picks the Ashen Covenant: the server has it, one Lord card shows');
  check(await a.evaluate(() => window.__ob.app.room.view.enemy.faction === null), 'A cannot see the rival faction before the reveal');
  await a.click('.lcard[data-lord="marshal"]');
  await b.click('.lcard[data-lord="lich"]');
  check(await waitFor(a, () => window.__ob.app.room?.phase === 'planning'), 'both picked: planning');
  check(await waitFor(a, () => window.__ob.app.room.view.enemy.lord === 'lich' && window.__ob.app.room.view.enemy.faction === 'ashen'), 'A sees the rival Lord and faction after the reveal');
  check(await b.evaluate(() => window.__ob.app.room.view.you.faction === 'ashen' && window.__ob.app.room.view.you.draftOptions.length > 0), 'B is offered recruits of its own faction');
  await sleep(3800);
  await shot(a, 'planning-A');
  await planTurn(a);
  await planTurn(b);
  const hidden = await a.evaluate(() => JSON.stringify(window.__ob.app.room.view.enemy));
  check(!/"squads"|"gold"|"stash"/.test(hidden), 'hidden info: no enemy squads / gold / stash in A\'s view');
  const nA = await a.evaluate(() => window.__ob.app.room.view.you.squads.length);
  check(nA >= 2, `A deployed through the shop (${nA} squads incl. the Lord)`);
  // a rejected intent comes back as a toast
  await a.evaluate(() => window.__ob.app.backend.intent({ t: 'deploy', unit: window.__ob.app.room.view.you.unlocked[0], pos: [4000, 9000] }));
  check(await waitFor(a, () => !!document.querySelector('.toast.bad')), 'a refused deploy shows a toast');
  // chat
  await a.keyboard.press('Enter');
  await a.type('.chat-in', 'glhf');
  await a.keyboard.press('Enter');
  check(await waitFor(b, () => [...document.querySelectorAll('.cl')].some((n) => /glhf/.test(n.textContent))), 'B receives chat');

  await a.keyboard.press('Space');
  check(await waitFor(b, () => window.__ob.app.room.view.enemy.ready), 'B sees A ready (Space)');
  await b.click('.ready-btn');
  check(await waitFor(a, () => !!document.querySelector('.battle')), 'A plays the battle');
  check(await waitFor(b, () => !!document.querySelector('.battle')), 'B plays the battle');
  check(await waitFor(s, () => !!document.querySelector('.battle')), 'the spectator plays the battle');
  await sleep(6000);
  await shot(a, 'battle-A');
  await shot(s, 'battle-spectator');
  // shared speed: A asks for 2x, B is prompted, A waits; B accepts and all three play at 2x
  check(await s.evaluate(() => document.querySelector('.b-ctrl')?.classList.contains('ro')), 'the spectator\'s speed controls are read-only');
  await a.click('.speed button[data-s="2"]');
  check(await waitFor(b, () => { const n = document.querySelector('.b-ask'); return !!n && !n.hidden && /speed up to 2×/.test(n.textContent); }), 'B is asked: the opponent wants 2×');
  check(await waitFor(a, () => { const n = document.querySelector('.b-ask.wait'); return !!n && !n.hidden && !!document.querySelector('.speed button.pending[data-s="2"]'); }), 'A waits for the opponent');
  await sleep(400);
  await shot(b, 'speed-prompt-B');
  await b.click('.b-ask button[data-accept="2"]');
  for (const [p, who] of [[a, 'A'], [b, 'B'], [s, 'the spectator']]) check(await waitFor(p, () => !!document.querySelector('.speed button.on[data-s="2"]') && document.querySelector('.b-ask').hidden), `${who} plays at 2×`);
  // skip needs both as well
  await a.click('.skip');
  check(await waitFor(b, () => /skip/.test(document.querySelector('.b-ask')?.textContent ?? '')), 'B is asked to skip');
  await b.click('.skip');
  check(await waitFor(a, () => ['results', 'over'].includes(window.__ob.app.room?.phase)), 'results after both skip');
  await sleep(1500);
  await shot(a, 'results-A');
  check(await waitFor(a, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 2, null, 25000), 'round 2 planning');
  check(await waitFor(a, () => (window.__ob.app.room.view.enemy.lastArmy?.length ?? 0) > 0), 'A sees B\'s last-round army (ghosts)');
  await sleep(2500);
  await shot(a, 'round2-A');
  for (const p of [a, b, s]) await p.close();

  // ------------------------------------------------------------ vs AI
  const c = await page('C');
  await c.type('.name', 'Cora');
  await c.click('.diff button[data-lvl="easy"]');
  await c.click('.vsai');
  check(await waitFor(c, () => window.__ob.app.room?.phase === 'lordPick'), 'vs AI: auto-started into lord pick');
  await c.click('.fcard[data-faction="caliphate"]');
  await waitFor(c, () => !!document.querySelector('.lcard[data-lord="sultana"]'));
  await c.click('.lcard[data-lord="sultana"]');
  check(await waitFor(c, () => window.__ob.app.room?.phase === 'planning'), 'vs AI: planning');
  check(await waitFor(c, () => { const v = window.__ob.app.room.view; return v.you.faction === 'caliphate' && !!v.enemy.faction && !!v.enemy.lord; }), 'vs AI: the Caliphate for me, and the AI has a faction and a Lord');
  await sleep(3800);
  await planTurn(c);
  await c.click('.ready-btn');
  check(await waitFor(c, () => !!document.querySelector('.battle')), 'vs AI: battle');
  await sleep(3000);
  await c.click('.skip');
  check(await waitFor(c, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 2, null, 30000), 'vs AI: round 2');
  await shot(c, 'vsai-round2');
  await c.close();
} finally {
  await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures || errors.length ? 1 : 0);
