// Screenshots + FPS of the render showcase (render-test.html) on the real GPU.
//   npx vite --port 5180 &   node e2e/render-shots.mjs
// Env: BASE (default http://127.0.0.1:5180/), CHROME, W/H (1600x900), ONLY=battle-early,meteor,...
//      FPS=0 to skip the fps runs. Writes e2e/shots/render-*.png and prints stats.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = 'e2e/shots';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function open(query) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${query}: ${m.text()}`));
  await page.goto(`${BASE}render-test.html?${query}&blur=0`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 60000 });
  return page;
}
const stats = (page) => page.evaluate(() => window.__rt.view.stats);
const want = (n) => !ONLY || ONLY.includes(n);

// name, query, wait ms, optional in-page action before the shot
const SHOTS_LIST = [
  ['battle-open', 'tier=high&ui=0', 2600],
  ['battle-clash', 'tier=high&ui=0&t=15000&cam=free', 1500, 'clash'],
  ['battle-director', 'tier=high&ui=0&t=17000', 5200],
  ['battle-meteor', 'tier=high&ui=0&t=18600', 2100],
  ['battle-wide', 'tier=high&ui=0&t=26000&cam=free', 1500, 'wide'],
  ['battle-ultra', 'tier=ultra&ui=0&t=22000&cam=free', 1500, 'low'],
  ['battle-late', 'tier=high&ui=0&t=48000&cam=free', 1500, 'keep'],
  ['planning', 'tier=high&ui=0&mode=planning', 2500],
  ['loot', 'tier=high&ui=0&mode=loot', 2500],
  ['panel', 'tier=high&t=18000', 3000],
  ['low-tier', 'tier=low&ui=0&t=15000&cam=free', 1500, 'clash'],
  // real sim battles with the art pipeline's models (militia, knight, keep)
  ['real-overview', 'real=big&tier=high&ui=0&t=9000&cam=free', 4000, 'realWide'],
  ['real-clash', 'real=big&tier=high&ui=0&t=14000&cam=free', 4000, 'realClose'],
  ['real-low', 'real=big&tier=ultra&ui=0&t=17000&cam=free', 4000, 'realLow'],
  ['real-director', 'real=big&tier=high&ui=0&t=12000', 7000],
  ['real-keep', 'real=1&tier=high&ui=0&t=1000&cam=free&paused=1', 4000, 'realKeep'],
  ['real-planning', 'real=big&tier=high&ui=0&mode=planning', 4000, 'realPlan'],
  ['real-militia', 'real=big&tier=ultra&ui=0&t=15500&cam=free&paused=1', 4500, 'realMilitia'],
  // full roster (all 14 units + lords + siege), real art + props
  ['all-overview', 'real=all&tier=high&ui=0&t=7000&cam=free', 6000, 'focus', { id: '*', dist: 85, pitch: 0.72, yaw: 0.35 }],
  ['all-clash', 'real=all&tier=high&ui=0&t=16000&cam=free', 6000, 'focus', { id: 'front', dist: 30, pitch: 0.42, yaw: 0.6 }],
  ['all-director', 'real=all&tier=high&ui=0&t=14000', 9000],
  ['all-dragon', 'real=all&tier=ultra&ui=0&t=9000&cam=free&paused=1', 6000, 'focus', { center: true, id: 'dragon', dist: 16, pitch: 0.18, yaw: 0.3 }],
  ['all-golem', 'real=all&tier=ultra&ui=0&t=6000&cam=free&paused=1', 6000, 'focus', { center: true, id: 'golem', dist: 11, pitch: 0.2, yaw: 0.4 }],
  ['all-lord', 'real=all&tier=ultra&ui=0&t=4000&cam=free&paused=1', 6000, 'focus', { center: true, id: 'lord_marshal', dist: 6, pitch: 0.15, yaw: -0.3 }],
  ['all-siege', 'real=all&tier=ultra&ui=0&t=5000&cam=free&paused=1', 6000, 'focus', { center: true, id: 'trebuchet', dist: 24, pitch: 0.42, yaw: 0.5 }],
  ['all-ballista', 'real=all&tier=ultra&ui=0&t=5000&cam=free&paused=1', 6000, 'focus', { center: true, id: 'ballista', dist: 8, pitch: 0.25, yaw: -0.5 }],
  ['all-cavalry', 'real=all&tier=ultra&ui=0&t=3000&cam=free&paused=1', 6000, 'focus', { center: true, id: 'cavaliers', dist: 10, pitch: 0.22, yaw: 0.4 }],
  ['props-bridge', 'real=all&tier=ultra&ui=0&mode=loot', 6000, 'focus', { id: 'bridge', dist: 24, pitch: 0.28, yaw: 0.8 }],
  ['props-ruins', 'real=all&tier=ultra&ui=0&mode=loot', 6000, 'focus', { id: 'ruins', dist: 26, pitch: 0.55, yaw: 2.6 }],
  ['props-rocks', 'real=all&tier=ultra&ui=0&mode=loot', 6000, 'focus', { id: 'rock', dist: 9, pitch: 0.3, yaw: 0.6 }],
  ['props-keep', 'real=all&tier=high&ui=0&mode=loot', 6000, 'focus', { id: 'keep', dist: 55, pitch: 0.3, yaw: 0.45 }],
  ['all-low', 'real=all&tier=low&ui=0&t=16000&cam=free', 6000, 'focus', { id: 'front', dist: 40, pitch: 0.55, yaw: 0.4 }],
  ['all-planning', 'real=all&tier=medium&ui=0&mode=planning', 6000],
  ['heroes-lineup', 'real=all&tier=ultra&ui=0&mode=planning', 9000, 'heroLineup'],
  ['heroes-close', 'real=all&tier=ultra&ui=0&mode=planning', 9000, 'heroClose'],
  ['planning-hud', 'real=all&tier=medium&ui=0&mode=planning&insets=110,120', 9000, 'rangeRing'],
  ['planning-hud-high', 'real=all&tier=high&ui=0&mode=planning&insets=110,120', 9000],
  ['art-lineup', 'real=1&tier=ultra&ui=0&mode=loot', 6000, 'artLineup'],
  ['real-knights', 'real=big&tier=ultra&ui=0&t=13500&cam=free&paused=1', 4500, 'realKnights'],
  ['real-keep-stage', 'real=1&tier=high&ui=0&t=1000&cam=free&paused=1', 4500, 'realKeepStage'],
];

