// Debug helper: open render-test.html with a query, run a JS expression in the page, print the result
// (and any console errors / warnings).   node e2e/render-eval.mjs "real=all&tier=high&mode=planning" "window.__rt.view.stats"
// Env: SHOT=path.png (also save a screenshot), W / H / DPR, THROTTLE (CPU rate), WAIT (ms, default 6000)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(process.env.W || 1600), height: Number(process.env.H || 900), deviceScaleFactor: Number(process.env.DPR || 1) });
  if (process.env.THROTTLE) await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(m.type().toUpperCase(), m.text().slice(0, 1500)));
  await page.goto(`${BASE}render-test.html?ui=0&blur=0&${process.argv[2] || ''}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rt?.ready, { timeout: 120000 });
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT || 6000)));
  const out = await page.evaluate(`(async () => { const v = window.__rt.view; const T = window.__rt.THREE; return (${process.argv[3] || 'v.stats'}); })()`);
  console.log(JSON.stringify(out, null, 1));
  if (process.env.SHOT) {
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: process.env.SHOT });
  }
} finally {
  await browser.close();
}
