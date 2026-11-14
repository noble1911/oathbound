import { launch, newPage, shot, sleep, log, waitFor } from './lib.mjs';
const browser = await launch();
const p = await newPage(browser, 'units', { w: 1920, h: 1080, url: '?dev=planning&lord=warden&timer=0&round=8' });
await sleep(5000);
await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u }); if (me.lootOffer) app.backend.intent({ t: 'pickLoot', index: 0 }); });
await sleep(500); await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
console.log(await p.evaluate(() => { const v = window.__ob.app.room.view; return { round: v.round, gold: v.you.gold, unlocked: v.you.unlocked, squads: v.you.squads.map((s) => s.type + '@' + s.pos) }; }));
let last = -1; while (last !== p.__net.bytes) { last = p.__net.bytes; await sleep(2500); }
await p.mouse.move(960, 600);
for (let i = 0; i < 5; i++) { await p.mouse.wheel({ deltaY: -300 }); await sleep(80); }
await sleep(1500); await shot(p, 'units-zoom-a');
await p.keyboard.down('a'); await sleep(700); await p.keyboard.up('a'); await sleep(800); await shot(p, 'units-zoom-b');
await p.keyboard.down('d'); await sleep(1400); await p.keyboard.up('d'); await sleep(800); await shot(p, 'units-zoom-c');
// battle: C key toggle test
await p.keyboard.press('Space');
await waitFor(p, () => !!document.querySelector('.battle'), null, 30000);
await sleep(9000);
const cam = () => p.evaluate(() => document.querySelector('.cam button.on')?.dataset.c);
console.log('cam at start', await cam());
await p.keyboard.press('c'); await sleep(400); console.log('after C #1', await cam());
await p.keyboard.press('c'); await sleep(400); console.log('after C #2 (expect director)', await cam());
await p.keyboard.press('c'); await sleep(400); console.log('after C #3', await cam());
await p.click('.cam button[data-c="director"]'); await sleep(3000);
await shot(p, 'units-battle-director-12s'); await sleep(6000); await shot(p, 'units-battle-director-18s'); await sleep(6000); await shot(p, 'units-battle-director-24s');
console.log([...new Set(log)].filter((l) => !/X4122|X3595|X4000|^\(/.test(l)).join('\n'));
await browser.close();
