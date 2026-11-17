// Visual QA of the counter-wheel / weighted-deploy / swarm-levelling / item-rework UI, offline on the ?dev= routes:
// the class line on recruit cards, shop cards, hover cards, the squad panel and the Lord pick; the deploy badge, weight
// chips and the weight-refusal toast; the codex wheel (F1); a levelled Swarm squad in planning and in battle; the loot
// screen (an all-Legendary round with its "Best on" lock); the battle inspector. Also prints a layout audit (elements
// cut off or overlapping) for each screen. Screenshots: $OUT/<TAG>-<W>-<name>.jpg.
//   npx vite --port 5193 &   W=1024 H=768 TAG=after node e2e/ux/wheel-ui.mjs
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5193/';
const W = +(process.env.W || 1920), H = +(process.env.H || 1080);
const TAG = process.env.TAG || 'shot';
const OUT = process.env.OUT || 'docs/reviews/shots-2026-11-17';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (n) => !ONLY || ONLY.includes(n);
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
const errors = [];
const notes = [];
const note = (s) => { console.log(`[${W}] ${s}`); notes.push(s); };

async function page(url) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: W, height: H, deviceScaleFactor: 1, isMobile: W < 600, hasTouch: W < 600 });
  p.on('pageerror', (e) => errors.push(`${url}: pageerror ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${url}: ${m.text()}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => document.body.classList.contains('booted'), null, 60000);
  return p;
}
const shot = async (p, name) => {
  const f = path.join(OUT, `${TAG}-${W}-${name}.jpg`);
  await p.screenshot({ path: f, type: 'jpeg', quality: 62 });
  return f;
};
/** Text nodes that are cut off (ellipsis / overflow) and boxes that leave the viewport. */
const audit = (p, label, sels) => p.evaluate((sels) => {
  const out = [];
  for (const s of sels) for (const n of document.querySelectorAll(s)) {
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    if (!r.width || cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (n.scrollWidth > n.clientWidth + 1 && cs.overflow !== 'visible') out.push(`clipped ${s} "${n.textContent.trim().slice(0, 40)}" (${n.scrollWidth}>${n.clientWidth})`);
    if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1) out.push(`off-screen ${s} "${n.textContent.trim().slice(0, 30)}" [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
  }
  return out;
}, sels).then((l) => { for (const x of [...new Set(l)].slice(0, 25)) note(`${label}: ${x}`); return l; });
/** Pairs of same-selector boxes that overlap (timing tags, chips). */
const overlaps = (p, label, sel) => p.evaluate((sel) => {
  const rs = [...document.querySelectorAll(sel)].map((n) => ({ n, r: n.getBoundingClientRect() })).filter((x) => x.r.width && getComputedStyle(x.n).display !== 'none' && +getComputedStyle(x.n).opacity > 0);
  const out = [];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i].r, b = rs[j].r;
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 2 && oy > 2) out.push(`"${rs[i].n.textContent.trim().slice(0, 20)}" x "${rs[j].n.textContent.trim().slice(0, 20)}" (${Math.round(ox)}x${Math.round(oy)})`);
  }
  return out;
}, sel).then((l) => { for (const x of l.slice(0, 15)) note(`${label}: overlap ${sel} ${x}`); return l; });
const closeModals = async (p) => {
  for (let i = 0; i < 4; i++) {
    if (!(await p.$('.modal'))) break;
    await p.keyboard.press('Escape');
    await sleep(500);
  }
};
const hover = async (p, sel) => {
  const h = await p.$(sel);
  if (!h) return note(`missing ${sel}`), false;
  const b = await h.boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await sleep(450);
  return true;
};
const emit = (p) => p.evaluate(() => window.__ob.app.local.emit());

