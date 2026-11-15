// Remodel review: every unit OLD (art-work/backup_v2/pre_remodel) vs NEW (staging dir over public/models/v2), drawn
// by the real engine (render-test.html, tier high): overhead / planning camera, mid-battle camera, close-up, for both
// team colours, plus motion strips (run or move, attack, death; 8 frames). Sheets are assembled by model-sheets.py.
//   node e2e/model-compare.mjs <batch> <id,id,...|all> [--stage art-work/stage_v2] [--only cams|strips] [--no-sheets]
// Crowd squads go through the VAT shader, heroes / siege through the AnimationMixer (exactly as in play). Ids without
// an old model (the six new Lords) are shown new-only. Units are placed with `showArmy` by model id, so nothing
// needs to be in the sim. Starts its own server (e2e/remodel-lib.mjs) and closes it and Chrome at the end.
// Output: e2e/shots/remodel/<batch>/raw/<id>__<old|new>__<shot>.png + pos.json, sheets in e2e/shots/remodel/<batch>/
// and in <scratchpad>/remodel-review/<batch>/ (REVIEW_DIR env overrides).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, CHROME, UNITS, squadOf, sleep, startServer, manifestParam, oldManifest, newManifest } from './remodel-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const batch = args[0] ?? 'test';
const ids = (!args[1] || args[1] === 'all' ? Object.keys(UNITS).join(',') : args[1]).split(',');
const only = opt('--only', null);
const REVIEW = process.env.REVIEW_DIR ?? 'C:/Users/rong0/AppData/Local/Temp/claude/b1e16ed48ffbe50a/65edc07b-0d7c-46dc-8bb0-73cca9199d67/scratchpad/remodel-review';
const OUT = path.join(ROOT, 'e2e/shots/remodel', batch);
const RAW = path.join(OUT, 'raw');
fs.mkdirSync(RAW, { recursive: true });
const posFile = path.join(RAW, 'pos.json');
const pos = fs.existsSync(posFile) ? JSON.parse(fs.readFileSync(posFile, 'utf8')) : {};
const N = Number(process.env.FRAMES || 8);
const TILE = 440;

const srv = await startServer({ stage: opt('--stage', undefined) });
const oldM = oldManifest().models, newM = newManifest(srv.stage).models;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900'] });

/** Aim the camera at a slot and hold it there until the rig really is on the goal (it eases / drifts otherwise). */
async function aim(page, slotIndex, cam) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await page.evaluate(async (i, cam) => {
      const v = window.__rt.view;
      const s = v.units.slots[i];
      const ground = v.field.heightAt(s.pos.x, s.pos.z);
      v.camera.setMode(cam.mode ?? 'free');
      // the rig's target height is relative to the ground + 1.2 m
      v.camera.goal.target.set(s.pos.x + (cam.dx ?? 0), s.pos.y - ground + (cam.h ?? 1.2) - 1.2, s.pos.z + (cam.dz ?? 0));
      v.camera.goal.dist = cam.dist;
      v.camera.goal.pitch = cam.pitch;
      v.camera.goal.yaw = cam.yaw ?? s.yaw + cam.rel;
      v.camera.snap();
      v.vfx.clear();
      v.engine.wake?.();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      const c = v.engine.camera;
      const t = v.camera.goal.target;
      const d = Math.hypot(c.position.x - t.x, c.position.z - t.z) / Math.cos(cam.pitch);
      const p = s.pos.clone(); p.y += cam.mark ?? 1.0; p.project(c);
      return { ok: Math.abs(d - cam.dist) < 0.06 * cam.dist + 0.3, xy: [(p.x * 0.5 + 0.5) * innerWidth, (0.5 - p.y * 0.5) * innerHeight] };
    }, slotIndex, cam);
    if (r.ok) return r.xy;
    await sleep(120);
  }
  return null;
}

