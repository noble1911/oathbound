// Lord pick at every supported size: each faction with and without the tutorial's coach, measured and shot.
// The Lords are the picture, so the checks are on the portraits: at least 40% of the card's height, at least
// 220 px tall (at 1024x768 and everywhere else), at least 180 px and three fifths of it clear of the caption
// band, and never a sliver (no wider than 1.25x its height, no taller than 1.45x its width). Nothing may clip or leave the screen; the timer, the three banners, the
// Lord's sheet and the footer stay visible; the coach sits clear of the cards and the sheet.
//   BASE=http://127.0.0.1:5191/ node e2e/ux/lordpick-shots.mjs
//   OUT=docs/reviews/shots-2026-11-17/lordpick-redesign   (jpg; default e2e/shots)
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5191/';
const SIZES = (process.env.SIZES || '1920x1080,1366x768,1280x1024,1024x768').split(',').map((s) => s.split('x').map(Number));
const OUT = process.env.OUT || 'e2e/shots';
const FACTIONS = ['kingdom', 'ashen', 'caliphate'];
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
let fails = 0;

/** the least a portrait may be tall on a screen this high (220 px at 768, a fifth of anything taller than 1100) */
const minPortrait = (H) => Math.max(220, Math.round(H * 0.2));

const measure = (p) => p.evaluate(() => {
  const box = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const one = (s) => { const n = document.querySelector(s); return n && getComputedStyle(n).display !== 'none' ? box(n) : null; };
  const out = { problems: [] };
  out.cards = [...document.querySelectorAll('.lcard')].map((c) => ({ lord: c.dataset.lord, card: box(c), port: box(c.querySelector('.lport')), art: c.querySelector('.lport').classList.contains('art'), plate: box(c.querySelector('.lc-name')) }));
  out.head = one('.lp-head h2'); out.timer = one('.lp-timer'); out.foot = one('.lp-foot'); out.detail = one('.lp-detail'); out.go = one('.lp-go'); out.coach = one('.coach.on'); out.row = one('.lp-row');
  out.banners = [...document.querySelectorAll('.fcard')].map(box);
  out.shown = document.querySelector('.ld.on')?.dataset.lord ?? null;
  out.on = [...document.querySelectorAll('.lcard.on')].map((n) => n.dataset.lord);
  // anything of the screen off the viewport, and any text box cut by its own overflow
  for (const n of document.querySelectorAll('.lordpick, .lordpick *:not(svg):not(svg *)')) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || n.closest('.ld:not(.on)')) continue;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const name = `<${n.tagName.toLowerCase()}.${String(n.className).replace(/ /g, '.')}>`;
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.problems.push(`OFF ${name} [${r.left | 0},${r.top | 0},${r.right | 0},${r.bottom | 0}]`);
    if (/auto|scroll|hidden/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2 && !n.classList.contains('lport')) out.problems.push(`VCLIP ${name} ${n.scrollHeight}>${n.clientHeight}`);
    if (/auto|scroll|hidden/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && !n.classList.contains('lport')) out.problems.push(`HCLIP ${name} ${n.scrollWidth}>${n.clientWidth}`);
    // a child that pokes out of the card or the sheet it belongs to
    const host = n.closest('.lcard, .lp-detail');
    if (host && host !== n && !n.classList.contains('lc-seal')) { const h = host.getBoundingClientRect(); if (r.left < h.left - 1 || r.right > h.right + 1 || r.top < h.top - 1 || r.bottom > h.bottom + 1) out.problems.push(`OUT ${name} of ${host.className}`); }
  }
  // every hidden sheet must fit too (they share the visible one's cell)
  for (const n of document.querySelectorAll('.ld')) { const r = n.getBoundingClientRect(), h = n.closest('.lp-detail').getBoundingClientRect(); for (const k of n.querySelectorAll('p, .uchip, .lc-stats, b')) { const q = k.getBoundingClientRect(); if (q.bottom > h.bottom + 1 || q.right > h.right + 1 || q.right > r.right + 1) out.problems.push(`SHEET ${n.dataset.lord} <${k.tagName.toLowerCase()}> out of the sheet`); } }
  if (document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1) out.problems.push('PAGE SCROLL');
  return out;
});
const hit = (a, b) => !!a && !!b && Math.min(a.r, b.r) - Math.max(a.x, b.x) > 2 && Math.min(a.b, b.b) - Math.max(a.y, b.y) > 2;