const ACTIONS = {
  rangeRing: () => {
    const v = window.__rt.view;
    const s = v.units.slots.find((x) => x.header.modelId === 'archers' && x.header.side === 0);
    if (s) v.showRangeRing(s.header.squad, 2800);
  },
  heroLineup: () => {
    const v = window.__rt.view;
    v.setPlanning({ visible: false });
    // the open meadow in front of seat 0's deploy line, heroes + siege in a row facing the camera
    const row = [['lord_marshal', 'lord', 'marshal'], ['lord_archmage', 'lord', 'archmage'], ['lord_warden', 'lord', 'warden'], ['lord_skylady', 'lord', 'skylady'], ['golem', 'golem'], ['ballista', 'ballista'], ['trebuchet', 'trebuchet']];
    v.showArmy(row.map(([m, t, l], i) => ({ id: i + 1, owner: i % 2, type: t, lord: l, modelId: m, pos: [2300 + i * 560, 4300], facing: 192 })));
    v.camera.setMode('rts');
    // a model inspection shot: hide the field-forest trees that sit between the camera and the row
    v.field.foliage.trees.slice(0, 5).forEach((t) => (t.visible = false));
    v.camera.goal.target.set(-2, 1.5, 17);
    v.camera.goal.yaw = 0.1;
    v.camera.goal.dist = 22;
    v.camera.goal.pitch = 0.16;
    v.camera.snap();
  },
  heroClose: () => {
    const v = window.__rt.view;
    v.setPlanning({ visible: false });
    v.showArmy([
      { id: 1, owner: 1, type: 'dragon', pos: [3000, 4300], facing: 176 },
      { id: 2, owner: 0, type: 'wyvern', pos: [4300, 4300], facing: 208 },
      { id: 4, owner: 1, type: 'pegasus', pos: [5300, 4300], facing: 176, size: 1 },
    ]);
    v.camera.setMode('rts');
    v.camera.goal.target.set(1, 7, 17);
    v.camera.goal.yaw = 0;
    v.camera.goal.dist = 26;
    v.camera.goal.pitch = 0.05;
    v.camera.snap();
  },
  focus: (spec) => {
    const v = window.__rt.view;
    const T = window.__rt.THREE;
    v.vfx.clear();
    if (v.camera.mode === 'orbit') v.camera.setMode('rts');
    const alive = v.units.slots.filter((s) => s.visible && s.deadAt < 0);
    let c = new T.Vector3();
    if (spec.id === '*') c.set(0, 0, 5);
    else if (spec.id === 'front') {
      let bd = Infinity;
      for (const a of alive) for (const b of alive) if (a.header.side !== b.header.side) {
        const d = a.pos.distanceToSquared(b.pos);
        if (d < bd) { bd = d; c = a.pos.clone().add(b.pos).multiplyScalar(0.5); }
      }
    } else if (spec.id === 'bridge') c.set(-25, 0, 0);
    else if (spec.id === 'ruins') {
      const f = v.field.hf.layout.features.find((f) => f.kind === 'ruins');
      c.set(f.cx, 0, f.cz);
    } else if (spec.id === 'rock') {
      const m = v.field.props.group.children.find((o) => o.name === 'rocks-0');
      const M = new T.Matrix4();
      let best = 0;
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, M);
        const p = new T.Vector3().setFromMatrixPosition(M);
        const sc = new T.Vector3().setFromMatrixScale(M).x;
        if (Math.abs(p.x) < 40 && Math.abs(p.z) < 55 && sc > best) { best = sc; c = p; }
      }
    } else if (spec.id === 'keep') c.copy(v.field.keep(1).position).add(new T.Vector3(0, 0, 20));
    else {
      const s = alive.find((s) => s.header.modelId === spec.id) ?? v.units.slots.find((s) => s.header.modelId === spec.id);
      if (s) {
        c.copy(s.pos);
        // fliers: look up at them from further away
        if (s.arch.flyHeight > 0 && s.deadAt < 0) {
          spec = { ...spec, dist: spec.dist * 1.6, pitch: 0.32 };
          c.y = 0;
        }
      }
    }
    v.camera.goal.target.set(c.x, 0, c.z);
    // camera on the field-centre side of the subject (+ the spec's yaw as an offset)
    v.camera.goal.yaw = spec.yaw === undefined || spec.center ? Math.atan2(-c.x, -c.z) + (spec.yaw ?? 0) : spec.yaw;
    v.camera.goal.dist = spec.dist;
    v.camera.goal.pitch = spec.pitch;
    v.camera.snap();
  },
  artLineup: () => {
    const v = window.__rt.view;
    v.vfx.clear();
    v.camera.setMode('rts');
    v.showArmy([
      { id: 1, owner: 0, type: 'militia', pos: [3700, 3000], facing: 0 },
      { id: 2, owner: 1, type: 'knights', pos: [4350, 3000], facing: 128 },
      { id: 3, owner: 0, type: 'archers', pos: [3700, 3650], facing: 0 },
    ]);
    v.camera.goal.target.set(0.3, 0, 30);
    v.camera.goal.yaw = 0.2;
    v.camera.goal.dist = 13;
    v.camera.goal.pitch = 0.3;
    v.camera.snap();
  },
  realKnights: () => {
    window.__rtFocus = 'knights';
  },
  realMilitia: () => {
    const v = window.__rt.view;
    const alive = v.units.slots.filter((s) => s.visible && s.deadAt < 0);
    const m = alive.filter((s) => s.header.modelId === (window.__rtFocus || 'militia'));
    // the art soldier closest to any enemy (the front line)
    let best = m[0];
    let bd = Infinity;
    for (const s of m) for (const o of alive) if (o.header.side !== s.header.side) {
      const d = s.pos.distanceToSquared(o.pos);
      if (d < bd) { bd = d; best = s; }
    }
    v.camera.goal.target.copy(best.pos).setY(0);
    v.camera.goal.yaw = 0.9;
    v.camera.goal.dist = 8;
    v.camera.goal.pitch = 0.28;
    v.camera.snap();
  },
  realKeepStage: () => {
    const v = window.__rt.view;
    v.field.keep(1).setStage(3);
    const k = v.field.keep(1).position;
    v.camera.goal.target.set(k.x, 0, k.z + 22);
    v.camera.goal.yaw = 0.5;
    v.camera.goal.dist = 48;
    v.camera.goal.pitch = 0.32;
    v.camera.snap();
  },
  realWide: () => {
    const v = window.__rt.view;
    v.camera.goal.target.set(0, 0, 5);
    v.camera.goal.yaw = 0.3;
    v.camera.goal.dist = 95;
    v.camera.goal.pitch = 0.75;
    v.camera.snap();
  },
  realClose: () => {
    const v = window.__rt.view;
    const pts = v.units.slots.filter((s) => s.visible && s.deadAt < 0 && /militia|knights/.test(s.header.modelId)).map((s) => s.pos);
    const c = pts.reduce((a, p) => a.add(p), new window.__rt.THREE.Vector3()).divideScalar(Math.max(1, pts.length));
    v.camera.goal.target.copy(c).setY(0);
    v.camera.goal.yaw = 0.6;
    v.camera.goal.dist = 26;
    v.camera.goal.pitch = 0.45;
    v.camera.snap();
  },
  realLow: () => {
    const v = window.__rt.view;
    const s = v.units.slots.find((s) => s.visible && s.deadAt < 0 && s.header.modelId === 'knights' && s.header.side === 0) ?? v.units.slots.find((s) => s.visible && s.deadAt < 0 && s.header.modelId === 'militia');
    v.camera.goal.target.copy(s.pos).setY(0);
    v.camera.goal.yaw = 2.4;
    v.camera.goal.dist = 11;
    v.camera.goal.pitch = 0.22;
    v.camera.snap();
  },
  realKeep: () => {
    const v = window.__rt.view;
    const k = v.field.keep(1).position;
    v.camera.goal.target.set(k.x, 0, k.z + 22);
    v.camera.goal.yaw = 0.5;
    v.camera.goal.dist = 48;
    v.camera.goal.pitch = 0.32;
    v.camera.snap();
  },
  realPlan: () => {
    const v = window.__rt.view;
    v.camera.goal.target.set(0, 0, 36);
    v.camera.goal.yaw = 0.15;
    v.camera.goal.dist = 45;
    v.camera.goal.pitch = 0.62;
    v.camera.snap();
  },
  clash: () => {
    const v = window.__rt.view;
    v.camera.goal.target.set(0, 0, 4);
    v.camera.goal.yaw = 0.55;
    v.camera.goal.dist = 34;
    v.camera.goal.pitch = 0.42;
    v.camera.snap();
  },
  meteor: () => {
    const v = window.__rt.view;
    v.camera.goal.target.set(0, 0, 8);
    v.camera.goal.yaw = -0.5;
    v.camera.goal.dist = 55;
    v.camera.goal.pitch = 0.5;
    v.camera.snap();
  },
  wide: () => {
    const v = window.__rt.view;
    v.camera.goal.target.set(0, 0, 0);
    v.camera.goal.yaw = 0.35;
    v.camera.goal.dist = 120;
    v.camera.goal.pitch = NaN;
    v.camera.snap();
  },
  low: () => {
    const v = window.__rt.view;
    v.camera.goal.target.set(-6, 0, 0);
    v.camera.goal.yaw = 1.2;
    v.camera.goal.dist = 22;
    v.camera.goal.pitch = 0.22;
    v.camera.snap();
  },
  keep: () => {
    const v = window.__rt.view;
    v.camera.goal.target.set(0, 0, -50);
    v.camera.goal.yaw = 0.4;
    v.camera.goal.dist = 50;
    v.camera.goal.pitch = 0.45;
    v.camera.snap();
  },
};

