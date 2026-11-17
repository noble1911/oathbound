// Lord pick clicks: the pick a player makes always registers, and a press meant for the screen before never picks.
// vs AI, the lobby's "Mustering the armies" line (it was the "Begin the war" button, since removed as a click
// trap) sits where the Lord cards land and the auto-start swaps the screen under
// the pointer; a press that lands on a card in the first moments used to pick that Lord at once (and with the
// AI already chosen, the match moved on: the player never chose). Each iteration, on a fresh room:
//   1. the pointer rests on "Begin the war" and presses 0..450 ms after the Lord pick appears: no Lord is picked;
//   2. a deliberate click on a Lord (or on "Lead with"), made right as the countdown ticks: that Lord is the
//      server's, the card is sealed, and the match moves on to planning.
// Server path (`node server/index.ts`, `npx vite --port 5174`), then the offline backend (?dev=match).
//   BASE=http://127.0.0.1:5174/ N=24 node e2e/ux/lordpick-clicks.mjs
import { launch, sleep } from '../qa/lib.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5174/';
const N = Number(process.env.N || 24);
const NLOCAL = Number(process.env.NLOCAL || 4);
const SIZES = [[1920, 1080], [1366, 768], [1280, 720]];
let fails = 0;
const errors = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const browser = await launch();

async function open(url, [w, h]) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
  return { p, ctx };
}
const lordPickShown = (p) => p.waitForFunction(() => !!document.querySelector('.lordpick .lcard'), { timeout: 30000, polling: 'raf' });
const state = (p) => p.evaluate(() => ({
  you: window.__ob.app.room?.view?.you?.lord ?? null,
  phase: window.__ob.app.room?.phase ?? null,
  sealed: document.querySelector('.lordpick.has-pick') ? (document.querySelector('.lcard.chosen')?.dataset.lord ?? '?') : null,
}));
/** resolve right after the countdown's number changes (the timer's own tick), or at once when there is no timer */
const nextTick = (p) => p.evaluate(() => new Promise((res) => {
  const b = document.querySelector('.lp-timer b');
  if (!b || b.parentElement.classList.contains('hidden')) return res(false);
  const was = b.textContent;
  const mo = new MutationObserver(() => { if (b.textContent !== was) { mo.disconnect(); res(true); } });
  mo.observe(b, { childList: true, characterData: true, subtree: true });
  setTimeout(() => { mo.disconnect(); res(false); }, 2500);
}));
async function press(p, x, y) { await p.mouse.move(x, y); await p.mouse.down(); await sleep(40 + Math.round(Math.random() * 60)); await p.mouse.up(); }

/** the deliberate pick, made right on a countdown tick; returns the Lord meant */
async function deliberate(p, i, tag) {
  await sleep(650);
  const ticked = await nextTick(p);
  const cards = await p.$$('.lcard');
  const k = i % cards.length;
  const lord = await cards[k].evaluate((n) => n.dataset.lord);
  const b = await cards[k].boundingBox();
  if (i % 3 === 2) {
    // hover the card (its sheet comes into view), then "Lead with" on the next tick
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await nextTick(p);
    const g = await (await p.$('.lp-go')).boundingBox();
    await press(p, g.x + g.width / 2, g.y + g.height / 2);
  } else {
    await press(p, b.x + b.width * (0.3 + 0.4 * Math.random()), b.y + b.height * (0.3 + 0.5 * Math.random()));
  }
  const ok = await p.waitForFunction((l) => window.__ob.app.room?.view?.you?.lord === l, { timeout: 5000, polling: 50 }, lord).then(() => true, () => false);
  const s = await state(p);
  check(ok && s.you === lord, `${tag}: a deliberate ${i % 3 === 2 ? '"Lead with"' : 'card'} click${ticked ? ' on a countdown tick' : ''} picks ${lord} (server has ${s.you})`);
  return lord;
}

/** one iteration, run again when the dev server reloads the page under it (an edit elsewhere in the tree) */
async function attempt(run) {
  for (let k = 0; ; k++) {
    let ctx = null;
    try {
      await run((c) => (ctx = c));
      return;
    } catch (e) {
      if (k >= 2 || !/context was destroyed|detached|Target closed|navigation/i.test(String(e?.message))) throw e;
      console.log(`  (page reloaded under the test: ${String(e.message).slice(0, 60)}; again)`);
    } finally {
      await ctx?.close().catch(() => {});
    }
  }
}

// ---- the server path: Play vs AI
for (let i = 0; i < N; i++) await attempt(async (keep) => {
  const size = SIZES[i % SIZES.length];
  const tag = `vsAI #${i + 1} ${size.join('x')}`;
  const { p, ctx } = await open('', size);
  keep(ctx);
  await p.click('.vsai');
  await p.waitForFunction(() => !!document.querySelector('.lobby .muster'), { timeout: 20000, polling: 'raf' });
  // rest the pointer where "Begin the war" used to be, off its middle (the gap between two Lord cards is under the middle)
  const s0 = await p.$eval('.lobby .muster', (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const fx = [0.2, 0.35, 0.65, 0.8][i % 4];
  const at = [s0.x + s0.w * fx, s0.y + s0.h / 2];
  await p.mouse.move(...at);
  await lordPickShown(p);
  const late = (i * 37) % 450;
  if (late) await sleep(late);
  const onCard = await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.lcard')?.dataset.lord ?? null, at);
  await press(p, ...at);
  await sleep(350);
  const s1 = await state(p);
  check(s1.you === null && s1.phase === 'lordPick' && !s1.sealed, `${tag}: a press ${late} ms after the screen shows${onCard ? ` (on ${onCard})` : ''} picks nothing (lord ${s1.you}, ${s1.phase})`);
  if (s1.phase === 'lordPick' && !s1.you) {
    const lord = await deliberate(p, i, tag);
    const moved = await p.waitForFunction(() => window.__ob.app.room?.phase === 'planning', { timeout: 8000, polling: 100 }).then(() => true, () => false);
    const s2 = await state(p);
    check(moved && s2.you === lord, `${tag}: the match moves on with ${lord} (${s2.phase}, ${s2.you})`);
  }
});

// ---- the offline backend (the same screen over src/ui/local.ts)
for (let i = 0; i < NLOCAL; i++) await attempt(async (keep) => {
  const size = SIZES[i % SIZES.length];
  const tag = `local #${i + 1} ${size.join('x')}`;
  const { p, ctx } = await open('?dev=match', size);
  keep(ctx);
  const b0 = await (async () => { await lordPickShown(p); return p.$eval('.lcard', (n) => { const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }); })();
  await press(p, ...b0);
  await sleep(300);
  const s1 = await state(p);
  check(s1.you === null && !s1.sealed, `${tag}: a press as the screen shows picks nothing (lord ${s1.you})`);
  if (!s1.you) await deliberate(p, i + 1, tag);
});

await browser.close();
if (errors.length) console.log(errors.slice(0, 20).join('\n'));
check(errors.length === 0, `no page errors (${errors.length})`);
console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
