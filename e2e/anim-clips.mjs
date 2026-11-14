// In-engine clip sheets for hero units (Lords, golem, wyvern, dragon): every clip of one unit, N frames each,
// one row per clip, from a side view and from the RTS angle. The unit is taken from a real sim battle
// (render-test.html?real=all), the battle is frozen and the hero's mixer pose is driven directly, so the sheet
// shows exactly what the engine draws for each clip (GLB + AnimationMixer + hero material + team tint).
//   npx vite --port 5180 &   node e2e/anim-clips.mjs [lord_warden,lord_marshal,...]
// Env: BASE, CHROME, FRAMES (8), TILE (300), CLIPS (idle,move,run,attack,attack2,cast,hit,death,victory).
// Writes e2e/shots/anim-<unit>-clips-<view>.png.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const N = Number(process.env.FRAMES || 8);
const TILE = Number(process.env.TILE || 300);
const CLIPS = (process.env.CLIPS || 'idle,move,run,attack,attack2,cast,hit,death,victory').split(',');
const SHOTS = 'e2e/shots';
const DIST = { golem: 12, wyvern: 11, dragon: 19 };
const VIEWS = [['side', -1.3, 0.1, 1], ['rts', -0.75, 0.62, 1.7]];   // name, yaw from behind, pitch, distance factor
const want = (process.argv[2] ?? 'lord_warden,lord_marshal,lord_archmage,lord_skylady').split(',');
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (const id of want) for (let attempt = 0; attempt < 3; attempt++) try {
    const page = await browser.newPage();
    await page.setViewport({ width: TILE, height: TILE });
    const lords = id.startsWith('lord_') ? `&lords=${id.slice(5)},${id === 'lord_marshal' ? 'archmage' : 'marshal'}` : '';
    await page.goto(`${BASE}render-test.html?real=all&tier=ultra&ui=0&blur=0&cam=free&t=600${lords}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
    let prev = -1;
    for (let i = 0; i < 40; i++) {
      const n = await page.evaluate(() => window.__rt.view.artLoads.length);
      if (n === prev && n > 0) break;
      prev = n;
      await sleep(1500);
    }
    const info = await page.evaluate(async (id) => {
      const v = window.__rt.view;
      const pb = v.playback;
      await new Promise((r) => setTimeout(r, 600));
      const s = v.units.slots.find((x) => x.header.modelId === id && x.hero && x.visible && x.header.side === 0) ?? v.units.slots.find((x) => x.header.modelId === id && x.hero && x.visible);
      if (!s) return null;
      pb.speed = 0;
      window.__subject = s;
      v.camera.setObstacles(() => -1e3);
      for (const o of v.field.foliage?.group.children ?? []) if (o.name !== 'grass') o.visible = false;
      // hide everyone else so the sheet shows one unit
      for (const o of v.units.slots) if (o !== s && o.hero) o.hero.root.visible = false;
      const h = s.hero;
      h.__pose = h.pose.bind(h);
      h.__force = null;
      h.pose = (a, ta, b, tb, wb) => (h.__force ? h.__pose(h.__force.name, h.__force.t, h.__force.name, h.__force.t, 0) : h.__pose(a, ta, b, tb, wb));
      return { art: !!h.asset.art, clips: [...h.asset.clips.entries()].map(([k, c]) => [k, c.name, c.duration]), chest: s.arch.chest };
    }, id);
    if (!info) { console.log(`${id}: not in the battle`); await page.close(); break; }
    console.log(`${id}: art=${info.art} clips ${info.clips.map(([k, n, d]) => `${k}=${n}(${d.toFixed(2)}s)`).join(' ')}`);
    const dist = DIST[id] ?? 4.6;
    for (const [vname, yawOff, pitch, df] of VIEWS) {
      const rows = [];
      for (const clip of CLIPS) {
        const c = info.clips.find(([k]) => k === clip);
        if (!c) continue;
        const loop = ['idle', 'move', 'run', 'victory'].includes(clip);
        const tiles = [];
        for (let i = 0; i < N; i++) {
          const t = loop ? (c[2] * i) / N : (c[2] * i) / (N - 1) - 1e-3;
          await page.evaluate(async (clip, t, dist, yawOff, pitch) => {
            const v = window.__rt.view;
            const s = window.__subject;
            s.hero.__force = { name: s.hero.asset.clips.get(clip).name, t: Math.max(0, t) };
            if (v.camera.mode !== 'rts') v.camera.setMode('rts');
            v.vfx.clear();
            const lift = s.pos.y - v.field.heightAt(s.pos.x, s.pos.z);
            v.camera.goal.target.set(s.pos.x, lift + s.arch.chest * 0.72 - 1.2, s.pos.z);
            v.camera.goal.yaw = s.yaw + Math.PI + yawOff;
            v.camera.goal.dist = dist;
            v.camera.goal.pitch = pitch;
            v.camera.snap();
            v.engine.wake?.();
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
          }, clip, t, dist * df, yawOff, pitch);
          await sleep(60);
          tiles.push(await page.screenshot({ encoding: 'base64' }));
        }
        rows.push(tiles);
      }
      const png = await page.evaluate(async (rows, TILE) => {
        const c = document.createElement('canvas');
        c.width = TILE * rows[0].length; c.height = TILE * rows.length;
        const g = c.getContext('2d');
        for (let r = 0; r < rows.length; r++) for (let i = 0; i < rows[r].length; i++) {
          const im = new Image();
          im.src = 'data:image/png;base64,' + rows[r][i];
          await im.decode();
          g.drawImage(im, i * TILE, r * TILE);
        }
        return c.toDataURL('image/png').split(',')[1];
      }, rows, TILE);
      const out = `${SHOTS}/anim-${id}-clips-${vname}.png`;
      fs.writeFileSync(out, Buffer.from(png, 'base64'));
      console.log('  wrote', out, `(rows: ${CLIPS.filter((k) => info.clips.find(([n]) => n === k)).join(', ')})`);
    }
    await page.close();
    break;
  } catch (e) {
    console.log(`${id}: ${String(e.message).slice(0, 90)} -- retrying`);
  }
} finally {
  await browser.close();
}
