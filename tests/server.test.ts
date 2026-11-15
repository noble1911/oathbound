// The server over real sockets, with the real v2 simulation (skipped while src/sim is not importable).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerView, Vec2 } from '../src/sim/types.ts';
import { FACTIONS, LORDS } from '../src/sim/index.ts';
import type { RoomView } from '../src/net/protocol.ts';
import { connect, makeRoom, sleep, type Client } from './server-helpers.ts';

let server: { port: number; close(): Promise<void> } | null = null;
let url = '';
let loadError = '';
beforeAll(async () => {
  try {
    const sim = await import('../src/sim/index.ts');
    sim.newMatch(1, null);
    const { startServer } = await import('../server/index.ts');
    server = await startServer(0, { lordPickMs: 400, planningMs: 4000, lootBonusMs: 0, battleSlackMs: 300, battleCapMs: 1500, resultsMs: 150, graceMs: 400 });
    url = `ws://127.0.0.1:${server.port}/ws`;
  } catch (e) {
    loadError = String((e as Error)?.message ?? e);
  }
});
afterAll(() => server?.close());

const skipIfNoSim = (ctx: { skip(note?: string): void }) => {
  if (!server) ctx.skip(`sim not ready: ${loadError}`);
};

/** Do the chores the sim may require before anything else this planning phase (drafts, loot). */
async function chores(c: Client, view: PlayerView): Promise<void> {
  const you = view.you!;
  for (let i = 0; i < (you.draftPicks ?? 0) && you.draftOptions?.[i]; i++) c.send({ t: 'intent', intent: { t: 'draft', unit: you.draftOptions[i] } });
  if (you.lootOffer?.length) c.send({ t: 'intent', intent: { t: 'pickLoot', index: 0 } });
  await sleep(30);
}

const latestView = async (c: Client, pred: (r: RoomView) => boolean = () => true) => (await c.wait('room', (m) => !!m.room.view && pred(m.room))).room;

