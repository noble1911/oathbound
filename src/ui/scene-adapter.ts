// The one seam between the screens and 3D. Screens only talk to `SceneAdapter`; `createScene()`
// returns the stand-in renderer (src/ui/standin-scene.ts) until the render agent's engine
// (src/render/) exposes the same needs, at which point the mapping lives here.
//
// Coordinates are always field centimetres (see src/sim/types.ts): x in 0..8000, y in 0..12000,
// facing as a 0..255 binary angle. The adapter turns the camera so the viewer's own Keep is at the
// bottom of the screen (`setPerspective`).
import type { DecodedReplay, LordId, Rarity, ReplayEvent, Seat, SquadType, Terrain, Vec2 } from '../sim/types.ts';

export type SceneMode = 'title' | 'lobby' | 'lordPick' | 'planning' | 'battle' | 'results';
export type CameraMode = 'director' | 'free';

export interface SquadVisual {
  id: number;
  type: SquadType;
  lord?: LordId | null;
  owner: Seat;
  pos: Vec2;
  facing: number;
  level: number;
  /** Best rarity equipped (aura colour), null = none. */
  rarity?: Rarity | null;
}

export interface PreviewSpec {
  type: SquadType;
  lord?: LordId | null;
  seat: Seat;
  pos: Vec2;
  facing: number;
  valid: boolean;
}

export interface RangeSpec {
  pos: Vec2;
  /** cm */
  range: number;
  minRange: number;
  enemy?: boolean;
}

export interface ScreenPoint { x: number; y: number }

/** A battle being played back. The scene owns the clock (frame-synced, sleeps when paused). */
export interface PlaybackHandle {
  speed: number;
  readonly timeMs: number;
  readonly durationMs: number;
  /** Jump (no events fire for the skipped span). */
  seek(ms: number): void;
  stop(): void;
}

export interface SceneAdapter {
  readonly kind: 'standin' | 'engine';
  setMode(m: SceneMode): void;
  /** Turn the camera so `seat`'s Keep is at the bottom of the screen (null = spectator, seat 0 view). */
  setPerspective(seat: Seat | null): void;
  setTerrain(t: Terrain): void;
  setKeeps(hp: [number, number], max: [number, number]): void;

  // ---- planning
  /** Field cm under the pointer, or null when the pointer misses the field. */
  groundAt(clientX: number, clientY: number): Vec2 | null;
  /** The squad (own or ghost) under the pointer. */
  squadAt(clientX: number, clientY: number): { id: number; ghost: boolean } | null;
  showDeployZone(seat: Seat | null): void;
  /** Squads drawn solid (the viewer's army; spectators: both armies). */
  setArmy(squads: SquadVisual[]): void;
  /** The enemy's last-round army, drawn as translucent ghosts. Null hides them. */
  setGhosts(squads: SquadVisual[] | null): void;
  setPreview(p: PreviewSpec | null): void;
  setSelected(id: number | null): void;
  setHovered(id: number | null): void;
  setRange(r: RangeSpec | null): void;
  /** Hide one squad while it is being dragged (its preview shows instead). */
  setHidden(id: number | null): void;
  /** Project a field position (+ height in metres) to client pixels. */
  toScreen(pos: Vec2, heightM?: number): ScreenPoint | null;
  /** Block/allow the RTS camera's own drag handling (while the UI drags a squad). */
  setInputLocked(locked: boolean): void;
  /** Asked on every left press on the canvas: return true to keep it for the UI (squad drag, placing). */
  setPointerClaim(fn: ((e: PointerEvent) => boolean) | null): void;
  /** Reserve screen space for HUD panels (CSS px); the view centres in the rest. */
  setInsets(i: { left?: number; right?: number; top?: number; bottom?: number }): void;

  // ---- battle playback
  /** Play a decoded replay from `offsetMs`; every event reaches `onEvent` as it fires (sound, kill feed). */
  playReplay(d: DecodedReplay, o: { offsetMs: number; onEvent(e: ReplayEvent, ms: number): void; onEnd(): void }): PlaybackHandle;
  clearReplay(): void;
  setCameraMode(m: CameraMode): void;
  /** The camera changed mode by itself (the user grabbed it, or pressed C). */
  onCameraMode: ((m: CameraMode) => void) | null;

  /** Power: battery saver (no idle orbit, 1x pixel ratio, 30 fps) and the fps cap (30 | 60). */
  setPower(p: { batterySaver?: boolean; fpsCap?: number }): void;
  /** Frames drawn so far (tests check idle planning draws 0 fps). */
  readonly framesDrawn: number;

  /** The canvas (pointer events for planning go here). */
  readonly canvas: HTMLCanvasElement;
  dispose(): void;
}

let current: SceneAdapter | null = null;

/** The scene singleton. Loaded lazily so title/lobby paint before three.js is parsed. */
export async function createScene(host: HTMLElement): Promise<SceneAdapter> {
  if (current) return current;
  // the render agent's engine by default; ?scene=standin (or an engine failure) uses the light stand-in
  if (!/[?&]scene=standin/.test(location.search)) {
    try {
      const { EngineScene } = await import('./engine-scene.ts');
      current = new EngineScene(host);
      return current;
    } catch (e) {
      console.warn('render engine unavailable, using the stand-in scene', e);
    }
  }
  const { StandInScene } = await import('./standin-scene.ts');
  current = new StandInScene(host);
  return current;
}
