// Planted feet / run sliding, old model vs new model (docs/art-review/ANIM-AUDIT.md), measured in the engine.
//   node e2e/slide-check.mjs <tag> <id,id,...|all> [--stage art-work/stage_v2] [--sets old,new]
//   node e2e/slide-check.mjs <tag> --battle [--lords marshal,lich;sultana,warden] [--secs 45] [--sets old,new]
// Clip mode (per unit, also for ids the sim does not know): the unit stands alone and its `move` / `run` clip is
// stepped at rate 1. Every vertex that is on the ground in two consecutive samples is a planted point; how fast those
// points travel backwards against the body is the ground speed the clip COVERS. The renderer plays the clip at
// `speed / arch.walkSpeed|runSpeed`, so feet slide by the mismatch between that number and the archetype's
// (src/render/crowd/archetypes.ts). `covers` is the weighted median over the samples (stance frames agree on one
// speed; toe-off frames do not); `spread` = the median deviation from it (0 = feet planted like nails).
// Crowd units are read from the VAT texels, heroes from the skinned vertices (what is drawn). Fliers have no contact.
// Battle mode (the audit's sampler): real battles, every moving soldier: ground covered per second against what its
// playing clip covers (`rate x walkSpeed / runSpeed`), mean and 95th percentile per unit type.
// Writes e2e/shots/remodel/slide-<tag>.json and prints a table. A NEW row is flagged when it is worse than OLD by
// more than 3 points and above 8 % (i.e. it would lower the audit grade).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHROME, UNITS, squadOf, sleep, startServer, manifestParam, oldManifest, newManifest } from './remodel-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const tag = args[0] ?? 'test';
const battle = args.includes('--battle');
const sets = opt('--sets', 'old,new').split(',');
const ids = battle ? [] : (!args[1] || args[1] === 'all' ? Object.keys(UNITS).join(',') : args[1]).split(',');
const srv = await startServer({ stage: opt('--stage', undefined) });
const man = { old: oldManifest().models, new: newManifest(srv.stage).models, cur: newManifest(srv.stage).models };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const result = {};