try {
  // ---- planning, round 4: the loot of round 3 (all Legendary) and the round's unlock
  if (want('planning')) {
    const p = await page(`?dev=planning&round=4&lord=marshal&timer=0`);
    await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob?.app.room?.view?.you, null, 60000);
    await sleep(4500);
    if (await p.$('.modal.draft, .modal .dcard')) {
      await shot(p, 'draft');
      await audit(p, 'draft', ['.dcard b', '.dc-cls', '.dc-ctr', '.dc-cost', '.wcl']);
      await hover(p, '.dcard');
      await shot(p, 'draft-tip');
      await p.click('.dcard');
      await sleep(900);
    }
    if (await p.$('.modal.loot')) {
      await sleep(2500);
      await shot(p, 'loot-legendary');
      await audit(p, 'loot', ['.drop', '.drop-rar', '.drop-fit', '.it-meta', '.it-best', '.loot-head p']);
      const offer = await p.evaluate(() => window.__ob.app.room.view.you.lootOffer?.map((i) => `${i.rarity} ${i.slot} ${i.legendary ?? ''}`));
      note(`loot offer: ${JSON.stringify(offer)}`);
    }
    await closeModals(p);
    await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await sleep(1200);
    await shot(p, 'planning');
    await audit(p, 'planning', ['.ucard b', '.uc-role', '.uc-meta', '.uc-tags', '.deploy-badge', '.dpw', '.shop', '.ready-box', '.topbar', '.ptools']);
    await overlaps(p, 'planning', '.ttag, .tm-tag, .timing-tag, .mtag');
    // shop tooltip
    if (await hover(p, '.shop .ucard')) await shot(p, 'shop-tip');
    // routes (T): the timing tags
    await p.mouse.move(5, H / 2);
    await p.keyboard.press('t');
    await sleep(900);
    await shot(p, 'timing');
    const tagSel = await p.evaluate(() => {
      const c = new Set();
      for (const n of document.querySelectorAll('.planning *')) for (const k of n.classList) if (/tag|tm-|mt-/.test(k)) c.add(k);
      return [...c].join(' ');
    });
    note(`tag-ish classes: ${tagSel}`);
    for (const k of tagSel.split(' ').filter(Boolean)) await overlaps(p, 'timing', '.' + k);
    await p.keyboard.press('t');
    await sleep(300);

    // ---- grow the Militia: gold, then level it to 5
    await p.evaluate(() => { window.__ob.app.local.s.players[0].gold = 9000; });
    await emit(p);
    await sleep(500);
    const mil = await p.evaluate(() => {
      const me = window.__ob.app.room.view.you;
      const q = me.squads.find((s) => s.type === 'militia') ?? null;
      return q && { id: q.id, level: q.level };
    });
    note(`militia squad: ${JSON.stringify(mil)}`);
    if (!mil) {
      // deploy one near the front centre
      await p.keyboard.press('1');
      const spot = await p.evaluate(() => window.__ob.app.scene.toScreen([4000, 3000], 0));
      await p.mouse.move(spot.x, spot.y);
      await sleep(200);
      await p.mouse.click(spot.x, spot.y);
      await sleep(700);
    }
    const sq = await p.evaluate(() => {
      const me = window.__ob.app.room.view.you;
      const q = me.squads.find((s) => s.type === 'militia' || s.type === 'skeleton' || s.type === 'spear_levy');
      return q && { id: q.id, scr: window.__ob.app.scene.toScreen(q.pos, 0.5), level: q.level, type: q.type };
    });
    if (sq) {
      // Tab through my squads to it (at 4:3 it may sit under the stash panel)
      for (let i = 0; i < 20; i++) {
        if (await p.evaluate((id) => window.__ob.app.screen.selected === id, sq.id)) break;
        await p.keyboard.press('Tab');
        await sleep(150);
      }
      await sleep(500);
      await shot(p, 'swarm-lv' + sq.level);
      for (let i = sq.level; i < 5; i++) {
        await p.keyboard.press('u');
        await sleep(450);
      }
      await sleep(600);
      const lv = await p.evaluate((id) => window.__ob.app.room.view.you.squads.find((s) => s.id === id)?.level, sq.id);
      note(`swarm squad levelled to ${lv}`);
      await shot(p, 'swarm-lv5-panel');
      await audit(p, 'sqpanel', ['.sqpanel', '.sqpanel .wline', '.sqpanel b', '.sqpanel .sp-acts']);
      await p.keyboard.press('Escape');
      await sleep(300);
      // a close look: hover card on the grown squad
      const at = await p.evaluate((id) => { const q = window.__ob.app.room.view.you.squads.find((s) => s.id === id); return window.__ob.app.scene.toScreen(q.pos, 0.5); }, sq.id);
      await p.mouse.move(at.x, at.y);
      await sleep(800);
      await shot(p, 'swarm-lv5-hover');
    }

    // ---- the weight refusal: spend deploys on cheap squads until a 400-gold unit no longer fits
    await p.mouse.move(5, H / 2);
    const left = await p.evaluate(() => { const me = window.__ob.app.room.view.you; return me.deployLimit - me.deploysUsed; });
    note(`deploy points left (half-points): ${left}`);
    // force: 1 half-point left, and a heavy unit unlocked (the Golem), so the badge reads ½ and the Golem is refused
    await p.evaluate(() => {
      const pl = window.__ob.app.local.s.players[0];
      pl.deploysUsed = pl.deployLimit - 1;
      if (!pl.unlocked.includes('golem')) pl.unlocked.push('golem');
    });
    await emit(p);
    await sleep(700);
    await shot(p, 'deploy-half-left');
    await audit(p, 'shop', ['.ucard b', '.uc-role', '.uc-meta', '.uc-tags', '.deploy-badge', '.dpw']);
    const golem = await p.$('.shop .ucard[data-u="golem"]');
    if (golem) {
      await hover(p, '.shop .ucard[data-u="golem"]');
      await shot(p, 'shop-golem-refused-tip');
      // drag it onto the field: the refusal toast
      const b = await golem.boundingBox();
      const spot = await p.evaluate(() => window.__ob.app.scene.toScreen([2000, 2500], 0));
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await p.mouse.down();
      for (let i = 1; i <= 10; i++) { await p.mouse.move(b.x + (spot.x - b.x) * i / 10, b.y + (spot.y - b.y) * i / 10); await sleep(20); }
      await p.mouse.up();
      await sleep(400);
      await shot(p, 'deploy-refused-toast');
      note(`toasts: ${JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim())))}`);
      // the keyboard path too
      const k = await p.evaluate(() => document.querySelector('.shop .ucard[data-u="golem"] kbd')?.textContent);
      if (k) {
        await p.keyboard.press(k);
        await sleep(400);
        await shot(p, 'deploy-refused-key');
        note(`toasts after key: ${JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim())))}`);
      }
    } else note('no golem card in the shop');
    await p.evaluate(() => { const pl = window.__ob.app.local.s.players[0]; pl.deploysUsed = 0; });
    await emit(p);
    await sleep(400);

    // ---- codex (F1) on the counters tab
    await p.keyboard.press('F1');
    await sleep(600);
    const tab = await p.$('.rl-tabs button[data-tab="combat"]');
    if (tab) { await tab.click(); await sleep(500); }
    await shot(p, 'codex-wheel');
    await audit(p, 'codex', ['.whl', '.whl-node', '.rl-row', '.wcl']);
    await p.evaluate(() => document.querySelector('.rl-body, .rl-page, .rules .body')?.scrollBy(0, 600));
    await sleep(300);
    await shot(p, 'codex-wheel-2');
    await p.keyboard.press('Escape');
    await sleep(300);

    // ---- into battle with the grown militia
    if (want('battle')) {
      await p.evaluate(() => { window.__ob.app.local.s.players[0].deploysUsed = 0; });
      await p.keyboard.press('Space');
      await waitFor(p, () => !!document.querySelector('.battle') || window.__ob.app.room?.phase === 'battle', null, 30000);
      await sleep(6000);
      await shot(p, 'battle-swarm-6s');
      // inspect the grown squad: Tab cycles own squads
      const rows = await p.evaluate(() => {
        const s = window.__ob.app.screen;
        const d = s.decoded;
        return d ? d.replay.squads?.map?.((q, i) => `${i}:${q.type}:${q.side}`) : null;
      });
      note(`replay squads: ${JSON.stringify(rows)?.slice(0, 400)}`);
      await p.keyboard.press('Tab');
      await sleep(700);
      await shot(p, 'battle-inspector');
      await audit(p, 'inspector', ['.insp', '.insp .wline', '.insp b', '.insp small']);
    }
    await p.close();
  }

  // ---- Lord pick
  if (want('lordpick')) {
    const p = await page(`?dev=match&timer=0`);
    await sleep(5000);
    await shot(p, 'lordpick');
    await audit(p, 'lordpick', ['.lcard', '.lp-detail', '.ld.on', '.wline', '.lc-name', '.lc-sig', '.lc-block', '.lc-stats', '.lp-go']);
    await p.close();
  }
} catch (e) {
  errors.push('exception: ' + (e?.stack ?? e));
} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, `${TAG}-${W}-notes.txt`), [...notes, ...errors.map((e) => 'ERROR ' + e)].join('\n'));
  for (const e of errors) console.log('ERROR', e);
  process.exit(errors.length ? 1 : 0);
}
