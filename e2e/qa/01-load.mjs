import { launch, newPage, shot, sleep, fps, log, dumpLog, layoutAudit, waitFor, BASE } from './lib.mjs';
const browser = await launch();
const VPS = [[1920, 1080], [3440, 1440], [1366, 768], [1024, 768]];
for (const [w, h] of VPS) {
  const t0 = Date.now();
  const p = await newPage(browser, `title-${w}`, { w, h });
  const tBoot = Date.now() - t0;
  await sleep(2500);
  const hasOb = await p.evaluate(() => !!window.__ob);
  const kind = await p.evaluate(() => window.__ob?.app.scene.kind);
  console.log(`${w}x${h} boot ${tBoot}ms reqs ${p.__net.reqs} bytes ${(p.__net.bytes / 1e6).toFixed(2)}MB __ob=${hasOb} scene=${kind}`);
  console.log('  title fps (3s):', await fps(p, 3000));
  await shot(p, `title-${w}x${h}`);
  console.log('  audit:', await layoutAudit(p, ['.title-head', '.title-menu', '.title-foot', '.shell .corner']));
  // how-to-play open
  await p.click('.how summary'); await sleep(400);
  await shot(p, `title-how-${w}x${h}`);
  console.log('  audit how:', await layoutAudit(p, ['.title-head', '.title-menu', '.title-foot', '.shell .corner']));
  // settings
  await p.click('.set-btn'); await sleep(400);
  await shot(p, `title-settings-${w}x${h}`);
  console.log('  audit settings:', await layoutAudit(p, ['.settings']));
  const perf = await p.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const res = performance.getEntriesByType('resource'); return { dcl: n.domContentLoadedEventEnd | 0, load: n.loadEventEnd | 0, res: res.map((r) => [r.name.replace(/^.*oathbound\//, ''), r.transferSize, r.duration | 0]).sort((a, b) => b[1] - a[1]).slice(0, 25) }; });
  if (w === 1920) console.log(JSON.stringify(perf, null, 0));
  await p.close();
}
dumpLog('e2e/qa/log-01.txt'); console.log(log.join('\n'));
await browser.close();