async function open(set, query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 400 });
  await page.setCacheEnabled(false);
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`${srv.base}render-test.html?real=all&tier=low&ui=0&blur=0&${query}${manifestParam(set)}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 180000 });
  await sleep(1200);
  return page;
}

/** In the page: ground speed covered by the planted points of `move` and `run`. */
const measure = async (squad) => {
  const v = window.__rt.view;
  v.setPlanning({ visible: false });
  v.showArmy([squad]);
  const art = (s) => (s.crowd ? s.crowd.asset.art : s.hero.asset.art);
  for (let i = 0; i < 160 && !art(v.units.slots[0]); i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 300));
  const s = v.units.slots[0];
  const out = { art: art(s), crowd: !!s.crowd, fly: s.arch.flyHeight, arch: { move: s.arch.walkSpeed, run: s.arch.runSpeed, runAbove: s.arch.runAbove }, clips: {} };
  if (s.arch.flyHeight > 0) return out;
  const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, sg = h & 0x8000 ? -1 : 1; return e === 0 ? sg * m * 2 ** -24 : e === 31 ? (m ? NaN : sg * Infinity) : sg * (1 + m / 1024) * 2 ** (e - 15); };
  /** frames[f] = Float32Array(xyz per sampled vertex), dt between frames */
  const sample = (clip) => {
    if (s.crowd) {
      const a = s.crowd.asset, c = a.clip.get(clip), vat = a.vat;
      if (!c) return null;
      const d = vat.pos.image.data, isHalf = d instanceof Uint16Array, W = vat.width, n = vat.vertexCount;
      const frames = [];
      for (let f = 0; f <= c.frames; f++) {
        const fr = c.start + (f % c.frames), p = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const o = ((fr * vat.rowsPerFrame + Math.floor(i / W)) * W + (i % W)) * 4;
          for (let k = 0; k < 3; k++) p[i * 3 + k] = isHalf ? half(d[o + k]) : d[o + k];
        }
        frames.push(p);
      }
      return { frames, dt: 1 / c.fps };
    }
    const h = s.hero, c = h.asset.clips.get(clip);
    if (!c) return null;
    const meshes = [];
    h.root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    if (!meshes.length) return null;
    const K = Math.max(12, Math.round(c.duration * 24)), frames = [];
    const inv = h.root.matrixWorld.clone();
    const tmp = h.root.position.clone();
    const steps = meshes.map((m) => Math.max(1, Math.floor(m.geometry.attributes.position.count / 4000)));
    const P = new (h.root.position.constructor)();
    for (let f = 0; f <= K; f++) {
      h.pose(clip, (c.duration * (f % K)) / K, clip, 0, 0);
      h.mixer.update(0);
      h.root.updateMatrixWorld(true);
      inv.copy(h.root.matrixWorld).invert();
      const p = [];
      meshes.forEach((m, mi) => {
        m.skeleton.update();
        const n = m.geometry.attributes.position.count;
        for (let i = 0; i < n; i += steps[mi]) { m.getVertexPosition(i, P); P.applyMatrix4(m.matrixWorld).applyMatrix4(inv); p.push(P.x, P.y, P.z); }
      });
      frames.push(Float32Array.from(p));
    }
    void tmp;
    return { frames, dt: c.duration / K };
  };
  for (const clip of ['move', 'run']) {
    if (clip === 'run' && s.arch.runAbove > 50) continue;      // never plays (golems, siege)
    const r = sample(clip);
    if (!r) continue;
    const { frames, dt } = r;
    const n = frames[0].length / 3;
    let top = -1e9;
    const ys = [];
    for (const p of frames) for (let i = 0; i < n; i++) { ys.push(p[i * 3 + 1]); if (p[i * 3 + 1] > top) top = p[i * 3 + 1]; }
    // ground = the median over the samples of the lowest point (a few vertices dip under the floor in some poses)
    const mins = frames.map((p) => { let m = 1e9; for (let i = 0; i < n; i++) if (p[i * 3 + 1] < m) m = p[i * 3 + 1]; return m; }).sort((a, b) => a - b);
    const ground = mins[mins.length >> 1];
    const tol = Math.max(0.035, 0.012 * (top - ground));
    let wsum = 0, vsum = 0, ssum = 0, contact = 0;
    const dbg = [];
    for (let f = 0; f + 1 < frames.length; f++) {
      const a = frames[f], b = frames[f + 1], dz = [];
      for (let i = 0; i < n; i++) if (a[i * 3 + 1] < ground + tol && b[i * 3 + 1] < ground + tol) dz.push(b[i * 3 + 2] - a[i * 3 + 2]);
      if (dz.length < 3) continue;
      contact++;
      dz.sort((x, y) => x - y);
      const med = dz[dz.length >> 1], mean = dz.reduce((t, x) => t + x, 0) / dz.length;
      const sd = Math.sqrt(dz.reduce((t, x) => t + (x - mean) ** 2, 0) / dz.length);
      wsum += dz.length; vsum += (-med / dt) * dz.length; ssum += (sd / dt) * dz.length;
      dbg.push([f, dz.length, +(-med / dt).toFixed(2)]);
    }
    if (squad.debug) (out.debug ??= {})[clip] = { ground, tol, top, dt, n, dbg };
    if (!wsum) continue;
    // stance frames agree on one speed; toe-off / touch-down frames and swinging tassels do not: weighted median
    const wmed = (xs) => { xs.sort((x, y) => x[0] - y[0]); let t = 0; const half = xs.reduce((q, x) => q + x[1], 0) / 2; for (const x of xs) { t += x[1]; if (t >= half) return x[0]; } return xs[xs.length - 1][0]; };
    const covers = wmed(dbg.map((d) => [d[2], d[1]]));
    const spread = wmed(dbg.map((d) => [Math.abs(d[2] - covers), d[1]]));
    void vsum; void ssum;
    out.clips[clip] = { covers: +covers.toFixed(2), spread: +spread.toFixed(2), contactFrames: +(contact / (frames.length - 1)).toFixed(2), arch: out.arch[clip], mismatch: +((covers - out.arch[clip]) / out.arch[clip]).toFixed(3) };
  }
  return out;
};

try {
  if (!battle) {
    for (const set of sets) {
      const page = await open(set, 'mode=planning');
      for (const id of ids) {
        const u = UNITS[id];
        if (!u) { console.log(`${id}: unknown unit`); continue; }
        if (!man[set][u.modelId ?? (u.lord ? `lord_${u.lord}` : id)]) continue;
        (result[id] ??= {})[set] = await page.evaluate(measure, squadOf(id, { size: 1, debug: !!process.env.DEBUG }));
      }
      await page.close();
    }
    const rows = [];
    for (const [id, r] of Object.entries(result)) {
      for (const clip of ['move', 'run']) {
        const o = r.old?.clips[clip], n = r.new?.clips[clip] ?? r.cur?.clips[clip];
        if (!o && !n) continue;
        const worse = o && n && Math.abs(n.mismatch) > Math.abs(o.mismatch) + 0.03 && Math.abs(n.mismatch) > 0.08;
        const rubber = o && n && n.spread > o.spread * 1.3 + 0.1;
        rows.push({ unit: id, clip, arch: (n ?? o).arch, 'old covers': o?.covers ?? '-', 'old slide %': o ? (o.mismatch * 100).toFixed(0) : '-', 'old spread': o?.spread ?? '-',
          'new covers': n?.covers ?? '-', 'new slide %': n ? (n.mismatch * 100).toFixed(0) : '-', 'new spread': n?.spread ?? '-', verdict: !n ? '' : (r.new ?? r.cur).art === false ? 'STAND-IN' : worse ? 'WORSE (set walkSpeed/runSpeed or fix the clip)' : rubber ? 'more rubbery' : 'ok' });
      }
      if ((r.new ?? r.old)?.fly > 0) rows.push({ unit: id, clip: '(flier: no ground contact)' });
    }
    console.table(rows);
  } else {
    const pairs = opt('--lords', 'marshal,lich;sultana,warden').split(';');
    const secs = Number(opt('--secs', 45));
    for (const set of sets) {
      const acc = {};
      for (const lords of pairs) {
        const page = await open(set, `lords=${lords}&seed=5&speed=1&cam=free`);
        const t0 = Date.now();
        while (Date.now() - t0 < secs * 1000) {
          const rows = await page.evaluate(() => window.__rt.view.units.slots.filter((s) => s.visible && s.deadAt < 0 && s.moving && s.speed > 0.4 && !s.anim.oneShot && (s.anim.clip === 'move' || s.anim.clip === 'run') && s.arch.flyHeight === 0)
            .map((s) => [s.header.modelId ?? s.header.type, s.speed, s.anim.rate * (s.anim.clip === 'move' ? s.arch.walkSpeed : s.arch.runSpeed)]));
          for (const [k, sp, cov] of rows) (acc[k] ??= []).push([sp, Math.abs(sp - cov) / sp]);
          await sleep(100);
        }
        await page.close();
      }
      for (const [k, a] of Object.entries(acc)) {
        const sp = a.map((x) => x[0]).sort((x, y) => x - y), sl = a.map((x) => x[1]).sort((x, y) => x - y);
        (result[k] ??= {})[set] = { samples: a.length, medianSpeed: +sp[sp.length >> 1].toFixed(2), meanSlide: +(sl.reduce((t, x) => t + x, 0) / sl.length).toFixed(3), p95Slide: +sl[Math.floor(sl.length * 0.95)].toFixed(3) };
      }
    }
    console.table(Object.entries(result).map(([k, r]) => ({ unit: k, 'median m/s': (r.new ?? r.old).medianSpeed, 'old mean/p95 %': r.old ? `${(r.old.meanSlide * 100).toFixed(0)} / ${(r.old.p95Slide * 100).toFixed(0)}` : '-',
      'new mean/p95 %': r.new ? `${(r.new.meanSlide * 100).toFixed(0)} / ${(r.new.p95Slide * 100).toFixed(0)}` : '-', verdict: r.old && r.new && r.new.meanSlide > r.old.meanSlide + 0.03 && r.new.meanSlide > 0.08 ? 'WORSE' : 'ok' })));
  }
  const out = path.join(ROOT, 'e2e/shots/remodel');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `slide-${tag}${battle ? '-battle' : ''}.json`), JSON.stringify(result, null, 1));
  console.log(`wrote ${path.join(out, `slide-${tag}${battle ? '-battle' : ''}.json`)}`);
} finally {
  await browser.close();
  await srv.close();
}
