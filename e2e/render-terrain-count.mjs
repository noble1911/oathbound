import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.goto('http://127.0.0.1:5181/src/render-test/terrain-dev.html?tier=high', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2000));
console.log(await page.evaluate(() => {
  const out = [];
  window.__tdev.bf.group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const n = o.isInstancedMesh ? o.count : 1;
    out.push(`${o.name} ${tris}x${n}=${(tris * n / 1000).toFixed(0)}k cast=${o.castShadow}`);
  });
  return out.join('\n');
}));
await browser.close();
