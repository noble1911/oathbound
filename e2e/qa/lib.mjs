import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
export const BASE = process.env.BASE || 'https://games.noblehaus.uk/oathbound/';
const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
export const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
export const SHOTS = 'e2e/shots';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function launch(extra = []) {
  return puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 600000, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...extra] });
}
export const log = [];
export async function newPage(browser, tag, { w = 1920, h = 1080, url = '', wait = true } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.__tag = tag;
  p.__net = { bytes: 0, reqs: 0, fails: [], list: [] };
  p.on('pageerror', (e) => { log.push(`[${tag}] pageerror: ${e.message}`); console.log(`[${tag}] PAGEERROR ${e.message}`); });
  p.on('console', (m) => { if (['error', 'warn', 'warning'].includes(m.type())) { log.push(`[${tag}] console.${m.type()}: ${m.text()}`); } });
  p.on('response', async (r) => {
    p.__net.reqs++;
    if (r.status() >= 400) { log.push(`[${tag}] HTTP ${r.status()} ${r.url()}`); p.__net.fails.push(`${r.status()} ${r.url()}`); }
  });
  p.on('requestfailed', (r) => { log.push(`[${tag}] requestfailed ${r.url()} ${r.failure()?.errorText}`); });
  const cdp = await p.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.loadingFinished', (e) => { p.__net.bytes += e.encodedDataLength; });
  p.__cdp = cdp;
  if (url !== null) {
    await p.goto(BASE + url, { waitUntil: 'load', timeout: 60000 });
    if (wait) await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 60000 });
  }
  return p;
}
export const shot = async (p, name) => { const f = path.join(SHOTS, `qa-${name}.png`); try { await p.screenshot({ path: f }); } catch (e) { console.log('shot fail', name, e.message); } return f; };
export async function waitFor(p, fn, arg = null, ms = 20000) {
  try { await p.waitForFunction(fn, { timeout: ms, polling: 200 }, arg); return true; } catch { return false; }
}
export const phase = (p) => p.evaluate(() => window.__ob?.app.room?.phase ?? null);
export const state = (p) => p.evaluate(() => {
  const { app } = window.__ob; const r = app.room; if (!r) return null; const v = r.view; const me = v?.you;
  return { phase: r.phase, round: v?.round, left: r.phaseEndsAt - r.serverNow, gold: me?.gold, keep: me?.keepHp, keepMax: me?.keepMax, ekeep: v?.enemy?.keepHp, ekeepMax: v?.enemy?.keepMax, deploys: me ? me.deployLimit - me.deploysUsed : null, unlocked: me?.unlocked, squads: me?.squads.map((s) => ({ id: s.id, type: s.type, level: s.level, pos: s.pos, items: Object.values(s.items).filter(Boolean).length })), stash: me?.stash?.length, draft: me?.draftOptions, draftPicks: me?.draftPicks, loot: me?.lootOffer?.map((i) => i.rarity + ':' + i.name), lastArmy: v?.enemy?.lastArmy?.map((s) => s.type + s.level), screen: app.screen?.constructor?.name, winner: v?.winner };
});
/** frames drawn over ms */
export async function fps(p, ms = 3000) {
  const a = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
  await sleep(ms);
  const b = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
  return +(((b - a) * 1000) / ms).toFixed(1);
}
export function dumpLog(file) { fs.writeFileSync(file, [...new Set(log)].join('\n')); }
/** Find DOM elements offscreen or overlapping. */
export const layoutAudit = (p, sels) => p.evaluate((sels) => {
  const W = innerWidth, H = innerHeight; const out = [];
  const rects = [];
  for (const s of sels) for (const n of document.querySelectorAll(s)) {
    const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    rects.push({ s, r });
    if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) out.push(`OFFSCREEN ${s} [${r.left | 0},${r.top | 0},${r.right | 0},${r.bottom | 0}] in ${W}x${H}`);
    if (n.scrollWidth > n.clientWidth + 2 && cs.overflowX !== 'visible' ) out.push(`HSCROLL/CLIP ${s} scrollW ${n.scrollWidth} > ${n.clientWidth}`);
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j]; if (a.s === b.s) continue;
    const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (ox > 4 && oy > 4) out.push(`OVERLAP ${a.s} x ${b.s} by ${ox | 0}x${oy | 0}`);
  }
  return out;
}, sels);
