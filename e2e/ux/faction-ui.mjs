// Faction UI screenshots (offline, no game server needed): the faction + Lord pick for each faction,
// the tutorial pick with its coach, the VS reveal, planning with the HUD faction bands, the recruit
// picker for a Covenant player, the codex Factions tab, the battle inspector on a Covenant / Caliphate
// squad, and a Lich battle with Grave Acolytes and its log. One browser per viewport, closed between.
//   BASE=http://127.0.0.1:5191/ SIZES=1920x1080,1024x768 node e2e/ux/faction-ui.mjs
// Writes e2e/shots/faction-ui-<W>-*.png and prints layout problems it can measure.
import { launch, sleep, waitFor, layoutAudit } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5191/';
const SIZES = (process.env.SIZES || '1920x1080,1366x768,1024x768,3440x1440').split(',').map((s) => s.split('x').map(Number));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);
const errors = [];
let fails = 0;

for (const [W, H] of SIZES) {
  const browser = await launch();
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${W}] ${what}`); if (!ok) fails++; };
  let p;
  const shot = (name) => p.screenshot({ path: path.join('e2e/shots', `faction-ui-${W}-${name}.png`) });
  const open = async (url, opts = {}) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: W, height: H });
    page.on('pageerror', (e) => errors.push(`[${W}] pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`[${W}] console: ${m.text()}`));
    if (opts.faction) await page.evaluateOnNewDocument((f) => { try { localStorage.setItem('oathbound.faction', f); } catch {} }, opts.faction);
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
    return page;
  };
  const close = async () => { if (p) await p.browserContext().close().catch(() => {}); p = null; };
  // overflow on screen-level elements: scrollbars, text cut, elements off screen
  const overflow = (sels) => p.evaluate((sels) => {
    const out = [];
    for (const s of sels) for (const n of document.querySelectorAll(s)) {
      const r = n.getBoundingClientRect();
      if (!r.width) continue;
      if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(`OFF ${s} [${r.left | 0},${r.top | 0},${r.right | 0},${r.bottom | 0}]`);
      const cs = getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 2 && /auto|scroll|hidden/.test(cs.overflowY)) out.push(`VCLIP ${s} <${n.tagName.toLowerCase()}.${String(n.className).replace(/ /g, '.')}> ${n.scrollHeight}>${n.clientHeight}`);
      if (n.scrollWidth > n.clientWidth + 2 && /auto|scroll|hidden/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis') out.push(`HCLIP ${s} <${n.tagName.toLowerCase()}.${String(n.className).replace(/ /g, '.')}> ${n.scrollWidth}>${n.clientWidth}`);
    }
    if (document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1) out.push('PAGE SCROLL');
    return out;
  }, sels);
  try {
    // ---- the pick screen, each faction (dev=match starts at the Lord pick)
    if (want('pick')) {
      p = await open('?dev=match&timer=0');
      check(await waitFor(p, () => !!document.querySelector('.lordpick .lcard'), null, 30000), 'dev=match reaches the pick');
      for (const f of ['kingdom', 'ashen', 'caliphate']) {
        await p.click(`.fcard[data-faction="${f}"]`);
        await sleep(700);
        await p.mouse.move(2, H - 2);
        await sleep(200);
        await shot(`pick-${f}`);
        const o = await overflow(['.lordpick', '.lp-factions', '.fcard', '.lp-ident', '.lp-cards', '.lp-row', '.lcard', '.lc-name', '.wline', '.lp-detail', '.ld', '.lc-block p', '.lc-sig', '.lc-stats', '.lp-go', '.lp-foot']);
        const port = await p.$$eval('.lcard', (ns) => ns.map((c) => { const n = c.querySelector('.lport'), r = n.getBoundingClientRect(), k = c.querySelector('.lc-name').getBoundingClientRect(); return { art: n.classList.contains('art'), w: r.width | 0, h: r.height | 0, card: c.getBoundingClientRect().height | 0, clear: (Math.min(r.bottom, k.top) - r.top) | 0 }; }));
        const seat = await p.evaluate(() => { const b = (s) => { const n = document.querySelector(s); const r = n?.getBoundingClientRect(); return r && r.height ? [r.top | 0, r.bottom | 0] : null; }; return { timer: b('.lp-timer'), banners: b('.lp-factions'), row: b('.lp-row .lcard'), sheet: b('.lp-detail'), foot: b('.lp-foot') }; });
        check(o.length === 0, `pick ${f} fits ${JSON.stringify(o.slice(0, 6))}`);
        check(port.length === 4 && port.every((x) => x.art && x.w > 40 && x.h > 40), `pick ${f} portraits ${JSON.stringify(port)}`);
        // the Lords are the picture: a portrait is at least 40% of its card and 220 px tall (at 1024x768 and above), at
        // least 180 px of it stands clear of the caption band, and it is never a sliver
        check(port.every((x) => x.h >= 0.4 * x.card && x.h >= 220 && x.clear >= 180 && x.w <= x.h * 1.25 && x.h <= x.w * 1.45), `pick ${f}: portraits at least 40% of the card and 220 px tall, no slivers`);
        // top to bottom with nothing over anything else: banners, the row of Lords, the Lord's sheet, the footer line
        check(!!seat.banners && !!seat.row && !!seat.sheet && !!seat.foot && seat.banners[1] <= seat.row[0] && seat.row[1] <= seat.sheet[0] + 8 && seat.sheet[1] <= seat.foot[0] + 4 && seat.foot[1] <= H, `pick ${f}: banners, Lords, sheet and footer stacked on screen ${JSON.stringify(seat)}`);
      }
      // the reveal: pick the Lich
      await p.click('.fcard[data-faction="ashen"]');
      await sleep(300);
      await p.click('.lcard[data-lord="lich"]');
      check(await waitFor(p, () => !!document.querySelector('.reveal'), null, 20000), 'VS reveal');
      await sleep(900);
      await shot('reveal');
      check((await overflow(['.reveal', '.rv-side', '.rv-side b', '.rv-fac'])).length === 0, `reveal fits ${JSON.stringify(await overflow(['.reveal', '.rv-side', '.rv-side b', '.rv-fac']))}`);
      // recruit picker for the Covenant
      if (await waitFor(p, () => !!document.querySelector('.modal.draft .dcard'), null, 12000)) {
        await sleep(1200);
        await p.mouse.move(2, H - 2);
        await shot('recruit-ashen');
        const o = await overflow(['.modal.draft', '.dcard', '.modal.draft .dcard p']);
        const types = await p.evaluate(() => window.__ob.app.room.view.you.draftOptions);
        check(o.length === 0, `Covenant recruit picker fits ${JSON.stringify(o.slice(0, 6))} options ${types}`);
      } else check(false, 'recruit picker after the reveal');
      await close();
    }
    // ---- tutorial pick with the coach
    if (want('tutorial')) {
      p = await open('');
      await p.type('.name', 'Tester');
      await p.click('.tutorial');
      check(await waitFor(p, () => !!document.querySelector('.lordpick .lcard') && !!document.querySelector('.coach.on'), null, 30000), 'tutorial pick with coach');
      await sleep(1400);
      await shot('tutorial-pick');
      const r = await p.evaluate(() => { const g = (s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return [r.left | 0, r.top | 0, r.right | 0, r.bottom | 0]; }; return { coach: g('.coach.on'), cards: g('.lp-cards'), sheet: g('.lp-detail'), foot: g('.lp-foot'), target: g('.lcard[data-lord="marshal"]'), port: g('.lcard[data-lord="marshal"] .lport') }; });
      const ov = (a, b) => a && b && Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 4 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 4;
      check(!ov(r.coach, r.cards) && !ov(r.coach, r.sheet) && !ov(r.coach, r.target) && r.coach[3] <= H, `coach clear of the cards and the Lord's sheet ${JSON.stringify(r)}`);
      const tsel = ['.coach.on', '.lp-cards', '.lp-row', '.lcard', '.lc-name', '.wline', '.lp-detail', '.ld', '.lc-block p', '.lp-go', '.fcard'];
      check((await overflow(tsel)).length === 0, `tutorial pick fits ${JSON.stringify(await overflow(tsel))}`);
      check(r.port[3] - r.port[1] >= 220 && r.port[3] - r.port[1] >= 0.4 * (r.target[3] - r.target[1]) && r.target[3] <= r.sheet[1] + 8, `tutorial pick: the coach does not squeeze the portraits (${r.port[2] - r.port[0]}x${r.port[3] - r.port[1]})`);
      await close();
    }
    // ---- planning: HUD faction bands, codex
    if (want('planning')) {
      p = await open('?dev=planning&lord=lich&enemy=sultana&timer=0');
      check(await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob.app.scene, null, 60000), 'planning');
      await sleep(3500);
      for (let i = 0; i < 4 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(400); }
      await sleep(1500);
      await shot('planning');
      const a = await layoutAudit(p, ['.tb-side.me', '.tb-mid', '.tb-side.foe', '.r-gold', '.r-army', '.r-ghost', '.stash', '.deploy-badge', '.ready-box', '.notices', '.ucard']);
      check(a.length === 0, `planning layout ${JSON.stringify(a.slice(0, 6))}`);
      const bands = await p.$$eval('.tb-side', (ns) => ns.map((n) => ({ cls: n.className, accent: getComputedStyle(n).getPropertyValue('--fa') + ' ' + n.style.getPropertyValue('--fb') + ' ' + (n.dataset.faction || '') })));
      console.log('     plaques', JSON.stringify(bands));
      await p.keyboard.press('F1');
      await sleep(500);
      await p.click('.rl-tabs button[data-tab="factions"]').catch(() => {});
      await sleep(500);
      await shot('codex-factions');
      const o = await overflow(['.rules', '.rl-tabs', '.rl-body']);
      const hs = await p.evaluate(() => { const b = document.querySelector('.rl-body'); return b ? b.scrollWidth > b.clientWidth + 2 : null; });
      check(!hs && o.filter((x) => !/VCLIP \.rl-body/.test(x)).length === 0, `codex factions fits ${JSON.stringify(o)}`);
      // scroll the codex body to see the lower part
      await p.evaluate(() => { const b = document.querySelector('.rl-body'); if (b) b.scrollTop = b.scrollHeight; });
      await sleep(300);
      await shot('codex-factions-end');
      await close();
    }
    // ---- battle: the inspector on a Covenant / Caliphate squad, the log
    if (want('battle')) {
      let found = null;
      for (const [round, seed] of [[4, 20261114], [5, 11], [6, 7], [5, 3], [7, 42], [6, 21]]) {
        p = await open(`?dev=battle&timer=0&lord=lich&enemy=sultana&round=${round}&seed=${seed}`);
        if (!(await waitFor(p, () => !!document.querySelector('.screen.battle') && !!window.__ob.app.screen?.pb, null, 60000))) { await close(); continue; }
        const rows = await p.evaluate(() => window.__ob.app.screen.decoded.replay.squads.map((q) => ({ row: q.row, side: q.side, type: q.type, summoned: !!q.summoned })));
        const aco = rows.find((q) => q.side === 0 && q.type === 'grave_acolyte');
        console.log(`     round ${round} seed ${seed}: ${rows.filter((q) => !q.summoned).map((q) => q.side + ':' + q.type).join(' ')}`);
        if (aco) { found = { round, seed, rows }; break; }
        if (!found && round === 6 && seed === 21) found = { round, seed, rows };
        await close();
      }
      check(!!found && found.rows.some((q) => q.type === 'grave_acolyte'), `a Lich battle with Grave Acolytes ${found ? found.round + '/' + found.seed : ''}`);
      if (p) {
        await sleep(14000);
        await shot('battle-log');
        const o = await overflow(['.b-feed', '.kf', '.tb-side', '.tb-mid']);
        check(o.length === 0, `battle HUD fits ${JSON.stringify(o.slice(0, 6))}`);
        const log = await p.$$eval('.kf', (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).slice(-8));
        console.log('     log', JSON.stringify(log));
        const mine = found.rows.find((q) => q.side === 0 && ['grave_acolyte', 'grave_knight'].includes(q.type) && !q.summoned) ?? found.rows.find((q) => q.side === 0 && q.type !== 'lord');
        await p.evaluate((row) => window.__ob.app.screen.insp.open(row), mine.row);
        await sleep(1200);
        await shot('inspect-ashen');
        let oi = await overflow(['.insp.on', '.insp.on *:not(svg):not(path)']);
        // the inspector body scrolls by design (its lower rows sit below the fold at 1024)
        oi = oi.filter((x) => !/^VCLIP .*in-body|^OFF /.test(x));
        check(oi.length === 0, `inspector (${mine.type}) fits ${JSON.stringify(oi.slice(0, 6))}`);
        // Skeleton Spearmen are a recruited squad (not a raised band): they must be inspectable
        const skel = found.rows.find((q) => q.side === 0 && q.type === 'skeleton' && !q.summoned);
        if (skel) {
          await p.evaluate((row) => window.__ob.app.screen.insp.open(row), skel.row);
          await sleep(1000);
          const t = await p.evaluate(() => document.querySelector('.insp.on')?.textContent?.replace(/\s+/g, ' ').slice(0, 80) ?? null);
          check(!!t && /Skeleton Spearmen/.test(t), `Skeleton Spearmen are inspectable (${t})`);
          await shot('inspect-skeleton');
        }
        const foe = found.rows.find((q) => q.side === 1 && q.type !== 'lord' && !q.summoned);
        if (foe) {
          await p.evaluate((row) => window.__ob.app.screen.insp.open(row), foe.row);
          await sleep(1200);
          await shot('inspect-caliphate');
          console.log('     inspected foe', foe.type);
        }
      }
      await close();
    }
  } catch (e) {
    console.log('EXCEPTION', e);
    fails++;
    if (p) await shot('exception').catch(() => {});
  } finally {
    await browser.close();
  }
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
