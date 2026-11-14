// GPU cost breakdown of the high tier: toggles features one by one and prints GPU ms (timer query).
//   npx vite --port 5180 &   node e2e/render-profile.mjs
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
await page.goto(`http://127.0.0.1:5180/render-test.html?tier=high&ui=0&blur=0&t=15000&paused=1&cam=free&real=${process.env.REAL || 'all'}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
await sleep(6000);
const measure = async (label, fn) => {
  await page.evaluate(fn);
  await page.evaluate(() => { const v = window.__rt.view; v.engine.animate(() => true); });
  await sleep(2500);
  const s = await page.evaluate(() => window.__rt.view.stats);
  console.log(label.padEnd(28), s.gpuMs.toFixed(2), 'ms', s.drawCalls, 'draws', (s.triangles/1e6).toFixed(2)+'M');
};
await measure('high baseline', () => {});
await measure('- water reflection', () => { window.__rt.view.field.water.setReflection(0); });
await measure('no AO', () => { const v = window.__rt.view; v.engine.quality = { ...v.engine.quality, ao: 'off' }; v.engine.post.configure(v.engine.quality); });
await measure('+ no SMAA (fxaa)', () => { const v = window.__rt.view; v.engine.quality = { ...v.engine.quality, aa: 'fxaa' }; v.engine.post.configure(v.engine.quality); });
await measure('+ no DOF/bloom', () => { const v = window.__rt.view; v.engine.quality = { ...v.engine.quality, dof: false, bloom: false }; v.engine.post.configure(v.engine.quality); });
await measure('+ no grass', () => { const v = window.__rt.view; v.field.foliage.setDensity(0, 1); });
await measure('+ no shadows', () => { const v = window.__rt.view; v.engine.renderer.shadowMap.enabled = false; });

await browser.close();
