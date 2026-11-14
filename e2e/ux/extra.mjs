// Two focused checks (offline, no server needed):
//   pick  - cavaliers, pegasus, wyvern and dragon select by their ground footprint and by where the
//           airborne model is drawn; the hover tooltip does not cover the squad
//   idle  - a player who does nothing is told what was chosen for them (Lord, recruits)
//   BASE=http://127.0.0.1:3047/ node e2e/ux/extra.mjs [pick|idle]
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3047/';
const which = process.argv[2] || 'all';
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
async function page(url, w = 1920, h = 1080) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join('e2e/shots', `ux-${name}.png`) });

try {
  if (which === 'all' || which === 'pick') {
    const p = await page('?dev=planning&timer=0&round=2');
    check(await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob.app.scene, null, 40000), 'dev planning up');
    await sleep(1500);
    for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(300); }
    await p.evaluate(() => {
      const { app } = window.__ob;
      const me = app.local.s.players[0];
      me.unlocked = ['militia', 'cavaliers', 'pegasus', 'wyvern', 'dragon', 'knights'];
      me.gold = 9000;
      me.deployLimit = 20;
      // clear the bot-built army away from the test spots
      me.squads = me.squads.filter((q) => q.type === 'lord');
      const spots = { cavaliers: [1500, 2600], pegasus: [3200, 2600], wyvern: [4900, 2600], dragon: [6500, 2600], knights: [2400, 1200] };
      for (const u in spots) app.backend.intent({ t: 'deploy', unit: u, pos: spots[u] });
    });
    await sleep(500);
    // wait for the unit models
    await waitFor(p, () => window.__ob.app.scene.view.units.slots.length >= 10, null, 20000);
    await sleep(6000);
    const r = await p.evaluate(() => {
      const { app } = window.__ob;
      const s = app.scene;
      return app.room.view.you.squads.map((q) => {
        const ground = s.toScreen(q.pos, 0);
        const model = s.view.squadScreen(q.id, 0.5);
        return { type: q.type, ground: s.squadAt(ground.x, ground.y)?.id === q.id, model: model ? s.squadAt(model.x, model.y)?.id === q.id : null, engine: s.view.pickSquad(ground.x, ground.y) === q.id, gx: Math.round(ground.x), gy: Math.round(ground.y), mx: model && Math.round(model.x), my: model && Math.round(model.y) };
      });
    });
    for (const x of r) console.log(`     ${JSON.stringify(x)}`);
    check(r.length >= 6 && r.every((x) => x.ground), 'every squad picks at its ground centre (cavaliers and fliers too)');
    check(r.every((x) => x.model !== false), 'every squad picks where its model is drawn (airborne squads)');
    console.log(`     the engine's own ray pick alone hits: ${r.filter((x) => x.engine).map((x) => x.type).join(', ')}`);
    // hover a flier: tooltip beside, not over
    const peg = r.find((x) => x.type === 'pegasus');
    await p.mouse.move(peg.mx, peg.my);
    await sleep(400);
    const tip = await p.evaluate(() => { const n = document.querySelector('.tip-layer.on'); if (!n) return null; const b = n.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
    check(!!tip && !(peg.mx >= tip[0] && peg.mx <= tip[2] && peg.my >= tip[1] && peg.my <= tip[3]) && (tip[0] > peg.mx + 20 || tip[2] < peg.mx - 20), `flier hover tooltip sits beside the squad (${JSON.stringify(tip?.map(Math.round))} vs ${peg.mx},${peg.my})`);
    await shot(p, 'pick-flier-hover');
    await p.mouse.click(peg.mx, peg.my);
    await sleep(400);
    const sel = await p.$eval('.sqpanel .sp-t b', (n) => n.textContent).catch(() => null);
    check(/Pegasus/.test(sel ?? ''), `clicking the airborne model selects it (${sel})`);
    await shot(p, 'pick-flier-selected');
    await p.close();
  }
  if (which === 'all' || which === 'idle') {
    const p = await page('', 1366, 768);
    await p.click('.offline');
    check(await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick'), 'offline skirmish: lord pick');
    const toasts = [];
    await p.exposeFunction('__toast', (t) => toasts.push(t));
    await p.evaluate(() => new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast') && window.__toast(n.className + ' | ' + n.textContent)))).observe(document.getElementById('ui'), { childList: true, subtree: true }));
    check(await waitFor(p, () => window.__ob.app.room?.phase === 'planning', null, 40000), 'the lord pick timed out into planning');
    await sleep(800);
    await shot(p, 'idle-lord-toast');
    check(toasts.some((t) => /auto/.test(t) && /was chosen to lead your host/.test(t)), `toast: the Lord chosen for an idle player (${JSON.stringify(toasts)})`);
    check(await waitFor(p, () => !!document.querySelector('.battle'), null, 90000), 'planning timed out into battle');
    await sleep(1500);
    await p.keyboard.press('End');
    check(await waitFor(p, () => ['results', 'over'].includes(window.__ob.app.room?.phase), null, 20000), 'results');
    await sleep(700);
    await shot(p, 'idle-draft-toast');
    check(toasts.some((t) => /did not choose recruits in time/.test(t)), `toast: the recruits unlocked for an idle player (${JSON.stringify(toasts.slice(-3))})`);
    await p.close();
  }
  if (which === 'all' || which === 'over') {
    for (const [w, h] of [[1366, 768], [1024, 768]]) {
      const p = await page('?dev=planning&round=3', w, h);
      await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob.app.scene, null, 40000);
      await sleep(1200);
      await p.evaluate(() => { const { app } = window.__ob; app.local.s.players[0].keepHp = 1; app.local.s.players[0].squads = app.local.s.players[0].squads.slice(0, 1); app.local.emit(); });
      for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(300); }
      await p.keyboard.press('Space');
      await waitFor(p, () => !!document.querySelector('.battle'), null, 15000);
      await sleep(1500);
      await p.keyboard.press('End');
      check(await waitFor(p, () => window.__ob.app.room?.phase === 'over' && !!document.querySelector('.screen.over'), null, 20000), `match over reached (${w}x${h})`);
      await sleep(3200);
      await shot(p, `${w}-over`);
      const r = await p.evaluate(() => { const c = document.querySelector('.over-card').getBoundingClientRect(); return { btn: document.querySelector('.rematch')?.textContent.trim(), fits: c.top >= 0 && c.bottom <= innerHeight && c.left >= 0 && c.right <= innerWidth, stats: document.querySelectorAll('.ov-stats > div').length, mvp: !!document.querySelector('.ov-mvp') }; });
      check(r.btn === 'Play again' && r.fits && r.stats >= 5, `match over vs AI: "Play again", richer stats, card on screen ${JSON.stringify(r)}`);
      const a = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
      await sleep(3000);
      const fps = ((await p.evaluate(() => window.__ob.app.scene.framesDrawn)) - a) / 3;
      check(fps <= 10.5, `match-over backdrop ${fps.toFixed(1)} fps`);
      await p.close();
    }
  }
} catch (e) {
  console.log('EXCEPTION', e);
  fails++;
} finally {
  await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
