// The server's rooms and phase machine against a fake simulation (always runnable, no real sim needed).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';

const calls: string[] = [];
vi.mock('../src/sim/index.ts', () => {
  type P = { seat: number; lord: string | null; ready: boolean; lootOffer: unknown; squads: { type: string; pos: number[] }[]; lastArmy: unknown };
  type S = { round: number; phase: string; players: P[]; winner: unknown };
  const player = (seat: number): P => ({ seat, lord: null, ready: false, lootOffer: null, squads: [], lastArmy: null });
  return {
    LORD_IDS: ['marshal', 'archmage', 'warden', 'skylady'],
    newMatch: (): S => ({ round: 0, phase: 'lordPick', players: [player(0), player(1)], winner: null }),
    applyIntent: (s: S, seat: number, i: { t: string; lord?: string; unit?: string; pos?: number[] }) => {
      const p = s.players[seat];
      if (i.t === 'pickLord' && s.phase === 'lordPick') {
        p.lord = i.lord!;
        if (s.players.every((x) => x.lord)) (s.phase = 'planning'), (s.round = 1);
        return { ok: true };
      }
      if (s.phase !== 'planning') return { ok: false, error: 'wrong phase' };
      if (i.t === 'ready') return (p.ready = true), { ok: true };
      if (i.t === 'unready') return (p.ready = false), { ok: true };
      if (i.t === 'deploy') return p.squads.push({ type: i.unit!, pos: i.pos! }), { ok: true };
      return { ok: false, error: 'nope' };
    },
    viewFor: (s: S, seat: number | null) => {
      const enemy = (x: P) => ({ seat: x.seat, lord: x.lord, ready: x.ready, lastArmy: x.lastArmy });
      return { round: s.round, phase: s.phase, seat, winner: s.winner, you: seat === null ? null : s.players[seat], enemy: enemy(s.players[seat === null ? 1 : 1 - seat]) };
    },
    allReady: (s: S) => s.players.every((p) => p.ready),
    forceReady: (s: S) => {
      calls.push('forceReady');
      for (const p of s.players) p.ready = true;
    },
    simulateBattle: (s: S) => ({ replay: { v: 2, round: s.round, ticks: 10, blob: 'x'.repeat(50_000) }, result: { round: s.round, ticks: 10 } }),
    applyBattle: (s: S) => {
      calls.push('applyBattle');
      for (const p of s.players) p.lastArmy = p.squads.map((q) => ({ ...q }));
      if (s.round >= 3) (s.phase = 'over'), (s.winner = 0);
      else s.phase = 'results';
    },
    nextRound: (s: S) => {
      s.round++;
      s.phase = 'planning';
      for (const p of s.players) p.ready = false;
    },
    botPlan: (s: S, seat: number, strategy: string) => {
      calls.push(`bot:${seat}:${strategy}:${s.phase}`);
      if (s.phase === 'lordPick') {
        s.players[seat].lord = 'warden';
        if (s.players.every((x) => x.lord)) (s.phase = 'planning'), (s.round = 1);
      } else s.players[seat].ready = true;
    },
  };
});

const { startServer } = await import('../server/index.ts');
const { connect, makeRoom, sleep } = await import('./server-helpers.ts');

let server: Awaited<ReturnType<typeof startServer>>;
let url: string;
beforeAll(async () => {
  server = await startServer(0, { lordPickMs: 300, planningMs: 400, lootBonusMs: 0, battleSlackMs: 300, resultsMs: 100, graceMs: 300 });
  url = `ws://127.0.0.1:${server.port}/ws`;
});
afterAll(() => server.close());

