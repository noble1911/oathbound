// A strip of the title's backdrop battle over time (camera work, framing, grade): one JPEG per moment.
//   BASE=http://127.0.0.1:5181/ node e2e/title-strip.mjs OUT_DIR [query]     TIMES=6,14,22,30,40,55  W=1920 H=1080
import { launch, sleep, waitFor } from './qa/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5181/';
const OUT = process.argv[2] || 'e2e/shots/title-strip';
const QUERY = process.argv[3] || 'titleseed=11';
const TIMES = (process.env.TIMES || '6,14,22,30,40,55').split(',').map(Number);
const W = +(process.env.W || 1920), H = +(process.env.H || 1080);
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
try {
  const p = await browser.newPage();
  await p.setViewport({ width: W, height: H });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.evaluateOnNewDocument(() => { localStorage.setItem('oathbound.name', 'Tester'); localStorage.setItem('oathbound.tutorial.done', '1'); });
  await p.goto(`${BASE}?${QUERY}`, { waitUntil: 'load' });
  await waitFor(p, () => window.__ob?.titleBattle()?.state === 'live', null, 90000);
  console.log(JSON.stringify(await p.evaluate(() => { const b = window.__ob.titleBattle(); const m = b.matchup; return { lords: m.lords, round: m.round, soldiers: m.replay.soldiers.length, sec: m.replay.ticks / 20 }; })));
  for (const t of TIMES) {
    if (!(await waitFor(p, (ms) => window.__ob.titleBattle().timeMs >= ms || window.__ob.titleBattle().played > 1, t * 1000, 120000))) break;
    await sleep(100);
    await p.screenshot({ path: path.join(OUT, `t${String(t).padStart(3, '0')}.jpg`), type: 'jpeg', quality: 80 });
    const s = await p.evaluate(() => { const v = window.__ob.app.scene.view; return { ...v.stats, cam: [v.camera.dist.toFixed(0), v.camera.pitch.toFixed(2), v.camera.yaw.toFixed(2)] }; });
    console.log(t, `fps ${s.fps.toFixed(1)} gpu ${s.gpuMs.toFixed(2)} ms draws ${s.drawCalls} tris ${(s.triangles / 1e6).toFixed(2)}M ${s.width}x${s.height} tier ${s.tier} cam ${s.cam}`);
  }
} finally {
  await browser.close();
}
