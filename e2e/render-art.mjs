// Checks the art pipeline integration in a real sim battle (render-test.html?real=1):
//  - art models load lazily (only unit types present) — prints download size + load time per model
//  - VAT decode sanity: frame 0 positions vs the GLB rest mesh, and octahedral normals (pos.w)
//    vs the GLB normals (mean dot should be high if the encoding / axes match)
//   npx vite --port 5180 &   node e2e/render-art.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  const reqs = [];
  page.on('requestfinished', async (r) => {
    if (!r.url().includes('/models/v2/')) return;
    const b = await r.response()?.buffer().catch(() => null);
    reqs.push({ url: r.url().replace(/.*models\/v2\//, ''), bytes: b?.length ?? 0 });
  });
  await page.setViewport({ width: 1280, height: 720 });
  const t0 = Date.now();
  await page.goto(`${BASE}render-test.html?real=${process.env.REAL || 'all'}&tier=high&ui=0&blur=0`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  // wait until every art type present + props + keep has loaded (or 60 s)
  let prev = -1;
  for (let i = 0; i < 60; i++) {
    const n = await page.evaluate(() => window.__rt.view.artLoads.length);
    if (n === prev && n > 0) break;
    prev = n;
    await sleep(1500);
  }
  const r = await page.evaluate(() => {
    const { view, THREE, info } = window.__rt;
    const types = [...new Set(view.units.slots.map((s) => s.header.modelId))];
    const checks = [];
    for (const b of view.units.batches.values()) {
      const a = b.asset;
      if (!a.art) continue;
      const g = a.geometry;
      const pos = g.getAttribute('position');
      const nrm = g.getAttribute('normal');
      const vid = g.getAttribute('vatIndex');
      const tex = a.vat.pos.image;
      const half = tex.data instanceof Uint16Array;
      const rd = (i) => (half ? THREE.DataUtils.fromHalfFloat(tex.data[i]) : tex.data[i]);
      const idle = a.clip.get('idle');
      let dist = 0;
      let dot = 0;
      let dotSwap = 0;
      const n = pos.count;
      for (let i = 0; i < n; i++) {
        const v = vid.getX(i);
        const x = v % a.vat.width;
        const y = idle.start * a.vat.rowsPerFrame + Math.floor(v / a.vat.width);
        const o = (y * a.vat.width + x) * 4;
        const px = rd(o), py = rd(o + 1), pz = rd(o + 2), w = Math.round(rd(o + 3));
        dist += Math.hypot(px - pos.getX(i), py - pos.getY(i), pz - pos.getZ(i));
        const ox = Math.floor(w / 45), oy = w - ox * 45;
        let ex = (ox / 44) * 2 - 1, ey = (oy / 44) * 2 - 1;
        let ez = 1 - Math.abs(ex) - Math.abs(ey);
        if (ez < 0) {
          const tx = (1 - Math.abs(ey)) * (ex >= 0 ? 1 : -1);
          const ty = (1 - Math.abs(ex)) * (ey >= 0 ? 1 : -1);
          ex = tx;
          ey = ty;
        }
        const l = Math.hypot(ex, ey, ez) || 1;
        const d = (ex * nrm.getX(i) + ey * nrm.getY(i) + ez * nrm.getZ(i)) / l;
        dot += d;
        // alternative convention (Blender Z-up): (x, z, -y)
        dotSwap += (ex * nrm.getX(i) + ez * nrm.getY(i) - ey * nrm.getZ(i)) / l;
      }
      checks.push({ model: a.key, verts: n, vatVerts: a.vat.vertexCount, meanPosDist: +(dist / n).toFixed(3), meanNormalDot: +(dot / n).toFixed(3), meanDotZup: +(dotSwap / n).toFixed(3), clips: [...a.clip.keys()].join(',') });
    }
    const heroes = [...new Set(view.units.slots.filter((s) => s.hero).map((s) => `${s.arch.key}: ${s.hero.asset.art ? 'ART' : 'procedural'} clips=${[...s.hero.asset.clips.keys()].join('/')}${s.hero.asset.fireTime !== undefined ? ' fireTime=' + s.hero.asset.fireTime.toFixed(2) : ''}`))];
    const crowd = [...view.units.batches.values()].map((b) => `${b.asset.key}: ${b.asset.art ? 'ART' : 'procedural'}`);
    return { info, types, loads: view.artLoads, checks, heroes, crowd };
  });
  console.log(r.info);
  console.log('unit types present:', r.types.join(', '));
  console.log('art loads:', JSON.stringify(r.loads));
  console.log('requests under models/v2:', JSON.stringify(reqs), 'total', reqs.reduce((a, b) => a + b.bytes, 0), 'bytes; page ready', Date.now() - t0, 'ms');
  console.table(r.checks);
  console.log('crowd:', r.crowd.join(' | '));
  console.log('heroes:');
  for (const h of r.heroes) console.log('  ' + h);
  const bad = logs.filter((l) => /error|warn/i.test(l));
  if (bad.length) console.log(bad.slice(0, 15).join('\n'));
} finally {
  await browser.close();
}
