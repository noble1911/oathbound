// The one seam between the screens and 3D. Screens only talk to `SceneAdapter`; `createScene()`
// returns the stand-in renderer (src/ui/standin-scene.ts) until the render agent's engine
// (src/render/) exposes the same needs, at which point the mapping lives here.
//
// Coordinates are always field centimetres (see src/sim/types.ts): x in 0..8000, y in 0..12000,
// facing as a 0..255 binary angle. The adapter turns the camera so the viewer's own Keep is at the
// bottom of the screen (`setPerspective`).
import type { DecodedReplay, LordId, Rarity, ReplayEvent, Seat, SkillEvent, SquadType, Terrain, Vec2, FactionId } from '../sim/types.ts';

export type SceneMode = 'title' | 'lobby' | 'lordPick' | 'planning' | 'battle' | 'results';
export type CameraMode = 'director' | 'free';
export type QualityChoice = 'low' | 'medium' | 'high' | 'ultra' | 'auto';

export interface SquadVisual {
  id: number;
  type: SquadType;
  lord?: LordId | null;
  owner: Seat;
  pos: Vec2;
  facing: number;
  level: number;
  /** Soldiers in the squad (grown Swarm squads, Warhorn); default the unit's level-1 squad size. */
  size?: number;
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
  /** A Lord's ability reach (cm) and its name, drawn as a second ring in the owner's livery. */
  aura?: { radius: number; label: string } | null;
}

/**
 * A small mark drawn at the left of a plate tag (relocation, DESIGN §2): `lock` locked in place, `open` locked but a
 * Muster relocation may move it, `reloc` relocated this round; on an enemy ghost `moved` (stood elsewhere the battle
 * before) or `new` (new last round). The Lord's stance (src/ui/stance.ts): `hold` / `follow` on my Lord's tag, and on
 * the enemy Lord's ghost (with `foe`) the stance he fought the last battle with. A tag with a badge may have empty text.
 */
export type TagBadge = 'lock' | 'open' | 'reloc' | 'moved' | 'new' | 'hold' | 'follow';

/**
 * My Lord's stance on the field (src/ui/stance.ts stanceMarker; field cm). Hold: a dashed watch ring round his post.
 * Follow: a dashed tether from the Lord to the spot behind the squad he follows, a post mark there and a short line on
 * to the squad (and its leash ring while the Lord is selected).
 */
export interface StanceSpec {
  kind: 'hold' | 'follow';
  lord: Vec2;
  post: Vec2;
  /** cm: the ring's radius (hold: the watch; follow: the leash round his spot). */
  leash: number;
  lead?: Vec2;
  /** The Lord is selected: drawn brighter, and the follow leash ring shows. */
  focus: boolean;
  label: string;
}

