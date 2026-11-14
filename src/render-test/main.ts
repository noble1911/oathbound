// Render showcase: the whole battlefield, two ~145-soldier armies from a fake battle source,
// VFX samples, tier selector and live stats. URL params (for e2e):
//   ?tier=low|medium|high|ultra|auto  &t=<ms start time>  &mode=battle|planning|loot
//   &cam=director|free  &speed=1  &paused=1  &ui=0 (hide the panel)
//   &real=1 (a real sim battle: newMatch + botPlan for both seats, `rounds` rounds; real=big = the
//   sim's ~250-soldier fixture)  &seed=N  &rounds=N  &art=0 (procedural stand-ins only)
//   &skills=1 (with real=all: every squad carries the item skills its class can use; casts are listed in
//   window.__rt.skills and logged as they fire in window.__rt.skillLog)
import * as THREE from 'three';
import { BattleView, defaultTerrain, sampleKeyframes, replaySource, TIER_ORDER, type BattleSource, type QualityTier } from '../render/index.ts';
import { makeFakeBattle } from './fake-battle.ts';
import { mountPanel } from './panel.ts';
import { newMatch, botPlan, simulateBattle, applyBattle, nextRound, decodeReplay, sampleReplay, makeTransforms, UNIT_TYPES, mirrorPos, SKILLS, SKILL_IDS, BASES, classesOf } from '../sim/index.ts';
import { bigBattle } from '../sim/fixtures.ts';
import type { DecodedReplay, KeepInfo, ReplaySoldier, Terrain, LordId, MatchState, Seat, Vec2, Item, ItemSlots, SkillId, SkillEvent, BaseId } from '../sim/types.ts';

const q = new URLSearchParams(location.search);
const tier = (q.get('tier') ?? 'auto') as QualityTier | 'auto';
const mode = q.get('mode') ?? 'battle';
const container = document.getElementById('view')!;
const realMode = q.get('real');

interface ShowBattle {
  decoded: DecodedReplay;
  soldiers: ReplaySoldier[];
  keeps: [KeepInfo, KeepInfo];
  terrain: Terrain;
  source: BattleSource;
  info: string;
}

/** Skill items for a squad of `type`: one per slot from the skills its class may use (`pick` varies which). */
function skillItems(s: MatchState, type: string, lord: LordId | undefined, pick: number): ItemSlots {
  const out: ItemSlots = { weapon: null, armor: null, relic: null };
  const cls = classesOf(type as never, lord);
  for (const slot of ['weapon', 'armor', 'relic'] as const) {
    const ids = SKILL_IDS.filter((id: SkillId) => SKILLS[id].slot === slot && SKILLS[id].classes.some((c) => cls.includes(c)));
    if (!ids.length) continue;
    const base = (Object.keys(BASES) as BaseId[]).find((b) => BASES[b].slot === slot)!;
    const item: Item = { id: s.nextId++, base, slot, rarity: 'rare', ilvl: 6, implicit: { id: BASES[base].implicit, value: BASES[base].lo }, affixes: [], legendary: null, skill: ids[pick % ids.length] };
    out[slot] = item;
  }
  return out;
}

/** Every unit type (14) per side plus both Lords: the full-roster render test. */
function allUnitsBattle(seed: number, lords: [LordId, LordId]): MatchState {
  const s = newMatch(seed, lords);
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    p.unlocked = [...UNIT_TYPES];
    UNIT_TYPES.forEach((u, k) => {
      const x = 800 + (k % 5) * 1600;
      const y = 3700 - Math.floor(k / 5) * 1100;
      const pos: Vec2 = seat === 0 ? [x, y] : mirrorPos([x, y]);
      const skills = q.get('skills') === '1';
      p.squads.push({ id: s.nextId++, owner: seat, type: u, level: skills ? 5 : 2, pos, facing: seat === 0 ? 64 : 192, items: skills ? skillItems(s, u, undefined, seat + k) : { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: 0 });
    });
  }
  s.round = 8;
  return s;
}

