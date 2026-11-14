// The recruit picker ("Recruit a new unit type": a free choice of any eligible unit), the loot pick
// and the codex loot schedule, offline. Checks the picker fits and screenshots it.
//   BASE=http://127.0.0.1:3051/ W=1024 H=768 node e2e/ux/recruit.mjs     -> e2e/shots/recruit-<W>-*.png
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3051/';
const W = +(process.env.W || 1366), H = +(process.env.H || 768);
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}] ${what}`); if (!ok) fails++; };
async function open(url) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: W, height: H });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join('e2e/shots', `recruit-${W}-${name}.png`) });
const fits = (p) => p.evaluate(() => {
  const m = document.querySelector('.modal.draft');
  const cards = [...m.querySelectorAll('.dcard')].map((n) => n.getBoundingClientRect());
  const foot = m.querySelector('.loot-foot').getBoundingClientRect();
  const head = m.querySelector('.loot-head').getBoundingClientRect();
  return { n: cards.length, inView: cards.every((r) => r.left >= 0 && r.right <= innerWidth && r.top >= head.bottom - 2 && r.bottom <= foot.top + 2), foot: foot.bottom <= innerHeight, scroll: m.scrollHeight > m.clientHeight + 2 };
});

try {
  // round 1: the opening muster (the match route starts at the Lord pick)
  let p = await open('?dev=match&timer=0&lord=marshal');
  await waitFor(p, () => !!document.querySelector('.lcard, .modal.draft .dcard'), null, 40000);
  if (await p.$('.lcard[data-lord="marshal"]')) await p.click('.lcard[data-lord="marshal"]');
  check(await waitFor(p, () => !!document.querySelector('.modal.draft .dcard'), null, 40000), 'the recruit picker opens in round 1');
  await sleep(1200);
  let f = await fits(p);
  check(f.n >= 3 && f.inView && f.foot && !f.scroll, `round 1: ${f.n} cards, all on screen with the footer, no scrolling (${JSON.stringify(f)})`);
  check(/any/.test(await p.$eval('.modal.draft .loot-head p', (n) => n.textContent)), 'it says you may choose any');
  check((await p.$$('.modal.draft .dc-def')).length === 1 && /is recruited for you/.test(await p.$eval('.modal.draft .loot-foot', (n) => n.textContent)), 'the timed-out default is marked and named');
  await shot(p, 'round1');
  const c = await p.$('.modal.draft .dcard');
  await c.hover();
  await sleep(500);
  await shot(p, 'round1-tip');
  await p.close();

  // a later round: the widest choice
  for (const round of [4, 7]) {
    p = await open(`?dev=planning&timer=0&round=${round}`);
    await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob.app.scene, null, 40000);
    await sleep(1500);
    if (!(await p.$('.modal.draft'))) { const n = await p.$('.notice.draft-n'); if (n) { await n.click(); await sleep(600); } }
    if (await p.$('.modal.draft')) {
      await sleep(900);
      f = await fits(p);
      check(f.inView && f.foot && !f.scroll, `round ${round}: ${f.n} cards fit (${JSON.stringify(f)})`);
      await shot(p, `round${round}`);
    } else console.log(`     round ${round}: no recruit pending`);
    await p.close();
  }

  // the loot pick: same items for both, no luck wording
  p = await open('?dev=loot&timer=0');
  await sleep(2400);
  if (await p.$('.modal.draft')) { await p.click('.modal.draft .later'); await sleep(600); }
  await sleep(3000);
  const head = await p.$eval('.modal.loot .loot-head', (n) => n.textContent);
  check(/Your opponent is offered the same items/.test(head) && !/tier higher|favours|luck/i.test(head), 'the loot pick says both sides get the same items');
  // (the slot order, weapon / armor / relic, is the sim's; ?dev=loot shows a rarity showcase instead of a real offer)
  await shot(p, 'loot');
  await p.close();

  // the codex: the fixed schedule, equal terms, no misses
  p = await open('');
  await p.click('.title-menu .how-btn');
  await sleep(400);
  await p.click('.rl-tabs button[data-tab="loot"]');
  await sleep(300);
  const sched = await p.$$eval('.rl-sched > div', (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  check(sched.length >= 4 && /Rounds 1–2/.test(sched[0]) && sched.some((x) => /Legendary/.test(x)), `the loot schedule (${sched.join(' | ')})`);
  await shot(p, 'codex-loot');
  await p.click('.rl-tabs button[data-tab="gold"]');
  await sleep(300);
  const gold = await p.$eval('.rl-body', (n) => n.textContent);
  check(/Equal terms/.test(gold) && !/catch-up gold\b(?!\.)|Falling behind|tier higher/i.test(gold.replace('There is no catch-up gold.', '')), 'the codex states equal terms and no catch-up');
  await shot(p, 'codex-gold');
  await p.click('.rl-tabs button[data-tab="terrain"]');
  await sleep(300);
  check(!/miss/i.test(await p.$eval('.rl-body', (n) => n.textContent)), 'no "miss" wording in the terrain rules');
  await p.close();
} catch (e) {
  errors.push(String(e?.stack || e));
} finally {
  await browser.close();
}
if (errors.length) console.log('errors:\n' + errors.join('\n'));
console.log(fails || errors.length ? `${fails} failed` : 'all passed');
process.exit(fails || errors.length ? 1 : 0);
