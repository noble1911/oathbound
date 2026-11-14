// A fake battle for the showcase: a crude 20 Hz simulation of two ~145-soldier armies that marches,
// clashes, shoots, casts and dies, recorded in exactly the sim's replay shape (DecodedReplay:
// frame-major typed arrays every 4 ticks + ReplayEvent[]), so the renderer is exercised through
// the same path as real replays. Not deterministic-integer like the real sim; it doesn't need to be.
import type { DecodedReplay, ReplayEvent, ReplaySoldier, KeepInfo, Terrain, Replay, ProjectileKind, ArcType, WeaponKind } from '../sim/types.ts';

type Kind = 'militia' | 'pikemen' | 'berserkers' | 'archers' | 'knights' | 'cavaliers' | 'mages' | 'clerics' | 'pegasus' | 'golem' | 'ballista' | 'trebuchet' | 'wyvern' | 'dragon' | 'lord';

interface Def {
  n: number;
  hp: number;
  dmg: number;
  range: number; // cm
  speed: number; // cm/tick
  cd: number; // ticks
  proj: ProjectileKind;
  arc: ArcType;
  weapon: WeaponKind;
  splash: number;
  flier?: boolean;
  large?: boolean;
  heal?: number;
  spacing: number;
}

const DEFS: Record<Kind, Def> = {
  militia: { n: 12, hp: 120, dmg: 14, range: 180, speed: 8, cd: 22, proj: 'none', arc: 'line', weapon: 'sword', splash: 0, spacing: 150 },
  pikemen: { n: 8, hp: 130, dmg: 16, range: 300, speed: 7, cd: 26, proj: 'none', arc: 'line', weapon: 'lance', splash: 0, spacing: 150 },
  berserkers: { n: 6, hp: 170, dmg: 22, range: 190, speed: 9, cd: 16, proj: 'none', arc: 'line', weapon: 'axe', splash: 0, spacing: 160 },
  archers: { n: 10, hp: 80, dmg: 12, range: 2600, speed: 7, cd: 34, proj: 'arrow', arc: 'arc', weapon: 'bow', splash: 0, spacing: 150 },
  knights: { n: 4, hp: 380, dmg: 26, range: 260, speed: 6, cd: 28, proj: 'none', arc: 'line', weapon: 'lance', splash: 0, spacing: 190 },
  cavaliers: { n: 4, hp: 260, dmg: 30, range: 220, speed: 22, cd: 24, proj: 'none', arc: 'line', weapon: 'sword', splash: 0, spacing: 300 },
  mages: { n: 4, hp: 90, dmg: 30, range: 2200, speed: 7, cd: 50, proj: 'fireball', arc: 'line', weapon: 'tome', splash: 300, spacing: 170 },
  clerics: { n: 3, hp: 100, dmg: 0, range: 1500, speed: 7, cd: 45, proj: 'none', arc: 'line', weapon: 'staff', splash: 0, heal: 60, spacing: 180 },
  pegasus: { n: 3, hp: 180, dmg: 22, range: 230, speed: 18, cd: 24, proj: 'none', arc: 'line', weapon: 'lance', splash: 0, flier: true, spacing: 400 },
  golem: { n: 1, hp: 2600, dmg: 70, range: 380, speed: 5, cd: 40, proj: 'none', arc: 'line', weapon: 'fists', splash: 250, large: true, spacing: 0 },
  ballista: { n: 1, hp: 300, dmg: 90, range: 4000, speed: 4, cd: 60, proj: 'bolt', arc: 'line', weapon: 'bolt', splash: 0, large: false, spacing: 0 },
  trebuchet: { n: 1, hp: 400, dmg: 80, range: 6000, speed: 3, cd: 110, proj: 'stone', arc: 'high_arc', weapon: 'stone', splash: 600, spacing: 0 },
  wyvern: { n: 2, hp: 700, dmg: 45, range: 300, speed: 16, cd: 30, proj: 'none', arc: 'line', weapon: 'axe', splash: 0, flier: true, large: true, spacing: 500 },
  dragon: { n: 1, hp: 2400, dmg: 40, range: 1300, speed: 14, cd: 70, proj: 'firebreath', arc: 'line', weapon: 'breath', splash: 500, flier: true, large: true, spacing: 0 },
  lord: { n: 1, hp: 1400, dmg: 45, range: 220, speed: 9, cd: 22, proj: 'none', arc: 'line', weapon: 'sword', splash: 0, spacing: 0 },
};

interface Sq {
  id: number;
  side: 0 | 1;
  kind: Kind;
  x: number;
  y: number;
  lord?: 'marshal' | 'archmage' | 'warden' | 'skylady';
}