describe('real sim', () => {
  it('faction pick: pickFaction then pickLord; the enemy choice stays hidden; the timer picks a Lord of the chosen faction', async (ctx) => {
    skipIfNoSim(ctx);
    const { host, guest, all } = await makeRoom(url);
    host.send({ t: 'start' });
    await host.wait('room', (m) => m.room.phase === 'lordPick');
    host.send({ t: 'intent', intent: { t: 'pickFaction', faction: 'ashen' } });
    const mine = await host.wait('room', (m) => m.room.view?.you?.faction === 'ashen');
    expect(mine.room.view!.you!.lord).toBe(null);
    // the guest does not see it, and may not pick a Lord of another faction after choosing one
    guest.send({ t: 'intent', intent: { t: 'pickFaction', faction: 'caliphate' } });
    const theirs = await guest.wait('room', (m) => m.room.view?.you?.faction === 'caliphate');
    expect(theirs.room.view!.enemy.faction).toBe(null);
    guest.send({ t: 'intent', intent: { t: 'pickLord', lord: 'marshal' } });
    expect((await guest.wait('rejected')).error).toMatch(/does not lead/);
    guest.send({ t: 'intent', intent: { t: 'ready' } });
    expect((await guest.wait('rejected')).error).toMatch(/Lord/);
    // neither picks a Lord: the timer gives each a Lord of the faction they chose
    const p = await latestView(host, (r) => r.phase === 'planning');
    expect(p.view!.you!.faction).toBe('ashen');
    // (any of the faction's four Lords, at random)
    const myLord = p.view!.you!.lord!;
    expect(FACTIONS.ashen.lords).toContain(myLord);
    expect(p.view!.enemy.faction).toBe('caliphate');
    expect(FACTIONS.caliphate.lords).toContain(p.view!.enemy.lord);
    expect(p.view!.you!.unlocked).toEqual(LORDS[myLord].signature);
    expect(p.view!.you!.draftOptions).toEqual(FACTIONS.ashen.basic.filter((u) => !LORDS[myLord].signature.includes(u)));
    for (const c of all) c.close();
  }, 15_000);

  it('pvp: lord pick -> planning with intents -> both ready -> battle on both -> battleDone -> results -> round 2', async (ctx) => {
    skipIfNoSim(ctx);
    const { host, guest, all } = await makeRoom(url);
    host.send({ t: 'start' });
    await host.wait('room', (m) => m.room.phase === 'lordPick');
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'marshal' } });
    guest.send({ t: 'intent', intent: { t: 'pickLord', lord: 'warden' } });
    const p = await latestView(host, (r) => r.phase === 'planning');
    expect(p.view!.round).toBe(1);
    expect(p.view!.you!.lord).toBe('marshal');
    expect(p.phaseEndsAt).toBeGreaterThan(Date.now());
    await chores(host, p.view!);
    // an illegal intent is rejected; a legal deploy shows up in our own view
    host.send({ t: 'intent', intent: { t: 'deploy', unit: 'dragon', pos: [100, 11000] } });
    expect((await host.wait('rejected')).error).toBeTruthy();
    const fresh = host.last!;
    const unit = fresh.view!.you!.unlocked[0];
    const before = fresh.view!.you!.squads.length;
    host.send({ t: 'intent', intent: { t: 'deploy', unit, pos: [4000, 2000] } });
    await host.wait('room', (m) => (m.room.view?.you?.squads.length ?? 0) > before);
    for (const c of all) c.drain();
    host.send({ t: 'intent', intent: { t: 'ready' } });
    await guest.wait('room', (m) => !!m.room.view?.enemy.ready);
    guest.send({ t: 'intent', intent: { t: 'ready' } });
    const [b1, b2] = await Promise.all([host.wait('battle'), guest.wait('battle')]);
    expect(b1.replay.round).toBe(1);
    expect(b2.replay.events).toBe(b1.replay.events);
    expect(b1.offsetMs).toBeLessThan(500);
    await host.wait('room', (m) => m.room.phase === 'battle');
    host.send({ t: 'battleDone' });
    guest.send({ t: 'battleDone' });
    const res = await host.wait('room', (m) => m.room.phase === 'results' || m.room.phase === 'over');
    expect(res.room.view!.history.length).toBe(1);
    const r2 = await latestView(host, (r) => r.phase === 'planning' && r.view!.round === 2);
    expect(r2.view!.you!.ready).toBe(false);
    expect(r2.view!.enemy.lastArmy).not.toBeNull();
    for (const c of all) c.close();
  }, 30_000);

  it('vsAI plays at least 3 rounds with the human only readying', async (ctx) => {
    skipIfNoSim(ctx);
    const { host, all } = await makeRoom(url, 'vsAI');
    host.send({ t: 'start' });
    let rounds = 0;
    for (let round = 1; round <= 3; round++) {
      const r = await host.wait('room', (m) => (m.room.phase === 'planning' && m.room.view!.round === round) || m.room.phase === 'over', 10_000);
      if (r.room.phase === 'over') break;
      expect(r.room.view!.enemy.ready).toBe(true);
      expect(r.room.view!.enemy.lord).toBeTruthy();
      host.send({ t: 'intent', intent: { t: 'ready' } });
      const b = await host.wait('battle', () => true, 10_000);
      expect(b.replay.round).toBe(round);
      rounds++;
    }
    expect(rounds).toBeGreaterThanOrEqual(3);
    for (const c of all) c.close();
  }, 60_000);

  it('hidden info: seat 0 and spectators never receive seat 1 current-round deploys before the battle', async (ctx) => {
    skipIfNoSim(ctx);
    const { host, guest, all, code } = await makeRoom(url);
    const spec = await connect(url);
    spec.send({ t: 'join', code, name: 'Watcher' });
    await spec.wait('welcome');
    host.send({ t: 'start' });
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'archmage' } });
    guest.send({ t: 'intent', intent: { t: 'pickLord', lord: 'skylady' } });
    const gv = await latestView(guest, (r) => r.phase === 'planning');
    await chores(guest, gv.view!);
    const g = guest.last!;
    const before = g.view!.you!.squads.length;
    // a distinctive spot in seat 1's half
    const pos: Vec2 = [1234, 9876];
    guest.send({ t: 'intent', intent: { t: 'deploy', unit: g.view!.you!.unlocked[0], pos, facing: 199 } });
    const after = await guest.wait('room', (m) => (m.room.view?.you?.squads.length ?? 0) > before);
    const mine = after.room.view!.you!.squads.find((s) => s.pos[0] === 1234);
    expect(mine).toBeTruthy();
    guest.send({ t: 'intent', intent: { t: 'move', squad: mine!.id, pos: [1235, 9877] } });
    await guest.wait('room', (m) => !!m.room.view?.you?.squads.some((q) => q.pos[0] === 1235 && q.pos[1] === 9877));
    guest.send({ t: 'chat', text: 'flush' });
    await host.wait('chat', (m) => m.text === 'flush');
    await spec.wait('chat', (m) => m.text === 'flush');
    for (const c of [host, spec]) {
      const text = c.raw.join('\n');
      expect(text).not.toMatch(/1234,9876|1235,9877/);
      expect(text).not.toContain(`"id":${mine!.id},"owner":1`);
      for (const raw of c.raw) {
        const m = JSON.parse(raw);
        if (m.t !== 'room' || !m.room.view) continue;
        const enemies = [m.room.view.enemy, ...(m.room.view.enemies ?? [])].filter(Boolean);
        for (const e of enemies) for (const k of ['gold', 'stash', 'squads', 'lootOffer', 'unlocked', 'draftOptions']) expect(e).not.toHaveProperty(k);
        if (m.room.me.seat === 0) expect(m.room.view.you.seat).toBe(0);
        if (m.room.me.spectator) expect(m.room.view.you).toBeNull();
      }
    }
    expect(guest.raw.join('\n')).toMatch(/1235,9877/);
    for (const c of [...all, spec]) c.close();
  }, 30_000);

  it('disconnect -> AI takes the seat -> rejoin gets it back (real sim)', async (ctx) => {
    skipIfNoSim(ctx);
    const { host, guest, all, code } = await makeRoom(url);
    host.send({ t: 'start' });
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'marshal' } });
    guest.send({ t: 'intent', intent: { t: 'pickLord', lord: 'warden' } });
    await host.wait('room', (m) => m.room.phase === 'planning');
    const tok = guest.token;
    guest.close();
    await host.wait('room', (m) => !!m.room.seats[1]?.botControlled, 3000);
    const v = await latestView(host, (r) => !!r.view!.enemy.ready);
    expect(v.seats[1]!.connected).toBe(false);
    const back = await connect(url);
    back.send({ t: 'join', code, name: 'Guest', token: tok });
    expect((await back.wait('welcome')).seat).toBe(1);
    const r = await back.wait('room', (m) => m.room.seats[1]?.botControlled === false && !!m.room.view);
    expect(r.room.view!.you!.seat).toBe(1);
    expect(r.room.view!.you!.lord).toBe('warden');
    for (const c of [...all, back]) c.close();
  }, 20_000);
});

