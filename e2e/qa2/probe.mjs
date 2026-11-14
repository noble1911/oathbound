// Small follow-up probes: quality persistence, results/over fps, berserker + wyvern close-ups, flier zoom clipping.
import { launch, newPage, shot, sleep, fps, log, waitFor } from './lib.mjs';
const browser = await launch();
const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const ctx = await browser.createBrowserContext();
const open = async (url = '') => { const p = await ctx.newPage(); await p.setViewport({ width: 1920, height: 1080 }); await p.goto('https://games.noblehaus.uk/oathbound/' + url, { waitUntil: 'load' }); await p.waitForFunction(() => document.body.classList.contains('booted')); return p; };
const q = (p) => p.evaluate(() => ({ stored: localStorage.getItem('oathbound.render.quality'), stats: (() => { const s = window.__ob.app.scene?.view?.stats; return s ? { tier: s.tier, auto: s.auto, cap: s.fpsCap } : null; })(), on: document.querySelector('.quality button.on')?.dataset.q ?? null, note: document.querySelector('.q-note')?.textContent }));
let p = await open();
await sleep(2500);
await p.click('.set-btn'); await sleep(400);
say('fresh', await q(p));
await p.click('.quality button[data-q="ultra"]'); await sleep(2000);
say('after ultra on title', await q(p));
await p.close();
p = await open(); await sleep(2500); await p.click('.set-btn'); await sleep(400);
say('reload after ultra', await q(p));
await p.keyboard.press('Escape');
// during a battle: change tier, then reload
await p.goto('https://games.noblehaus.uk/oathbound/?dev=battle&round=6&seed=3', { waitUntil: 'load' });
await waitFor(p, () => !!document.querySelector('.battle'), null, 40000); await sleep(3000);
await p.click('.set-btn'); await sleep(300);
say('in battle before', await q(p));
await p.click('.quality button[data-q="low"]'); await sleep(2500);
say('in battle after low', await q(p));
await p.click('.quality button[data-q="ultra"]'); await sleep(2500);
say('in battle after ultra', await q(p));
await p.keyboard.press('Escape');
await p.keyboard.press('End');
await waitFor(p, () => !!document.querySelector('.results'), null, 30000); await sleep(1200);
say('results fps (1.2 s in)', await fps(p, 1500), ' then', await fps(p, 1500));
await shot(p, 'probe-results');
await p.close();
p = await open(); await sleep(2500); await p.click('.set-btn'); await sleep(400);
say('reload after in-battle ultra', await q(p));
await p.close();
// berserkers + wyvern + flier zoom
p = await open('?dev=planning&timer=0&round=2');
await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob.app.scene, null, 40000); await sleep(1500);
for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(300); }
const res = await p.evaluate(() => { const { app } = window.__ob; const me = app.local.s.players[0]; me.unlocked = ['berserkers', 'wyvern', 'pegasus', 'dragon']; me.gold = 9000; me.deployLimit = 40; me.deploysUsed = 0; me.squads = me.squads.filter((q) => q.type === 'lord'); const r = []; [['berserkers', [1500, 3000]], ['wyvern', [2800, 3000]], ['pegasus', [5400, 3000]], ['dragon', [6600, 3000]], ['berserkers', [1500, 3000]], ['berserkers', [1700, 3100]]].forEach(([u, pos]) => r.push(u + ':' + JSON.stringify(app.backend.intent({ t: 'deploy', unit: u, pos })))); return r; });
say('deploy results (last two overlap the first)', res);
await sleep(9000);
say('toasts', await p.evaluate(() => [...document.querySelectorAll('.toast')].map((n) => n.textContent)));
const sq = await p.evaluate(() => window.__ob.app.room.view.you.squads.map((q) => ({ id: q.id, type: q.type, pos: q.pos })));
say('squads', sq);
await p.keyboard.press('Home'); await sleep(900); await p.mouse.move(960, 300); await sleep(400); await shot(p, 'probe-fliers-rts');
for (const s of sq.filter((x) => x.type !== 'lord')) {
  await p.keyboard.press('Home'); await sleep(900);
  let xy = await p.evaluate((id) => window.__ob.app.scene.view.squadScreen(id, 0.5) ?? null, s.id) ?? await p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), s.pos);
  await p.mouse.move(xy.x, xy.y);
  for (let k = 0; k < 5; k++) { await p.mouse.wheel({ deltaY: -240 }); await sleep(200); xy = (await p.evaluate((id) => window.__ob.app.scene.view.squadScreen(id, 0.5) ?? null, s.id)) ?? xy; await p.mouse.move(Math.max(200, Math.min(1700, xy.x)), Math.max(200, Math.min(800, xy.y))); }
  await sleep(1500); await p.mouse.move(40, 780); await sleep(600);
  await shot(p, `probe-${s.type}-mid`);
  say(s.type, 'cam', await p.evaluate(() => { const c = window.__ob.app.scene.view.camera; return { dist: +c.dist?.toFixed?.(1), pitch: +c.pitch?.toFixed?.(2) }; }));
}
console.log([...new Set(log)].join('\n'));
await browser.close();
