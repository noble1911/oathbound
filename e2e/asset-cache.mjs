// Versioned-asset check against the real server (PORT=3011 node server/index.ts, after `vite build`).
// Loads the full-roster render test twice in one browser profile and reports, per asset class,
// how the second load was served: from the HTTP cache (0 bytes on the wire), revalidated (304), or
// downloaded again. Models / VAT bins / textures / audio must all come from the cache.
//   node e2e/asset-cache.mjs          Env: BASE (default http://127.0.0.1:3011/), CHROME
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:3011/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const classOf = (u) => {
  const p = new URL(u).pathname;
  if (/\/models\/.*\.(glb|gltf)$/.test(p)) return 'models (glb)';
  if (/\/models\/.*\.bin$/.test(p)) return 'VAT bins';
  if (/\/models\/.*\.(webp|png|jpg)$/.test(p)) return 'model textures';
  if (/\/textures\//.test(p)) return 'env textures';
  if (/\/audio\//.test(p)) return 'audio';
  if (/\/ui\//.test(p)) return 'ui images';
  if (/\.json$/.test(p)) return 'json (manifest, vat meta, versions)';
  if (/\/assets\//.test(p)) return 'bundles (/assets)';
  return 'other';
};

async function run(label) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const req = new Map();
  cdp.on('Network.requestWillBeSent', (e) => req.set(e.requestId, { url: e.request.url, cache: false, status: 0, bytes: 0 }));
  cdp.on('Network.requestServedFromCache', (e) => req.get(e.requestId) && (req.get(e.requestId).cache = true));
  cdp.on('Network.responseReceived', (e) => {
    const r = req.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    if (e.response.fromDiskCache || e.response.fromPrefetchCache) r.cache = true;
  });
  cdp.on('Network.loadingFinished', (e) => req.get(e.requestId) && (req.get(e.requestId).bytes = e.encodedDataLength));
  await page.goto(`${BASE}render-test.html?real=all&tier=medium&ui=0&blur=0&t=3000`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await sleep(12000);
  const rows = {};
  let unversioned = 0;
  for (const r of req.values()) {
    if (!r.url.startsWith(BASE)) continue;
    const c = classOf(r.url);
    const o = (rows[c] ??= { requests: 0, cached: 0, '304': 0, downloaded: 0, wireKB: 0 });
    o.requests++;
    if (r.cache) o.cached++;
    else if (r.status === 304) o['304']++;
    else o.downloaded++;
    o.wireKB += r.bytes / 1024;
    if (/\/(models|textures|audio|ui)\//.test(r.url) && !/\.json(\?|$)/.test(r.url) && !/[?&]v=/.test(r.url)) unversioned++;
  }
  for (const o of Object.values(rows)) o.wireKB = Math.round(o.wireKB);
  console.log(`\n${label}`);
  console.table(rows);
  console.log(`art / audio requests without ?v=: ${unversioned}`);
  await page.close();
  return rows;
}

await run('first load (cold cache)');
const second = await run('second load (warm cache)');
let bad = 0;
for (const c of ['models (glb)', 'VAT bins', 'model textures', 'env textures', 'audio', 'ui images']) {
  const o = second[c];
  if (o && (o['304'] || o.downloaded)) bad += o['304'] + o.downloaded;
}
console.log(bad ? `\nFAIL: ${bad} art request(s) hit the network on the second load` : '\nOK: every model / texture / audio request on the second load came from the cache');
await browser.close();
process.exit(bad ? 1 : 0);
