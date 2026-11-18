// The end of a match must not hitch: from 2 s before the losing Keep falls (its last stage, the collapse VFX) to 2 s
// after the match-over screen shows, no frame may take longer than LIMIT ms (default 50): neither a main-thread
// frame (rAF gaps, long tasks), nor a frame of the 3D view (the gap between frames the renderer drew: a backdrop cap
// or a stall shows here, not on the main thread), and the effects on screen must not freeze in mid-air.
// Default: a local match (?dev=planning round 4). One ordinary round is played first (battle at 4x, results screen),
// as a real match has by its end; then the falling Keep (FALL=enemy: a victory, the enemy army cut to its Lord;
// mine: a defeat) is cut to a sliver of life so the next round is lethal. That battle plays at 4x until 6 s before
// the collapse, then at 1x, under a Chrome performance trace. ONLINE=1 plays a whole vs-AI match on the server
// instead (every round, as a player would; ~10 min). Reported: the longest rAF gap, the longest gap between drawn
// frames and the drawn fps before / after the match-over screen, frozen effects, Long Animation Frames (with their
// scripts) and long main-thread tasks with what they spent their time on (trace events + CPU samples, self time).
//   npm run build && PORT=3191 node server/index.ts &
//   BASE=http://127.0.0.1:3191/ node e2e/ux/endgame-hitch.mjs
//     TIERS=medium,low  FALL=enemy,mine  ONLINE=1  HEADED=1  W=1600 H=900  LIMIT=50  REPORT=25  RUNS=1  THROTTLE=1
// Exits 1 when any run breaks LIMIT. TRACE=1 keeps the raw traces in e2e/shots/.
import puppeteer from 'puppeteer-core';
import { CHROME, sleep, waitFor } from '../qa/lib.mjs';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:3191/';
const TIERS = (process.env.TIERS || 'medium,low').split(',');
const LIMIT = Number(process.env.LIMIT || 50);
/** Frames / tasks longer than this are listed (the check uses LIMIT). */
const REPORT = Number(process.env.REPORT || 25);
/** CPU slow-down (CDP), to stand in for a slower machine. */
const THROTTLE = Number(process.env.THROTTLE || 1);
const RUNS = Number(process.env.RUNS || 1);
/** ONLINE=1 plays a whole match on the server instead (BASE must be the server). */
const ONLINE = !!process.env.ONLINE;
const FALLS = ONLINE ? ['mine'] : (process.env.FALL || 'enemy,mine').split(',');
const PRE = 2000;
const POST = 2000;
// HEADED=1 runs a visible window (real vsync and compositing)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: !process.env.HEADED, protocolTimeout: 600000, defaultViewport: null, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--window-size=${process.env.W || 1600},${process.env.H || 900}`] });
let fails = 0;
const errors = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

/** Probes installed before the page runs: rAF frame times and Long Animation Frames with their scripts. */
function probes() {
  const h = (window.__hitch = { frames: [], drawn: [], fx: [], loaf: [], marks: {} });
  // every display frame (main-thread jank), and the frames the renderer actually drew (a capped or stalled 3D view)
  let last = -1;
  const f = (t) => {
    h.frames.push(t);
    const n = window.__ob?.app?.scene?.view?.engine?.frames;
    if (n !== undefined && n !== last) {
      if (last >= 0) h.drawn.push(t);
      last = n;
      // the VFX clock and whether effects are alive: the aftermath must keep moving, never freeze in mid-air
      const v = window.__ob.app.scene.view.vfx;
      h.fx.push([t, v.time, v.busy ? 1 : 0]);
    }
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) h.loaf.push({ start: e.startTime, dur: e.duration, block: e.blockingDuration, render: e.renderStart, style: e.styleAndLayoutStart, scripts: (e.scripts || []).map((s) => ({ dur: Math.round(s.duration), inv: s.invoker, fn: s.sourceFunctionName, src: (s.sourceURL || '').split('/').pop(), at: s.sourceCharPosition, layout: Math.round(s.forcedStyleAndLayoutDuration || 0) })) });
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* no LoAF */ }
  // the match-over screen: the moment it is in the DOM
  const watch = () => new MutationObserver(() => { if (!h.marks.over && document.querySelector('.screen.over .over-card')) h.marks.over = performance.now(); }).observe(document.body, { childList: true, subtree: true });
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
}

const CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'v8', 'v8.execute', 'blink', 'blink.user_timing', 'loading', 'disabled-by-default-v8.cpu_profiler', 'gpu', 'disabled-by-default-v8.gc'];

