// Performance, network, audio and settings probes on the live site (one browser, nothing else running).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { CHROME, BASE, sleep } from './lib.mjs';
const out = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); out.push(s); fs.writeFileSync('e2e/qa2/out-perf.txt', out.join('\n')); };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 600000, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.createBrowserContext();
const errs = [];
async function open(tag, url = '') {
  const p = await ctx.newPage();
  await p.setViewport({ width: 1920, height: 1080 });
  p.on('pageerror', (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  p.on('console', (m) => { if (['error', 'warn', 'warning'].includes(m.type())) errs.push(`[${tag}] console.${m.type()} ${m.text().slice(0, 300)}`); });
  const cdp = await p.createCDPSession();
  await cdp.send('Network.enable');
  const net = { reqs: new Map(), list: [] };
  cdp.on('Network.responseReceived', (e) => { net.reqs.set(e.requestId, { url: e.response.url.replace(BASE, ''), status: e.response.status, enc: e.response.headers['content-encoding'] ?? e.response.headers['Content-Encoding'] ?? '', cc: e.response.headers['cache-control'] ?? '', etag: !!(e.response.headers['etag']), disk: !!e.response.fromDiskCache, sw: !!e.response.fromServiceWorker, type: e.type, bytes: 0, t: Date.now() }); });
  cdp.on('Network.requestServedFromCache', (e) => { const r = net.reqs.get(e.requestId); if (r) r.mem = true; else net.reqs.set(e.requestId, { url: '?', status: 0, mem: true, bytes: 0 }); });
  cdp.on('Network.loadingFinished', (e) => { const r = net.reqs.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; net.list.push(r); } });
  cdp.on('Network.loadingFailed', (e) => { const r = net.reqs.get(e.requestId); errs.push(`[${tag}] loadingFailed ${r?.url} ${e.errorText}`); });
  p.__net = net; p.__cdp = cdp;
  const t0 = Date.now();
  await p.goto(BASE + url, { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
  p.__boot = Date.now() - t0;
  return p;
}
const sum = (net, f = () => true) => { const l = net.list.filter(f); return { n: l.length, MB: +(l.reduce((a, r) => a + r.bytes, 0) / 1e6).toFixed(2) }; };
const byKind = (net) => { const k = {}; for (const r of net.list) { const g = /models\//.test(r.url) ? 'models' : /textures\//.test(r.url) ? 'textures' : /audio\//.test(r.url) ? 'audio' : /\.js/.test(r.url) ? 'js' : /\.css/.test(r.url) ? 'css' : /\.(png|webp|jpg|avif)/.test(r.url) ? 'images' : 'other'; k[g] ??= { n: 0, MB: 0 }; k[g].n++; k[g].MB = +(k[g].MB + r.bytes / 1e6).toFixed(2); } return k; };
const fpsOf = async (p, ms = 3000) => { const a = await p.evaluate(() => window.__ob.app.scene?.framesDrawn ?? 0); await sleep(ms); const b = await p.evaluate(() => window.__ob.app.scene?.framesDrawn ?? 0); return +(((b - a) * 1000) / ms).toFixed(1); };
// rAF callbacks per second too: a "0 fps" renderer can still spin a JS loop
const rafOf = (p, ms = 2000) => p.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }), ms);
const waitFor = async (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, { timeout: ms, polling: 200 }, arg).then(() => true, () => false);
const shot = (p, n) => p.screenshot({ path: `e2e/shots/qa2-perf-${n}.png` });
const cpu = async (p, ms = 3000) => { const a = await p.metrics(); await sleep(ms); const b = await p.metrics(); return { taskPct: +(((b.TaskDuration - a.TaskDuration) / (ms / 1000)) * 100).toFixed(1), scriptPct: +(((b.ScriptDuration - a.ScriptDuration) / (ms / 1000)) * 100).toFixed(1), heapMB: +(b.JSHeapUsedSize / 1e6).toFixed(0) }; };

// ------------------------------------------------------------------ cold visit
const p = await open('cold');
say('cold boot ms', p.__boot, 'at booted:', sum(p.__net), byKind(p.__net));
await sleep(600); await shot(p, 'title-early');
say('title loading line', await p.evaluate(() => { const l = document.querySelector('.title-load'); return { on: l?.classList.contains('on'), text: l?.innerText, w: l?.querySelector('i')?.style.width }; }));
const tl0 = Date.now();
await waitFor(p, () => !document.querySelector('.title-load.on'), null, 60000);
say('title: battlefield ready after', Date.now() - tl0, 'ms more; downloaded', sum(p.__net), byKind(p.__net));
await sleep(1500);
say('title fps (framesDrawn)', await fpsOf(p), 'cpu', await cpu(p));
say('title: stats', await p.evaluate(() => { const s = window.__ob.app.scene?.view?.stats; return s ? { tier: s.tier, auto: s.auto, gpu: s.gpu, w: s.width, h: s.height, dpr: devicePixelRatio } : null; }));
// rules codex
await p.keyboard.press('F1'); await sleep(700); await shot(p, 'rules'); say('rules open', await p.evaluate(() => { const r = document.querySelector('.rules, .codex, [class*="rules"]'); return r ? { cls: r.className, len: r.innerText.length, heads: [...r.querySelectorAll('h2,h3,nav button,.tab')].map((n) => n.textContent.trim()).slice(0, 30) } : null; }));
say('rules fps', await fpsOf(p, 2000));
await p.keyboard.press('Escape'); await sleep(300);
// settings on the title
await p.click('.set-btn'); await sleep(500); await shot(p, 'settings');
say('settings text', await p.evaluate(() => document.querySelector('.settings').innerText.replace(/\n+/g, ' | ')));
const setSlider = (k, v) => p.evaluate((k, v) => { const r = document.querySelector(`.sl input[data-k="${k}"]`); r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }, k, v);
await setSlider('volume', 0.35); await setSlider('music', 0.25); await setSlider('sfx', 0.55); await setSlider('amb', 0.15); await setSlider('ui', 0.45);
await p.click('.quality button[data-q="medium"]'); await sleep(1500);
await p.click('.fps button[data-fps="60"]'); await sleep(300);
say('after changing: storage', await p.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('oathbound.')).map((k) => [k, localStorage.getItem(k)]))));
say('non-prefixed storage keys', await p.evaluate(() => Object.keys(localStorage).filter((k) => !k.startsWith('oathbound.'))));
say('stats after medium', await p.evaluate(() => { const s = window.__ob.app.scene?.view?.stats; return s ? { tier: s.tier, auto: s.auto, fpsCap: s.fpsCap } : null; }));
// fullscreen
await p.click('.fs-ck').catch(() => {}); await sleep(600);
say('fullscreen after click', await p.evaluate(() => !!document.fullscreenElement));
await p.evaluate(() => document.fullscreenElement && document.exitFullscreen()); await sleep(300);
await p.keyboard.press('Escape'); await sleep(300);
say('settings closed by Esc', await p.evaluate(() => !document.querySelector('.settings.on, .settings.open') ));

