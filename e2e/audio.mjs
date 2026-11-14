// Audio end-to-end: a vs-AI match through the real server, checking that the sound bank loads by
// phase, music streams and crossfades, the ambience follows the phase, and that a full battle
// (watched, not skipped) triggers its sounds without machine-gunning (per-sound counts, pooled
// and dropped hits, peak voices). Run against a built dist/:
//   npm run build && PORT=3297 node server/index.ts &  BASE=http://127.0.0.1:3297/ node e2e/audio.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:3297/';
const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const audioReqs = [];
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const waitFor = async (p, fn, ms = 20000) => p.waitForFunction(fn, { timeout: ms, polling: 200 }).then(() => true, () => false);
const dbg = (p) => p.evaluate(() => window.__ob.sound.debug());
const stats = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__ob.sound.stats)));
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1])));

try {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1280, height: 720 });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('response', (r) => {
    if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`);
    if (/\/audio\//.test(r.url())) audioReqs.push(r.url().replace(/.*\/audio\//, ''));
  });
  await p.goto(BASE, { waitUntil: 'networkidle0' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  await sleep(500);
  const pre = audioReqs.filter((u) => !/^ui\/|^loot\/|^sting\/reveal|^amb\/wind|^battle\/horn/.test(u)).length;
  check(pre === 0, `before the first gesture only boot sounds are fetched (${audioReqs.length} boot, ${pre} other)`);
  await p.mouse.click(5, 5);
  check(await waitFor(p, () => window.__ob.sound.debug().buffers >= 30), 'menu: interface sounds decoded after the first gesture');
  let d = await dbg(p);
  console.log('  menu:', JSON.stringify(d));
  check(d.state === 'running' && d.track === 'menu', 'menu: context running, menu music selected');
  const bootReqs = audioReqs.length;
  const battleEarly = audioReqs.filter((u) => /^battle\//.test(u) && !/horn/.test(u)).length;
  check(battleEarly === 0, `menu: battle sounds not loaded yet (${battleEarly})`);
  await sleep(1500);
  d = await dbg(p);
  check(d.trackTime > 0.3 && !d.trackPaused, `menu music streams (t=${d.trackTime.toFixed(2)}s)`);

  await p.type('.name', 'Audrey');
  await p.click('.diff button[data-lvl="easy"]');
  await p.click('.vsai');
  check(await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick'), 'lord pick');
  await p.click('.lcard[data-lord="warden"]');
  check(await waitFor(p, () => window.__ob.app.room?.phase === 'planning'), 'planning');
  check(await waitFor(p, () => !!document.querySelector('.modal.draft.fresh .draft-ribbon'), 8000), 'draft appears with the "New recruits!" ribbon');
  await sleep(2500);
  d = await dbg(p);
  console.log('  planning:', JSON.stringify(d));
  check(d.track === 'planning', 'planning music');
  check((d.loops.ambForest ?? 0) > 0 && (d.loops.ambWind ?? 0) > 0, 'planning ambience: forest (birds) + wind');
  check(await waitFor(p, () => window.__ob.sound.debug().buffers >= 100, 30000), 'battle set decoded during planning');
  let s = await stats(p);
  check((s.plays.draft ?? 0) >= 1, 'draft sting played');
  await p.evaluate(() => {
    const { app } = window.__ob;
    const me = app.room.view.you;
    for (const u of me.draftOptions.slice(0, me.draftPicks)) app.backend.intent({ t: 'draft', unit: u });
  });
  await sleep(600);
  await p.keyboard.press('Escape');
  await sleep(300);
  for (let k = 0; k < 4; k++) {
    const card = await p.$('.ucard:not(.off)');
    if (!card) break;
    await card.click();
    await sleep(200);
    const xy = await p.evaluate((k) => {
      const { app } = window.__ob;
      const seat = app.room.view.seat;
      const y = seat === 0 ? 2400 : 12000 - 2400;
      return app.scene.toScreen([1800 + k * 1400, y], 0);
    }, k);
    if (xy) await p.mouse.click(xy.x, xy.y);
    await sleep(400);
  }
  s = await stats(p);
  console.log('  planning plays:', sorted(s.plays));
  check((s.plays.deploy ?? 0) >= 1, 'deploy sound');
  const before = await stats(p);
  await p.click('.ready-btn');
  check(await waitFor(p, () => !!document.querySelector('.battle')), 'battle starts');
  await sleep(1500);
  d = await dbg(p);
  console.log('  battle:', JSON.stringify(d));
  check(d.track === 'battle_a' || d.track === 'battle_b', 'battle music');
  // watch the whole battle (no skip), sampling the beds
  const maxBed = { bedSkirmish: 0, bedMelee: 0, ambBattle: 0, ambRiver: 0 };
  let samples = 0;
  for (let i = 0; i < 240; i++) {
    const done = await p.evaluate(() => !!document.querySelector('.battle.over') || !document.querySelector('.battle'));
    d = await dbg(p);
    for (const k of Object.keys(maxBed)) maxBed[k] = Math.max(maxBed[k], d.loops[k] ?? 0);
    samples++;
    if (done) break;
    await sleep(500);
  }
  s = await stats(p);
  const delta = {};
  for (const [k, v] of Object.entries(s.plays)) if (v - (before.plays[k] ?? 0) > 0) delta[k] = v - (before.plays[k] ?? 0);
  console.log(`  battle watched for ~${(samples / 2).toFixed(0)} s`);
  console.log('  battle plays:', sorted(delta));
  console.log('  pooled into beds / one-per-volley / scatter:', sorted(s.pooled));
  console.log('  dropped by reason:', sorted(s.dropped));
  console.log(`  peak voices: ${s.peakVoices}; ${s.loaded} buffers decoded in ${s.decodeMs.toFixed(0)} ms; failed: ${JSON.stringify(s.failed)}`);
  console.log('  peak loop gains:', JSON.stringify(maxBed));
  check(s.failed.length === 0, 'no sound failed to load or decode');
  check(s.peakVoices <= 40, 'voice cap held');
  check((delta.horn ?? 0) >= 1 && (delta.charge ?? 0) >= 1, 'battle start: horn + charge');
  check((delta.clash ?? 0) + (delta.clashHeavy ?? 0) > 0, 'melee clashes');
  check(maxBed.bedSkirmish > 0 || maxBed.bedMelee > 0, 'clash beds follow the melee');
  check(await waitFor(p, () => ['results', 'planning', 'over'].includes(window.__ob.app.room?.phase), 30000), 'results after the battle');
  await sleep(2500);
  d = await dbg(p);
  console.log('  after battle:', JSON.stringify(d));
  check(!d.loops.bedMelee && !d.loops.bedSkirmish, 'beds stopped after the battle');
  await p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(500);
  d = await dbg(p);
  check(d.state === 'suspended' && d.trackPaused, `hidden tab: context suspended, music paused (${d.state})`);
  await p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(500);
  d = await dbg(p);
  check(d.state === 'running', 'visible again: context resumed');
  const frames = await p.evaluate(async () => {
    const a = window.__ob.app.scene.framesDrawn;
    await new Promise((r) => setTimeout(r, 2000));
    return window.__ob.app.scene.framesDrawn - a;
  });
  console.log(`  frames drawn in 2 s with audio running (planning/results idle): ${frames}`);
  console.log(`  audio requests: ${audioReqs.length} (${bootReqs} by the end of the menu)`);
  await p.close();

  // ------------------------------------------------ a late-round battle: big mixed armies (ranged, siege, monsters)
  for (const round of [6, 9]) {
    const q = await (await browser.createBrowserContext()).newPage();
    await q.setViewport({ width: 1280, height: 720 });
    q.on('pageerror', (e) => errors.push(e.message));
    q.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await q.goto(`${BASE}?dev=battle&round=${round}&seed=${round * 7}`, { waitUntil: 'domcontentloaded' });
    await q.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
    await q.mouse.click(5, 700);
    await waitFor(q, () => !!document.querySelector('.battle'));
    await sleep(500);
    let mb = 0;
    let secs = 0;
    for (let i = 0; i < 240; i++) {
      const done = await q.evaluate(() => !!document.querySelector('.battle.over') || !document.querySelector('.battle'));
      const dd = await dbg(q);
      mb = Math.max(mb, dd.loops.bedMelee ?? 0);
      secs = i / 2;
      if (done) break;
      await sleep(500);
    }
    const st = await stats(q);
    console.log(`  dev battle round ${round}: watched ~${secs.toFixed(0)} s, peak voices ${st.peakVoices}, peak melee bed ${mb}`);
    console.log('    plays:', sorted(st.plays));
    console.log('    pooled:', sorted(st.pooled));
    console.log('    dropped:', sorted(st.dropped));
    check(st.failed.length === 0 && st.peakVoices <= 40, `round ${round}: loads clean, voice cap held`);
    await q.close();
  }
} finally {
  await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures || errors.length ? 1 : 0);
