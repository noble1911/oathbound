import { launch, sleep } from './lib.mjs';
const b = await launch(); const p = await b.newPage(); await p.setViewport({ width: 1366, height: 768 });
await p.evaluateOnNewDocument(() => {
  const seen = new Set();
  const g = WebGL2RenderingContext.prototype.getActiveUniform;
  WebGL2RenderingContext.prototype.getActiveUniform = function (prog, i) { const u = g.call(this, prog, i); if (u && u.type === 0x8B50 && u.size > 1 && !seen.has(u.name)) { seen.add(u.name); console.log('VEC2ARR ' + u.name + ' size ' + u.size); } return u; };
});
p.on('console', (m) => m.text().startsWith('VEC2ARR') && console.log(m.text()));
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(process.env.BASE + 'render-test.html?real=all', { waitUntil: 'load' });
await sleep(40000);
await b.close();