try {
  for (const [name, query, wait, act, spec] of SHOTS_LIST) {
    if (!want(name)) continue;
    const p = await open(query);
    if (act === 'heroLineup' || act === 'heroClose') await sleep(5000); // art first
    if (act === 'focus') {
      await sleep(Math.min(wait, 4000)); // let the art arrive first
      await p.evaluate(ACTIONS.focus, spec);
      await sleep(800);
    } else if (act) await p.evaluate(ACTIONS[act]);
    if (act === 'realKnights') await p.evaluate(ACTIONS.realMilitia);
    await sleep(wait);
    await p.screenshot({ path: path.join(SHOTS, `render-${name}.png`) });
    const s = await stats(p);
    console.log(`${name}: ${s.fps.toFixed(0)} fps, ${s.drawCalls} draws, ${(s.triangles / 1e6).toFixed(2)}M tris, ${s.soldiers} soldiers, tier ${s.tier}`);
    await p.close();
  }
  if (process.env.FPS !== '0') {
    for (const tier of ['high', 'ultra']) {
      const p = await open(`tier=${tier}&ui=0&t=14000`);
      await sleep(2500);
      const samples = [];
      for (let i = 0; i < 8; i++) {
        await sleep(600);
        samples.push(await stats(p));
      }
      const fps = samples.map((s) => s.fps).sort((a, b) => a - b);
      const s = samples.at(-1);
      console.log(`FPS ${tier}: median ${fps[fps.length >> 1].toFixed(0)} (min ${fps[0].toFixed(0)}), ${s.drawCalls} draws, ${(s.triangles / 1e6).toFixed(2)}M tris, ${s.soldiers} soldiers + ${s.heroes} heroes, ${s.width}x${s.height}, ${s.gpu}`);
      await p.close();
    }
    // render-on-demand check: planning with idleFps=0 must stop drawing
    const p = await open('tier=high&ui=0&mode=loot');
    await p.evaluate(() => window.__rt.planning());
    await p.evaluate(() => (window.__rt.view.engine.idleFps = 0));
    await sleep(3000);
    const f0 = await p.evaluate(() => window.__rt.view.engine.frames);
    await sleep(1500);
    const f1 = await p.evaluate(() => window.__rt.view.engine.frames);
    console.log(`idle frames over 1.5 s (planning, on demand): ${f1 - f0}`);
    await p.close();
  }
} finally {
  await browser.close();
  if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].slice(0, 30).join('\n'));
}
