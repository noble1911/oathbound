// In-engine animation frame strips: a real sim battle (render-test.html?real=all), the camera locked on one
// unit, N frames across one loop of the clip it is playing -- to judge gaits, flaps and retargets as the game
// shows them (crowd units through the VAT shader, heroes through the AnimationMixer).
//   npx vite --port 5180 &   node e2e/anim-strips.mjs [golem,cavaliers,...]
// Env: BASE (default http://127.0.0.1:5180/), CHROME, FRAMES (8), TILE (360). Writes e2e/shots/anim-<unit>-<clip>.png.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const N = Number(process.env.FRAMES || 8);
const TILE = Number(process.env.TILE || 360);
const SHOTS = 'e2e/shots';
// unit (replay modelId), battle time (ms) at which it is marching, camera distance, side offset (rad from behind)
const UNITS = {
  golem: { t: 5000, dist: 11, views: [['side', 1.45, 0.12], ['back', 0.35, 0.5]] },
  cavaliers: { t: 2500, dist: 6, views: [['side', 1.45, 0.1], ['rts', 0.9, 0.6]] },
  pegasus: { t: 1200, dist: 6.5, views: [['side', 1.45, 0.05], ['rts', 0.9, 0.6]] },
  wyvern: { t: 3000, dist: 10, views: [['side', 1.45, 0.05], ['rts', 0.9, 0.6]] },
  dragon: { t: 3000, dist: 18, views: [['side', 1.45, 0.05], ['rts', 0.9, 0.6]] },
  militia: { t: 3000, dist: 6, views: [['side', 1.45, 0.12]] },
  knights: { t: 3000, dist: 6, views: [['side', 1.45, 0.12]] },
  lord_archmage: { t: 3000, dist: 7, views: [['side', 1.45, 0.12]] },
};
const want = (process.argv[2] ?? 'golem,cavaliers,pegasus,wyvern,dragon').split(',');
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
try {
  for (const id of want) for (let attempt = 0; attempt < 3; attempt++) try {
    const u = UNITS[id];
    const page = await browser.newPage();
    await page.setViewport({ width: TILE, height: TILE });
    page.on('pageerror', (e) => errors.push(`${id}: ${e.message}`));
    await page.goto(`${BASE}render-test.html?real=all&tier=ultra&ui=0&blur=0&cam=free&t=${u.t}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
    let prev = -1;
    for (let i = 0; i < 40; i++) {
      const n = await page.evaluate(() => window.__rt.view.artLoads.length);
      if (n === prev && n > 0) break;
      prev = n;
      await sleep(1500);
    }
    // let the battle run a moment so speeds / clips settle, then slow it right down
    const info = await page.evaluate(async (id) => {
      const v = window.__rt.view;
      const pb = v.playback;
      pb.playing = true;
      pb.speed = 1;
      await new Promise((r) => setTimeout(r, 1200));
      const s = v.units.slots.find((x) => x.header.modelId === id && x.visible && x.deadAt < 0 && x.moving) ?? v.units.slots.find((x) => x.header.modelId === id && x.visible && x.deadAt < 0);
      if (!s) return null;
      window.__subject = s;
      // inspection shots: no canopy between the camera and the unit, and no obstacle-avoidance camera lift
      v.camera.setObstacles(() => -1e3);
      for (const o of v.field.foliage?.group.children ?? []) if (o.name !== 'grass') o.visible = false;
      pb.speed = 0;
      const clip = s.anim.oneShot ?? s.anim.clip;
      const dur = s.crowd ? s.crowd.asset.clip.get(clip).duration : s.hero.asset.clips.get(clip).duration;
      return { clip, dur, rate: s.anim.rate, speed: s.speed, hero: !!s.hero, art: s.crowd ? !!s.crowd.asset.art : !!s.hero.asset.art };
    }, id);
    if (!info) { console.log(`${id}: no such unit in the battle`); await page.close(); break; }
    console.log(`${id}: clip ${info.clip} (${info.dur.toFixed(2)} s, rate ${info.rate.toFixed(2)}, ${info.speed.toFixed(1)} m/s), ${info.hero ? 'hero/mixer' : 'crowd/VAT'}, art=${info.art}`);
    for (const [vname, yawOff, pitch] of u.views) {
      const tiles = [];
      for (let i = 0; i < N; i++) {
        await page.evaluate(async (dtMs, dist, yawOff, pitch) => {
          const v = window.__rt.view;
          const pb = v.playback;
          const s = window.__subject;
          // advance battle time by one strip step at normal speed, then freeze
          if (dtMs > 0) {
            const t0 = pb.timeMs;
            pb.speed = 1;
            while (pb.timeMs - t0 < dtMs) await new Promise((r) => requestAnimationFrame(r));
            pb.speed = 0;
          }
          if (v.camera.mode !== 'rts') v.camera.setMode('rts');
          v.vfx.clear();
          const lift = s.pos.y - v.field.heightAt(s.pos.x, s.pos.z);
          v.camera.goal.target.set(s.pos.x, lift + s.arch.chest * 0.75 - 1.2, s.pos.z);
          v.camera.goal.yaw = s.yaw + Math.PI + yawOff;       // yawOff 0 = from behind
          v.camera.goal.dist = dist;
          v.camera.goal.pitch = pitch;
          v.camera.snap();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }, i === 0 ? 0 : (info.dur / info.rate / N) * 1000, u.dist, yawOff, pitch);
        await sleep(120);
        tiles.push(await page.screenshot({ encoding: 'base64' }));
      }
      // stitch in the page
      const png = await page.evaluate(async (tiles, TILE) => {
        const c = document.createElement('canvas');
        c.width = TILE * tiles.length; c.height = TILE;
        const g = c.getContext('2d');
        for (let i = 0; i < tiles.length; i++) {
          const im = new Image();
          im.src = 'data:image/png;base64,' + tiles[i];
          await im.decode();
          g.drawImage(im, i * TILE, 0);
        }
        return c.toDataURL('image/png').split(',')[1];
      }, tiles, TILE);
      const out = `${SHOTS}/anim-${id}-${info.clip}-${vname}.png`;
      fs.writeFileSync(out, Buffer.from(png, 'base64'));
      console.log('  wrote', out);
    }
    await page.close();
    break;
  } catch (e) {
    // the dev server reloads the page when someone edits a source file mid-capture: try again
    console.log(`${id}: ${String(e.message).slice(0, 80)} -- retrying`);
  }
  if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