/** The planning march preview (src/ui/timing.ts): plate tags, and route lines with their time marks. */
export interface TimingSpec {
  /** A small seconds tag under a squad's plate (`pos` is the squad's field position). */
  tags: { id: number; pos: Vec2; text: string; hot?: boolean; badge?: TagBadge; foe?: boolean }[];
  /** Field-cm polylines; `marks` are labels along them (the river, the enemy front). */
  routes: { pts: Vec2[]; hot?: boolean; marks: { pos: Vec2; text: string; dim?: boolean }[] }[];
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

/** The battle behind the title menu (`SceneAdapter.playBackdrop`). */
export interface BackdropOptions {
  /** Each seat's faction (its Keep). */
  factions: [FactionId, FactionId];
  /** Which flank the camera dollies along. */
  side: 1 | -1;
  /** Cost, whatever the player's graphics settings: tier, drawing-buffer scale (of CSS pixels) and frame cap. */
  tier: 'low' | 'medium';
  scale: number;
  fps: number;
  onEnd(): void;
}

export interface BackdropHandle {
  /** Starts paused. Paused = nothing is drawn (the last frame stays on the canvas). */
  playing: boolean;
  readonly timeMs: number;
  readonly durationMs: number;
  /** Every unit model of this battle has arrived. */
  loaded(): boolean;
  /** Jump to `ms` and frame the fight there at once (a still, or the start of a battle joined midway). */
  frameAt(ms: number): void;
  /** The frame as drawn now (JPEG), or null. */
  still(): Promise<Blob | null>;
  /** Reserve screen space for the menu (CSS px): the camera frames the fight in the rest. */
  setInsets(i: { left?: number; right?: number; top?: number; bottom?: number }): void;
  stop(): void;
}

export interface SceneAdapter {
  readonly kind: 'standin' | 'engine';
  /**
   * Title only: play a battle as a backdrop, drawn cheaply (see BackdropOptions) by a slow cinematic camera, with no
   * plates, numbers or sound. Any other `setMode` ends it and restores the player's settings. A scene without it
   * (the stand-in) leaves the title on its static art.
   */
  playBackdrop?(d: DecodedReplay, o: BackdropOptions): BackdropHandle;
  setMode(m: SceneMode): void;
  /** Turn the camera so `seat`'s Keep is at the bottom of the screen (null = spectator, seat 0 view). */
  setPerspective(seat: Seat | null): void;
  setTerrain(t: Terrain): void;
  setKeeps(hp: [number, number], max: [number, number]): void;
  /** Each seat's faction (sim seats; null = not known yet): the renderer builds that faction's Keep and arrow towers. */
  setFactions(f: [FactionId | null, FactionId | null]): void;

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
  /** Several of my squads selected at once (each gets the selected plate and a footprint ring). */
  setSelection?(ids: number[]): void;
  /** The march preview; null clears it. Drawn only when it changes (render on demand). */
  setTiming?(t: TimingSpec | null): void;
  /** My Lord's stance markers (null: Advance, or not in planning). Drawn only when it changes. */
  setStance?(s: StanceSpec | null): void;
  setHovered(id: number | null): void;
  setRange(r: RangeSpec | null): void;
  /** Hide one squad while it is being dragged (its preview shows instead). */
  setHidden(id: number | null): void;
  /** Project a field position (+ height in metres) to client pixels. */
  toScreen(pos: Vec2, heightM?: number): ScreenPoint | null;
  /** Where the camera looks (field cm) and its distance in metres (audio listener). Null if unknown. */
  cameraFocus?(): { pos: Vec2; dist: number } | null;
  /** Block/allow the RTS camera's own drag handling (while the UI drags a squad). */
  setInputLocked(locked: boolean): void;
  /** Asked on every left press on the canvas: return true to keep it for the UI (squad drag, placing). */
  setPointerClaim(fn: ((e: PointerEvent) => boolean) | null): void;
  /** Reserve screen space for HUD panels (CSS px); the view centres in the rest. */
  setInsets(i: { left?: number; right?: number; top?: number; bottom?: number }): void;

  // ---- battle playback
  /**
   * Play a decoded replay from `offsetMs`; every event reaches `onEvent` as it fires (sound, kill feed).
   * Item-skill casts are not replay events: a scene that plays them reports each through `onSkill`
   * (`e.squad` = the caster's row in Replay.squads) as its effect starts.
   */
  playReplay(d: DecodedReplay, o: { offsetMs: number; onEvent(e: ReplayEvent, ms: number): void; onSkill?(e: SkillEvent, ms: number): void; onEnd(): void }): PlaybackHandle;
  clearReplay(): void;
  /** Battle: the replay soldier (index in Replay.soldiers) under the pointer, or null (the inspector's pick). */
  pickSoldier?(clientX: number, clientY: number): number | null;
  /** Battle: mark squads' in-world plates as selected / hovered (MatchState squad ids). */
  markSquads?(selected: number[], hovered: number | null): void;
  setCameraMode(m: CameraMode): void;
  /** The battle camera's mode right now (the user may have grabbed it). */
  cameraMode?(): CameraMode;
  /** Back to the home framing (planning: the deploy zone inside the HUD insets). */
  resetCamera?(): void;
  /** The camera changed mode by itself (the user grabbed it, or pressed C). */
  onCameraMode: ((m: CameraMode) => void) | null;

  /** Power: battery saver (no idle orbit, 1x pixel ratio, 30 fps) and the fps cap (30 | 60). */
  setPower(p: { batterySaver?: boolean; fpsCap?: number }): void;
  /** The stored power settings (the renderer keeps them; one key each). */
  power?(): { batterySaver: boolean; fpsCap: number };
  /** Graphics tier ('auto' = pick by GPU and frame time). */
  setQuality?(q: QualityChoice): void;
  quality?(): { choice: QualityChoice; tier: string };
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
  if (!/[?&]scene=standin\b/.test(location.search)) {
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
