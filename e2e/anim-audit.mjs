// Animation audit sheets: EVERY clip of EVERY unit as the engine draws it (crowd units through the VAT shader,
// heroes / siege through the AnimationMixer), one soldier alone on the field, the pose driven directly.
// Per unit: a close-up side view (two sheets of up to 5 clips, 8 frames each) and one sheet at RTS distance
// (the pixel size a 1080p player sees from ~35 m, 3/4 from behind).
//   node e2e/anim-audit.mjs <tag> [unit,unit,...] [--clips idle,move,...] [--views side,rts]
// Starts its own vite dev server (no HMR, no file watching, closed at the end) unless BASE is set.
// Env: BASE, CHROME, TILE (300), FRAMES (8). Writes e2e/shots/anim-audit/<tag>/<unit>-{side-a,side-b,rts}.jpg
// Remodel: SET=new audits the staged models (STAGE dir, default art-work/stage_v2, laid over public/models/v2),
// SET=old the models from before the remodel (art-work/backup_v2/pre_remodel); see e2e/remodel-lib.mjs.
//   SET=old node e2e/anim-audit.mjs v3-old lord_marshal ; SET=new node e2e/anim-audit.mjs v3-new lord_marshal
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { startServer, manifestParam } from './remodel-lib.mjs';

