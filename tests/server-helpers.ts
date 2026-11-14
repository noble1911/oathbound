// Shared by the server tests: a tiny websocket client with an inbox and typed waiters.
import WebSocket from 'ws';
import type { Seat } from '../src/sim/types.ts';
import type { AiLevel, ClientMsg, RoomMode, RoomView, ServerMsg } from '../src/net/protocol.ts';

export class Client {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  /** Every raw text frame received, for leak checks. */
  raw: string[] = [];
  waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  seat: Seat | null = null;
  /** The newest room snapshot received. */
  last: RoomView | null = null;
  spectator = false;
  token = '';
  code = '';
  closeCode: Promise<number>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {});
    this.closeCode = new Promise((r) => this.ws.once('close', (c) => r(c)));
    this.ws.on('message', (d) => {
      const s = String(d);
      this.raw.push(s);
      const m = JSON.parse(s) as ServerMsg;
      if (m.t === 'room') this.last = m.room;
      if (m.t === 'welcome') {
        this.seat = m.seat;
        this.spectator = m.spectator;
        this.token = m.token;
        this.code = m.code;
      }
      const w = this.waiters.find((x) => x.pred(m));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.res(m);
      } else this.inbox.push(m);
    });
  }
  open(): Promise<void> {
    return new Promise((r) => this.ws.once('open', () => r()));
  }
  send(m: ClientMsg): void {
    this.ws.send(JSON.stringify(m));
  }
  wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 8000): Promise<Extract<ServerMsg, { t: T }>> {
    const i = this.inbox.findIndex((m) => m.t === t && pred(m as never));
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as never);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${t}`)), ms);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as never),
        res: ((m: ServerMsg) => {
          clearTimeout(timer);
          res(m as never);
        }) as never,
      });
    });
  }
  /** Drop queued messages (of one type, or all) so the next wait() sees only fresh ones. */
  drain(t?: ServerMsg['t']): void {
    this.inbox = t ? this.inbox.filter((m) => m.t !== t) : [];
  }
  close(): void {
    this.ws.close();
  }
}

export async function connect(url: string): Promise<Client> {
  const c = new Client(url);
  await c.open();
  return c;
}

/** A pvp room with both seats filled (host = seat 0), or a vsAI room (host vs the bot). */
export async function makeRoom(url: string, mode: RoomMode = 'pvp', aiLevel?: AiLevel) {
  const host = await connect(url);
  host.send(aiLevel ? { t: 'create', name: 'Host', mode, aiLevel } : { t: 'create', name: 'Host', mode });
  const { code } = await host.wait('welcome');
  if (mode === 'vsAI') {
    await host.wait('room', (m) => !!m.room.seats[1]?.isBot);
    return { host, guest: null as unknown as Client, all: [host], code };
  }
  const guest = await connect(url);
  guest.send({ t: 'join', code, name: 'Guest' });
  await guest.wait('welcome');
  await host.wait('room', (m) => !!m.room.seats[1]);
  return { host, guest, all: [host, guest], code };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