// ------------------------------------------------------------------ a vs-AI match: fps by phase, bytes, audio
await p.click('.diff button[data-lvl="easy"]');
const beforeMatch = sum(p.__net);
await p.click('.vsai');
await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick');
await sleep(1500);
say('lordpick fps', await fpsOf(p), 'raf/s', (await rafOf(p)) / 2, 'cpu', await cpu(p));
say('audio at lordpick', await p.evaluate(() => window.__ob.sound.debug()));
await p.click('.lcard[data-lord="warden"]');
await waitFor(p, () => window.__ob.app.room?.phase === 'planning');
await sleep(5000);
say('first planning reached: total', sum(p.__net), byKind(p.__net), 'since match click', +(sum(p.__net).MB - beforeMatch.MB).toFixed(2), 'MB');
say('planning + draft modal fps', await fpsOf(p), 'cpu', await cpu(p));
await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u }); });
await sleep(700); for (let i = 0; i < 3 && (await p.$('.modal')); i++) { await p.keyboard.press('Escape'); await sleep(300); }
for (const x of [2600, 5400]) { const card = await p.$('.ucard:not(.off)'); if (!card) break; await card.click(); await sleep(200); const xy = await p.evaluate((x) => window.__ob.app.scene.toScreen([x, 2800], 0), x); await p.mouse.move(xy.x, xy.y, { steps: 3 }); await p.mouse.click(xy.x, xy.y); await sleep(500); }
await p.mouse.move(960, 400); await sleep(2500);
say('planning idle fps (mouse still)', await fpsOf(p, 4000), 'raf/s', (await rafOf(p)) / 2, 'cpu', await cpu(p));
// moving the mouse over the field (hover) - how much does it draw?
const a0 = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
for (let i = 0; i < 60; i++) { await p.mouse.move(500 + i * 15, 400 + (i % 5) * 20); await sleep(33); }
say('planning: frames drawn during 2 s of mouse movement over the field', (await p.evaluate(() => window.__ob.app.scene.framesDrawn)) - a0);
say('planning stats', await p.evaluate(() => { const s = window.__ob.app.scene.view.stats; return { tier: s.tier, draws: s.drawCalls, tris: s.triangles, w: s.width, h: s.height, gpuMs: s.gpuMs, soldiers: s.soldiers }; }));
say('audio in planning', await p.evaluate(() => window.__ob.sound.debug()), await p.evaluate(() => { const s = window.__ob.sound.stats; return { loaded: s.loaded, failed: s.failed, decodeMs: s.decodeMs | 0, plays: s.plays }; }));
say('sound volumes live', await p.evaluate(() => { const s = window.__ob.sound; return { volume: s.volume, music: s.musicVol, sfx: s.sfx, amb: s.amb, ui: s.ui, muted: s.muted }; }));
// hidden tab during planning + battle
const hide = (h) => p.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') }); document.dispatchEvent(new Event('visibilitychange')); }, h);
await p.keyboard.press('Space');
await waitFor(p, () => !!document.querySelector('.battle'));
await p.evaluate(() => document.querySelector('.speed button[data-s="1"]')?.click());
await sleep(4000);
say('battle fps @medium cap60', await fpsOf(p, 4000), 'cpu', await cpu(p, 2000), await p.evaluate(() => { const s = window.__ob.app.scene.view.stats; return { tier: s.tier, draws: s.drawCalls, tris: s.triangles, gpuMs: s.gpuMs, frameMs: s.frameMs, soldiers: s.soldiers, fpsCap: s.fpsCap }; }));
await hide(true); await sleep(600);
say('battle, tab hidden (emulated): fps', await fpsOf(p, 3000), 'audio', await p.evaluate(() => { const d = window.__ob.sound.debug(); return { state: d.state, paused: d.trackPaused }; }));
await hide(false); await sleep(600);
say('visible again: fps', await fpsOf(p, 2000), 'audio state', await p.evaluate(() => window.__ob.sound.debug().state));
// a real hidden tab: another page in front
const other = await ctx.newPage(); await other.goto('about:blank'); await other.bringToFront(); await sleep(800);
say('battle, another tab in front: fps', await fpsOf(p, 3000), 'visibility', await p.evaluate(() => document.visibilityState));
await p.bringToFront(); await other.close(); await sleep(500);
// set ultra for a battle fps reading
await p.click('.set-btn'); await sleep(300);
for (const q of ['low', 'high', 'ultra']) {
  await p.click(`.quality button[data-q="${q}"]`); await sleep(2500);
  if (!(await p.$('.battle:not(.over)'))) { say('battle ended before tier', q); break; }
  await p.click('.fps button[data-fps="0"]'); await sleep(300);
  say(`battle fps @${q} uncapped`, await fpsOf(p, 3000), await p.evaluate(() => { const s = window.__ob.app.scene.view.stats; return { tier: s.tier, draws: s.drawCalls, tris: s.triangles, gpuMs: +s.gpuMs.toFixed?.(2), frameMs: +s.frameMs.toFixed?.(2), w: s.width, h: s.height }; }));
  await shot(p, `battle-${q}`);
}
say('q-note', await p.evaluate(() => document.querySelector('.q-note')?.textContent));
await p.keyboard.press('Escape'); await sleep(200);
await waitFor(p, () => document.querySelector('.battle.over') || !document.querySelector('.battle'), null, 120000);
say('audio after battle', await p.evaluate(() => { const s = window.__ob.sound.stats; return { dbg: window.__ob.sound.debug(), loaded: s.loaded, failed: s.failed, peakVoices: s.peakVoices, plays: s.plays, dropped: s.dropped, pooled: s.pooled }; }));
await waitFor(p, () => !!document.querySelector('.results'), null, 30000); await sleep(1500);
say('results fps', await fpsOf(p, 2500));
await waitFor(p, () => window.__ob.app.room?.phase === 'planning' && window.__ob.app.room.view.round === 2, null, 30000);
await sleep(4000);
say('r2 planning w/ modal fps', await fpsOf(p, 3000));
say('after 1 round: total', sum(p.__net), byKind(p.__net));
const big = [...p.__net.list].sort((a, b) => b.bytes - a.bytes).slice(0, 22).map((r) => `${(r.bytes / 1e3) | 0}kB ${r.status} enc=${r.enc || '-'} cc="${r.cc}" ${r.url}`);
say('largest downloads:\n  ' + big.join('\n  '));
const noCache = p.__net.list.filter((r) => !/max-age=\d{4,}|immutable/.test(r.cc)).map((r) => `${r.url} cc="${r.cc}" etag=${r.etag}`);
say(`responses without long-lived caching (${noCache.length}):\n  ` + noCache.slice(0, 40).join('\n  '));
const uncompressed = p.__net.list.filter((r) => !r.enc && /\.(js|css|json|html|svg|bin|txt)(\?|$)/.test(r.url) && r.bytes > 2000).map((r) => `${(r.bytes / 1e3) | 0}kB ${r.url}`);
say('text responses without content-encoding:', uncompressed);
say('statuses', Object.entries(p.__net.list.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {})));
// leave
await p.click('.leave-btn'); await sleep(400); await shot(p, 'leave-dialog'); say('leave dialog', await p.evaluate(() => document.querySelector('.dialog')?.innerText.replace(/\n+/g, ' | ')));
await p.click('.dialog .yes'); await waitFor(p, () => !!document.querySelector('.title-menu')); await sleep(1500);
say('title after leaving: fps', await fpsOf(p, 3000), 'audio', await p.evaluate(() => window.__ob.sound.debug()));
await p.close();