const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const TILE = Number(process.env.TILE || 300);
const N = Number(process.env.FRAMES || 8);
const args = process.argv.slice(2);
const tag = args[0] ?? 'before';
const viewArg = args.includes('--views') ? args[args.indexOf('--views') + 1].split(',') : null;
const clipArg = args.includes('--clips') ? args[args.indexOf('--clips') + 1].split(',') : null;
// unit id -> showArmy squad + close-up camera distance (m)
const UNITS = {
  militia: { type: 'militia', dist: 4.6 }, pikeman: { type: 'pikemen', dist: 5.4 }, berserker: { type: 'berserkers', dist: 4.6 },
  archer: { type: 'archers', dist: 4.6 }, knight: { type: 'knights', dist: 5.4 }, mage: { type: 'mages', dist: 4.6 },
  cleric: { type: 'clerics', dist: 4.6 }, skeleton: { type: 'militia', modelId: 'skeleton', dist: 4.6 },
  cavalier: { type: 'cavaliers', dist: 6.2 }, pegasus: { type: 'pegasus', dist: 6.8 },
  lord_marshal: { type: 'lord', lord: 'marshal', dist: 5 }, lord_archmage: { type: 'lord', lord: 'archmage', dist: 5 },
  lord_warden: { type: 'lord', lord: 'warden', dist: 5.4 }, lord_skylady: { type: 'lord', lord: 'skylady', dist: 5.6 },
  golem: { type: 'golem', dist: 11 }, wyvern: { type: 'wyvern', dist: 11 }, dragon: { type: 'dragon', dist: 19 },
  ballista: { type: 'ballista', dist: 7 }, trebuchet: { type: 'trebuchet', dist: 15 },
  // the Ashen Covenant / the Sun Caliphate
  grave_knight: { type: 'grave_knight', dist: 5.4 }, bone_archer: { type: 'bone_archer', dist: 4.6 }, wraith_rider: { type: 'wraith_rider', dist: 6.2 },
  grave_acolyte: { type: 'grave_acolyte', dist: 4.8 }, bone_drake: { type: 'bone_drake', dist: 19 }, corpse_catapult: { type: 'corpse_catapult', dist: 14 },
  bone_golem: { type: 'bone_golem', dist: 11 }, lord_lich: { type: 'lord', lord: 'lich', dist: 5.8 },
  spear_levy: { type: 'spear_levy', dist: 4.8 }, scimitar: { type: 'scimitar', dist: 4.8 }, camel_archer: { type: 'camel_archer', dist: 7.4 }, mamluk: { type: 'mamluk', dist: 6.2 },
  djinn_binder: { type: 'djinn_binder', dist: 4.8 }, sun_priest: { type: 'sun_priest', dist: 4.6 }, djinn: { type: 'djinn', dist: 9 }, war_elephant: { type: 'war_elephant', dist: 14 },
  sand_golem: { type: 'sand_golem', dist: 11 }, lord_sultana: { type: 'lord', lord: 'sultana', dist: 6.5 },
  // Lords whose models ship ahead of the sim (archetypes keyed by model id)
  lord_deathknight: { type: 'lord', lord: 'deathknight', dist: 5.8 }, lord_ossuary: { type: 'lord', lord: 'ossuary', dist: 8.5 }, lord_drakerider: { type: 'lord', lord: 'drakerider', dist: 12 },
  lord_vizier: { type: 'lord', lord: 'vizier', dist: 6 }, lord_rajah: { type: 'lord', lord: 'rajah', dist: 6 }, lord_rocrider: { type: 'lord', lord: 'rocrider', dist: 12 },
};
const want = (args[1] && !args[1].startsWith('--') ? args[1] : Object.keys(UNITS).join(',')).split(',');
const SHEETS = [['side-a', ['idle', 'move', 'run', 'hit', 'victory', 'reload']], ['side-b', ['attack', 'attack2', 'cast', 'death']]];
const OUT = `e2e/shots/anim-audit/${tag}`;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let BASE = process.env.BASE;
const SET = process.env.SET;                       // old | new: a model set served by e2e/remodel-lib.mjs
if (!BASE && SET) {
  const srv = await startServer({ port: 5187 });
  server = { close: srv.close };
  BASE = srv.base;
} else if (!BASE) {
  const { createServer } = await import('vite');
  server = await createServer({ logLevel: 'error', server: { port: 5187, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
  await server.listen();
  BASE = `http://127.0.0.1:${server.config.server.port}/`;
}
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: TILE, height: TILE });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`${BASE}render-test.html?real=all&tier=high&ui=0&blur=0&mode=planning${SET ? manifestParam(SET) : ''}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
  await sleep(1500);
  await page.evaluate(() => {
    const v = window.__rt.view;
    v.setPlanning({ visible: false });
    v.setSquadPlates(false);
    v.camera.setMode('rts');
    v.camera.setObstacles(() => -1e3);
    for (const o of v.field.foliage?.group.children ?? []) o.visible = false;
  });
  for (const id of want) {
    const u = UNITS[id];
    if (!u) { console.log(`${id}: unknown unit`); continue; }
    const info = await page.evaluate(async (u) => {
      const v = window.__rt.view;
      v.showArmy([{ id: 1, owner: 0, type: u.type, lord: u.lord, modelId: u.modelId ?? (u.lord ? `lord_${u.lord}` : undefined), pos: [4000, 4300], facing: 64, size: 1 }]);
      v.setSquadPlates(false);
      const slot = () => v.units.slots[0];
      for (let i = 0; i < 120; i++) {
        const s = slot();
        if (s.crowd ? s.crowd.asset.art : s.hero.asset.art) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 400));
      const s = slot();
      window.__subject = s;
      window.__force = null;
      s.deathYaw = 0;
      window.__arch0 = s.arch;
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
        return { art: b.asset.art, crowd: true, clips: [...b.asset.clip.values()].map((c) => [c.name, c.duration, c.loop]), fly: s.arch.flyHeight };
      }
      const h = s.hero;
      const pose = h.pose.bind(h);
      h.pose = (a, ta, b, tb, wb) => (window.__force ? pose(window.__force.clip, window.__force.t, window.__force.clip, window.__force.t, 0) : pose(a, ta, b, tb, wb));
      return { art: h.asset.art, crowd: false, clips: [...h.asset.clips.entries()].map(([k, c]) => [k, c.duration, ['idle', 'move', 'run', 'victory'].includes(k)]), fly: s.arch.flyHeight };
    }, u);
    console.log(`${id}: art=${info.art} ${info.crowd ? 'crowd/VAT' : 'hero/mixer'} clips ${info.clips.map(([k, d]) => `${k}(${d.toFixed(2)}s)`).join(' ')}`);
    const shot = async (clip, t, dist, yawOff, pitch, crop) => {
      // the camera rig occasionally drifts off the goal between frames: check, and re-take the frame
      for (let attempt = 0; attempt < 6; attempt++) if (await page.evaluate(async (clip, t, dist, yawOff, pitch) => {
        const v = window.__rt.view;
        const s = window.__subject;
        window.__force = { clip, t: Math.max(0, t) };
        // fliers: the renderer drops the corpse to the ground while the death clip plays
        if (clip === 'death' && s.arch.flyHeight > 0) s.deadAt = v.engine.time - t;
        else if (s.deadAt >= 0) { s.deadAt = -1; s.lift = s.arch.flyHeight; }
        v.vfx.clear();
        v.engine.wake?.();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const lift = s.pos.y - v.field.heightAt(s.pos.x, s.pos.z);
        v.camera.goal.target.set(s.pos.x, lift + s.arch.chest * 0.72 - 1.2, s.pos.z);
        v.camera.goal.yaw = s.yaw + Math.PI + yawOff;
        v.camera.goal.dist = dist;
        v.camera.goal.pitch = pitch;
        v.camera.snap();
        if (clip === 'death' && s.arch.flyHeight > 0) s.deadAt = v.engine.time - t;
        v.engine.wake?.();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
        const cam = v.engine.camera.position;
        const d = Math.hypot(cam.x - s.pos.x, cam.z - s.pos.z);
        return Math.abs(d - dist * Math.cos(pitch)) < 0.12 * dist;
      }, clip, t, dist, yawOff, pitch)) break;
      const ok = () => page.evaluate((dist, pitch) => {
        const s = window.__subject;
        const cam = window.__rt.view.engine.camera.position;
        return Math.abs(Math.hypot(cam.x - s.pos.x, cam.z - s.pos.z) - dist * Math.cos(pitch)) < 0.12 * dist;
      }, dist, pitch);
      let png = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(50);
        png = await page.screenshot({ encoding: 'base64', clip: crop });
        if (await ok()) break;                       // the rig drifted while the frame was taken: aim again
        await page.evaluate((dist, yawOff, pitch) => {
          const v = window.__rt.view; const s = window.__subject;
          v.camera.goal.yaw = s.yaw + Math.PI + yawOff; v.camera.goal.dist = dist; v.camera.goal.pitch = pitch;
          v.camera.snap(); v.engine.wake?.();
        }, dist, yawOff, pitch);
      }
      return png;
    };
    const sheet = async (name, clips, dist, yawOff, pitch, crop) => {
      const rows = [];
      const labels = [];
      // the camera eases into a new view: hold the goal until it has settled
      for (let i = 0; i < 12; i++) { await shot('idle', 0, dist, yawOff, pitch, crop); await sleep(150); }
      for (const clip of clips) {
        const c = info.clips.find(([k]) => k === clip);
        if (!c || (clipArg && !clipArg.includes(clip))) continue;
        const tiles = [];
        for (let i = 0; i < N; i++) tiles.push(await shot(clip, c[2] ? (c[1] * i) / N : (c[1] * i) / (N - 1) - 1e-3, dist, yawOff, pitch, crop));
        rows.push(tiles);
        labels.push(`${clip} ${c[1].toFixed(2)}s`);
      }
      if (!rows.length) return;
      const w = crop?.width ?? TILE;
      const jpg = await page.evaluate(async (rows, labels, w) => {
        const c = document.createElement('canvas');
        c.width = w * rows[0].length; c.height = w * rows.length;
        const g = c.getContext('2d');
        for (let r = 0; r < rows.length; r++) {
          for (let i = 0; i < rows[r].length; i++) {
            const im = new Image();
            im.src = 'data:image/png;base64,' + rows[r][i];
            await im.decode();
            g.drawImage(im, i * w, r * w);
          }
          g.font = `bold ${Math.round(w / 14)}px sans-serif`;
          g.fillStyle = '#000'; g.fillText(labels[r], 7, r * w + w / 11 + 1);
          g.fillStyle = '#fff'; g.fillText(labels[r], 6, r * w + w / 11);
        }
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
      }, rows, labels, w);
      fs.writeFileSync(`${OUT}/${id}-${name}.jpg`, Buffer.from(jpg, 'base64'));
      console.log(`  wrote ${OUT}/${id}-${name}.jpg (${labels.join(', ')})`);
    };
    for (const [name, clips] of SHEETS) if (!viewArg || viewArg.includes('side')) await sheet(name, clips, u.dist, Math.PI / 2, 0.1, null);
    const k = Math.round(TILE * 0.44);
    const off = Math.round((TILE - k) / 2);
    if (!viewArg || viewArg.includes('rts')) await sheet('rts', [...SHEETS[0][1], ...SHEETS[1][1]], Math.max(10, u.dist * 1.6), 0.9, 0.62, { x: off, y: off, width: k, height: k });
    await page.evaluate(() => { window.__force = null; });
  }
} finally {
  await browser.close();
  if (server) await server.close();
}