for (const [W, H] of SIZES) {
  const browser = await launch();
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}x${H}] ${what}`); if (!ok) fails++; };
  const open = async (url) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: W, height: H });
    page.on('pageerror', (e) => errors.push(`[${W}] pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`[${W}] console: ${m.text()}`));
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
    return page;
  };
  const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${W}x${H}-${name}.jpg`), type: 'jpeg', quality: 88 });
  /** the layout checks every state shares */
  const layout = (m, tag, { coach, timer }) => {
    const floor = minPortrait(H);
    const ports = m.cards.map((c) => `${c.port.w}x${c.port.h}/${c.card.h}`);
    check(m.cards.length === 4 && m.cards.every((c) => c.art), `${tag}: four Lords, each with its portrait art`);
    check(m.cards.every((c) => c.port.h >= 0.4 * c.card.h), `${tag}: portrait at least 40% of its card (${ports.join(' ')})`);
    check(m.cards.every((c) => c.port.h >= floor), `${tag}: portrait at least ${floor}px tall (${m.cards.map((c) => c.port.h).join(' ')})`);
    check(m.cards.every((c) => c.port.w <= c.port.h * 1.25 && c.port.h <= c.port.w * 1.45), `${tag}: portrait is no sliver (at most 1.25x as wide as tall, 1.45x as tall as wide)`);
    // the caption band is inked over the foot of the portrait: the portrait clear of it (face and shoulders) is at least
    // 180 px and three fifths of the portrait
    const clear = m.cards.map((c) => Math.min(c.port.b, c.plate.y) - c.port.y);
    check(m.cards.every((c) => c.plate.h > 30 && c.plate.b <= c.card.b + 1 && c.plate.x >= c.card.x - 1 && c.plate.r <= c.card.r + 1), `${tag}: name plate inside the card`);
    check(m.cards.every((c, i) => clear[i] >= 180 && clear[i] >= 0.6 * c.port.h), `${tag}: portrait clear of the name plate (${clear.join(' ')} of ${m.cards.map((c) => c.port.h).join(' ')})`);
    check(m.cards.every((c) => c.card.b <= m.detail.y + 8 && c.card.y >= m.banners[0].b), `${tag}: cards between the banners and the sheet (${m.cards[0].card.y}..${m.cards[0].card.b}, sheet at ${m.detail.y})`);
    check(m.problems.length === 0, `${tag}: nothing clipped or off screen ${JSON.stringify(m.problems.slice(0, 6))}`);
    check(m.banners.length === 3 && m.banners.every((b) => b.h > 30 && b.y >= 0 && b.b <= H), `${tag}: three faction banners visible`);
    check(!!m.detail && m.detail.h > 40 && m.detail.b <= H && m.detail.y >= m.row.b - 6, `${tag}: the Lord's sheet under the row, on screen`);
    check(!!m.shown && m.on.join() === m.shown, `${tag}: one Lord in view, card and sheet agree (${m.shown})`);
    if (timer) check(!!m.timer && m.timer.w > 10 && m.timer.y >= 0 && !m.cards.some((c) => hit(m.timer, c.card)), `${tag}: timer visible`);
    if (coach) check(!!m.coach && m.coach.b <= H && !m.cards.some((c) => hit(m.coach, c.card)) && !hit(m.coach, m.detail) && !hit(m.coach, m.head), `${tag}: coach on screen, clear of the cards, the sheet and the heading`);
    else check(!!m.foot && m.foot.h > 8 && m.foot.b <= H && !hit(m.foot, m.detail), `${tag}: footer line visible`);
  };
  try {
    // ---- a match (timed): each faction
    let p = await open('?dev=match');
    check(await waitFor(p, () => !!document.querySelector('.lordpick .lcard'), null, 30000), 'dev=match reaches the pick');
    await sleep(1500);
    for (const f of FACTIONS) {
      await p.click(`.fcard[data-faction="${f}"]`);
      await p.mouse.move(2, H - 2);
      await sleep(900);
      await shot(p, `pick-${f}`);
      layout(await measure(p), `pick ${f}`, { coach: false, timer: true });
    }
    // hover brings a Lord into view without picking; the sheet does not change size
    const before = await measure(p);
    const seen = [];
    for (const c of before.cards) {
      await p.hover(`.lcard[data-lord="${c.lord}"]`);
      await sleep(150);
      const m = await measure(p);
      seen.push(m.shown === c.lord && Math.abs(m.detail.h - before.detail.h) <= 1 && Math.abs(m.cards[0].port.h - before.cards[0].port.h) <= 1 && m.problems.length === 0);
    }
    check(seen.every(Boolean) && !(await p.$('.lordpick.has-pick')), `hover shows each Lord's sheet, same size, nothing picked ${JSON.stringify(seen)}`);
    await shot(p, 'pick-caliphate-hover-last');
    // keyboard: focus shows, arrows move, Enter picks
    await p.mouse.move(2, H - 2);
    await p.focus('.lcard:nth-child(1)');
    await p.keyboard.press('ArrowRight');
    await sleep(150);
    let m = await measure(p);
    check(m.shown === m.cards[1].lord, `keyboard: arrow key moves to the second Lord and shows the sheet (${m.shown})`);
    await p.keyboard.press('Enter');
    // (offline the rival picks at once and the screen moves on, so the check is the match's own record)
    check(await waitFor(p, (l) => window.__ob.app.room?.view?.you?.lord === l, m.cards[1].lord, 15000) && !(await p.$('.chat.on input:focus')), `keyboard: Enter picks the focused Lord (${m.cards[1].lord}) and does not open chat`);
    await p.browserContext().close();

    // ---- touch: a tap shows, the sheet's button picks
    p = await open('?dev=match&timer=0');
    await waitFor(p, () => !!document.querySelector('.lordpick .lcard'), null, 30000);
    await sleep(1200);
    const third = await p.$eval('.lcard:nth-child(3)', (n) => { const r = n.getBoundingClientRect(); return { lord: n.dataset.lord, x: r.left + r.width / 2, y: r.top + r.height / 3 }; });
    await p.touchscreen.tap(third.x, third.y);
    await sleep(400);
    m = await measure(p);
    check(m.shown === third.lord && !(await p.$('.lordpick.has-pick')), `touch: a tap brings the Lord into view and picks nothing (${m.shown})`);
    await p.touchscreen.tap(m.go.x + m.go.w / 2, m.go.y + m.go.h / 2);
    check(await waitFor(p, (l) => window.__ob.app.room?.view?.you?.lord === l, third.lord, 15000), 'touch: the sheet\'s button picks the Lord in view');
    await p.browserContext().close();

    // ---- the tutorial (untimed, with the coach under the sheet): each faction
    p = await open('');
    await p.type('.name', 'Tester');
    await p.click('.tutorial');
    check(await waitFor(p, () => !!document.querySelector('.lordpick .lcard') && !!document.querySelector('.coach.on'), null, 30000), 'tutorial pick with its coach');
    await sleep(1500);
    for (const f of FACTIONS) {
      await p.click(`.fcard[data-faction="${f}"]`);
      await p.mouse.move(2, 2);
      await sleep(900);
      await shot(p, `tutorial-${f}`);
      layout(await measure(p), `tutorial ${f}`, { coach: true, timer: false });
    }
    await p.browserContext().close();
  } catch (e) {
    console.log('EXCEPTION', e);
    fails++;
  } finally {
    await browser.close();
  }
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