/** Keep collapses are timed in the page (the last one is the Keep that ends the match). */
const hookCollapse = (p) => p.evaluate(() => {
  const vfx = window.__ob.app.scene.view.vfx;
  if (vfx.__hitch) return;
  vfx.__hitch = true;
  const orig = vfx.keepCollapse.bind(vfx);
  vfx.keepCollapse = (pos) => { window.__hitch.marks.collapse ??= []; window.__hitch.marks.collapse.push(performance.now()); return orig(pos); };
});

/** ?dev=planning (a local match): the falling Keep is cut to a sliver of life so this round ends the match. */
async function local(p, tier, n, fall) {
  await p.goto(`${BASE}?dev=planning&timer=0&round=4&seed=${20261114 + n}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
  // the player's first click unlocks the audio (music, stings and voice load and decode as in real play)
  await p.evaluate(() => window.__ob.sound.unlock());
  if (!(await waitFor(p, () => !!window.__ob.app.scene && !!document.querySelector('.planning'), null, 90000))) throw new Error('planning never came up');
  // let the art finish loading (the renderer goes idle)
  await sleep(4000);
  // one ordinary round first (its battle at 4x, its results screen), as in a real match: the screens and the
  // renderer are in the state a match leaves them in by its last round
  await p.evaluate(() => window.__ob.app.backend.intent({ t: 'ready' }));
  if (!(await waitFor(p, () => !!window.__ob.app.screen?.pb && !!window.__ob.app.screen?.decoded, null, 30000))) throw new Error('no first battle');
  await p.evaluate(() => { window.__ob.app.screen.pb.speed = 4; });
  if (!(await waitFor(p, () => window.__ob.app.room?.phase === 'results', null, 120000))) { console.log('  the first round ended the match; skipped'); return false; }
  if (!(await waitFor(p, () => window.__ob.app.room?.phase === 'planning' && !!document.querySelector('.planning'), null, 30000))) throw new Error('no second planning');
  await sleep(2500);
  await p.evaluate((fall) => {
    const app = window.__ob.app;
    const s = app.local.s;
    // the falling Keep has a sliver of life (its art already shows the heavy-damage stage), so this round ends the
    // match on the field with the collapse. 'enemy' (a victory): the enemy army is cut to its Lord so we win.
    const lose = fall === 'enemy' ? 1 : 0;
    const pl = s.players[lose];
    pl.keepHp = Math.max(1, Math.round(pl.keepMax * 0.06));
    if (fall === 'enemy') s.players[1].squads = s.players[1].squads.filter((q) => q.type === 'lord');
    app.backend.intent({ t: 'ready' });
    return { tier: app.scene.view.stats.tier };
  }, fall);
  await hookCollapse(p);
  if (!(await waitFor(p, () => !!window.__ob.app.screen?.pb && !!window.__ob.app.screen?.decoded, null, 30000))) throw new Error('no battle');
  // where the losing Keep's last stage falls in the replay
  const fallMs = await p.evaluate(() => {
    const b = window.__ob.app.screen;
    const ev = b.decoded.events.filter((e) => e.k === 'keepStage' && e.stage === 4);
    return ev.length ? ev.at(-1).tick * 50 : null;
  });
  if (fallMs === null) { console.log(`  ${tier} ${fall}#${n}: no Keep fell this round (match did not end on the field); skipped`); return false; }
  await p.evaluate(() => { window.__ob.app.screen.pb.speed = 4; });
  await waitFor(p, (ms) => window.__ob.app.screen.pb.timeMs > ms - 6000, fallMs, 120000);
  await p.evaluate(() => { window.__ob.app.screen.pb.speed = 1; });
  return true;
}

/**
 * ONLINE=1: a whole vs-AI match on the server, as a player plays it (the title, the Lord pick, every round). The
 * player readies at once with only the Lord, so the AI wins every round until our Keep falls; each battle plays at
 * 4x until the lethal one, which runs at 1x from 6 s before the collapse.
 */
async function online(p, tier) {
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
  await p.evaluate(() => window.__ob.sound.unlock());
  await p.evaluate(() => window.__ob.app.connect().create('Hitch', 'vsAI', 'easy'));
  const t0 = Date.now();
  let lastRound = -1;
  let round = 0;
  while (Date.now() - t0 < 15 * 60_000) {
    const st = await p.evaluate(() => {
      const a = window.__ob.app;
      const r = a.room;
      const sc = a.screen;
      const battle = sc?.pb && sc.decoded && !sc.isDone ? { t: sc.pb.timeMs, round: sc.decoded.replay.round, fall: (sc.decoded.events.filter((e) => e.k === 'keepStage' && e.stage === 4).at(-1)?.tick ?? -1) * 50 } : null;
      return { phase: r?.phase, lord: !!r?.view?.you?.lord, ready: !!r?.view?.you?.ready, draft: r?.view?.you?.draftPicks ? r.view.you.draftOptions : null, scene: !!a.scene, battle, round: r?.view?.round ?? 0 };
    });
    if (st.scene) await hookCollapse(p);
    if (st.phase === 'lordPick' && !st.lord) await p.evaluate(() => window.__ob.app.backend.intent({ t: 'pickLord', lord: 'marshal' }));
    if (st.phase === 'planning' && !st.ready && st.scene) {
      if (st.draft?.length) await p.evaluate((u) => window.__ob.app.backend.intent({ t: 'draft', unit: u }), st.draft[0]);
      await p.evaluate(() => window.__ob.app.backend.intent({ t: 'ready' }));
    }
    if (st.battle) {
      if (st.battle.round !== lastRound) {
        lastRound = st.battle.round;
        round = st.battle.round;
        console.log(`  ${tier} online: round ${round}${st.battle.fall >= 0 ? `, the Keep falls at ${Math.round(st.battle.fall / 1000)} s` : ''}`);
        if (st.battle.fall < 0 || st.battle.fall > 8000) await p.evaluate(() => window.__ob.app.screen.request(4));
      }
      if (st.battle.fall >= 0 && st.battle.t > st.battle.fall - 6000) {
        await p.evaluate(() => window.__ob.app.screen.request(1));
        return true;
      }
    }
    if (st.phase === 'over') { console.log('  the match ended without a Keep falling on the field'); return false; }
    await sleep(250);
  }
  return false;
}

async function run(tier, n, fall) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: Number(process.env.W || 1600), height: Number(process.env.H || 900) });
  p.on('pageerror', (e) => errors.push(`${tier}: ${e.message}`));
  await p.evaluateOnNewDocument((tier) => {
    localStorage.setItem('oathbound.render.quality', tier);
    localStorage.setItem('oathbound.tutorial.done', '1');
  }, tier);
  await p.evaluateOnNewDocument(probes);
  if (THROTTLE > 1) await (await p.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  if (ONLINE) { if (!(await online(p, tier))) { await ctx.close(); return null; } }
  else if (!(await local(p, tier, n, fall))) { await ctx.close(); return null; }
  await sleep(300);
  await p.tracing.start({ categories: CATS });
  // a user-timing mark ties the trace clock to performance.now()
  const t0 = await p.evaluate(() => { const t = performance.now(); performance.mark('hitch-anchor', { startTime: t }); window.__hitch.anchor = t; return t; });
  const ok = await waitFor(p, () => !!window.__hitch.marks.over, null, 150000);
  if (!ok) throw new Error('match-over screen never showed');
  await sleep(POST + 800);
  const buf = await p.tracing.stop();
  const h = await p.evaluate(() => window.__hitch);
  // power: once the screen is up and the aftermath has settled, the field behind it is a backdrop again
  await p.evaluate((at) => new Promise((r) => setTimeout(r, Math.max(0, at - performance.now()))), h.marks.over + 8000);
  const f0 = await p.evaluate(() => window.__ob.app.scene.view.engine.frames);
  await sleep(2000);
  const restFps = ((await p.evaluate(() => window.__ob.app.scene.view.engine.frames)) - f0) / 2;
  await ctx.close();
  const collapse = (h.marks.collapse || []).at(-1) ?? null;
  if (collapse === null) throw new Error('keepCollapse never fired');
  const from = collapse - PRE;
  const to = h.marks.over + POST;
  const trace = JSON.parse(Buffer.from(buf).toString('utf8'));
  if (process.env.TRACE) fs.writeFileSync(`e2e/shots/endgame-${tier}-${n}.json`, buf);
  return { ...analyse(tier, n, h, trace, { from: Math.max(from, t0), to, collapse, over: h.marks.over }), restFps };
}

