// Art review shots on the live site: every unit type at RTS distance and close (cursor zoom), camera
// home/reset, environment close-ups, and a late-round dev battle for VFX.
import { launch, newPage, shot, sleep, fps, log, waitFor } from './lib.mjs';
import fs from 'node:fs';
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync('e2e/qa2/out-units.txt', out.join('\n')); };
const W = 1920, H = 1080;
const browser = await launch();
const which = process.argv[2] || 'all';
const camState = (p) => p.evaluate(() => { const c = window.__ob.app.scene.view.camera; const o = {}; for (const k of ['mode', 'dist', 'yaw', 'pitch', 'distance', 'zoom']) if (typeof c[k] !== 'object' && c[k] !== undefined) o[k] = typeof c[k] === 'number' ? +c[k].toFixed(3) : c[k]; const cam = window.__ob.app.scene.view.engine?.camera; if (cam) o.pos = cam.position.toArray().map((v) => +v.toFixed(1)); return o; });
if (which === 'all' || which === 'units') {
  const p = await newPage(browser, 'units', { w: W, h: H, url: '?dev=planning&timer=0&round=2' });
  await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob.app.scene, null, 40000);
  await sleep(1500);
  for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(300); }
  await p.evaluate(() => { const b = document.querySelector('.quality button[data-q="high"]'); b?.click(); });
  const groups = [['militia', 'pikemen', 'berserkers', 'archers', 'knights'], ['cavaliers', 'mages', 'clerics', 'pegasus', 'ballista'], ['trebuchet', 'golem', 'wyvern', 'dragon']];
  for (let g = 0; g < groups.length; g++) {
    await p.evaluate((units) => {
      const { app } = window.__ob; const me = app.local.s.players[0];
      me.unlocked = units; me.gold = 9000; me.deployLimit = 40; me.deploysUsed = 0;
      me.squads = me.squads.filter((q) => q.type === 'lord');
      units.forEach((u, i) => app.backend.intent({ t: 'deploy', unit: u, pos: [1300 + i * 1350, 2700] }));
    }, groups[g]);
    await sleep(800);
    await waitFor(p, (n) => window.__ob.app.scene.view.units.slots.length >= n, 6, 20000);
    await sleep(7000);
    await p.keyboard.press('Home'); await sleep(1200);
    await p.mouse.move(W / 2, 300); await sleep(500);
    await shot(p, `units-g${g}-rts`);
    if (g === 0) say('home camera', await camState(p), 'idle fps', await fps(p, 2000));
    const sq = await p.evaluate(() => window.__ob.app.room.view.you.squads.map((q) => ({ id: q.id, type: q.type, pos: q.pos })));
    say(`group ${g}:`, sq.map((s) => s.type));
    for (const s of sq) {
      if (s.type === 'lord' && g > 0) continue;
      await p.keyboard.press('Home'); await sleep(900);
      let xy = await p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), s.pos);
      await p.mouse.move(xy.x, xy.y);
      for (let k = 0; k < 9; k++) { await p.mouse.wheel({ deltaY: -240 }); await sleep(180); xy = await p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), s.pos); if (xy) await p.mouse.move(Math.max(200, Math.min(W - 200, xy.x)), Math.max(200, Math.min(H - 250, xy.y))); }
      await sleep(1600);
      xy = await p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), s.pos);
      const drift = xy ? Math.hypot(xy.x - W / 2, xy.y - H / 2) | 0 : null;
      await p.mouse.move(40, H - 300); await sleep(700);
      await shot(p, `unit-${s.type}-close`);
      say(`  ${s.type}: after cursor zoom squad at screen ${xy ? [xy.x | 0, xy.y | 0] : null} (dist from centre ${drift}) cam`, await camState(p));
    }
  }
  // Home reset check after zoom + rotate
  await p.keyboard.press('q'); await p.keyboard.press('q'); await sleep(600);
  const rot = await camState(p);
  await p.keyboard.press('Home'); await sleep(1200);
  say('camera rotated+zoomed', rot, '-> after Home', await camState(p));
  await shot(p, 'units-home-after-reset');
  // environment close-ups: river/ford, bridge, forest edge, hill, keep
  const spots = { river: [2000, 6000], bridge: [4000, 6000], forestL: [900, 4200], keep: [4000, 500], tower: [2500, 650], enemyKeep: [4000, 11500] };
  const terr = await p.evaluate(() => { const t = window.__ob.app.room.view.terrain; return t?.features?.map((f) => ({ k: f.kind ?? f.type, x: f.x ?? f.pos?.[0], y: f.y ?? f.pos?.[1], w: f.w, h: f.h, r: f.r })) ?? Object.keys(t ?? {}); });
  say('terrain features', terr);
  for (const [name, pos] of Object.entries(spots)) {
    await p.keyboard.press('Home'); await sleep(900);
    let xy = await p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), pos);
    if (!xy) { say('no screen pos for', name); continue; }
    await p.mouse.move(Math.max(100, Math.min(W - 100, xy.x)), Math.max(100, Math.min(H - 100, xy.y)));
    for (let k = 0; k < 7; k++) { await p.mouse.wheel({ deltaY: -240 }); await sleep(180); xy = await p.evaluate((pos) => window.__ob.app.scene.toScreen(pos, 0), pos); if (xy) await p.mouse.move(Math.max(200, Math.min(W - 200, xy.x)), Math.max(200, Math.min(H - 250, xy.y))); }
    await sleep(1800); await p.mouse.move(40, H - 300); await sleep(500);
    await shot(p, `env-${name}`);
  }
  // furthest zoom-out + rotated
  await p.keyboard.press('Home'); await sleep(800); await p.mouse.move(W / 2, H / 2);
  for (let k = 0; k < 12; k++) { await p.mouse.wheel({ deltaY: 300 }); await sleep(120); }
  await sleep(1500); await shot(p, 'env-max-zoomout'); say('max zoom-out cam', await camState(p));
  await p.mouse.move(W / 2, H / 2); await p.mouse.down({ button: 'right' }); await p.mouse.move(W / 2 + 500, H / 2, { steps: 10 }); await p.mouse.up({ button: 'right' }); await sleep(1500);
  await shot(p, 'env-rotated'); say('rotated cam', await camState(p));
  say('stats', await p.evaluate(() => { const s = window.__ob.app.scene.view.stats; return { tier: s.tier, draws: s.drawCalls, tris: s.triangles, gpu: s.gpu }; }));
  await p.close();
}
if (which === 'all' || which === 'battle') {
  for (const [round, seed] of [[9, 63], [12, 5]]) {
    const p = await newPage(browser, 'vfx' + round, { w: W, h: H, url: `?dev=battle&round=${round}&seed=${seed}` });
    await waitFor(p, () => !!document.querySelector('.battle'), null, 40000);
    await p.mouse.click(5, 700);
    const info = await p.evaluate(() => { const r = window.__ob.app.lastBattle?.replay; return r ? { sec: r.ticks / 20, soldiers: r.soldiers.length, types: [...new Set(r.soldiers.map((s) => s.type))] } : null; });
    say(`dev battle r${round}`, info);
    for (const t of [3, 7, 11, 15, 19, 24, 30, 38]) {
      const now = await p.evaluate(() => (window.__ob.app.scene.view.playback?.timeMs ?? 0) / 1000).catch(() => 0);
      await sleep(Math.max(200, (t - (now || 0)) * 1000 > 0 && now ? (t - now) * 1000 : 3800));
      if (!(await p.$('.battle:not(.over)'))) break;
      await shot(p, `vfx-r${round}-t${String(t).padStart(2, '0')}`);
      if (t === 11) say(`  r${round} battle fps`, await fps(p, 2000), await p.evaluate(() => { const s = window.__ob.app.scene.view.stats; return { tier: s.tier, draws: s.drawCalls, tris: s.triangles, soldiers: s.soldiers, frameMs: s.frameMs, gpuMs: s.gpuMs }; }));
      if (t === 15) { await p.keyboard.press('c'); await sleep(300); await p.mouse.move(W / 2, H / 2); for (let k = 0; k < 6; k++) { await p.mouse.wheel({ deltaY: 300 }); await sleep(100); } await sleep(900); await shot(p, `vfx-r${round}-free-wide`); for (let k = 0; k < 12; k++) { await p.mouse.wheel({ deltaY: -300 }); await sleep(100); } await sleep(900); await shot(p, `vfx-r${round}-free-close`); say('  free close cam', await camState(p)); await p.keyboard.press('c'); await sleep(500); say('  C back -> mode', (await camState(p)).mode); }
    }
    await waitFor(p, () => document.querySelector('.battle.over') || !document.querySelector('.battle'), null, 100000);
    await sleep(800); await shot(p, `vfx-r${round}-end`);
    await p.close();
  }
}
say('LOG\n' + [...new Set(log)].join('\n'));
await browser.close();
