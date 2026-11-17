// Text-overflow audit of the card UIs, offline on the ?dev= routes: every unit of every faction on the round's
// recruit (draft) cards, the shop cards (full and compact), their hover cards, the loot screen and the Lord pick.
// A finding is any element whose content is wider or taller than its own box (scrollWidth/scrollHeight past
// clientWidth/clientHeight: text cut off by an ellipsis or a line clamp, or spilling out), or whose rect leaves its
// card. Exits non-zero on any finding. (Whether the widest real draft scrolls is printed as a note.)
//   npx vite --port 5197 &   BASE=http://127.0.0.1:5197/ node e2e/ux/overflow.mjs
//   SIZES=1366x768 FACTIONS=ashen SHOTS=0 ...   (defaults: 1920x1080,1366x768,1024x768; all factions; screenshots on)
// Screenshots: $OUT/<W>x<H>-<screen>.jpg (default docs/reviews/shots-2026-11-17/overflow).
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5197/';
const OUT = process.env.OUT || 'docs/reviews/shots-2026-11-17/overflow';
const SIZES = (process.env.SIZES || '1920x1080,1366x768,1024x768').split(',').map((s) => s.split('x').map(Number));
const FACTIONS = (process.env.FACTIONS || 'kingdom,ashen,caliphate').split(',');
const SHOTS = process.env.SHOTS !== '0';
const LORD = { kingdom: 'marshal', ashen: 'lich', caliphate: 'sultana' };
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch();
const findings = [];
const errors = [];
const notes = [];
let W = 0, H = 0;
const say = (s) => console.log(`[${W}x${H}] ${s}`);
const report = (where, list) => {
  for (const x of list) { findings.push(`[${W}x${H}] ${where}: ${x}`); say(`FAIL ${where}: ${x}`); }
  if (!list.length) say(`ok   ${where}`);
};