function analyse(tier, n, h, trace, w) {
  // frames (rAF deltas) in the window
  let worst = 0, worstAt = 0;
  const gaps = [];
  for (let i = 1; i < h.frames.length; i++) {
    const a = h.frames[i - 1], b = h.frames[i];
    if (b < w.from || a > w.to) continue;
    const d = b - a;
    if (d > worst) { worst = d; worstAt = a; }
    if (d > REPORT) gaps.push({ at: Math.round(a - w.collapse), ms: Math.round(d) });
  }
  // the 3D view: the longest gap between drawn frames (the scene keeps moving through the whole window: dust, fire,
  // the camera), and the drawn fps before and after the match-over screen
  let drawnWorst = 0, drawnAt = 0;
  for (let i = 1; i < h.drawn.length; i++) {
    const a = h.drawn[i - 1], b = h.drawn[i];
    if (b < w.from || a > w.to) continue;
    if (b - a > drawnWorst) { drawnWorst = b - a; drawnAt = a; }
  }
  // the longest stretch in the window where effects were alive on screen but their clock stood still
  let frozen = 0, frozenAt = 0, since = null;
  for (let i = 1; i < h.fx.length; i++) {
    const [t, vt, busy] = h.fx[i];
    if (t < w.from || t > w.to) continue;
    const still = busy && vt === h.fx[i - 1][1];
    if (still) { since ??= h.fx[i - 1][0]; if (t - since > frozen) { frozen = t - since; frozenAt = since; } }
    else since = null;
  }
  const fpsIn = (a, b) => +((h.drawn.filter((t) => t >= a && t < b).length * 1000) / Math.max(1, b - a)).toFixed(1);
  const drawnFps = { before: fpsIn(w.from, w.over), after: fpsIn(w.over, w.to) };
  const loaf = h.loaf.filter((e) => e.start + e.dur > w.from && e.start < w.to && e.dur > REPORT).map((e) => ({ at: Math.round(e.start - w.collapse), ms: Math.round(e.dur), scripts: e.scripts.filter((s) => s.dur >= 5).sort((a, b) => b.dur - a.dur).slice(0, 5) }));
  const ev = trace.traceEvents ?? trace;
  const names = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
  // the page's renderer main thread: the CrRendererMain with the most FireAnimationFrame events
  const fire = new Map();
  for (const e of ev) if (e.name === 'FireAnimationFrame') { const k = `${e.pid}:${e.tid}`; fire.set(k, (fire.get(k) ?? 0) + 1); }
  const main = [...fire.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return { tier, n, frozen: Math.round(frozen), frozenAt: Math.round(frozenAt - w.collapse), longest: Math.max(worst, drawnWorst, frozen), drawnWorst: Math.round(drawnWorst), drawnAt: Math.round(drawnAt - w.collapse), drawnFps, worst: Math.round(worst), gaps, loaf, tasks: [], note: 'no main thread in trace' };
  const [mpid, mtid] = main.split(':').map(Number);
  const onMain = ev.filter((e) => e.pid === mpid && e.tid === mtid);
  // clock anchor: the user-timing mark set right after tracing started
  const mark = ev.find((e) => e.name === 'hitch-anchor');
  const off = mark ? mark.ts / 1000 - h.anchor : 0;
  const toPerf = (us) => us / 1000 - off;
  const tasks = onMain.filter((e) => e.ph === 'X' && (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && e.dur / 1000 > REPORT && toPerf(e.ts + e.dur) > w.from && toPerf(e.ts) < w.to);
  // CPU samples (Profile + ProfileChunk, per profile id; sample times are µs on the trace clock)
  const nodes = new Map();
  const samples = [];
  const clock = new Map();
  for (const e of ev) {
    if (e.pid !== mpid) continue;
    if (e.name === 'Profile') clock.set(e.id, e.args?.data?.startTime ?? e.ts);
    if (e.name !== 'ProfileChunk') continue;
    const d = e.args?.data;
    if (!d) continue;
    for (const nd of d.cpuProfile?.nodes ?? []) nodes.set(`${e.id}:${nd.id}`, { ...nd, key: e.id });
    const ids = d.cpuProfile?.samples ?? [];
    const deltas = d.timeDeltas ?? [];
    let t = clock.get(e.id) ?? e.ts;
    for (let i = 0; i < ids.length; i++) { t += deltas[i] ?? 0; samples.push({ t, id: `${e.id}:${ids[i]}` }); }
    clock.set(e.id, t);
  }
  samples.sort((x, y) => x.t - y.t);
  const parentOf = new Map();
  for (const [k, nd] of nodes) for (const c of nd.children ?? []) parentOf.set(`${nd.key}:${c}`, k);
  for (const [k, nd] of nodes) if (nd.parent !== undefined) parentOf.set(k, `${nd.key}:${nd.parent}`);
  const label = (k) => { const nd = nodes.get(k); const cf = nd?.callFrame; if (!cf) return '?'; return `${cf.functionName || '(anon)'}${cf.url ? ` ${cf.url.split('/').pop()}:${cf.lineNumber + 1}` : ''}`; };
  const stackOf = (k) => { const s = []; let c = k; let g = 0; while (c && g++ < 60) { s.push(label(c)); c = parentOf.get(c); } return s; };
  const out = [];
  for (const t of tasks) {
    const a = t.ts, b = t.ts + t.dur;
    const kids = onMain.filter((e) => e.ph === 'X' && e.ts >= a && e.ts + (e.dur ?? 0) <= b && e !== t && e.dur > 2000);
    const by = {};
    for (const e of kids) {
      const nm = e.name === 'FunctionCall' ? `FunctionCall ${e.args?.data?.functionName || ''} ${(e.args?.data?.url || '').split('/').pop()}` : e.name;
      by[nm] = (by[nm] ?? 0) + e.dur / 1000;
    }
    const self = {};
    const incl = {};
    let ns = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.t < a || s.t > b) continue;
      const dt = Math.min(5, ((samples[i + 1]?.t ?? s.t) - s.t) / 1000);
      ns++;
      const st = stackOf(s.id);
      self[st[0]] = (self[st[0]] ?? 0) + dt;
      for (const f of new Set(st.slice(0, 14))) incl[f] = (incl[f] ?? 0) + dt;
    }
    const top = (o, k = 8) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, k).map(([k2, v]) => `${Math.round(v)}ms ${k2}`);
    out.push({ at: Math.round(toPerf(a) - w.collapse), ms: Math.round(t.dur / 1000), events: top(by, 10), self: top(self), incl: top(incl, 14), samples: ns });
  }
  const longest = Math.max(worst, drawnWorst, frozen, ...out.map((t) => t.ms), 0);
  return { tier, n, frozen: Math.round(frozen), frozenAt: Math.round(frozenAt - w.collapse), drawnWorst: Math.round(drawnWorst), drawnAt: Math.round(drawnAt - w.collapse), drawnFps, worst: Math.round(worst), worstAt: Math.round(worstAt - w.collapse), overAt: Math.round(w.over - w.collapse), longest, gaps, loaf, tasks: out };
}