describe('rooms (fake sim)', () => {
  it('serves /healthz, survives a malformed URL and an oversized frame', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(base + '/healthz')).text()).toBe('ok');
    expect((await fetch(base + '/../package.json')).status).not.toBe(200);
    const bad = await new Promise<number>((resolve) => {
      const sock = net.connect(server.port, '127.0.0.1', () => sock.write('GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('close', () => resolve(Number(data.split(' ')[1])));
    });
    expect(bad).toBe(400);
    const big = new WebSocket(url);
    big.on('error', () => {});
    await new Promise((r) => big.once('open', r));
    big.send('x'.repeat(20_000));
    await new Promise((r) => big.once('close', r));
    expect((await fetch(base + '/healthz')).status).toBe(200);
  });

  it('negotiates permessage-deflate', async () => {
    const c = await connect(url);
    expect(c.ws.extensions).toMatch(/permessage-deflate/);
    c.close();
  });

  it('create, join, spectate, bad code, full', async () => {
    const host = await connect(url);
    host.send({ t: 'create', name: 'Alice', mode: 'pvp' });
    const w = await host.wait('welcome');
    expect(w.code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(w.seat).toBe(0);
    const guest = await connect(url);
    guest.send({ t: 'join', code: w.code.toLowerCase(), name: 'Bob' });
    expect((await guest.wait('welcome')).seat).toBe(1);
    const r = await host.wait('room', (m) => !!m.room.seats[1]);
    expect(r.room.phase).toBe('lobby');
    expect(r.room.view).toBeNull();
    expect(r.room.mode).toBe('pvp');
    expect(r.room.seats.map((s) => [s!.name, s!.isHost, s!.connected, s!.isBot])).toEqual([['Alice', true, true, false], ['Bob', false, true, false]]);
    const specs = [];
    for (let i = 0; i < 6; i++) {
      const s = await connect(url);
      s.send({ t: 'join', code: w.code, name: `S${i}` });
      const sw = await s.wait('welcome');
      expect(sw.seat).toBeNull();
      expect(sw.spectator).toBe(true);
      specs.push(s);
    }
    const r2 = await host.wait('room', (m) => m.room.spectators.length === 6);
    expect(r2.room.spectators[0].name).toBe('S0');
    const extra = await connect(url);
    extra.send({ t: 'join', code: w.code, name: 'Late' });
    expect((await extra.wait('error')).error).toMatch(/full/i);
    const lost = await connect(url);
    lost.send({ t: 'join', code: 'ZZZZ', name: 'X' });
    expect((await lost.wait('error')).error).toMatch(/no room/i);
    // only players act; a spectator's start / intent is refused
    specs[0].send({ t: 'start' });
    expect((await specs[0].wait('rejected')).error).toMatch(/host/);
    for (const c of [host, guest, extra, lost, ...specs]) c.close();
  });

  it('rejoining with the token replaces the old socket (close code 4000)', async () => {
    const one = await connect(url);
    one.send({ t: 'create', name: 'Tab', mode: 'pvp' });
    const w = await one.wait('welcome');
    const two = await connect(url);
    two.send({ t: 'join', code: w.code, name: 'Tab', token: w.token });
    const w2 = await two.wait('welcome');
    expect(w2.seat).toBe(0);
    expect(w2.token).toBe(w.token);
    expect(await one.closeCode).toBe(4000);
    // the old socket closing must not have marked the seat as gone
    await sleep(50);
    two.drain();
    two.send({ t: 'chat', text: 'still here' });
    const r = await two.wait('chat');
    expect(r).toMatchObject({ seat: 0, name: 'Tab', system: false });
    two.close();
  });

  it('host swaps seats in the lobby; only the host starts; leaving frees the seat', async () => {
    const { host, guest, all } = await makeRoom(url);
    guest.send({ t: 'swapSeats' });
    expect((await guest.wait('rejected')).error).toMatch(/host/);
    host.drain();
    guest.drain();
    host.send({ t: 'swapSeats' });
    expect((await host.wait('welcome')).seat).toBe(1);
    expect((await guest.wait('welcome')).seat).toBe(0);
    const r = await guest.wait('room', (m) => m.room.seats[0]?.name === 'Guest');
    expect(r.room.me.seat).toBe(0);
    expect(r.room.seats[1]!.isHost).toBe(true);
    guest.send({ t: 'start' });
    expect((await guest.wait('rejected')).error).toMatch(/host/);
    host.send({ t: 'leave' });
    const r2 = await guest.wait('room', (m) => m.room.seats[1] === null);
    expect(r2.room.seats[0]!.isHost).toBe(true);
    guest.send({ t: 'start' });
    expect((await guest.wait('rejected')).error).toMatch(/opponent/);
    for (const c of all) c.close();
  });

  it('chat reaches everyone, cleaned', async () => {
    const { host, guest, all } = await makeRoom(url);
    host.send({ t: 'chat', text: '  hello <b>there</b>  ' });
    const m = await guest.wait('chat', (x) => !x.system);
    expect(m).toMatchObject({ seat: 0, name: 'Host' });
    expect(m.text).not.toMatch(/</);
    for (const c of all) c.close();
  });

  it('floods are dropped and the flooder is cut off', async () => {
    const c = await connect(url);
    for (let i = 0; i < 400; i++) c.send({ t: 'ping' });
    expect(await c.closeCode).toBe(1008);
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
  });
});

