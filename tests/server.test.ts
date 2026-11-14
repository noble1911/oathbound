// The server over real sockets, with the real v2 simulation (skipped while src/sim is not importable).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerView, Vec2 } from '../src/sim/types.ts';
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
