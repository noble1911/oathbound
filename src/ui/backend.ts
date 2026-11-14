// What the screens send. The online `Net` client (src/net/client.ts) or the local dev harness
// (src/ui/local.ts) implement it; both report back through `AppHandlers` with the same RoomView
// snapshots (src/net/protocol.ts), so every screen runs unchanged offline.
import type { Intent, Replay, Seat } from '../sim/types.ts';
import type { RoomView } from '../net/protocol.ts';

export interface Backend {
  readonly online: boolean;
  start(): void;
  swapSeats(): void;
  intent(i: Intent): void;
  battleDone(): void;
  rematch(): void;
  chat(text: string): void;
  leave(): void;
  /** PvP, in a running match: give up and stay in the room for the result (`{ t: 'concede' }`). Absent offline. */
  concede?(): void;
}

export interface AppHandlers {
  onRoom(room: RoomView, mySeat: Seat | null): void;
  onBattle(replay: Replay, offsetMs: number): void;
  onRejected(error: string): void;
  onChat(seat: Seat | null, name: string, text: string, system: boolean): void;
}