describe('phase machine (fake sim)', () => {
  it('lordPick timeout -> planning -> ready -> battle -> battleDone -> results -> round 2 -> timers -> over -> rematch', async () => {
    calls.length = 0;
    const { host, guest, all } = await makeRoom(url);
    host.send({ t: 'start' });
    const lp = await host.wait('room', (m) => m.room.phase === 'lordPick');
    expect(lp.room.phaseEndsAt).toBeGreaterThan(Date.now());
    // a planning intent is refused during lord pick
    host.send({ t: 'intent', intent: { t: 'ready' } });
    expect((await host.wait('rejected')).error).toMatch(/lord/i);
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'marshal' } });
    // guest never picks: the timer picks for them
    const pl = await guest.wait('room', (m) => m.room.phase === 'planning', 3000);
    expect(pl.room.view!.you!.lord).toBeTruthy();
    expect(pl.room.view!.round).toBe(1);
    host.send({ t: 'intent', intent: { t: 'deploy', unit: 'archers', pos: [100, 500] } });
    host.send({ t: 'intent', intent: { t: 'ready' } });
    guest.send({ t: 'intent', intent: { t: 'ready' } });
    const [b1, b2] = await Promise.all([host.wait('battle'), guest.wait('battle')]);
    expect(b1.offsetMs).toBe(0);
    expect(b2.replay.round).toBe(1);
    await host.wait('room', (m) => m.room.phase === 'battle');
    host.send({ t: 'intent', intent: { t: 'unready' } });
    expect((await host.wait('rejected')).error).toMatch(/planning/);
    host.send({ t: 'battleDone' });
    guest.send({ t: 'battleDone' });
    await host.wait('room', (m) => m.room.phase === 'results');
    const r2 = await host.wait('room', (m) => m.room.phase === 'planning' && m.room.view!.round === 2);
    expect(r2.room.view!.you!.ready).toBe(false);
    expect(calls).not.toContain('forceReady');
    // round 2: nobody readies -> forceReady; nobody sends battleDone -> the slack timer ends the battle
    await host.wait('battle', () => true, 3000);
    expect(calls).toContain('forceReady');
    await host.wait('room', (m) => m.room.phase === 'results', 3000);
    await host.wait('battle', () => true, 3000);
    const over = await host.wait('room', (m) => m.room.phase === 'over', 3000);
    expect(over.room.phaseEndsAt).toBe(0);
    guest.send({ t: 'rematch' });
    await host.wait('room', (m) => !!m.room.seats[1]?.rematch);
    host.send({ t: 'rematch' });
    const again = await guest.wait('room', (m) => m.room.phase === 'lordPick');
    expect(again.room.seats.map((s) => s!.name)).toEqual(['Host', 'Guest']);
    for (const c of all) c.close();
  }, 15_000);

  it('vsAI: the bot picks and readies at once; the human only readies', async () => {
    calls.length = 0;
    const { host, all } = await makeRoom(url, 'vsAI', 'easy');
    host.send({ t: 'start' });
    const lp = await host.wait('room', (m) => m.room.phase === 'lordPick');
    expect(lp.room.view!.enemy.lord).toBe('warden');
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'skylady' } });
    for (let round = 1; round <= 3; round++) {
      const p = await host.wait('room', (m) => m.room.phase === 'planning' && m.room.view!.round === round);
      expect(p.room.view!.enemy.ready).toBe(true);
      host.send({ t: 'intent', intent: { t: 'ready' } });
      await host.wait('battle');
    }
    await host.wait('room', (m) => m.room.phase === 'over', 3000);
    expect(calls).toContain('bot:1:random:planning');
    for (const c of all) c.close();
  }, 15_000);

  it('disconnect -> grace -> bot takes over -> rejoin mid-battle gets the replay with an offset and the seat back', async () => {
    calls.length = 0;
    const { host, guest, all, code } = await makeRoom(url);
    host.send({ t: 'start' });
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'marshal' } });
    guest.send({ t: 'intent', intent: { t: 'pickLord', lord: 'archmage' } });
    await host.wait('room', (m) => m.room.phase === 'planning');
    const tok = guest.token;
    guest.close();
    const gone = await host.wait('room', (m) => m.room.seats[1]?.connected === false);
    expect(gone.room.seats[1]!.graceEndsAt).toBeGreaterThan(Date.now());
    expect((await host.wait('chat', (m) => m.system && /disconnected/.test(m.text))).text).toMatch(/AI takes over/);
    const taken = await host.wait('room', (m) => !!m.room.seats[1]?.botControlled, 2000);
    expect(taken.room.view!.enemy.ready).toBe(true);
    expect(calls).toContain('bot:1:best:planning');
    host.send({ t: 'intent', intent: { t: 'ready' } });
    await host.wait('battle');
    await sleep(60);
    const back = await connect(url);
    back.send({ t: 'join', code, name: 'Guest', token: tok });
    expect((await back.wait('welcome')).seat).toBe(1);
    const b = await back.wait('battle');
    expect(b.offsetMs).toBeGreaterThan(0);
    const r = await back.wait('room', (m) => m.room.seats[1]?.botControlled === false);
    expect(r.room.seats[1]!.connected).toBe(true);
    expect((await host.wait('chat', (m) => m.system && /back/.test(m.text))).text).toMatch(/Guest/);
    // the battle now waits for the rejoined player too
    host.send({ t: 'battleDone' });
    back.send({ t: 'battleDone' });
    await back.wait('room', (m) => m.room.phase === 'results');
    for (const c of [...all, back]) c.close();
  }, 10_000);

  it('every snapshot is viewFor(the socket seat): the enemy current deploys never reach the other seat or spectators', async () => {
    const { host, guest, all, code } = await makeRoom(url);
    const spec = await connect(url);
    spec.send({ t: 'join', code, name: 'Watcher' });
    await spec.wait('welcome');
    host.send({ t: 'start' });
    host.send({ t: 'intent', intent: { t: 'pickLord', lord: 'marshal' } });
    guest.send({ t: 'intent', intent: { t: 'pickLord', lord: 'archmage' } });
    await host.wait('room', (m) => m.room.phase === 'planning');
    guest.send({ t: 'intent', intent: { t: 'deploy', unit: 'dragon', pos: [4321, 9876] } });
    await guest.wait('room', (m) => !!m.room.view?.you?.squads.length);
    await sleep(50);
    expect(host.raw.join('\n')).not.toMatch(/dragon|9876/);
    expect(spec.raw.join('\n')).not.toMatch(/dragon|9876/);
    expect(guest.raw.join('\n')).toMatch(/dragon/);
    for (const c of [...all, spec]) c.close();
  });
});