const results = [];
try {
  for (const tier of TIERS) for (const fall of FALLS) {
    for (let n = 0; n < RUNS; n++) {
      let r = null;
      for (let tries = 0; tries < 4 && !r; tries++) r = await run(tier, n + tries * 7, fall);
      if (!r) { check(false, `${tier}: no run ended the match on the field`); continue; }
      results.push(r);
      console.log(`\n== ${tier} #${n}: longest rAF frame ${r.worst} ms (at ${r.worstAt} ms from the collapse), match-over screen at +${r.overAt} ms`);
      console.log(`  3D view: longest gap between drawn frames ${r.drawnWorst} ms (at ${r.drawnAt} ms); drawn fps ${r.drawnFps.before} before the match-over screen, ${r.drawnFps.after} after; effects frozen in mid-air for ${r.frozen} ms${r.frozen ? ` (from ${r.frozenAt} ms)` : ''}`);
      if (r.gaps.length) console.log('  frames over limit (ms from collapse: ms):', r.gaps.map((g) => `${g.at}:${g.ms}`).join(' '));
      for (const l of r.loaf) console.log(`  LoAF at ${l.at}: ${l.ms} ms`, JSON.stringify(l.scripts));
      for (const t of r.tasks) {
        console.log(`  long task at ${t.at} ms: ${t.ms} ms (${t.samples} samples)`);
        console.log('    events:', t.events.join(' | '));
        console.log('    self:  ', t.self.join(' | '));
        console.log('    incl:  ', t.incl.join(' | '));
      }
      check(r.restFps <= 12, `${tier}, ${fall} Keep falls, #${n}: 8 s into the match-over screen the field draws at the backdrop rate (${r.restFps} fps <= 12)`);
      check(r.longest <= LIMIT, `${tier}, ${fall} Keep falls, #${n}: longest frame/task/3D frame ${Math.round(r.longest)} ms <= ${LIMIT} ms from 2 s before the Keep falls to 2 s after the match-over screen`);
    }
  }
} finally {
  await browser.close();
}
if (errors.length) { console.log('page errors:', errors.slice(0, 10)); fails++; }
process.exit(fails ? 1 : 0);
