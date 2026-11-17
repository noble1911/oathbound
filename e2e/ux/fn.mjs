// Functional UX checks (need the server for the spectator part):
//   - the graphics quality choice survives a reload;
//   - planning from round 2: the enemy's last-round army is always drawn, the intel chip is a plain
//     label, Tab cycles through your own squads, the squad panel shows "Countered by" at 1366x768;
//   - the tutorial at 1024x768: coach clear of the Lord pick heading and cards with Aldric ringed,
//     no timer in the footer, step numbers only ever go up, round 2 teaches levelling up, and it
//     ends with Finish tutorial / Keep playing when no modal is open;
//   - a spectator follows the room when the players skip a battle, sees the results, and idles at 0 fps.
// Screenshots: e2e/shots/fn-*.png.
//   DIST=dist-fn PORT=3057 node server/index.ts &  BASE=http://127.0.0.1:3057/ node e2e/ux/fn.mjs [quality|planning|tutorial|spectator ...]
import { launch, sleep, waitFor } from '../qa/lib.mjs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3057/';
const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);
const browser = await launch();
const errors = [];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
async function page(tag, w, h, url = '') {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`));
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.body.classList.contains('booted'), { timeout: 30000 });
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join('e2e/shots', `fn-${name}.png`) });
const rect = (p, sel) => p.evaluate((sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const hit = (a, b) => !!a && !!b && a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y;
const sceneUp = (p) => waitFor(p, () => !!window.__ob.app.scene && !!document.querySelector('.planning'), null, 60000);
const fps = async (p, ms = 2500) => {
  const a = await p.evaluate(() => window.__ob.app.scene.framesDrawn);
  await sleep(ms);
  return +((((await p.evaluate(() => window.__ob.app.scene.framesDrawn)) - a) * 1000) / ms).toFixed(1);
};
const intent = (p, i) => p.evaluate((i) => window.__ob.app.backend.intent(i), i);
const coach = (p) => p.evaluate(() => {
  const c = document.querySelector('.coach.on');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { n: c.querySelector('.coach-n').textContent, t: c.querySelector('.coach-t').textContent, x: c.querySelector('.coach-x').textContent, slot: c.dataset.slot, final: c.classList.contains('final'), rect: { x: r.left, y: r.top, r: r.right, b: r.bottom }, z: Number(getComputedStyle(c).zIndex) };
});

try {
  if (want('quality')) {
    const p = await page('Q', 1366, 768, '?dev=planning&timer=0');
    await sceneUp(p);
    await p.evaluate(() => window.__ob.app.shell.onQuality('ultra'));
    await sleep(400);
    const before = await p.evaluate(() => window.__ob.app.scene.quality());
    await p.reload({ waitUntil: 'domcontentloaded' });
    await sceneUp(p);
    const after = await p.evaluate(() => window.__ob.app.scene.quality());
    check(before.choice === 'ultra' && after.choice === 'ultra' && after.tier === 'ultra', `Ultra survives a reload (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
    await p.evaluate(() => window.__ob.app.shell.onQuality('auto'));
    await p.reload({ waitUntil: 'domcontentloaded' });
    await sceneUp(p);
    check((await p.evaluate(() => window.__ob.app.scene.quality().choice)) === 'auto', 'Auto survives a reload');
    await p.close();
  }

  if (want('planning')) {
    const p = await page('P', 1366, 768, '?dev=planning&timer=0');
    await sceneUp(p);
    await sleep(3500);
    // deal with the round's recruits and spoils first (their modals own the keyboard)
    await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; for (let i = 0; i < me.draftPicks; i++) app.backend.intent({ t: 'draft', unit: me.draftOptions[i] }); });
    await sleep(600);
    await p.evaluate(() => { const { app } = window.__ob; if (app.room.view.you.lootOffer) app.backend.intent({ t: 'pickLoot', index: 0 }); });
    await waitFor(p, () => !document.querySelector('.modal'));
    await sleep(600);
    const chip = await p.evaluate(() => { const n = document.querySelector('.r-ghost'); return { tag: n.tagName, text: n.textContent.trim(), on: n.classList.contains('on'), kbd: !!n.querySelector('kbd'), tip: n.dataset.tip }; });
    check(chip.tag === 'DIV' && chip.text === 'Enemy positions: last round' && chip.on && !chip.kbd, `intel chip is a plain label (${JSON.stringify(chip)})`);
    const ghosts = await p.evaluate(() => {
      const { app } = window.__ob;
      const last = app.room.view.enemy.lastArmy ?? [];
      const drawn = last.filter((s) => app.scene.view.units.slots.some((u) => u.visible && u.header.squad === s.id)).length;
      const on = last.map((s) => app.scene.toScreen(s.pos, 0)).filter((q) => q && q.x >= 0 && q.x <= innerWidth && q.y >= 0 && q.y <= innerHeight).length;
      return { n: last.length, drawn, on };
    });
    check(ghosts.n > 0 && ghosts.drawn === ghosts.n, `every squad of the enemy's last army is drawn as a ghost (${JSON.stringify(ghosts)})`);
    console.log(`     ghosts inside the default planning framing: ${ghosts.on}/${ghosts.n}`);
    await shot(p, 'planning-ghosts-1366');
    const sel = () => p.evaluate(() => window.__ob.app.screen.selected);
    await p.keyboard.press('Tab');
    await sleep(250);
    const s1 = await sel();
    await p.keyboard.press('Tab');
    await sleep(250);
    const s2 = await sel();
    await p.keyboard.down('Shift');
    await p.keyboard.press('Tab');
    await p.keyboard.up('Shift');
    await sleep(250);
    const s3 = await sel();
    check(s1 !== null && s2 !== null && s1 !== s2 && s3 === s1, `Tab / Shift+Tab cycle through my squads (${s1}, ${s2}, back to ${s3})`);
    check((await p.evaluate(() => (window.__ob.app.room.view.enemy.lastArmy ?? []).every((s) => window.__ob.app.scene.view.units.slots.some((u) => u.visible && u.header.squad === s.id)))), 'ghosts still drawn after Tab');
    // every squad's panel: nothing below the fold that cannot be reached, "Countered by" on screen
    const n = await p.evaluate(() => window.__ob.app.room.view.you.squads.length);
    let worst = { over: -1 };
    for (let i = 0; i < n; i++) {
      await p.keyboard.press('Tab');
      await sleep(200);
      const m = await p.evaluate(() => {
        const pn = document.querySelector('.sqpanel');
        const r = pn.getBoundingClientRect();
        const c = pn.querySelector('.ctr-row.bad') ?? pn.querySelector('.ctr-d') ?? pn.lastElementChild;
        const cr = c.getBoundingClientRect();
        return { name: pn.querySelector('.sp-t b').textContent, over: pn.scrollHeight - pn.clientHeight, cut: Math.round(cr.bottom - r.bottom), bottom: Math.round(r.bottom), bar: Math.round(document.querySelector('.bottom').getBoundingClientRect().top) };
      });
      if (m.over > worst.over) worst = m;
      if (m.over > 0 || m.cut > 0) await shot(p, `panel-clip-${i}`);
    }
    check(worst.over <= 0 && worst.cut <= 0, `squad panel fits at 1366x768 without scrolling (worst: ${JSON.stringify(worst)})`);
    await shot(p, 'panel-1366');
    const sp = await rect(p, '.sqpanel');
    check(!hit(sp, await rect(p, '.r-ghost')) && sp.b <= (await rect(p, '.ready-box')).y + 1, 'squad panel clear of the intel label and the Ready button');
    await p.close();
  }

  if (want('tutorial')) {
    const p = await page('T', 1024, 768);
    await p.type('.name', 'Wanderer');
    await p.click('.tutorial');
    await waitFor(p, () => window.__ob.app.room?.phase === 'lordPick');
    await waitFor(p, () => !!document.querySelector('.coach.on'));
    await sleep(1500);
    const labels = [];
    const note = async () => { const c = await coach(p); if (c && c.n && labels.at(-1) !== c.n) labels.push(c.n); return c; };
    let c = await note();
    const cards = await p.$$eval('.lcard', (ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, ring: n.classList.contains('coach-target'), lord: n.dataset.lord }; }));
    check(!!c && !hit(c.rect, await rect(p, '.lp-head h2')) && !cards.some((k) => hit(c.rect, k)), `lord pick: coach clear of the heading and the cards (slot ${c?.slot})`);
    check(!hit(c.rect, await rect(p, '.lp-foot')) || (await rect(p, '.lp-foot')).h === 0, 'lord pick: coach clear of the footer line');
    check(cards.filter((k) => k.ring).map((k) => k.lord).join() === 'marshal', 'lord pick: the recommended Aldric card is ringed');
    check(cards.every((k) => k.b <= 768 && k.y >= 0), 'lord pick: all four cards still on screen');
    const foot = await p.$eval('.lp-foot', (n) => n.textContent);
    check(!/timer/i.test(foot), `lord pick footer does not mention a timer (${JSON.stringify(foot)})`);
    await shot(p, 'tut-lordpick-1024');
    await p.click('.lcard[data-lord="marshal"]');
    await waitFor(p, () => !!document.querySelector('.modal.draft'), null, 15000);
    await sleep(700);
    await note();
    for (let i = 0; i < 2; i++) {
      await p.evaluate(() => window.__ob.app.backend.intent({ t: 'draft', unit: window.__ob.app.room.view.you.draftOptions[0] }));
      await sleep(500);
    }
    await waitFor(p, () => !document.querySelector('.modal'));
    await sleep(800);
    c = await note();
    check(c?.t === 'Deploy a squad' && c.slot === 'right', `deploy step sits on the right (${c?.t}, ${c?.slot})`);
    // hover the first shop card: the tooltip must not hide the coach
    const uc = await rect(p, '.ucard');
    await p.mouse.move(uc.x + uc.w / 2, uc.y + uc.h / 2, { steps: 4 });
    await sleep(700);
    const tipR = await rect(p, '.tip-layer.on');
    c = await coach(p);
    const tipZ = await p.evaluate(() => Number(getComputedStyle(document.querySelector('.tip-layer')).zIndex));
    check(!!tipR && (!hit(c.rect, tipR) || c.z > tipZ), `unit tooltip does not cover the coach (overlap ${hit(c.rect, tipR)}, coach z ${c.z} vs tip ${tipZ})`);
    await shot(p, 'tut-ucard-hover-1024');
    await p.mouse.move(512, 300);
    // round 1: three cheapest squads, ready, skip the battle
    const deployAll = async () => {
      for (let i = 0; i < 4; i++) {
        const st = await p.evaluate(() => { const me = window.__ob.app.room.view.you; return { left: me.deployLimit - me.deploysUsed, gold: me.gold, n: me.squads.length }; });
        if (st.left <= 0 || st.gold < 100) break;
        await intent(p, { t: 'deploy', unit: 'militia', pos: [1400 + st.n * 1100, 3000], facing: 64 });
        await sleep(500);
        await note();
      }
    };
    await deployAll();
    await sleep(500);
    await note();
    const battle = async () => {
      await intent(p, { t: 'ready' });
      await waitFor(p, () => !!document.querySelector('.battle'), null, 15000);
      await sleep(1500);
      await note();
      await p.keyboard.press('End');
      await waitFor(p, () => window.__ob.app.room?.phase === 'results', null, 15000);
      await sleep(900);
      await note();
      await waitFor(p, () => window.__ob.app.room?.phase === 'planning', null, 20000);
    };
    await battle();
    // round 2: recruits, spoils, equip, then the level-up lesson
    const gold2 = await p.evaluate(() => ({ gold: window.__ob.app.room.view.you.gold, grant: window.__ob.app.local.tutorialGrant }));
    check(gold2.grant > 0, `round 2: the tutorial match granted level-up gold (${JSON.stringify(gold2)})`);
    await waitFor(p, () => !!document.querySelector('.modal.draft'), null, 15000);
    await sleep(600);
    await note();
    await p.evaluate(() => window.__ob.app.backend.intent({ t: 'draft', unit: window.__ob.app.room.view.you.draftOptions[0] }));
    await waitFor(p, () => !!document.querySelector('.modal.loot'), null, 15000);
    await sleep(600);
    await note();
    await intent(p, { t: 'pickLoot', index: 0 });
    await waitFor(p, () => !document.querySelector('.modal'));
    await sleep(800);
    await note();
    await p.evaluate(() => { const me = window.__ob.app.room.view.you; const it = me.stash[0]; const sq = me.squads.find((s) => s.type === 'lord'); window.__ob.app.backend.intent({ t: 'equip', item: it.id, squad: sq.id }); });
    await sleep(900);
    c = await note();
    check(c?.t === 'Level up a squad' && /Tab/.test(c.x), `round 2: the coach asks for a level-up before deploying (${c?.t})`);
    await shot(p, 'tut-level-1024');
    await p.keyboard.press('Tab');
    await sleep(300);
    await p.keyboard.press('Tab'); // past the Lord
    await sleep(700);
    c = await coach(p);
    const ringed = await p.evaluate(() => !!document.querySelector('.sqpanel .lvl.coach-target'));
    check(c?.t === 'Level up' && ringed && !hit(c.rect, await rect(p, '.sqpanel')), 'round 2: Level up button ringed, coach clear of the squad panel');
    await shot(p, 'tut-level-selected-1024');
    await p.keyboard.press('u');
    await sleep(900);
    check(await p.evaluate(() => window.__ob.app.room.view.you.squads.some((s) => s.type !== 'lord' && s.level === 2)), 'round 2: a squad is level 2');
    await p.keyboard.press('Escape');
    await sleep(600);
    c = await note();
    // deploys are weighted: the Marshal's limit is 6 deploy points (4 + his passive's 2), whole numbers, never "½"
    check(/deploy points? left/.test(c?.t ?? '') && /You have 6 deploy points this round/.test(c.x) && !/½/.test(c.t + c.x), `deploys step quotes the Marshal's limit (${c?.t}: ${c?.x.slice(0, 60)})`);
    await deployAll();
    await sleep(800);
    c = await note();
    // gold left over after the deploys: the coach asks to spend it on levels first ("Spend what is left")
    for (let i = 0; i < 6 && c?.t === 'Spend what is left'; i++) {
      await p.evaluate(() => { const me = window.__ob.app.room.view.you; for (const q of me.squads) if (q.type !== 'lord') window.__ob.app.backend.intent({ t: 'levelUp', squad: q.id }); });
      await sleep(700);
      c = await note();
    }
    check(c?.t === 'Know your enemy' && !/hides/.test(c.x), `ghosts step no longer mentions hiding them (${c?.t})`);
    await shot(p, 'tut-ghosts-1024');
    await battle();
    // round 3: the closing choice, only once the recruits and spoils are dealt with
    await waitFor(p, () => !!document.querySelector('.modal.draft'), null, 15000);
    await sleep(900);
    c = await coach(p);
    check(!c?.final, `round 3: no closing card over the draft modal (${c?.t})`);
    await p.evaluate(() => window.__ob.app.backend.intent({ t: 'draft', unit: window.__ob.app.room.view.you.draftOptions[0] }));
    await waitFor(p, () => !!document.querySelector('.modal.loot'), null, 15000);
    await sleep(600);
    await intent(p, { t: 'pickLoot', index: 0 });
    await waitFor(p, () => !document.querySelector('.modal'));
    await sleep(1000);
    c = await note();
    const acts = await p.$$eval('.coach .coach-acts button', (ns) => ns.filter((n) => n.getBoundingClientRect().height > 0).map((n) => n.textContent));
    check(!!c?.final && acts.join('|') === 'Keep playing|Finish tutorial', `round 3: closing choice shown (${c?.t}; ${acts.join('|')})`);
    await shot(p, 'tut-finish-1024');
    await sleep(10000);
    check(!!(await coach(p))?.final, 'the closing choice stays until answered');
    const nums = labels.map((l) => Number(l.split('/')[0]));
    check(nums.every((v, i) => v === i + 1), `step numbers run 1, 2, 3 … in order (${labels.join(', ')})`);
    await p.click('.coach-finish');
    check(await waitFor(p, () => !!document.querySelector('.title-menu') && !window.__ob.app.room, null, 8000), 'Finish tutorial returns to the title');
    await p.close();
  }

  if (want('spectator')) {
    const a = await page('A', 1280, 720);
    await a.type('.name', 'Alda');
    await a.click('.create');
    await waitFor(a, () => window.__ob.app.room?.phase === 'lobby');
    const code = await a.evaluate(() => window.__ob.app.room.code);
    const b = await page('B', 1280, 720, `?room=${code}`);
    await b.type('.name', 'Brann');
    await b.click('.join');
    await waitFor(a, () => !!window.__ob.app.room?.seats[1]);
    const s = await page('S', 1280, 720, `?room=${code}`);
    await s.click('.spectate');
    await waitFor(a, () => window.__ob.app.room?.spectators.length === 1);
    await a.click('.start');
    await waitFor(b, () => !!document.querySelector('.lcard'));
    await a.click('.lcard[data-lord="marshal"]');
    await b.click('.lcard[data-lord="warden"]');
    for (const p of [a, b, s]) await waitFor(p, () => !!document.querySelector('.planning'), null, 60000);
    await sleep(4500);
    for (let round = 1; round <= 2; round++) {
      for (const p of [a, b]) {
        await p.evaluate(() => { const me = window.__ob.app.room.view.you; for (let i = 0; i < me.draftPicks; i++) window.__ob.app.backend.intent({ t: 'draft', unit: me.draftOptions[i] }); if (me.lootOffer) window.__ob.app.backend.intent({ t: 'pickLoot', index: 0 }); });
        await sleep(500);
        await p.evaluate(() => { const { app } = window.__ob; const me = app.room.view.you; const u = [...me.unlocked][0]; const y = app.room.view.seat === 0 ? 3000 : 9000; app.backend.intent({ t: 'deploy', unit: u, pos: [1500 + me.squads.length * 1200, y], facing: app.room.view.seat === 0 ? 64 : 192 }); });
        await sleep(400);
        await intent(p, { t: 'ready' });
      }
      for (const p of [a, b, s]) check(await waitFor(p, () => !!document.querySelector('.battle'), null, 20000), `r${round}: ${p === s ? 'spectator' : 'player'} sees the battle`);
      await sleep(2500);
      // both players skip at once: the room moves to the results while the spectator's replay has barely begun
      await a.keyboard.press('End');
      await b.keyboard.press('End');
      await waitFor(a, () => window.__ob.app.room?.phase === 'results', null, 10000);
      const t0 = Date.now();
      const followed = await waitFor(s, () => !!document.querySelector('.screen.results'), null, 5000);
      check(followed, `r${round}: spectator reaches the results screen ${Date.now() - t0} ms after the players (was: a full phase late)`);
      if (round === 1) await s.screenshot({ path: 'e2e/shots/fn-spectator-results.png' });
      for (const p of [a, b, s]) await waitFor(p, () => window.__ob.app.room?.phase === 'planning' && !!document.querySelector('.planning'), null, 20000);
      await sleep(5000);
      const f = [await fps(a), await fps(b), await fps(s)];
      check(f[2] <= 1, `r${round + 1} planning idle fps A/B/S ${f.join(' ')} (spectator at rest)`);
    }
    await s.screenshot({ path: 'e2e/shots/fn-spectator-planning.png' });
    for (const p of [a, b, s]) await p.close();
  }
} catch (e) {
  console.log('ERROR', e);
  fails++;
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(fails ? `${fails} FAILED` : 'all ok');
await browser.close();
process.exit(fails ? 1 : 0);
