// The slim top HUD (no bar: two corner plaques and a centre medallion): five screenshots and the
// measurements that matter, with one browser and its own short-lived server. Light on purpose.
//   npx vite build && node e2e/ux/tophud.mjs        -> e2e/shots/tophud-<W>-{planning,battle}.png
import { spawn } from 'node:child_process';
import path from 'node:path';
import { launch, sleep, waitFor } from '../qa/lib.mjs';

const PORT = process.env.PORT || '3053';
const BASE = `http://127.0.0.1:${PORT}/`;
const server = spawn(process.execPath, ['server/index.ts'], { env: { ...process.env, PORT }, stdio: 'ignore' });
await sleep(1500);
const browser = await launch();
let fails = 0;
const errors = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

async function page(w, h, url) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 40000 });
  return { p, ctx };
}
// the top HUD's pieces: how tall the opaque area is, whether anything spans the width, overlaps, and the engine's top inset
const measure = (p) => p.evaluate(() => {
  const box = (q) => { const n = document.querySelector(q); if (!n || !n.getClientRects().length) return null; const r = n.getBoundingClientRect(); return { q, x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width }; };
  const parts = ['.tb-side.me', '.tb-mid', '.tb-side.foe', '.r-gold', '.r-army', '.r-ghost', '.b-tally'].map(box).filter(Boolean);
  const others = ['.shell .corner', '.notices', '.sqpanel', '.insp.on'].map(box).filter(Boolean);
  const hit = (a, b) => a.x < b.r - 1 && a.r > b.x + 1 && a.y < b.b - 1 && a.b > b.y + 1;
  const overlaps = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (hit(parts[i], parts[j])) overlaps.push(`${parts[i].q} x ${parts[j].q}`);
  for (const a of parts) for (const b of others) if (hit(a, b)) overlaps.push(`${a.q} x ${b.q}`);
  const bar = getComputedStyle(document.querySelector('.topbar'));
  return {
    tall: Math.round(Math.max(...parts.map((r) => r.b))), widest: Math.round(Math.max(...parts.map((r) => r.w))), overlaps,
    barBg: bar.backgroundImage === 'none' && (bar.backgroundColor === 'rgba(0, 0, 0, 0)' || bar.backgroundColor === 'transparent'),
    inset: window.__ob.app.scene.view?.engine.insets?.top ?? null, onScreen: parts.every((r) => r.x >= 0 && r.r <= innerWidth),
    names: [...document.querySelectorAll('.tb-name b')].map((n) => n.scrollWidth <= n.clientWidth + 1),
  };
});

try {
  for (const [w, h] of [[1920, 1080], [1366, 768], [1024, 768]]) {
    // planning, round 3 (ghosts in view, a draft notice): the busiest top row
    let { p, ctx } = await page(w, h, '?dev=planning&timer=0&round=3');
    await waitFor(p, () => !!document.querySelector('.planning') && !!window.__ob.app.scene, null, 40000);
    await sleep(1800);
    // put the pending picks aside (recruits, spoils): the HUD is what is being looked at
    for (let k = 0; k < 4 && (await p.$('.modal')); k++) { await p.keyboard.press('Escape'); await sleep(600); }
    let m = await measure(p);
    const limit = Math.round((h / 1080) * 64) + (w / h < 1.34 ? 40 : 0); // 4:3 tucks the resources under the medallion
    console.log(`     [${w}] planning ${JSON.stringify(m)}`);
    check(m.barBg, `[${w}] no bar behind the top HUD`);
    check(m.widest < w * 0.4, `[${w}] nothing spans the width (widest piece ${m.widest}px)`);
    check(m.tall <= Math.max(limit, 46), `[${w}] the top HUD is ${m.tall}px tall (limit ${Math.max(limit, 46)})`);
    check(m.overlaps.length === 0 && m.onScreen, `[${w}] its pieces do not overlap each other or the tools ${JSON.stringify(m.overlaps)}`);
    check(m.inset === null || m.inset <= m.tall + 2, `[${w}] the engine's top inset follows it (${m.inset})`);
    await p.screenshot({ path: path.join('e2e/shots', `tophud-${w}-planning.png`) });
    await ctx.close();
    if (w === 1024) break; // 1024: planning only
    // battle, a few seconds in
    ({ p, ctx } = await page(w, h, '?dev=battle&timer=0&round=3'));
    await waitFor(p, () => !!document.querySelector('.screen.battle') && !!window.__ob.app.screen?.pb, null, 40000);
    await sleep(3500);
    m = await measure(p);
    console.log(`     [${w}] battle ${JSON.stringify(m)}`);
    check(m.tall <= Math.max(Math.round((h / 1080) * 64), 46) && m.overlaps.length === 0, `[${w}] battle: ${m.tall}px tall, no overlaps ${JSON.stringify(m.overlaps)}`);
    check(m.inset === null || m.inset <= m.tall + 2, `[${w}] battle: the engine's top inset follows it (${m.inset})`);
    await p.screenshot({ path: path.join('e2e/shots', `tophud-${w}-battle.png`) });
    await ctx.close();
  }
} catch (e) {
  errors.push(String(e?.stack || e));
} finally {
  await browser.close();
  server.kill();
}
if (errors.length) console.log('errors:\n' + errors.join('\n'));
console.log(fails || errors.length ? `${fails} failed` : 'all passed');
process.exit(fails || errors.length ? 1 : 0);