async function page(url) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => errors.push(`${url}: pageerror ${e.message}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => document.body.classList.contains('booted'), null, 60000);
  return p;
}
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(OUT, `${W}x${H}-${name}.jpg`), type: 'jpeg', quality: 70 }); };

/**
 * Audit every card matched by `cardSel` (or the whole `cardSel` box): the card and each visible descendant may not
 * be cut off or spill (scroll size past the client box), nor leave the card's rect. `skip` matches descendants that
 * may legitimately leave the card (badges pinned on its frame).
 */
const audit = (p, cardSel, skip = '') => p.evaluate((cardSel, skip) => {
  const out = [];
  const label = (n) => {
    const c = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    return `${n.tagName.toLowerCase()}${c ? '.' + c : ''}`;
  };
  const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  for (const card of document.querySelectorAll(cardSel)) {
    const cs0 = getComputedStyle(card);
    const cr = card.getBoundingClientRect();
    if (!cr.width || cs0.display === 'none' || cs0.visibility === 'hidden') continue;
    const id = card.dataset.u || card.dataset.lord || card.dataset.faction || card.dataset.i || text(card).slice(0, 20);
    const all = [card, ...card.querySelectorAll('*')];
    for (const n of all) {
      if (n.closest('svg') && n.tagName.toLowerCase() !== 'svg') continue;
      if (skip && n !== card && n.matches(skip)) continue;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const inline = cs.display === 'inline';
      // own box: content wider or taller than the box (cut off, ellipsis, line clamp, or spilling)
      // (the card itself only when it clips: a visible card's glow / frame pseudo-elements are not text, and its
      // children are checked one by one below)
      const ownBox = n !== card || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (ownBox && !inline && n.tagName.toLowerCase() !== 'svg' && n.tagName.toLowerCase() !== 'img') {
        // (a glyph's ascent/descent past a tight line-height is not a spill: allow 0.2em vertically where the box clips,
        // and 0.35em where it does not: a real extra line of text is a whole line-height)
        const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
        const sx = n.scrollWidth - n.clientWidth, sy = n.scrollHeight - n.clientHeight - Math.max(2, (clips ? 0.2 : 0.35) * parseFloat(cs.fontSize));
        const scroller = /(auto|scroll)/.test(cs.overflowX + cs.overflowY) && n !== card;
        if (!scroller && (sx > 1 || sy > 0) && n.clientWidth > 0) out.push(`${id} ${label(n)} "${text(n)}" content ${n.scrollWidth}x${n.scrollHeight} > box ${n.clientWidth}x${n.clientHeight}`);
      }
      // the rect inside the card
      if (n !== card) {
        const o = Math.max(cr.left - r.left, r.right - cr.right, cr.top - r.top, r.bottom - cr.bottom);
        if (o > 1.5) out.push(`${id} ${label(n)} "${text(n)}" leaves its card by ${Math.round(o)}px`);
      }
    }
  }
  return [...new Set(out)];
}, cardSel, skip);

/** Hover each element of `sel` in turn and audit the tooltip it opens (the tip layer is the card). */
async function hoverAll(p, sel, where, max = 99) {
  const n = Math.min(max, (await p.$$(sel)).length);
  const all = [];
  for (let i = 0; i < n; i++) for (let tries = 0; tries < 2; tries++) try {
    const h = (await p.$$(sel))[i];
    if (!h) break;
    await h.evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
    const b = await h.boundingBox();
    if (!b) break;
    await p.mouse.move(5, 5);
    await sleep(60);
    await p.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 30));
    await sleep(320);
    const id = await h.evaluate((e) => e.dataset.u || e.dataset.lord || e.dataset.i || '');
    const l = await audit(p, '.tip-layer');
    // the tip must stay on screen too
    const off = await p.evaluate(() => { const t = document.querySelector('.tip-layer'); if (!t || !t.getBoundingClientRect().width) return null; const r = t.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 ? `[${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]` : null; });
    if (off) l.push(`tip off-screen ${off}`);
    all.push(...l.map((x) => `hover ${id}: ${x}`));
    if (i === 0) await shot(p, `${where}-hover`);
    break;
  } catch (e) {
    // the card re-rendered under the pointer (a stale handle): query it again once
    if (tries) throw e;
    await sleep(500);
  }
  report(`${where} hover cards (${n})`, all);
}

const planning = async (f) => {
  const p = await page(`?dev=planning&round=7&lord=${LORD[f]}&timer=0`);
  await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob?.app.room?.view?.you, null, 60000);
  await sleep(2500);
  // a pending loot pick (the dev route's legendary round) comes first: claim it
  for (let i = 0; i < 6; i++) { const t = await p.$('.modal.loot .take'); if (!t) break; await t.click(); await sleep(1500); }
  for (let i = 0; i < 4 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(400); }
  await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  return p;
};
const units = (p) => p.evaluate(() => ({ unlocked: [...window.__ob.app.local.s.players[0].unlocked] }));

async function factionRun(f) {
  const p = await planning(f);
  // every unit of the faction, read from the sim through the page
  const all = await p.evaluate(async () => (await import('/src/sim/data/factions.ts')).FACTIONS[window.__ob.app.local.s.players[0].faction ?? 'kingdom'].units);
  say(`${f}: ${all.length} units`);

  // ---- the recruit draft, every unit of the faction on offer (draftOrder sorts them by class); a real round offers
  // at most the faction's units less the two signature ones, so the row may scroll here: each card is audited alone
  await p.evaluate((all) => { const pl = window.__ob.app.local.s.players[0]; pl.draftOptions = [...all]; pl.draftPicks = 1; window.__ob.app.local.emit(); }, all);
  if (!(await waitFor(p, () => !!document.querySelector('.modal.draft .dcard'), null, 4000))) {
    const n = await p.$('.notice.draft-n');
    if (n) { await n.click(); await waitFor(p, () => !!document.querySelector('.modal.draft .dcard'), null, 4000); }
  }
  await sleep(1200);
  const nd = (await p.$$('.modal.draft .dcard')).length;
  report(`${f} draft cards (${nd}/${all.length})`, nd === all.length ? await audit(p, '.modal.draft .dcard', '.dc-def') : [`only ${nd} draft cards`]);
  await shot(p, `${f}-draft`);
  // the widest real draft: every unit but the Lord's two signature ones, which are all that is already yours
  const had = await p.evaluate(async (all) => { const pl = window.__ob.app.local.s.players[0]; const had = [...pl.unlocked]; const sig = (await import('/src/sim/data/lords.ts')).LORDS[pl.lord].signature; pl.unlocked = [...sig]; pl.draftOptions = all.filter((u) => !sig.includes(u)); window.__ob.app.local.emit(); return had; }, all);
  await sleep(2600); // a changed offer re-opens the picker after its entrance delay
  // (informational: the row is a scroll box by design; a scrolled-off card is not text leaving its box)
  const rowNotes = await p.evaluate(() => {
    const row = document.querySelector('.modal.draft .draft-row');
    if (!row) return ['no draft row'];
    const out = [];
    if (row.scrollHeight > row.clientHeight + 2) out.push(`the widest real draft (${row.children.length} cards) scrolls: ${row.scrollHeight} > ${row.clientHeight}`);
    for (const c of row.children) { const r = c.getBoundingClientRect(); if (r.right > innerWidth || r.left < 0) out.push(`card ${c.dataset.u} off-screen`); }
    return out;
  });
  for (const x of rowNotes) { notes.push(`[${W}x${H}] ${f} draft row: ${x}`); say(`note ${f} draft row: ${x}`); }
  await shot(p, `${f}-draft-real`);
  await p.evaluate((all, had) => { const pl = window.__ob.app.local.s.players[0]; pl.unlocked = had; pl.draftOptions = [...all]; window.__ob.app.local.emit(); }, all, had);
  await sleep(2600);
  await hoverAll(p, '.modal.draft .dcard', `${f}-draft`);
  await p.keyboard.press('Escape');
  await sleep(400);
  await p.evaluate(() => { const pl = window.__ob.app.local.s.players[0]; pl.draftPicks = 0; pl.draftOptions = []; window.__ob.app.local.emit(); });
  await sleep(500);
  for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(400); }

  // ---- the shop: in groups of 5 (full cards), then the whole faction at once (the compact cards)
  const saved = await units(p);
  const groups = [];
  for (let i = 0; i < all.length; i += 5) groups.push(all.slice(i, i + 5));
  groups.push(all);
  for (const [gi, g] of groups.entries()) {
    await p.evaluate((g) => { const pl = window.__ob.app.local.s.players[0]; pl.unlocked = [...g]; pl.gold = 5000; pl.deploysUsed = 0; window.__ob.app.local.emit(); }, g);
    await sleep(700);
    const ns = (await p.$$('.shop .ucard')).length;
    const tag = gi === groups.length - 1 ? 'all' : `group ${gi + 1}`;
    report(`${f} shop ${tag} (${ns} cards)`, await audit(p, '.shop .ucard'));
    if (gi === 0 || gi === groups.length - 1) await shot(p, `${f}-shop-${gi === 0 ? 'full' : 'all'}`);
    if (gi < groups.length - 1) await hoverAll(p, '.shop .ucard', `${f}-shop-g${gi + 1}`);
  }
  await p.evaluate((u) => { const pl = window.__ob.app.local.s.players[0]; pl.unlocked = u; window.__ob.app.local.emit(); }, saved.unlocked);
  await p.close();

  // ---- the loot screen (two seeds: different items, affixes and set lines)
  for (const seed of [3, 11]) {
    const q = await page(`?dev=loot&lord=${LORD[f]}&seed=${seed}&timer=0`);
    await waitFor(q, () => !!document.querySelector('.modal.loot .drop, .modal.draft .dcard'), null, 40000);
    // a pending recruit comes first: take one, then the loot shows
    for (let i = 0; i < 20 && !(await q.$('.modal.loot .drop')); i++) { const d = await q.$('.modal.draft .dcard'); if (d) await d.click(); await sleep(500); }
    const ok = await waitFor(q, () => !!document.querySelector('.modal.loot .drop'), null, 10000);
    await sleep(3500); // the drops deal in
    report(`${f} loot seed ${seed}`, ok ? await audit(q, '.modal.loot .drop', '.beam') : ['no loot screen']);
    report(`${f} loot head/foot seed ${seed}`, ok ? await audit(q, '.modal.loot .loot-head, .modal.loot .loot-foot') : []);
    if (seed === 3) await shot(q, `${f}-loot`);
    await q.close();
  }
}

async function lordPick() {
  const p = await page(`?dev=match&timer=0`);
  await waitFor(p, () => !!document.querySelector('.lcard'), null, 40000);
  await sleep(2500);
  for (const f of FACTIONS) {
    const b = await p.$(`.fcard[data-faction="${f}"]`);
    if (b) { await b.click(); await sleep(900); }
    report(`lord pick ${f} banners`, await audit(p, '.fcard'));
    report(`lord pick ${f} cards`, await audit(p, '.lcard'));
    // each Lord's sheet, by hovering its card
    const n = (await p.$$('.lcard')).length;
    const sheet = [];
    for (let i = 0; i < n; i++) {
      const c = (await p.$$('.lcard'))[i];
      const bb = await c.boundingBox();
      await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await sleep(400);
      const lid = await c.evaluate((e) => e.dataset.lord);
      sheet.push(...(await audit(p, '.lp-detail .ld.on')).map((x) => `${lid}: ${x}`));
    }
    report(`lord pick ${f} sheets (${n})`, sheet);
    await shot(p, `lordpick-${f}`);
  }
  await p.close();
}

try {
  for (const [w, h] of SIZES) {
    W = w; H = h;
    for (const f of FACTIONS) await factionRun(f);
    await lordPick();
  }
} catch (e) {
  errors.push('exception: ' + (e?.stack ?? e));
} finally {
  await browser.close();
  console.log(`\n${findings.length} overflow finding(s)`);
  for (const e of errors) console.log('ERROR', e);
  fs.writeFileSync(path.join(OUT, 'findings.txt'), [...findings, ...errors.map((e) => 'ERROR ' + e), ...notes.map((n) => 'note ' + n)].join('\n') + '\n');
  process.exit(findings.length || errors.length ? 1 : 0);
}