describe('real sim: AI takeover and rematch', () => {
  it('a disconnected player\'s seat is played by the AI round after round, then handed back on rejoin', async (ctx) => {
    skipIfNoSim(ctx);
    const { host, guest, all, code } = await makeRoom(url);
    host.send({ t: 'start' });
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'marshal' } });
    guest.send({ t: 'intent', intent: { t: 'pickLord', lord: 'skylady' } });
    await host.wait('room', (m) => m.room.phase === 'planning');
    const tok = guest.token;
    guest.close();
    const taken = await host.wait('room', (m) => !!m.room.seats[1]?.botControlled && !!m.room.view?.enemy.ready, 3000);
    // the AI plays (and readies) seat 1 in every planning phase while its player is away
    let played = 0;
    for (let round = 1; round <= 2; round++) {
      const r = round === 1 ? taken : await host.wait('room', (m) => (m.room.phase === 'planning' && m.room.view!.round === round && !!m.room.view!.enemy.ready) || m.room.phase === 'over', 10_000);
      if (r.room.phase === 'over') break;
      expect(r.room.seats[1]!.botControlled).toBe(true);
      host.send({ t: 'intent', intent: { t: 'ready' } });
      const b = await host.wait('battle', () => true, 10_000);
      expect(b.replay.round).toBe(round);
      // the AI really deployed an army for the absent player (more than the Lord alone)
      expect(b.replay.soldiers.filter((s) => s.side === 1 && s.type !== 'lord').length).toBeGreaterThan(0);
      played++;
    }
    expect(played).toBeGreaterThanOrEqual(1);
    const back = await connect(url);
    back.send({ t: 'join', code, name: 'Guest', token: tok });
    expect((await back.wait('welcome')).seat).toBe(1);
    const r = await back.wait('room', (m) => m.room.seats[1]?.botControlled === false && !!m.room.view);
    expect(r.room.view!.you!.lord).toBe('skylady');
    expect(r.room.view!.you!.squads.length).toBeGreaterThan(1);
    for (const c of [...all, back]) c.close();
  }, 60_000);
});

