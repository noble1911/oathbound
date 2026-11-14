// Item-skill VFX review shots from a real sim battle in which every squad carries the skills of
// its class (render-test.html?real=all&skills=1). For each skill: seek to just before its first
// cast, frame the spot, let it play and capture two moments. Writes e2e/shots/skill-<id>-a/b.png
// and prints which skills were cast (and which never triggered in this battle).
//   npx vite --port 5180 &   node e2e/render-skills.mjs
// Env: BASE, CHROME, ONLY=fireball,cleave  TIER=high  SEED=5
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const TIER = process.env.TIER || 'high';
fs.mkdirSync('e2e/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
const url = `${BASE}render-test.html?real=all&skills=1&seed=${process.env.SEED || 5}&tier=${TIER}&ui=0&cam=free&blur=0`;
const load = async () => {
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await sleep(7000);
};
await load();

// skill: [camera distance, pitch, ms after the cast for shot a, for shot b]
const PLAN = {
  fireball: [20, 0.42, 250, 1500],
  chain_lightning: [18, 0.42, 120, 260],
  frost_nova: [22, 0.5, 300, 1400],
  mending_light: [18, 0.45, 450, 1000],
  shield_wall: [15, 0.36, 500, 2200],
  war_cry: [24, 0.5, 250, 600],
  cleave: [13, 0.42, 700, 1500],
  fire_arrows: [22, 0.42, 450, 1100],
  pinning_shot: [22, 0.42, 450, 1100],
  rain_of_arrows: [22, 0.48, 900, 1650],
  thunderous_charge: [14, 0.4, 260, 600],
  trample: [15, 0.45, 250, 650],
  dive_strike: [16, 0.4, 180, 420],
  incendiary_payload: [24, 0.45, 1100, 2600],
};
const all = await page.evaluate(() => window.__rt.skills.map((e) => ({ skill: e.skill, tick: e.tick, pos: e.pos, src: e.src })));
const counts = {};
for (const e of all) counts[e.skill] = (counts[e.skill] || 0) + 1;
console.log('casts in this battle:', JSON.stringify(counts));

async function shoot(skill) {
  const [dist, pitch, a, b] = PLAN[skill];
  // prefer a cast a little into the battle (armies engaged) when there is a choice
  const casts = all.filter((e) => e.skill === skill);
  if (!casts.length) return false;
  const e = casts[Math.min(casts.length - 1, 1)];
  for (const [tag, wait] of [['a', a], ['b', b]]) {
    await page.evaluate((e, dist, pitch) => {
      const v = window.__rt.view;
      const pb = v.battle;
      pb.playing = true;
      pb.speed = 1;
      pb.seek(Math.max(0, e.tick * 50 - 400));
      // aim between the caster and the target point
      const s = v.units.slots[e.src];
      const wx = e.pos[0] / 100 - 40;
      const wz = 60 - e.pos[1] / 100;
      v.camera.setMode('free');
      const tx = s ? (wx + s.pos.x) / 2 : wx;
      const tz = s ? (wz + s.pos.z) / 2 : wz;
      const far = s ? Math.hypot(wx - s.pos.x, wz - s.pos.z) : 0;
      v.camera.goal.target.set(far > 14 ? wx : tx, v.field.heightAt(tx, tz) + 1, far > 14 ? wz : tz);
      v.camera.goal.dist = dist;
      v.camera.goal.pitch = pitch;
      v.camera.goal.yaw = 0.35;
      v.camera.snap();
    }, e, dist, pitch);
    // wait in BATTLE time (the page may run slower than real time on a busy GPU)
    await page.waitForFunction((ms) => window.__rt.view.battle.timeMs >= ms, { timeout: 60000, polling: 30 }, e.tick * 50 + wait);
    await page.evaluate(() => (window.__rt.view.battle.playing = false));
    await sleep(120);
    await page.screenshot({ path: `e2e/shots/skill-${skill}-${tag}.png` });
  }
  return true;
}

const missing = [];
for (const skill of Object.keys(PLAN)) {
  if (ONLY && !ONLY.includes(skill)) continue;
  let done = false;
  for (let attempt = 0; attempt < 3 && !done; attempt++) {
    try {
      const ok = await shoot(skill);
      if (!ok) missing.push(skill);
      else console.log('shot', skill);
      done = true;
    } catch (err) {
      console.log('retry', skill, String(err.message).slice(0, 70));
      await sleep(2000);
      await load().catch(() => {});
    }
  }
}
if (missing.length) console.log('never cast in this battle:', missing.join(', '));
const hooked = await page.evaluate(() => window.__rt.skillLog.length);
console.log(`onSkill fired ${hooked} times`);
console.log(errors.length ? 'PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 12).join('\n') : 'no page errors');
await browser.close();
