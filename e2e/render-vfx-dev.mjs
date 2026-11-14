// VFX dev screenshots: starts nothing; run `npx vite --port 5182` first. Writes e2e/shots/dev-vfx-*.png
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:5182/src/render-test/vfx-dev.html';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
fs.mkdirSync('e2e/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(800);
const shots = (process.env.SHOTS || 'hits:250,fireball:1000,stone:2350,meteor:1350,lightning:120,rally:900,bulwark:700,skyfall:420,breath:1200,loot:1200,collapse:600,numbers:350,heal:600,frost:900,arrows:800,level:300').split(',');
for (const s of shots) {
  const [name, ms] = s.split(':');
  await page.evaluate(() => window.__vfx.vfx.clear());
  await sleep(150);
  await page.evaluate((n) => window.__vfx.fx[n](), name);
  await sleep(Number(ms));
  await page.screenshot({ path: `e2e/shots/dev-vfx-${name}.png` });
  console.log('shot', name);
}
console.log(errs.length ? errs.join('\n') : 'no errors');
await browser.close();