async function capture(id, set) {
  const u = UNITS[id];
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.setCacheEnabled(false);
  page.on('pageerror', (e) => console.log(`  page error (${id} ${set}):`, e.message));
  page.on('console', (m) => { if (/art model|art prop/.test(m.text())) console.log(`  ${set}:`, m.text()); });
  await page.goto(`${srv.base}render-test.html?real=all&tier=${process.env.TIER ?? 'high'}&ui=0&blur=0&mode=planning${manifestParam(set)}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
  await sleep(1500);
  const show = async (squads, hideFoliage) => page.evaluate(async (squads, hideFoliage) => {
    const v = window.__rt.view;
    v.setPlanning({ visible: false });
    v.camera.setObstacles(() => -1e3, () => -1e3);         // no canopy / unit-top floor under the lens (ground + 1.8 m stays)
    for (const o of v.field.foliage?.group.children ?? []) o.visible = !hideFoliage;
    v.showArmy(squads);
    v.setSquadPlates(false);
    if (v.plates) v.plates.enabled = false;
    const art = (s) => (s.crowd ? s.crowd.asset.art : s.hero.asset.art);
    for (let i = 0; i < 160 && !v.units.slots.every(art); i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 600));
    const sl = v.units.slots;
    // the soldier nearest the centre of each side's squad
    const pick = (side) => {
      const mine = sl.filter((s) => s.header.side === side);
      if (!mine.length) return -1;
      const cx = mine.reduce((t, s) => t + s.pos.x, 0) / mine.length, cz = mine.reduce((t, s) => t + s.pos.z, 0) / mine.length;
      return mine.sort((a, b) => Math.hypot(a.pos.x - cx, a.pos.z - cz) - Math.hypot(b.pos.x - cx, b.pos.z - cz))[0].index;
    };
    v.camera.home(0);
    const s0 = sl[0];
    return {
      art: sl.every(art), crowd: !!s0.crowd, n: sl.length, blue: pick(0), red: pick(1), chest: s0.arch.chest, fly: s0.arch.flyHeight,
      home: { dist: v.camera.goal.dist, pitch: v.camera.goal.pitch, yaw: v.camera.goal.yaw },
      clips: s0.crowd ? [...s0.crowd.asset.clip.values()].map((c) => [c.name, c.duration, c.loop]) : [...s0.hero.asset.clips.entries()].map(([k, c]) => [k, c.duration, ['idle', 'move', 'run', 'victory'].includes(k)]),
    };
  }, squads, hideFoliage);
  const shot = async (name, slot, cam, clip) => {
    const xy = await aim(page, slot, cam);
    await sleep(350);
    await aim(page, slot, cam);
    await sleep(80);
    await page.screenshot({ path: path.join(RAW, `${id}__${set}__${name}.png`), clip });
    if (xy) pos[`${id}__${set}__${name}`] = xy;
  };

  // ---- cameras: a blue and a red squad facing each other
  let info = null;
  if (only !== 'strips') {
    info = await show([squadOf(id, { id: 1, owner: 0, pos: [4000, 3700], facing: 64 }), squadOf(id, { id: 2, owner: 1, pos: [4000, 5100], facing: 192 })], false);
    const h = info.chest;
    const H = info.home;
    await shot('overview', info.blue, { dist: H.dist, pitch: H.pitch, yaw: H.yaw, h: 0, dz: 0, mark: h });
    await page.evaluate((b, r) => { const s = window.__rt.view.units.slots; window.__mid = [s[b].pos.clone(), s[r].pos.clone()]; }, info.blue, info.red);
    pos[`${id}__${set}__overview_red`] = await page.evaluate((r, h) => {
      const v = window.__rt.view; const p = v.units.slots[r].pos.clone(); p.y += h; p.project(v.engine.camera);
      return [(p.x * 0.5 + 0.5) * innerWidth, (0.5 - p.y * 0.5) * innerHeight];
    }, info.red, h);
    const big = Math.max(1, u.dist / 9);
    for (const [tag, slot] of [['blue', info.blue], ['red', info.red]]) {
      await shot(`mid_${tag}`, slot, { dist: 17 * Math.max(1, big * 0.8), pitch: 0.42, rel: 0.75, h: h * 0.8, mark: h });
      await shot(`close_${tag}`, slot, { dist: u.dist * (u.sq ? 0.8 : 0.72), pitch: 0.2, rel: 0.6, h: h * 0.72, mark: h });
    }
    await shot('back_blue', info.blue, { dist: u.dist * 0.8, pitch: 0.3, rel: Math.PI + 0.5, h: h * 0.72, mark: h });
  }

  // ---- motion strips: one soldier alone, the pose driven directly (as e2e/anim-audit.mjs)
  if (only !== 'cams') {
    info = await show([squadOf(id, { size: 1 })], true);
    await page.setViewport({ width: TILE, height: TILE });
    await sleep(500);
    await page.evaluate(() => {
      const v = window.__rt.view;
      const s = v.units.slots[0];
      window.__subject = s; window.__force = null; s.deathYaw = 0;
      if (s.crowd) {
        const b = s.crowd;
        const orig = b.push.bind(b);
        b.push = (m, a, bb, blend, fade, flash, fc, team, mirror) => {
          const f = window.__force;
          if (!f) return orig(m, a, bb, blend, fade, flash, fc, team, mirror);
          const c = b.asset.clip.get(f.clip);
          let x = f.t * c.fps, f0, f1;
          if (c.loop) { x = ((x % c.frames) + c.frames) % c.frames; f0 = Math.floor(x); f1 = (f0 + 1) % c.frames; } else { x = Math.min(Math.max(x, 0), c.frames - 1); f0 = Math.floor(x); f1 = Math.min(f0 + 1, c.frames - 1); }
          const fr = [c.start + f0, c.start + f1, x - f0];
          return orig(m, fr, fr, 0, 1, 0, 0, team, 1);
        };
      } else {
        const h = s.hero;
        const pose = h.pose.bind(h);
        h.pose = (a, ta, b, tb, wb) => (window.__force ? pose(window.__force.clip, window.__force.t, window.__force.clip, window.__force.t, 0) : pose(a, ta, b, tb, wb));
      }
    });
    const want = [info.clips.some(([k]) => k === 'run') && !u.siege ? 'run' : 'move', 'attack', 'death'].filter((c) => info.clips.some(([k]) => k === c));
    if (u.siege) want.unshift('idle');
    const stripClips = [];
    for (let i = 0; i < 6; i++) { await aim(page, 0, { dist: u.dist, pitch: 0.1, rel: Math.PI + Math.PI / 2, h: info.chest * 0.6 }); await sleep(150); }   // let the rig settle on the side view
    for (const clip of [...new Set(want)]) {
      const c = info.clips.find(([k]) => k === clip);
      for (let i = 0; i < N; i++) {
        const t = Math.max(0, c[2] ? (c[1] * i) / N : (c[1] * i) / (N - 1) - 1e-3);
        await page.evaluate((clip, t) => {
          const v = window.__rt.view; const s = window.__subject;
          window.__force = { clip, t };
          if (clip === 'death' && s.arch.flyHeight > 0) s.deadAt = v.engine.time - t;
          else if (s.deadAt >= 0) { s.deadAt = -1; s.lift = s.arch.flyHeight; }
        }, clip, t);
        // side view; fliers are followed at their own height (`abs` off), corpses of fliers fall to the ground
        await shot(`strip_${clip}_${i}`, 0, { dist: u.dist, pitch: 0.1, rel: Math.PI + Math.PI / 2, h: info.chest * 0.6, mark: info.chest * 0.6 });
      }
      stripClips.push([clip, c[1]]);
    }
    pos[`${id}__${set}__strips`] = stripClips;
    await page.evaluate(() => { window.__force = null; });
  }
  pos[`${id}__${set}__info`] = { art: info.art, crowd: info.crowd, n: info.n };
  await page.close();
  fs.writeFileSync(posFile, JSON.stringify(pos));
  return info;
}

try {
  for (const id of ids) {
    const u = UNITS[id];
    if (!u) { console.log(`${id}: unknown unit (add it to e2e/remodel-lib.mjs UNITS)`); continue; }
    const key = u.modelId ?? (u.lord ? `lord_${u.lord}` : id);
    for (const set of ['old', 'new']) {
      const has = (set === 'old' ? oldM : newM)[key];
      if (!has) { console.log(`${id}: no ${set} model`); delete pos[`${id}__${set}__info`]; continue; }
      const t = Date.now();
      const info = await capture(id, set);
      console.log(`${id} ${set}: art=${info.art} ${info.crowd ? 'crowd/VAT' : 'hero/mixer'} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    }
  }
} finally {
  fs.writeFileSync(posFile, JSON.stringify(pos));
  await browser.close();
  await srv.close();
}
if (!args.includes('--no-sheets')) {
  const r = spawnSync('python', [path.join(ROOT, 'e2e/model-sheets.py'), OUT, path.join(REVIEW, batch), ids.join(',')], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}