/** A real sim battle: two bots play `rounds` rounds; the last round's replay is shown. */
function realBattle(seed: number, rounds: number, big: boolean | 'all'): ShowBattle {
  const t0 = performance.now();
  let replay;
  if (big === 'all') {
    const lords = (q.get('lords') ?? 'marshal,archmage').split(',') as [LordId, LordId];
    replay = simulateBattle(allUnitsBattle(seed, lords)).replay;
  } else if (big) {
    replay = simulateBattle(bigBattle(seed)).replay;
  } else {
    const s = newMatch(seed, ['marshal', 'archmage']);
    for (let r = 0; r < rounds; r++) {
      botPlan(s, 0, 'best', r);
      botPlan(s, 1, 'counter', r);
      const out = simulateBattle(s);
      replay = out.replay;
      if (r === rounds - 1) break;
      applyBattle(s, out.result);
      if (s.phase === 'over') break;
      nextRound(s);
    }
  }
  const decoded = decodeReplay(replay!);
  return {
    decoded, soldiers: replay!.soldiers, keeps: replay!.keeps, terrain: replay!.terrain,
    source: replaySource(decoded, sampleReplay, makeTransforms),
    info: `real sim: round ${replay!.round}, ${replay!.soldiers.length} soldiers, ${(replay!.ticks / 20).toFixed(1)} s, sim ${(performance.now() - t0).toFixed(0)} ms`,
  };
}

function fakeBattle(): ShowBattle {
  const terrain = defaultTerrain(11);
  const fake = makeFakeBattle(terrain, 7);
  const source: BattleSource = {
    soldiers: fake.soldiers,
    keeps: fake.keeps,
    terrain,
    durationMs: fake.durationMs,
    events: fake.decoded.events,
    sample: (ms, out) => void sampleKeyframes(fake.decoded, ms, out),
    makeTransforms: () => makeTransforms(fake.soldiers.length),
  };
  return { decoded: fake.decoded, soldiers: fake.soldiers, keeps: fake.keeps, terrain, source, info: 'fake battle' };
}

const battle = realMode ? realBattle(Number(q.get('seed') ?? 5), Number(q.get('rounds') ?? 5), realMode === 'all' ? 'all' : realMode === 'big') : fakeBattle();
console.info(battle.info);
const terrain = battle.terrain;
const source = battle.source;
const view = new BattleView(container, {
  quality: tier, terrain, keeps: battle.keeps, idleFps: Number(q.get('idle') ?? 0), seat: 0, pauseOnBlur: q.get('blur') !== '0',
  batterySaver: q.get('saver') === '1', fpsCap: Number(q.get('cap') ?? 0), artManifest: q.get('art') === '0' ? undefined : 'models/v2/manifest.json',
});
const fake = { decoded: battle.decoded, soldiers: battle.soldiers };
// HUD insets (as the game's HUD sets them): &insets=top,bottom in CSS px
if (q.get('insets')) {
  const [top, bottom] = q.get('insets')!.split(',').map(Number);
  view.engine.setInsets({ top, bottom });
}

const loot: { dispose(): void }[] = [];
const skillLog: SkillEvent[] = [];
function clearLoot(): void {
  loot.splice(0).forEach((b) => b.dispose());
}

function startBattle(atMs = 0): void {
  clearLoot();
  const pb = view.playBattle(source, { director: (q.get('cam') ?? 'director') === 'director', onSkill: (e) => void skillLog.push(e) });
  if (atMs > 0) pb.seek(atMs);
  pb.speed = Number(q.get('speed') ?? 1);
  if (q.get('paused') === '1') pb.playing = false;
}

function planning(): void {
  clearLoot();
  view.stopBattle();
  // the starting squads, shown as planning formations
  const squads = new Map<number, { id: number; owner: 0 | 1; type: string; lord?: string; xs: number; ys: number; n: number }>();
  const d = fake.decoded;
  fake.soldiers.forEach((s, i) => {
    const e = squads.get(s.squad) ?? { id: s.squad, owner: s.side, type: s.type, lord: s.lord, xs: 0, ys: 0, n: 0 };
    e.xs += d.x[i];
    e.ys += d.y[i];
    e.n++;
    squads.set(s.squad, e);
  });
  view.showArmy(
    [...squads.values()].map((s) => ({ id: s.id, owner: s.owner, type: s.type, lord: s.lord, pos: [s.xs / s.n, s.ys / s.n] as [number, number], size: s.n })),
    { ghostOwners: [1], highlight: { 3: 'selected', 5: 'hover' } },
  );
  view.setPlanning({ visible: true, seat: 0, grid: true });
  view.camera.home(0);
}

