// UX tour at one window size: title, rules codex, settings, the tutorial match (offline: no server
// needed for it) through lord pick, draft, deploy, battle, results, loot and round 2, the late-game
// shop, the fps of every menu, and layout checks. Screenshots: e2e/shots/ux-<W>-*.png.
//   BASE=http://127.0.0.1:3047/ W=1366 H=768 node e2e/ux/tour.mjs
import { launch, sleep, waitFor, layoutAudit } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3047/';
const W = +(process.env.W || 1920), H = +(process.env.H || 1080);
const TAG = `${W}`;
const browser = await launch();
const ctx = await browser.createBrowserContext();
const p = await ctx.newPage();
await p.setViewport({ width: W, height: H });
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
p.on('response', (r) => r.status() >= 400 && !/favicon/.test(r.url()) && errors.push(`${r.status()} ${r.url()}`));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${TAG}] ${what}`); if (!ok) fails++; };
const shot = (name) => p.screenshot({ path: path.join('e2e/shots', `${process.env.SHOT_PREFIX || 'ux'}-${TAG}-${name}.png`) });
const rect = (sel) => p.evaluate((sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const inView = (r) => !!r && r.x >= -1 && r.y >= -1 && r.r <= W + 1 && r.b <= H + 1;
const frames = async (ms) => {
  const a = await p.evaluate(() => window.__ob.app.scene?.framesDrawn ?? 0);
  await sleep(ms);
  const b = await p.evaluate(() => window.__ob.app.scene?.framesDrawn ?? 0);
  return +(((b - a) * 1000) / ms).toFixed(1);
};
const state = () => p.evaluate(() => { const r = window.__ob.app.room; const me = r?.view?.you; return r ? { phase: r.phase, round: r.view?.round, gold: me?.gold, squads: me?.squads.length, deploys: me ? me.deployLimit - me.deploysUsed : null, draft: me?.draftPicks, loot: !!me?.lootOffer, stash: me?.stash.length, unlocked: me?.unlocked.length } : null; });

try {
  const t0 = Date.now();
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  const tMenu = Date.now() - t0;
  const sceneAtMenu = await p.evaluate(() => !!window.__ob.app.scene);
  check(tMenu < 6000, `menu interactive in ${tMenu} ms (renderer ready then: ${sceneAtMenu})`);
  await sleep(900);
  await shot('title');
  // ---- title layout
  const menu = await rect('.title-menu');
  check(inView(menu) && Math.abs(menu.x + menu.w / 2 - W / 2) < 3, `title menu on screen and centred (${JSON.stringify(menu)})`);
  for (const sel of ['.title-menu .name', '.title-menu .code', '.title-menu .join', '.title-menu .spectate', '.title-menu .vsai', '.title-menu .tutorial']) {
    const r = await rect(sel);
    check(r && r.x >= menu.x && r.r <= menu.r + 0.5, `${sel} inside the menu`);
  }
  const head = await rect('.title-head');
  check(head.b <= menu.y + 2, 'title wordmark clear of the menu');
  await waitFor(p, () => !!window.__ob.app.scene, null, 30000);
  await sleep(1500);
  check((await frames(3000)) === 0, 'title draws 0 fps (painted backdrop)');

  // ---- rules codex
  await p.click('.title-menu .how-btn');
  await sleep(400);
  for (const tab of ['match', 'combat', 'air', 'terrain', 'loot', 'gold', 'keys']) {
    await p.click(`.rl-tabs button[data-tab="${tab}"]`);
    await sleep(250);
    await shot(`rules-${tab}`);
    const over = await p.evaluate(() => { const b = document.querySelector('.rl-body'); return b.scrollWidth > b.clientWidth + 2; });
    check(!over && inView(await rect('.rules')), `rules/${tab} fits`);
  }
  await p.keyboard.press('Escape');
  check(!(await p.$('.rules-veil')), 'Esc closes the codex');

  // ---- settings
  await p.click('.set-btn');
  await sleep(300);
  await shot('settings-title');
  check(inView(await rect('.settings')), 'settings popover on screen');
  await p.keyboard.press('Escape');
  check(!(await p.$('.settings.on')), 'Esc closes settings');
  await p.click('.set-btn');
  await p.mouse.click(10, H - 10);
  check(!(await p.$('.settings.on')), 'click outside closes settings');
  check(!(await rect('.leave-btn'))?.w, 'no leave button on the title');

  // ---- tutorial: lord pick
  await p.type('.name', 'Tester');
  await p.click('.tutorial');
  check(await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick'), 'tutorial reaches lord pick');
  await sleep(1200);
  await shot('lordpick');
  const cards = await p.$$eval('.lcard', (ns) => ns.map((n) => { const r = n.getBoundingClientRect(); const a = n.querySelector('.lc-block.abil p').getBoundingClientRect(); return { r: [r.left, r.top, r.right, r.bottom], abil: [a.top, a.bottom], vis: a.height > 8 }; }));
  check(cards.length === 4 && cards.every((c) => c.vis && c.r[0] >= 0 && c.r[2] <= W && c.abil[1] <= H), `4 lord cards with their ability text on screen`);
  check(!!(await p.$('.coach.on')), 'coach shows on lord pick');
  check((await frames(2500)) === 0, 'lord pick draws 0 fps');
  await p.click('.lcard[data-lord="marshal"]');
  check(await waitFor(p, () => window.__ob.app.room?.phase === 'planning', null, 30000), 'planning after the pick');
  await sleep(1200);
  check(!!(await p.$('.reveal')) && !(await p.$('.modal.draft')), 'VS reveal plays with no draft modal under it');
  await shot('reveal');
  check(await waitFor(p, () => !!document.querySelector('.modal.draft .dcard'), null, 9000), 'draft opens after the reveal');
  await sleep(900);
  await shot('draft');
  for (let k = 0; k < 2; k++) { const c = await p.$('.modal.draft .dcard:not(.chosen)'); if (c) { await c.click(); await sleep(700); } }
  await sleep(800);
  await p.keyboard.press('Escape');
  await sleep(600);
  await shot('plan-r1');
  // ---- planning layout + framing
  const audit = await layoutAudit(p, ['.tb-side.me', '.tb-mid', '.tb-side.foe', '.r-gold', '.r-army', '.r-ghost', '.stash', '.deploy-badge', '.ready-box', '.shell .corner', '.notices', '.coach', '.ucard']);
  const bad = audit.filter((x) => !/OVERLAP \.shell \.corner x \.coach/.test(x));
  check(bad.length === 0, `planning layout clean ${JSON.stringify(bad.slice(0, 6))}`);
  check((await p.$$('.r-deploy')).length === 0 && (await p.$$('.deploy-badge')).length === 1, '"Deploys left" shown once');
  const zone = await p.evaluate(() => { const s = window.__ob.app.scene; const pts = { fl: [300, 3900], fr: [7700, 3900], ml: [300, 2200], mr: [7700, 2200], bc: [4000, 1300], lord: window.__ob.app.room.view.you.squads[0].pos }; const o = {}; for (const k in pts) o[k] = s.toScreen(pts[k], 0); return o; });
  const hud = { top: Math.max((await rect('.res')).b, (await rect('.topbar')).b), bottom: (await rect('.bottom')).y };
  const vis = (q) => q && q.x >= 0 && q.x <= W && q.y >= hud.top - 2 && q.y <= hud.bottom + 2;
  console.log(`     zone corners ${JSON.stringify(Object.fromEntries(Object.entries(zone).map(([k, v]) => [k, v && [Math.round(v.x), Math.round(v.y)]])))} hud ${JSON.stringify(hud)}`);
  check(vis(zone.lord) && vis(zone.fl) && vis(zone.fr), 'default framing: Lord and the zone front inside the HUD insets');
  // the home view is a low battlefield shot: the last strip in front of the own Keep is cropped by design
  // (reached by scrolling back), so the check is the zone's side edges at mid depth and its back rows at the centre
  check(vis(zone.ml) && vis(zone.mr) && vis(zone.bc), 'default framing: zone side edges (mid depth) and back rows (centre) inside the HUD insets');
  check((await frames(2000)) === 0, 'planning idle 0 fps');
  // ---- deploy with the hotkey, rotate while placing
  const spot = async (pos) => p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), pos);
  let s0 = await state();
  let xy = await spot([2600, 3000]);
  await p.mouse.move(xy.x, xy.y);
  await p.keyboard.press('1');
  await sleep(250);
  await p.keyboard.press('q');
  await sleep(250);
  await shot('placing');
  await p.mouse.click(xy.x, xy.y);
  await sleep(700);
  let s1 = await state();
  check(s1.squads === s0.squads + 1, `hotkey 1 + click deploys (${s0.squads} -> ${s1.squads})`);
  const facing = await p.evaluate(() => window.__ob.app.room.view.you.squads.at(-1).facing);
  check(facing !== 64, `Q while placing turns the squad (facing ${facing})`);
  // Q with nothing held turns the camera, not the selected squad
  await p.mouse.click(xy.x, xy.y);
  await sleep(300);
  check(!!(await p.$('.planning.has-sel')), 'clicking the squad selects it');
  await shot('selected');
  const sp = await rect('.sqpanel'), gh = await rect('.r-ghost');
  check(!(sp.x < gh.r && sp.r > gh.x && sp.y < gh.b && sp.b > gh.y), 'squad panel clear of the enemy-intel label');
  const yaw0 = await p.evaluate(() => window.__ob.app.scene.view.camera.goal.yaw);
  await p.keyboard.down('q'); await sleep(300); await p.keyboard.up('q');
  await sleep(300);
  const f2 = await p.evaluate(() => window.__ob.app.room.view.you.squads.at(-1).facing);
  const yaw1 = await p.evaluate(() => window.__ob.app.scene.view.camera.goal.yaw);
  check(f2 === facing && yaw1 !== yaw0, `plain Q turns the camera only (yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}, facing ${f2})`);
  await p.keyboard.down('Shift'); await p.keyboard.press('q'); await p.keyboard.up('Shift');
  await sleep(400);
  const f3 = await p.evaluate(() => window.__ob.app.room.view.you.squads.at(-1).facing);
  check(f3 !== facing, `Shift+Q turns the selected squad (${facing} -> ${f3})`);
  await p.keyboard.press('Home');
  await sleep(900);
  const yaw2 = await p.evaluate(() => window.__ob.app.scene.view.camera.goal.yaw);
  check(Math.abs(yaw2) < 0.01, `Home resets the camera (yaw ${yaw2.toFixed(2)})`);
  // ---- sell needs two presses
  await p.keyboard.press('Delete');
  await sleep(300);
  let s2 = await state();
  check(s2.squads === s1.squads && !!(await p.$('.sell.armed')), 'Delete arms the sell, does not sell');
  await shot('sell-armed');
  await p.keyboard.press('Escape');
  await sleep(200);
  check(!(await p.$('.sell.armed')), 'Esc disarms it');
  await p.keyboard.press('Escape');
  // second deploy by drag from the shop
  const card = await p.$('.ucard:not(.off)');
  if (card) {
    const cb = await card.boundingBox();
    xy = await spot([5200, 3000]);
    await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await p.mouse.down();
    await p.mouse.move(xy.x, xy.y, { steps: 8 });
    await sleep(200);
    await p.mouse.up();
    await sleep(600);
  }
  check((await state()).squads >= s1.squads + 1, 'drag from the shop deploys');
  // a drop on top of another squad lands beside it
  await sleep(300);
  await shot('plan-r1-deployed');
  // ---- picking: every squad by its centre
  const picks = await p.evaluate(() => { const { app } = window.__ob; return app.room.view.you.squads.map((q) => { const c = app.scene.toScreen(q.pos, 0); const hit = app.scene.squadAt(c.x, c.y); return { type: q.type, ok: hit?.id === q.id }; }); });
  check(picks.every((x) => x.ok), `squads pick at their centre ${JSON.stringify(picks)}`);

  // ---- ready, battle
  await p.keyboard.press('Space');
  check(await waitFor(p, () => !!document.querySelector('.battle'), null, 15000), 'battle starts');
  await sleep(3500);
  await shot('battle');
  const clock = await p.$eval('.tb-clock', (n) => n.textContent.trim());
  check(/\d:\d\d\s*\/ 1:30/.test(clock), `battle clock shows the limit ("${clock}")`);
  const mode = () => p.evaluate(() => window.__ob.app.scene.cameraMode());
  const m0 = await mode();
  await p.keyboard.press('c'); await sleep(250);
  const m1 = await mode();
  await p.keyboard.press('c'); await sleep(250);
  const m2 = await mode();
  check(m0 === 'director' && m1 === 'free' && m2 === 'director', `C toggles director <-> free (${m0} ${m1} ${m2})`);
  // grabbing the camera frees it, C brings the director back
  await p.keyboard.down('w'); await sleep(200); await p.keyboard.up('w'); await sleep(200);
  const m3 = await mode();
  await p.keyboard.press('c'); await sleep(250);
  check(m3 === 'free' && (await mode()) === 'director', 'after WASD, C returns to the director');
  await p.keyboard.press('Enter'); await sleep(250);
  check(!!(await p.$('.chat.on')) && !(await p.$('.battle.over')), 'Enter opens chat in battle (does not skip)');
  await p.keyboard.press('Escape');
  await p.keyboard.press('End');
  check(await waitFor(p, () => !!document.querySelector('.results') || !!document.querySelector('.screen.over'), null, 15000), 'End skips to the results');
  await sleep(1500);
  await shot('results');
  check(inView(await rect('.res-card')), 'results card on screen');
  check((await p.$$('.res-hints li')).length >= 1 && (await p.$$('.rt-row')).length >= 3, 'results explain the round (hints + per-squad table)');
  const fr = await frames(3000);
  check(fr <= 10.5, `results backdrop ${fr} fps (<= 10)`);

  // ---- round 2: loot, report, equip
  check(await waitFor(p, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 2, null, 20000), 'round 2 planning');
  await waitFor(p, () => !!document.querySelector('.modal'), null, 8000);
  await sleep(2600);
  await shot('r2-modal');
  for (let i = 0; i < 4 && (await p.$('.modal')); i++) {
    if (await p.$('.modal.loot')) { await sleep(1800); await shot('loot'); const t = await p.$('.modal.loot .drop .take'); if (t) await t.click(); await sleep(1100); }
    else if (await p.$('.modal.draft')) { const c = await p.$('.modal.draft .dcard'); if (c) await c.click(); await sleep(1500); }
    await waitFor(p, () => !!document.querySelector('.modal'), null, 1500);
  }
  await sleep(500);
  await shot('plan-r2');
  if (await p.$('.report-n')) {
    await p.click('.report-n');
    await sleep(400);
    await shot('report');
    check(inView(await rect('.report')), 'battle report overlay on screen');
    await p.keyboard.press('Escape');
  } else check(false, 'battle report notice present in round 2');
  // stash tooltip must not cover the item
  const it = await p.$('.stash-grid .islot.item');
  if (it) {
    const ib = await it.boundingBox();
    await p.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await sleep(350);
    const tip = await rect('.tip-layer.on');
    check(tip && (tip.b <= ib.y + 1 || tip.y >= ib.y + ib.height - 1 || tip.x >= ib.x + ib.width - 1 || tip.r <= ib.x + 1), 'item tooltip does not cover the item');
    await shot('stash-tip');
  }
  const uc = await p.$('.ucard');
  if (uc) {
    const ub = await uc.boundingBox();
    await p.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2);
    await sleep(350);
    const tip = await rect('.tip-layer.on');
    check(tip && tip.b <= ub.y + 1, 'shop tooltip sits above its card');
    await shot('shop-tip');
    await p.mouse.move(W / 2, H / 2);
  }

  // ---- late-game shop: every unit type unlocked
  for (const n of [9, 11, 14]) {
    await p.evaluate((n) => { const { app } = window.__ob; const all = ['militia', 'pikemen', 'archers', 'berserkers', 'clerics', 'knights', 'cavaliers', 'mages', 'pegasus', 'ballista', 'trebuchet', 'wyvern', 'golem', 'dragon']; app.local.s.players[0].unlocked = all.slice(0, n); app.local.s.players[0].gold = 900; app.local.emit(); }, n);
    await sleep(500);
    const r = await p.evaluate(() => { const shop = document.querySelector('.shop').getBoundingClientRect(); const badge = document.querySelector('.deploy-badge').getBoundingClientRect(); const ready = document.querySelector('.ready-box').getBoundingClientRect(); const cs = [...document.querySelectorAll('.ucard')].map((c) => c.getBoundingClientRect()); return { mode: document.querySelector('.shop').dataset.mode, n: cs.length, ok: cs.every((c) => c.left >= badge.right - 0.5 && c.right <= ready.left + 0.5 && c.left >= shop.left - 0.5 && c.right <= shop.right + 0.5 && c.bottom <= innerHeight && c.width > 40), keys: [...document.querySelectorAll('.ucard kbd')].map((k) => k.textContent).join('') }; });
    check(r.n === n && r.ok, `shop with ${n} units fits between the badge and Ready (${r.mode}, keys ${r.keys})`);
    await shot(`shop-${n}`);
  }
  // hotkey 0 picks the 10th card
  await p.mouse.move(W / 2, H * 0.6);
  await p.keyboard.press('0');
  await sleep(250);
  check(!!(await p.$('.ucard.arming')), 'hotkey 0 arms the 10th unit');
  await p.keyboard.press('Escape');

  // ---- settings in a match: quality, leave
  await p.click('.set-btn');
  await sleep(300);
  await shot('settings-match');
  check(inView(await rect('.settings')), 'settings popover on screen in a match');
  await p.click('.quality button[data-q="low"]');
  await sleep(600);
  const q = await p.evaluate(() => ({ q: window.__ob.app.scene.quality(), keys: Object.keys(localStorage).filter((k) => /fps|saver|batterySaver|quality/i.test(k)) }));
  check(q.q.choice === 'low', `quality selector sets the tier (${JSON.stringify(q)})`);
  check(!q.keys.includes('oathbound.fps') && !q.keys.includes('oathbound.saver'), 'power settings live under the renderer keys only');
  await p.click('.quality button[data-q="auto"]');
  await p.click('.leave-set');
  await sleep(300);
  await shot('leave-confirm');
  check(!!(await p.$('.dialog-veil')), 'Leave match asks first');
  await p.keyboard.press('Escape');
  await sleep(200);
  check(!(await p.$('.dialog-veil')) && (await state())?.phase === 'planning', 'Esc keeps playing');
  await p.click('.leave-btn');
  await sleep(200);
  await p.click('.dialog .yes');
  check(await waitFor(p, () => !!document.querySelector('.title-menu') && !window.__ob.app.room, null, 5000), 'Leave match returns to the title');
} catch (e) {
  console.log('EXCEPTION', e);
  fails++;
  await shot('exception').catch(() => {});
} finally {
  await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails || errors.length ? 1 : 0);