interface Sol {
  i: number;
  sq: Sq;
  def: Def;
  x: number;
  y: number;
  hp: number;
  max: number;
  face: number; // 0..255
  cd: number;
  tgt: number;
  anim: number;
  alive: boolean;
  pending: { tick: number; tgt: number; dmg: number; crit: boolean }[];
  atKeep: boolean;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The two armies (seat 0 layout; seat 1 mirrors with a few swaps). */
function armies(): Sq[] {
  const sq: Sq[] = [];
  let id = 1;
  const add = (side: 0 | 1, kind: Kind, x: number, y: number, lord?: Sq['lord']) => {
    const mx = side === 0 ? x : 7999 - x;
    const my = side === 0 ? y : 11999 - y;
    sq.push({ id: id++, side, kind, x: mx, y: my, lord });
  };
  for (const side of [0, 1] as const) {
    // front line
    add(side, 'militia', 1600, 3500);
    add(side, 'militia', 3200, 3600);
    add(side, 'militia', 4800, 3600);
    add(side, 'militia', 6400, 3500);
    add(side, 'pikemen', 2400, 3100);
    add(side, 'pikemen', 5600, 3100);
    add(side, side === 0 ? 'knights' : 'berserkers', 4000, 3150);
    add(side, side === 0 ? 'berserkers' : 'knights', 4000, 2800);
    add(side, 'knights', 1200, 2900);
    add(side, 'berserkers', 6800, 2900);
    // flanks
    add(side, 'cavaliers', 600, 2400);
    add(side, 'cavaliers', 7400, 2400);
    // back line
    add(side, 'archers', 2200, 2000);
    add(side, 'archers', 4000, 1900);
    add(side, 'archers', 5800, 2000);
    add(side, 'mages', 3000, 1500);
    add(side, 'mages', 5000, 1500);
    add(side, 'clerics', 4000, 1300);
    add(side, 'pegasus', 7000, 1600);
    add(side, 'golem', side === 0 ? 3200 : 4800, 2600);
    add(side, 'ballista', 1500, 1200);
    add(side, 'trebuchet', 6500, 900);
    add(side, side === 0 ? 'wyvern' : 'dragon', 4000, 900);
    add(side, 'lord', 4000, 2300, side === 0 ? 'marshal' : 'archmage');
  }
  return sq;
}

function formation(def: Def, n: number, i: number, side: 0 | 1): [number, number] {
  if (n === 1) return [0, 0];
  const cols = Math.ceil(Math.sqrt(n * 2));
  const rows = Math.ceil(n / cols);
  const c = i % cols;
  const r = Math.floor(i / cols);
  const sx = (c - (cols - 1) / 2) * def.spacing;
  const sy = (r - (rows - 1) / 2) * def.spacing * 0.9;
  return [sx, side === 0 ? -sy : sy];
}

export interface FakeBattle {
  decoded: DecodedReplay;
  soldiers: ReplaySoldier[];
  keeps: [KeepInfo, KeepInfo];
  durationMs: number;
}

export function makeFakeBattle(terrain: Terrain, seed = 7): FakeBattle {
  const R = rng(seed);
  const deferred: { tick: number; run: () => void }[] = [];
  const squads = armies();
  const sols: Sol[] = [];
  const header: ReplaySoldier[] = [];
  for (const sq of squads) {
    const def = DEFS[sq.kind];
    for (let k = 0; k < def.n; k++) {
      const [ox, oy] = formation(def, def.n, k, sq.side);
      const i = sols.length;
      const jitter = def.n > 1 ? 40 : 0;
      sols.push({
        i, sq, def, x: sq.x + ox + (R() - 0.5) * jitter, y: sq.y + oy + (R() - 0.5) * jitter, hp: def.hp, max: def.hp,
        face: sq.side === 0 ? 64 : 192, cd: Math.floor(R() * def.cd), tgt: -1, anim: 0, alive: true, pending: [], atKeep: false,
      });
      const flags: string[] = [];
      if (def.flier) flags.push('flier');
      if (def.large) flags.push('large');
      if (sq.kind === 'cavaliers' || sq.kind === 'knights') flags.push('mounted');
      header.push({
        id: i, squad: sq.id, side: sq.side, type: sq.kind, modelId: sq.kind === 'lord' ? `lord_${sq.lord}` : sq.kind, lord: sq.lord, level: 1, maxHp: def.hp,
        items: [], flags, spawnTick: 0, summoned: false,
      });
    }
  }
  const n = sols.length;
  const keeps: [KeepInfo, KeepInfo] = [
    { seat: 0, pos: [4000, 0], hpBefore: 4000, hpMax: 4000, towers: [[2600, 700], [5400, 700]] },
    { seat: 1, pos: [4000, 11999], hpBefore: 4000, hpMax: 4000, towers: [[5400, 11299], [2600, 11299]] },
  ];
  const keepHp = [4000, 4000];
  const keepStage = [0, 0];
  const isWater = (y: number) => {
    const river = terrain.features.find((f) => f.kind === 'river');
    return !!river && y > river.y && y < river.y + river.h;
  };
  const onCrossing = (x: number, y: number) =>
    terrain.features.some((f) => (f.kind === 'bridge' || f.kind === 'ford') && x >= f.x && x <= f.x + f.w && y >= f.y - 100 && y <= f.y + f.h + 100);
  const bridgeX = terrain.features.filter((f) => f.kind === 'bridge' || f.kind === 'ford').map((f) => f.x + f.w / 2);

  const events: ReplayEvent[] = [];
  const TICKS = 85 * 20;
  const frames: { x: Int16Array; y: Int16Array; f: Uint8Array; hp: Uint16Array; a: Uint8Array }[] = [];
  let projId = 1;
  const abilityAt: Record<string, number> = {};
  const lords = sols.filter((s) => s.sq.kind === 'lord');
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const hitTgt = (src: Sol, t: Sol, dmg: number, tick: number, crit: boolean) => {
    if (!t.alive) return;
    t.hp -= dmg;
    events.push({ k: 'hit', tick, src: src.i, tgt: t.i, dmg: Math.round(dmg), crit, effective: false, triangle: 0, miss: false });
    if (t.hp <= 0) {
      t.hp = 0;
      t.alive = false;
      t.anim = 4;
      events.push({ k: 'death', tick, tgt: t.i, src: src.i });
    }
  };
  const splash = (src: Sol, x: number, y: number, r: number, dmg: number, tick: number) => {
    for (const o of sols) if (o.alive && o.sq.side !== src.sq.side && Math.hypot(o.x - x, o.y - y) < r) hitTgt(src, o, dmg * (o.def.large ? 0.4 : 1), tick, false);
  };

  for (let tick = 0; tick <= TICKS; tick++) {
    // resolve delayed hits (melee windups, projectile landings)
    for (const s of sols) {
      for (let p = s.pending.length - 1; p >= 0; p--) {
        const h = s.pending[p];
        if (h.tick > tick) continue;
        s.pending.splice(p, 1);
        if (!s.alive && s.def.proj === 'none') continue;
        const t = sols[h.tgt];
        if (s.def.splash > 0 && s.def.proj !== 'none') splash(s, t.x, t.y, s.def.splash, h.dmg, tick);
        else if (s.def.heal) {
          if (t.alive) {
            t.hp = Math.min(t.max, t.hp + s.def.heal);
            events.push({ k: 'heal', tick, src: s.i, tgt: t.i, amount: s.def.heal });
          }
        } else hitTgt(s, t, h.dmg, tick, h.crit);
        if (s.sq.kind === 'golem') events.push({ k: 'ability', tick, src: s.i, tgt: -1, ability: 'stomp', pos: [Math.round(t.x), Math.round(t.y)], radius: 400, dur: 0 });
      }
    }
    // lords' abilities (scripted beats for the showcase)
    for (const L of lords) {
      if (!L.alive) continue;
      const key = `${L.i}`;
      const kind = L.sq.lord === 'marshal' ? 'rally' : 'meteor';
      const next = abilityAt[key] ?? (kind === 'rally' ? 20 * 14 : 20 * 19);
      if (tick === next) {
        if (kind === 'meteor') {
          // densest enemy cluster (coarse)
          let best = { x: 4000, y: 6000, c: -1 };
          for (const e of sols) {
            if (!e.alive || e.sq.side === L.sq.side) continue;
            let c = 0;
            for (const o of sols) if (o.alive && o.sq.side !== L.sq.side && Math.abs(o.x - e.x) < 800 && Math.abs(o.y - e.y) < 800) c++;
            if (c > best.c) best = { x: e.x, y: e.y, c };
          }
          events.push({ k: 'ability', tick, src: L.i, tgt: -1, ability: 'meteor', pos: [Math.round(best.x), Math.round(best.y)], radius: 1000, dur: 24 });
          const land = tick + 24;
          // the damage lands at `land`; apply via a deferred splash
          const bx = best.x;
          const by = best.y;
          deferred.push({ tick: land, run: () => splash(L, bx, by, 1000, 140, land) });
        } else {
          events.push({ k: 'ability', tick, src: L.i, tgt: -1, ability: 'rally', pos: [Math.round(L.x), Math.round(L.y)], radius: 1200, dur: 160 });
        }
        abilityAt[key] = next + 20 * 22;
      }
    }
    for (let d = deferred.length - 1; d >= 0; d--) if (deferred[d].tick <= tick) {
      deferred[d].run();
      deferred.splice(d, 1);
    }
    // ai
    for (const s of sols) {
      if (!s.alive) continue;
      const def = s.def;
      if (tick % 10 === s.i % 10 || s.tgt < 0 || !sols[s.tgt].alive) {
        let best = -1;
        let bd = Infinity;
        for (const o of sols) {
          if (!o.alive) continue;
          if (def.heal ? o.sq.side !== s.sq.side || o.hp >= o.max || o === s : o.sq.side === s.sq.side) continue;
          if (o.def.flier && def.proj === 'none' && !def.flier && s.sq.kind !== 'lord') continue;
          const dd = dist(s, o) * (s.sq.kind === 'archers' && o.def.flier ? 0.5 : 1);
          if (dd < bd) {
            bd = dd;
            best = o.i;
          }
        }
        s.tgt = best;
      }
      let goal: { x: number; y: number } | null = null;
      if (s.tgt >= 0) goal = sols[s.tgt];
      else if (!def.heal) {
        // march on the enemy keep
        const k = keeps[s.sq.side === 0 ? 1 : 0];
        goal = { x: k.pos[0] + ((s.i % 7) - 3) * 300, y: k.pos[1] + (s.sq.side === 0 ? -900 : 900) };
        s.atKeep = dist(s, goal) < 500;
      }
      if (!goal) {
        s.anim = 0;
        continue;
      }
      const d = dist(s, goal);
      const reach = s.tgt >= 0 ? def.range : 200;
      if (d > reach) {
        // move (with river crossing preference for walkers)
        let gx = goal.x;
        const gy = goal.y;
        const crossing = !def.flier && (s.y - 6000) * (gy - 6000) < 0;
        if (crossing && bridgeX.length) {
          const bx = bridgeX.reduce((a, b) => (Math.abs(b - s.x) < Math.abs(a - s.x) ? b : a));
          if (Math.abs(s.y - 6000) > 700 || !onCrossing(s.x, s.y)) gx = bx + ((s.i % 5) - 2) * 120;
        }
        let dx = gx - s.x;
        let dy = gy - s.y;
        const l = Math.hypot(dx, dy) || 1;
        let sp = def.speed * (s.tgt >= 0 ? 1 : 0.8);
        if (!def.flier && isWater(s.y) && !onCrossing(s.x, s.y)) sp *= 0.5;
        dx = (dx / l) * sp;
        dy = (dy / l) * sp;
        // separation
        for (const o of sols) {
          if (o === s || !o.alive || o.def.flier !== def.flier) continue;
          const ox = s.x - o.x;
          const oy = s.y - o.y;
          const dd = ox * ox + oy * oy;
          const r = (def.large || o.def.large ? 260 : 95) + (def.spacing > 250 || o.def.spacing > 250 ? 60 : 0);
          if (dd < r * r && dd > 1) {
            const f = (r - Math.sqrt(dd)) * 0.25;
            dx += (ox / Math.sqrt(dd)) * f;
            dy += (oy / Math.sqrt(dd)) * f;
          }
        }
        s.x = Math.max(50, Math.min(7950, s.x + dx));
        s.y = Math.max(50, Math.min(11950, s.y + dy));
        s.face = Math.round(((Math.atan2(dy, dx) / (Math.PI * 2)) * 256 + 256) % 256);
        s.anim = 1;
      } else {
        const tx = goal.x - s.x;
        const ty = goal.y - s.y;
        s.face = Math.round(((Math.atan2(ty, tx) / (Math.PI * 2)) * 256 + 256) % 256);
        s.anim = 2;
        if (s.cd <= 0) {
          s.cd = def.cd + Math.floor(R() * 6);
          if (s.tgt < 0) {
            // hitting the keep
            const seat = s.sq.side === 0 ? 1 : 0;
            events.push({ k: 'attack', tick, src: s.i, tgt: -1, weapon: def.weapon, projectile: def.proj, hitTick: tick + 8 });
            const dmg = Math.round(def.dmg * 0.6);
            keepHp[seat] = Math.max(0, keepHp[seat] - dmg);
            events.push({ k: 'keepHit', tick: tick + 8, seat: seat as 0 | 1, src: s.i, dmg, hpAfter: keepHp[seat], final: false });
            const st = keepHp[seat] <= 0 ? 4 : keepHp[seat] < 1000 ? 3 : keepHp[seat] < 2000 ? 2 : keepHp[seat] < 3000 ? 1 : 0;
            if (st > keepStage[seat]) {
              keepStage[seat] = st;
              events.push({ k: 'keepStage', tick: tick + 8, seat: seat as 0 | 1, stage: st });
            }
          } else {
            const t = sols[s.tgt];
            const crit = R() < 0.08;
            const dmg = def.dmg * (crit ? 2 : 1) * (0.85 + R() * 0.3);
            const leadT = def.proj === 'arrow' ? 12 : def.proj === 'stone' ? 3 : 4;
            events.push({ k: 'attack', tick, src: s.i, tgt: t.i, weapon: def.weapon, projectile: def.proj, hitTick: def.proj === 'none' ? tick + 7 : tick + leadT + Math.max(6, Math.round(d / (def.proj === 'stone' ? 150 : def.proj === 'arrow' ? 330 : def.proj === 'firebreath' ? 900 : 500))) });
            if (def.proj === 'none') {
              s.pending.push({ tick: tick + 7, tgt: t.i, dmg, crit });
            } else {
              const lead = def.proj === 'arrow' ? 12 : def.proj === 'stone' ? 3 : 4;
              const flight = Math.max(6, Math.round(d / (def.proj === 'stone' ? 150 : def.proj === 'arrow' ? 330 : def.proj === 'firebreath' ? 900 : 500)));
              const id = projId++;
              const launch = tick + lead;
              events.push({ k: 'projectile', tick: launch, id, src: s.i, tgt: t.i, kind: def.proj, arc: def.arc, from: [Math.round(s.x), Math.round(s.y)], to: [Math.round(t.x), Math.round(t.y)], flight });
              events.push({ k: 'impact', tick: launch + flight, id, pos: [Math.round(t.x), Math.round(t.y)], kind: def.proj, splash: def.splash });
              s.pending.push({ tick: launch + flight, tgt: t.i, dmg, crit });
              // archers' legendary: chain lightning now and then
              if (s.sq.kind === 'archers' && s.sq.side === 1 && R() < 0.05) {
                let prev = t;
                for (let c = 0; c < 3; c++) {
                  const nx = sols.find((o) => o.alive && o.sq.side === t.sq.side && o !== prev && Math.hypot(o.x - prev.x, o.y - prev.y) < 600);
                  if (!nx) break;
                  events.push({ k: 'ability', tick: launch + flight + c * 2, src: prev.i, tgt: nx.i, ability: 'chain', pos: [Math.round(nx.x), Math.round(nx.y)], radius: 0, dur: 0 });
                  deferred.push({ tick: launch + flight + c * 2, run: () => hitTgt(s, nx, 20, launch + flight + c * 2, false) });
                  prev = nx;
                }
              }
              if (s.sq.kind === 'mages' && R() < 0.3) events.push({ k: 'ability', tick: launch + flight, src: s.i, tgt: t.i, ability: 'burn', pos: [Math.round(t.x), Math.round(t.y)], radius: 0, dur: 60 });
            }
          }
        }
      }
      s.cd--;
    }
    if (tick % 4 === 0) {
      const f = { x: new Int16Array(n), y: new Int16Array(n), f: new Uint8Array(n), hp: new Uint16Array(n), a: new Uint8Array(n) };
      for (const s of sols) {
        f.x[s.i] = Math.round(s.x);
        f.y[s.i] = Math.round(s.y);
        f.f[s.i] = s.face & 255;
        f.hp[s.i] = Math.round(s.hp);
        f.a[s.i] = s.alive ? s.anim : 4;
      }
      frames.push(f);
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  const F = frames.length;
  const cat = <T extends Int16Array | Uint8Array | Uint16Array>(C: new (n: number) => T, pick: (f: (typeof frames)[number]) => T): T => {
    const out = new C(F * n);
    frames.forEach((f, i) => out.set(pick(f), i * n));
    return out;
  };
  const replay = { v: 2, seed, round: 3, ticks: TICKS, frameTicks: 4, frameCount: F, soldiers: header, keeps, terrain, frames: '', events: '', eventCount: events.length } as unknown as Replay;
  const decoded: DecodedReplay = {
    replay, soldierCount: n, frameCount: F,
    x: cat(Int16Array, (f) => f.x), y: cat(Int16Array, (f) => f.y), facing: cat(Uint8Array, (f) => f.f), hp: cat(Uint16Array, (f) => f.hp), anim: cat(Uint8Array, (f) => f.a),
    events,
  };
  return { decoded, soldiers: header, keeps, durationMs: TICKS * 50 };
}

