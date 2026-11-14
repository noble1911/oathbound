// Camera-vs-props check: for N seeds (real sim battles, full roster, terrain from the seed), plays the
// battle with the director at 3x and every 0.5 s casts 9 rays through the view frustum (centre,
// edges, corners) against nearby trees / props / keeps. FAILS if any prop is within 8 m of the camera.
// Also writes 10 director frames of one battle to e2e/shots/render-director-<k>.png.
//   npx vite --port 5180 &   node e2e/render-camera.mjs      (SEEDS=20, SAMPLES=24, FRAMES=1)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const SEEDS = Number(process.env.SEEDS || 20);
const SAMPLES = Number(process.env.SAMPLES || 24);
const MIN_DIST = 8;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${BASE}render-test.html?${query}&ui=0&blur=0`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  // props must be in (the canopy grid is built from them)
  await page.waitForFunction(() => window.__rt.view.artLoads.some((l) => l.model.startsWith('props')), { timeout: 60000 }).catch(() => {});
  await sleep(1500);
  return page;
}

/** Nearest prop hit (m) along 9 frustum rays, ignoring units. */
const probe = () => {
  const { view, THREE } = window.__rt;
  const cam = view.engine.camera;
  cam.updateMatrixWorld();
  const origin = cam.position.clone();
  const rc = new THREE.Raycaster();
  rc.far = 30;
  const meshes = [];
  view.field.foliage.trees.forEach((t) => t.visible && meshes.push(t));
  view.field.props.group.traverse((o) => o.isMesh && o.visible && meshes.push(o));
  [0, 1].forEach((s) => view.field.keep(s).group.traverse((o) => o.isMesh && o.visible && meshes.push(o)));
  // nearby instances only (fast)
  const cand = [];
  const m4 = new THREE.Matrix4();
  for (const m of meshes) {
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const r = m.geometry.boundingSphere.radius;
    if (m.isInstancedMesh) {
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, m4);
        m4.premultiply(m.matrixWorld);
        const p = new THREE.Vector3().setFromMatrixPosition(m4);
        const s = new THREE.Vector3().setFromMatrixScale(m4).x;
        if (p.distanceTo(origin) < 30 + r * s) {
          const tmp = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
          tmp.matrixAutoUpdate = false;
          tmp.matrix.copy(m4);
          tmp.matrixWorld.copy(m4);
          cand.push(tmp);
        }
      }
    } else {
      const p = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
      if (p.distanceTo(origin) < 60) {
        const tmp = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        tmp.matrixAutoUpdate = false;
        tmp.matrix.copy(m.matrixWorld);
        tmp.matrixWorld.copy(m.matrixWorld);
        cand.push(tmp);
      }
    }
  }
  let min = Infinity;
  for (const [x, y] of [[0, 0], [-0.9, 0], [0.9, 0], [0, -0.9], [0, 0.9], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
    rc.setFromCamera(new THREE.Vector2(x, y), cam);
    rc.far = 30;
    const hit = rc.intersectObjects(cand, false)[0];
    if (hit && hit.distance < min) min = hit.distance;
  }
  return { min: Number.isFinite(min) ? min : 1e9, mode: view.camera.mode, cam: origin.toArray().map((v) => +v.toFixed(1)), t: view.battle ? +(view.battle.timeMs / 1000).toFixed(1) : 0, cand: cand.length };
};

let fails = 0;
let worst = Infinity;
const rows = [];
try {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const p = await open(`real=all&seed=${seed}&tier=low&speed=3`);
    let segFail = 0;
    let segMin = Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      await sleep(500);
      const r = await p.evaluate(probe);
      segMin = Math.min(segMin, r.min);
      if (r.min < MIN_DIST) {
        segFail++;
        if (segFail <= 2) console.log(`  seed ${seed} t=${r.t}s ${r.mode}: prop at ${r.min.toFixed(1)} m from camera ${JSON.stringify(r.cam)}`);
      }
    }
    fails += segFail;
    worst = Math.min(worst, segMin);
    rows.push({ seed, samples: SAMPLES, fails: segFail, nearestPropM: segMin < 1e8 ? +segMin.toFixed(1) : 'none' });
    await p.close();
  }
  console.table(rows);
  console.log(`${fails === 0 ? 'PASS' : 'FAIL'}: ${fails} of ${SEEDS * SAMPLES} director samples had a prop within ${MIN_DIST} m (nearest ${worst.toFixed(1)} m)`);

  if (process.env.FRAMES !== '0') {
    const p = await open('real=all&seed=5&tier=high');
    fs.mkdirSync('e2e/shots', { recursive: true });
    for (let k = 0; k < 10; k++) {
      await sleep(k === 0 ? 2500 : 4200);
      await p.screenshot({ path: path.join('e2e/shots', `render-director-${k}.png`) });
      const r = await p.evaluate(probe);
      console.log(`director frame ${k}: t=${r.t}s nearest prop ${r.min < 1e8 ? r.min.toFixed(1) + ' m' : 'none'} soldiers ${await p.evaluate(() => window.__rt.view.stats.soldiers)}`);
    }
    await p.close();
  }
} finally {
  await browser.close();
}
process.exitCode = fails ? 1 : 0;