// ------------------------------------------------------------------ returning visit (same profile)
const q = await open('return');
await waitFor(q, () => !document.querySelector('.title-load.on'), null, 60000); await sleep(1000);
say('RETURN visit: boot ms', q.__boot, 'network bytes', sum(q.__net), 'statuses', Object.entries(q.__net.list.reduce((a, r) => { const k = r.disk || r.mem ? 'cache' : String(r.status); a[k] = (a[k] ?? 0) + 1; return a; }, {})));
say('RETURN: non-cache responses:\n  ' + q.__net.list.filter((r) => !(r.disk || r.mem)).map((r) => `${r.status} ${(r.bytes / 1e3).toFixed(1)}kB ${r.url} cc="${r.cc}"`).slice(0, 60).join('\n  '));
say('RETURN: persisted settings', await q.evaluate(() => { const s = window.__ob.sound; return { volume: s.volume, music: s.musicVol, sfx: s.sfx, amb: s.amb, ui: s.ui, muted: s.muted }; }));
await q.click('.set-btn'); await sleep(400);
say('RETURN: slider DOM', await q.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sl input')].map((r) => [r.dataset.k, r.value]))), 'quality on', await q.evaluate(() => document.querySelector('.quality button.on')?.dataset.q ?? null), 'fps on', await q.evaluate(() => document.querySelector('.fps button.on')?.dataset.fps ?? null));
await shot(q, 'settings-return'); await q.keyboard.press('Escape');
const b2 = sum(q.__net);
await q.click('.vsai'); await waitFor(q, () => window.__ob.app.room?.phase === 'lordPick'); await q.click('.lcard[data-lord="warden"]'); await waitFor(q, () => window.__ob.app.room?.phase === 'planning'); await sleep(6000);
say('RETURN: to first planning, extra network bytes', +(sum(q.__net).MB - b2.MB).toFixed(2), 'MB; statuses', Object.entries(q.__net.list.reduce((a, r) => { const k = r.disk || r.mem ? 'cache' : String(r.status); a[k] = (a[k] ?? 0) + 1; return a; }, {})));
say('RETURN: non-cache:\n  ' + q.__net.list.filter((r) => !(r.disk || r.mem)).map((r) => `${r.status} ${(r.bytes / 1e3).toFixed(1)}kB ${r.url}`).slice(0, 80).join('\n  '));
// mute key persistence
await q.keyboard.press('Escape'); await q.keyboard.press('m'); await sleep(300);
say('M pressed: muted', await q.evaluate(() => window.__ob.sound.muted), 'ctx', await q.evaluate(() => window.__ob.sound.debug().state));
await q.keyboard.press('m');
await q.close();
say('ERRORS/WARNINGS\n' + [...new Set(errs)].join('\n'));
await browser.close();
