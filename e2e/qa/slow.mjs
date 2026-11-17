// First visit on a 10 Mbit/s connection: what does the player see while 20 MB of models stream in?
import { launch, newPage, shot, sleep, log, waitFor, BASE } from './lib.mjs';
const browser = await launch();
const p = await newPage(browser, 'slow', { w: 1366, h: 768, url: null });
await p.__cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: (10 * 1e6) / 8, uploadThroughput: (2 * 1e6) / 8 });
const t0 = Date.now();
const nav = p.goto(BASE, { waitUntil: 'domcontentloaded' });
for (const t of [600, 1500, 3000]) { await sleep(t - (Date.now() - t0)); await shot(p, `slow-boot-${t}ms`); console.log(t, 'booted', await p.evaluate(() => document.body.classList.contains('booted')).catch(() => 'n/a'), 'MB', (p.__net.bytes / 1e6).toFixed(2)); }
await nav;
await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
console.log('booted at', Date.now() - t0, 'ms; MB', (p.__net.bytes / 1e6).toFixed(2));
await shot(p, 'slow-booted');
console.log('loading indicator elements:', await p.evaluate(() => [...document.querySelectorAll('[class*=load],[class*=progress],[class*=spinner]')].map((e) => e.className)));
// play immediately
await p.click('.vsai');
await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick', null, 30000);
await sleep(700); // the Lord pick ignores presses in its first 600 ms (they were meant for the screen before it)
await p.click('.lcard[data-lord="warden"]');
await waitFor(p, () => window.__ob.app.room?.phase === 'planning', null, 30000);
const t1 = Date.now();
await sleep(4500);
for (let k = 0; k < 2; k++) { const c = await p.$('.modal.draft .dcard:not(.chosen)'); if (c) { await c.click(); await sleep(600); } }
await p.keyboard.press('Escape');
const card = await p.$('.ucard:not(.off)'); await card.click();
const xy = await p.evaluate(() => window.__ob.app.scene.toScreen([4000, 3300], 0)); await p.mouse.move(xy.x, xy.y, { steps: 3 }); await p.mouse.click(xy.x, xy.y);
for (const t of [500, 2500, 6000, 12000]) { await sleep(t - (Date.now() - t1 - 6000) > 0 ? 1500 : 500); await shot(p, `slow-plan-after-deploy-${t}`); console.log('plan +', Date.now() - t1, 'MB', (p.__net.bytes / 1e6).toFixed(2), 'pending-ish reqs', p.__net.reqs); }
// wait until network quiet
let last = -1; while (last !== p.__net.bytes) { last = p.__net.bytes; await sleep(2500); }
console.log('network quiet at', Date.now() - t0, 'ms total; MB', (p.__net.bytes / 1e6).toFixed(2));
await shot(p, 'slow-plan-final');
// offline skirmish from a fresh page (no throttle)
const q = await newPage(browser, 'offline', { w: 1366, h: 768 });
await q.click('.offline');
const ok = await waitFor(q, () => ['lordPick', 'planning'].includes(window.__ob.app.room?.phase), null, 10000);
await sleep(1000); await shot(q, 'offline-skirmish');
console.log('offline skirmish starts:', ok, await q.evaluate(() => window.__ob.app.room?.phase));
console.log([...new Set(log)].filter((l) => !/X4122|X3595|X4000|^\(/.test(l)).join('\n'));
await browser.close();