describe('real sim: match end and rematch (matches one hit from the end)', () => {
  let fast: { port: number; close(): Promise<void> } | null = null;
  let furl = '';
  beforeAll(async () => {
    if (!server) return;
    const sim = await import('../src/sim/index.ts');
    const { startServer } = await import('../server/index.ts');
    fast = await startServer(0, {
      lordPickMs: 400, planningMs: 4000, lootBonusMs: 0, battleSlackMs: 200, battleCapMs: 800, resultsMs: 100, graceMs: 300,
      // both keeps at 1 HP with the Lords already picked: the first decided round ends the match
      newMatch: (seed) => {
        const s = sim.newMatch(seed, ['marshal', 'archmage']);
        for (const p of s.players) p.keepHp = 1;
        return s;
      },
    });
    furl = `ws://127.0.0.1:${fast.port}/ws`;
  });
  afterAll(() => fast?.close());

  async function playToOver(c: Client): Promise<RoomView> {
    let done = 0;
    for (let i = 0; i < 12; i++) {
      const r = await c.wait('room', (m) => (m.room.phase === 'planning' && m.room.view!.round > done) || m.room.phase === 'over', 10_000);
      if (r.room.phase === 'over') return r.room;
      done = r.room.view!.round;
      c.send({ t: 'intent', intent: { t: 'ready' } });
      await c.wait('battle', (m) => m.replay.round === done, 10_000);
    }
    throw new Error('the match did not end');
  }

  it('vsAI: the match ends, the winner is shown, and a rematch starts a fresh match (the bot always agrees)', async (ctx) => {
    if (!fast) return ctx.skip('sim not ready');
    const { host, all } = await makeRoom(furl, 'vsAI', 'hard');
    host.send({ t: 'start' });
    const over = await playToOver(host);
    expect(over.view!.phase).toBe('over');
    expect([0, 1, 'draw']).toContain(over.view!.winner);
    expect(over.seats[1]!.rematch).toBe(true);
    expect(over.phaseEndsAt).toBe(0);
    host.drain();
    host.send({ t: 'rematch' });
    expect((await host.wait('chat', (m) => m.system && /Rematch/.test(m.text))).text).toMatch(/new match/);
    const fresh = await host.wait('room', (m) => m.room.phase === 'planning' && m.room.view!.round === 1);
    expect(fresh.room.view!.history.length).toBe(0);
    expect(fresh.room.seats[0]!.rematch).toBe(false);
    for (const c of all) c.close();
  }, 60_000);

  it('pvp: a rematch needs every human; a player who left is played by the AI and does not block it', async (ctx) => {
    if (!fast) return ctx.skip('sim not ready');
    const { host, guest, all } = await makeRoom(furl);
    host.send({ t: 'start' });
    const over = await Promise.all([playToOver(host), playToOver(guest)]);
    expect(over[0].view!.winner).toBe(over[1].view!.winner);
    host.drain();
    guest.drain();
    host.send({ t: 'rematch' });
    const waiting = await guest.wait('room', (m) => !!m.room.seats[0]?.rematch);
    expect(waiting.room.phase).toBe('over'); // still waiting for the guest
    guest.send({ t: 'leave' });
    await host.wait('room', (m) => !!m.room.seats[1]?.botControlled);
    const fresh = await host.wait('room', (m) => m.room.phase === 'planning' && m.room.view!.round === 1);
    expect(fresh.room.seats[1]!.botControlled).toBe(true);
    expect(fresh.room.view!.enemy.ready).toBe(true); // the AI already played seat 1's first turn
    for (const c of all) c.close();
  }, 60_000);
});
