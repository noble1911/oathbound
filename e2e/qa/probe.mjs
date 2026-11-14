// Focused probes on the live site: visibility of the field under the HUD, squad hit-testing, camera, settings, power.
import { launch, newPage, shot, sleep, fps, log, waitFor, state } from './lib.mjs';
import fs from 'node:fs';
const W = +(process.env.W || 1920), H = +(process.env.H || 1080), TAG = process.env.TAG || 'probe';
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync(`e2e/qa/out-${TAG}.txt`, out.join('\n')); };
const browser = await launch();
const p = await newPage(browser, TAG, { w: W, h: H });
const S = (n) => shot(p, `${TAG}-${n}`);
const frames = () => p.evaluate(() => window.__ob.app.scene.framesDrawn);
await p.type('.name', 'Probe');
await p.click('.diff button[data-lvl="easy"]');
await p.click('.vsai');
await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick', null, 30000);
await p.click('.lcard[data-lord="marshal"]');
await waitFor(p, () => window.__ob.app.room?.phase === 'planning', null, 30000);
await sleep(4500);
// draft via UI
for (let k = 0; k < 2; k++) { const c = await p.$('.modal.draft .dcard:not(.chosen)'); if (c) { await c.click(); await sleep(700); } }
await p.keyboard.press('Escape'); await sleep(500);
const toScreen = (pos, h = 0) => p.evaluate((pos, h) => window.__ob.app.scene.toScreen(pos, h), pos, h);
const hud = await p.evaluate(() => Object.fromEntries(['.topbar', '.bottom', '.shop', '.ready-box', '.stash', '.deploy-badge', '.res', '.sqpanel'].map((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return [s, r ? [r.left | 0, r.top | 0, r.right | 0, r.bottom | 0] : null]; })));
say('HUD rects', hud);
const pts = { lord: (await state(p)).squads[0].pos, myKeep: [4000, 150], zoneFL: [0, 4000], zoneFR: [8000, 4000], zoneBL: [0, 400], zoneBR: [8000, 400], zoneBackMid: [4000, 400], zoneMid: [4000, 2200], river: [4000, 6000], enemyZoneFront: [4000, 8000], enemyZoneMid: [4000, 9800], enemyZoneBack: [4000, 11600], enemyKeep: [4000, 11850] };
const vis = {};
for (const [k, v] of Object.entries(pts)) { const s = await toScreen(v); vis[k] = s ? [s.x | 0, s.y | 0, s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H ? 'onscreen' : 'OFFSCREEN'] : null; }
say('default planning camera, field points -> screen', vis);
// what DOM element is on top at the lord's screen position
const lordXY = await toScreen(pts.lord);
say('element over lord:', lordXY ? await p.evaluate((x, y) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + e.className : null; }, lordXY.x, lordXY.y) : 'offscreen');
await S('default-view');
// ---- deploy two squads and test hit-testing
async function deploy(u, pos) { const c = await p.$(`.ucard[data-u="${u}"]:not(.off)`); if (!c) return false; await c.click(); await sleep(150); const xy = await toScreen(pos); await p.mouse.move(xy.x, xy.y, { steps: 4 }); await sleep(150); await p.mouse.click(xy.x, xy.y); await sleep(500); return true; }
say('unlocked', (await state(p)).unlocked);
await deploy('cavaliers', [4000, 3300]);
await deploy('militia', [2600, 3300]);
let st = await state(p);
say('squads', st.squads);
for (const sq of st.squads) {
  const c = await toScreen(sq.pos);
  if (!c) { say('hit-test', sq.type, 'offscreen'); continue; }
  const res = await p.evaluate((cx, cy) => { const s = window.__ob.app.scene; let rows = []; for (let dy = -40; dy <= 40; dy += 8) { let row = ''; for (let dx = -64; dx <= 64; dx += 8) { const h = s.squadAt(cx + dx, cy + dy); row += h ? (h.ghost ? 'g' : '#') : '.'; } rows.push(row); } return rows; }, c.x, c.y);
  say(`hit-test map for ${sq.type} (centre of grid = squad centre, 8px cells):\n` + res.join('\n'));
}
await S('hit-test');
// ---- stacking: can two squads share one position?
st = await state(p);
// ---- deploy outside zone
const cardM = await p.$('.ucard:not(.off)');
if (cardM) { await cardM.click(); const xy = await toScreen([4000, 6000]); await p.mouse.move(xy.x, xy.y, { steps: 4 }); await sleep(300); await S('deploy-outside-preview'); await p.mouse.click(xy.x, xy.y); await sleep(500); say('toast after outside deploy:', await p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent))); await S('deploy-outside-toast'); await p.keyboard.press('Escape'); }
// ---- idle fps and camera
await p.mouse.move(W / 2, H * 0.4); await sleep(1500);
say('planning idle fps', await fps(p, 3000));
let f0 = await frames();
await p.mouse.move(W / 2 + 100, H * 0.4 + 50, { steps: 20 }); await sleep(500);
say('frames drawn by a plain mouse move over the field:', (await frames()) - f0);
// wheel zoom in/out limits
await p.mouse.move(W / 2, H / 2);
for (let i = 0; i < 12; i++) { await p.mouse.wheel({ deltaY: -300 }); await sleep(60); } await sleep(900); await S('cam-zoom-in-max');
for (let i = 0; i < 30; i++) { await p.mouse.wheel({ deltaY: 300 }); await sleep(60); } await sleep(900); await S('cam-zoom-out-max');
const vis2 = {};
for (const [k, v] of Object.entries(pts)) { const s = await toScreen(v); vis2[k] = s ? [s.x | 0, s.y | 0, s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H ? 'onscreen' : 'OFFSCREEN'] : null; }
say('max zoom-out, field points -> screen', vis2);
// pan with W
await p.keyboard.down('w'); await sleep(1500); await p.keyboard.up('w'); await sleep(600); await S('cam-pan-w');
// rotate camera with Q (nothing selected)
await p.keyboard.down('q'); await sleep(1200); await p.keyboard.up('q'); await sleep(600); await S('cam-rotate-q');
say('after rotate, facing of squads (should be unchanged):', (await p.evaluate(() => window.__ob.app.room.view.you.squads.map((s) => s.facing))));
// is there a reset? try Home, then F, then double-click
await p.keyboard.press('Home'); await sleep(900); await S('cam-after-home');
const vis3 = {}; for (const k of ['zoneFL', 'zoneFR', 'zoneBackMid']) { const s = await toScreen(pts[k]); vis3[k] = s ? [s.x | 0, s.y | 0] : null; }
say('after Home key: zone corners', vis3, '(default was', { zoneFL: vis.zoneFL, zoneFR: vis.zoneFR, zoneBackMid: vis.zoneBackMid }, ')');
await sleep(1500);
say('fps 2s after camera input stops', await fps(p, 2500));
// ---- sell / keys
st = await state(p);
const mil = st.squads.find((s) => s.type === 'militia');
if (mil) {
  const g0 = st.gold;
  await p.evaluate((id) => { /* select through UI by clicking */ }, mil.id);
  const xy = await toScreen(mil.pos);
  if (xy) { await p.mouse.click(xy.x - 8, xy.y); await sleep(300); }
  let sel = await p.evaluate(() => document.querySelector('.planning')?.classList.contains('has-sel'));
  say('militia selected after camera moved:', sel);
  if (sel) { await p.keyboard.press('Backspace'); await sleep(500); const s2 = await state(p); say(`Backspace on selected squad: squads ${st.squads.length} -> ${s2.squads.length}, gold ${g0} -> ${s2.gold} (no confirmation dialog: ${!(await p.$('.confirm, .modal'))})`); await S('after-backspace-sell'); }
}
// ---- settings
await p.click('.set-btn'); await sleep(300);
await S('settings-planning');
say('settings rect', await p.evaluate(() => { const r = document.querySelector('.settings').getBoundingClientRect(); return [r.left | 0, r.top | 0, r.right | 0, r.bottom | 0, innerWidth, innerHeight]; }));
// Escape closes settings?
await p.keyboard.press('Escape'); await sleep(300);
say('Escape closes settings:', !(await p.evaluate(() => document.querySelector('.settings').classList.contains('on'))));
await p.evaluate(() => document.querySelector('.settings').classList.add('on'));
// click outside closes?
await p.mouse.click(W / 2, H / 2); await sleep(300);
say('click-outside closes settings:', !(await p.evaluate(() => document.querySelector('.settings').classList.contains('on'))));
await p.evaluate(() => document.querySelector('.settings').classList.add('on'));
// volume slider
await p.evaluate(() => { const r = document.querySelector('.settings input[data-k="volume"]'); r.value = '0.3'; r.dispatchEvent(new Event('input', { bubbles: true })); });
await p.click('.fps button[data-fps="30"]'); await sleep(200);
say('storage after settings', await p.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))));
say('sound state', await p.evaluate(() => { const s = window.__ob.sound; return { volume: s.volume, sfx: s.sfx, ui: s.ui, muted: s.muted, ctx: s.ctx?.state }; }));
await p.evaluate(() => document.querySelector('.settings').classList.remove('on'));
// M key mute while typing name? chat focus M
await p.keyboard.press('m'); await sleep(200);
say('M toggles mute:', await p.evaluate(() => window.__ob.sound.muted));
await p.keyboard.press('m');
// ---- ready, battle with 30fps cap
await p.keyboard.press('Space');
await waitFor(p, () => !!document.querySelector('.battle'), null, 100000);
await sleep(3000);
say('battle fps with 30 cap:', await fps(p, 4000));
await p.click('.set-btn'); await sleep(200); await p.click('.fps button[data-fps="60"]'); await sleep(200);
say('battle fps with 60 cap:', await fps(p, 4000));
await p.click('.saver-ck'); await sleep(300);
say('battle fps with battery saver:', await fps(p, 4000));
await S('battle-settings-open');
await p.click('.saver-ck'); await p.click('.close-set');
// 4x speed
await p.click('.speed button[data-s="4"]'); await sleep(500); say('battle fps at 4x:', await fps(p, 3000)); await S('battle-4x');
// hidden tab emulation
await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(500); say('battle fps while tab "hidden" (emulated):', await fps(p, 3000));
await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
// resize mid-battle
await p.setViewport({ width: 1024, height: 768 }); await sleep(1200); await S('battle-resized-1024');
say('canvas size after resize', await p.evaluate(() => { const c = window.__ob.app.scene.canvas; const r = c.getBoundingClientRect(); return [r.width, r.height, c.width, c.height, devicePixelRatio]; }));
await p.setViewport({ width: W, height: H }); await sleep(800);
// Enter = skip (documented), check the Enter/chat conflict
await p.keyboard.press('Enter'); await sleep(1500);
say('after Enter in battle: battle over?', await p.evaluate(() => !!document.querySelector('.battle.over') || !document.querySelector('.battle')), 'chat open?', await p.evaluate(() => document.querySelector('.chat').classList.contains('on')));
await waitFor(p, () => window.__ob.app.room?.phase === 'results' || !!document.querySelector('.results'), null, 30000);
await sleep(800); await S('results');
say('results fps', await fps(p, 2500));
await waitFor(p, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 2, null, 30000);
await sleep(3000);
// round 2: where are the ghosts on screen?
const ghosts = await p.evaluate(() => { const { app } = window.__ob; return (app.room.view.enemy.lastArmy ?? []).map((s) => { const xy = app.scene.toScreen(s.pos, 0); return { type: s.type, pos: s.pos, screen: xy ? [xy.x | 0, xy.y | 0] : null, on: !!xy && xy.x >= 0 && xy.x <= innerWidth && xy.y >= 0 && xy.y <= innerHeight }; }); });
say('round 2 enemy ghosts on screen with the default camera:', ghosts);
await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await sleep(400);
await S('r2-default-view');
// leave mid-match -> title? is there a leave / surrender button at all?
say('leave/surrender/menu buttons present in planning:', await p.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /leave|surrender|quit|menu|concede/i.test(b.textContent + ' ' + b.className + ' ' + (b.dataset.tip || ''))).map((b) => b.className)));
// reload mid-planning -> rejoin
const before = await state(p);
await p.reload({ waitUntil: 'load' });
await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
const back = await waitFor(p, () => window.__ob.app.room?.phase === 'planning', null, 15000);
await sleep(2500);
const after = await state(p);
say('reload mid-planning rejoined:', back, 'round', after?.round, 'squads', after?.squads?.length, 'vs before', before.squads.length, 'timer left', after?.left);
await S('after-reload');
say('LOG\n' + [...new Set(log)].filter((l) => !/X4122|X3595|X4000|^\(/.test(l)).join('\n'));
await browser.close();