function lootScreen(): void {
  view.stopBattle();
  view.setPlanning({ visible: false });
  view.showArmy([]);
  clearLoot();
  const rar = ['common', 'magic', 'rare', 'legendary'] as const;
  rar.forEach((r, i) => {
    const x = (i - 1.5) * 4.5;
    const z = 36 - Math.abs(i - 1.5) * 1.2;
    loot.push(view.vfx.lootBeam(new THREE.Vector3(x, view.field.heightAt(x, z), z), r));
  });
  view.camera.setMode('orbit');
  view.camera.goal.target.set(0, 2.5, 35);
  view.camera.goal.yaw = 0.25;
  view.camera.goal.dist = 21;
  view.camera.goal.pitch = 0.2;
  view.camera.snap();
}

const actions: Record<string, () => void> = {
  meteor: () => view.vfx.meteor(groundAtView(), 10),
  rally: () => view.vfx.rally(groundAtView(), 12, 6),
  bulwark: () => view.vfx.bulwark(groundAtView(), 12, 6),
  skyfall: () => {
    const p = groundAtView();
    view.vfx.skyfall(p.clone().add(new THREE.Vector3(-20, 35, 10)), p);
  },
  lightning: () => {
    const p = groundAtView();
    view.vfx.lightning(p.clone().add(new THREE.Vector3(-6, 1.5, 0)), p.clone().add(new THREE.Vector3(6, 1.5, 2)));
  },
  breath: () => {
    const p = groundAtView();
    view.vfx.breath(p.clone().add(new THREE.Vector3(0, 8, 14)), new THREE.Vector3(0, -0.45, -1).normalize(), 18, 0.35, 2);
  },
  fireball: () => {
    const p = groundAtView();
    view.vfx.projectile('fireball', p.clone().add(new THREE.Vector3(-18, 2, 8)), p.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.9, 'line', () => view.vfx.impact('fireball', p, 3));
  },
  volley: () => {
    const p = groundAtView();
    for (let i = 0; i < 24; i++) {
      const from = p.clone().add(new THREE.Vector3(-25 + Math.random() * 6, 1.5, 18 + Math.random() * 6));
      const to = p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, 0.2, (Math.random() - 0.5) * 8));
      view.vfx.projectile('arrow', from, to, 1.3 + Math.random() * 0.3, 'arc', () => view.vfx.impact('arrow', to, 0));
    }
  },
  trebuchet: () => {
    const p = groundAtView();
    view.vfx.projectile('stone', p.clone().add(new THREE.Vector3(0, 6, 45)), p.clone(), 2.4, 'high_arc', () => view.vfx.impact('stone', p, 6));
  },
  heal: () => view.vfx.heal(groundAtView(), 1.5),
  frost: () => view.vfx.frost(groundAtView(), 3),
  burn: () => view.vfx.burn(groundAtView(), 3),
  keepHit: () => view.vfx.keepHit(view.field.keep(1).hitPoint(), true),
  keepCollapse: () => {
    const k = view.field.keep(1);
    k.setStage(Math.min(4, (stage = stage + 1)));
    view.vfx.keepCollapse(k.position.clone());
  },
  numbers: () => {
    const p = groundAtView().add(new THREE.Vector3(0, 2, 0));
    view.vfx.damageNumber(p.clone(), 42, 'normal');
    view.vfx.damageNumber(p.clone().add(new THREE.Vector3(1.5, 0.5, 0)), 187, 'crit');
    view.vfx.damageNumber(p.clone().add(new THREE.Vector3(-1.5, 0.2, 0)), 35, 'heal');
    view.vfx.damageNumber(p.clone().add(new THREE.Vector3(0, 1.2, 0)), 0, 'miss');
  },
};
let stage = 0;

function groundAtView(): THREE.Vector3 {
  const t = view.camera.target;
  return new THREE.Vector3(t.x, view.field.heightAt(t.x, t.z), t.z);
}

if (mode === 'planning') planning();
else if (mode === 'loot') lootScreen();
else startBattle(Number(q.get('t') ?? 0));

if (q.get('ui') !== '0') {
  mountPanel(document.getElementById('rt-ui')!, view, {
    tiers: ['auto', ...TIER_ORDER],
    tier,
    onTier: (t) => view.setQuality(t),
    modes: { Battle: () => startBattle(0), Planning: planning, Loot: lootScreen },
    actions,
  });
}

declare global {
  interface Window {
    __rt: unknown;
  }
}
window.__rt = { view, startBattle, planning, lootScreen, actions, THREE, info: battle.info, skills: battle.decoded.skills ?? [], skillLog, ready: true };
