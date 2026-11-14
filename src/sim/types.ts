// Oathbound v2 — public simulation types. This file is the contract between sim, server, UI and renderer.
// Everything here is plain JSON-serialisable data (no classes, no Maps), so the server can send it as-is.
//
// ---- Units of measure (used everywhere) ----
//  * Distances / positions: integer CENTIMETRES. The field is FIELD_W x FIELD_H = 8000 x 12000 cm (80 m x 120 m).
//    Seat 0 deploys in y in [400, 3999] and its Keep sits at y ~ 0; seat 1 deploys in y in [8000, 11599], Keep at y ~ 12000.
//    A stored position p stands for the point p + 0.5 cm, which makes the 180-degree mirror an exact integer map:
//    mirror(x, y) = (FIELD_W - 1 - x, FIELD_H - 1 - y). Use `mirrorPos` from index.ts.
//  * Facing: binary angle 0..255 (256 = one turn). 0 = +x, 64 = +y (towards seat 1), 128 = -x, 192 = -y.
//    Seat 0 squads face 64 by default, seat 1 squads face 192.
//  * Time: the battle runs at TICK_HZ = 20 ticks/s (TICK_MS = 50). Replay keyframes are every KEYFRAME_TICKS = 4 ticks.
//  * Percentages in items / stats are integer percent points (12 = +12%).

export type Seat = 0 | 1;
export type Vec2 = [number, number];

export type LordId = 'marshal' | 'archmage' | 'warden' | 'skylady';

export type UnitType =
  | 'militia' | 'pikemen' | 'berserkers' | 'archers' | 'knights' | 'cavaliers' | 'mages'
  | 'clerics' | 'pegasus' | 'ballista' | 'trebuchet' | 'golem' | 'wyvern' | 'dragon';

/** A squad is either one of the 14 unit types or the player's Lord (a 1-soldier squad). */
export type SquadType = UnitType | 'lord';
/** Soldiers raised by the Gravebloom legendary. They exist only inside a battle (replay header), never in MatchState. */
export type SoldierType = SquadType | 'skeleton';

export type Tag = 'mounted' | 'armored' | 'flier' | 'large' | 'infantry';
export type WeaponKind = 'sword' | 'axe' | 'lance' | 'bow' | 'tome' | 'staff' | 'bolt' | 'stone' | 'fists' | 'breath';
export type DamageType = 'physical' | 'magic';
/** What flies through the air. 'none' = melee swing (no projectile). */
export type ProjectileKind = 'none' | 'arrow' | 'bolt' | 'stone' | 'fireball' | 'firebreath' | 'lightning' | 'tower_arrow';
/** Flight path for the renderer: 'arc' = ballistic parabola (arrows, stones), 'line' = straight (bolts, fireballs, breath). */
export type ArcType = 'line' | 'arc' | 'high_arc';

export interface UnitDef {
  id: UnitType;
  name: string;
  /** Renderer model key (public/models/v2/<modelId>.glb). */
  modelId: string;
  cost: number;
  squadSize: number;
  tags: Tag[];
  weapon: WeaponKind;
  damageType: DamageType;
  projectile: ProjectileKind;
  /** Per soldier at Lv1. */
  hp: number;
  dmg: number;
  /** Ticks between attacks. */
  attackTicks: number;
  /** Max attack range in cm (melee ~150-250). */
  range: number;
  /** Min range in cm (trebuchet). 0 = none. */
  minRange: number;
  /** cm per tick (x20 for cm/s). */
  speed: number;
  /** Physical damage reduction, percent. */
  armor: number;
  /** Magic damage reduction, percent. */
  magicResist: number;
  /** Splash radius in cm, 0 = single target. */
  splash: number;
  /** Damage multipliers (percent, 100 = x1) vs targets carrying a tag. */
  effective: Partial<Record<Tag, number>>;
  /** Soldier body radius in cm (separation / melee reach). */
  radius: number;
  /** Heal per cast (clerics); 0 otherwise. */
  heal: number;
  /** Lifesteal percent of damage dealt. */
  lifesteal: number;
  /** Special rules, see data/units.ts. */
  traits: UnitTrait[];
  /** Earliest round in which the unit may be offered in the unlock draft. */
  minRound: number;
  /** Short role text for UI. */
  role: string;
}
export type UnitTrait = 'brace' | 'charge' | 'pierce' | 'stomp' | 'cone' | 'slowTurn' | 'healer' | 'ignoresArmor' | 'crushing' | 'backline' | 'raider';

export interface LordDef {
  id: LordId;
  name: string;
  title: string;
  modelId: string;
  weapon: WeaponKind;
  damageType: DamageType;
  projectile: ProjectileKind;
  signature: [UnitType, UnitType];
  tags: Tag[];
  hp: number;
  dmg: number;
  attackTicks: number;
  range: number;
  speed: number;
  armor: number;
  magicResist: number;
  splash: number;
  passive: string;
  ability: AbilityId;
  abilityName: string;
  abilityText: string;
}
export type AbilityId = 'rally' | 'meteor' | 'bulwark' | 'skyfall';

// ---------------------------------------------------------------- Items / loot

export type Slot = 'weapon' | 'armor' | 'relic';
export type Rarity = 'common' | 'magic' | 'rare' | 'legendary';
export type BaseId =
  | 'steel_blade' | 'ironbark_bow' | 'war_axe' | 'ash_spear' | 'grimoire'
  | 'mail_hauberk' | 'warded_robe' | 'plate_cuirass' | 'leather_jerkin'
  | 'bone_charm' | 'sun_medallion' | 'oath_ring' | 'war_banner';
export type AffixId =
  | 'keen' | 'vicious' | 'haste' | 'leech' | 'stalwart' | 'warding' | 'fleet' | 'thorns'
  | 'slaying' | 'embers' | 'frost' | 'farreach' | 'phoenix' | 'command' | 'plated';
export type LegendaryId =
  | 'stormcaller' | 'kingsbane' | 'undying_oath' | 'ember_crown' | 'mirror_aegis' | 'warhorn'
  | 'gravebloom' | 'bloodthirst' | 'earthshaker' | 'frostheart' | 'lifebinder' | 'hydra_volley'
  | 'windrunner' | 'sunfire';

export interface Affix {
  id: AffixId;
  /** Rolled value: percent points for % affixes, cm for 'farreach', dps for 'embers', 1 for flags (phoenix, command, frost). */
  value: number;
  /** Only for 'slaying'. */
  tag?: Tag;
}

export interface Item {
  /** Unique within the match. */
  id: number;
  base: BaseId;
  slot: Slot;
  rarity: Rarity;
  /** Item level = the round it dropped in; scales affix ranges. */
  ilvl: number;
  /** Implicit of the base (rolled), e.g. +10% damage on a Steel Blade. */
  implicit: Affix;
  affixes: Affix[];
  legendary: LegendaryId | null;
}
export interface ItemSlots { weapon: Item | null; armor: Item | null; relic: Item | null }

/** One tooltip line. `style` drives colour in the UI: name uses the rarity colour, legendary lines are orange. */
export interface ItemLine { text: string; style: 'name' | 'base' | 'implicit' | 'affix' | 'legendary' | 'flavor' | 'meta' }

// ---------------------------------------------------------------- Terrain

export type TerrainKind = 'plain' | 'forest' | 'hill' | 'river' | 'ford' | 'bridge' | 'ruins';
/** A terrain feature for the renderer. Circles use (x, y, r); rects use (x, y) as min corner and (w, h). All cm. */
export interface TerrainFeature { kind: Exclude<TerrainKind, 'plain'>; shape: 'circle' | 'rect'; x: number; y: number; r: number; w: number; h: number }
export interface Terrain {
  seed: number;
  /** Mirrored: for every feature there is its 180-degree mirror (self-mirrored features appear once). */
  features: TerrainFeature[];
}

// ---------------------------------------------------------------- Match state (server-side, full information)

export type Phase = 'lordPick' | 'planning' | 'results' | 'over';

export interface Squad {
  /** Unique within the match (never reused). */
  id: number;
  owner: Seat;
  type: SquadType;
  /** 1..5 for units (gold level-ups), 1..10 for the Lord (XP). */
  level: number;
  /** Squad centre, cm. */
  pos: Vec2;
  /** 0..255, see header. */
  facing: number;
  items: ItemSlots;
  /** Round in which it was deployed (sell refunds 50% only during that round's planning). */
  deployedRound: number;
  /** Gold spent on this squad (deploy + level-ups); used for selling and stats. */
  spent: number;
}

export interface PlayerState {
  seat: Seat;
  lord: LordId | null;
  gold: number;
  keepHp: number;
  keepMax: number;
  /** Unit types this player may deploy. */
  unlocked: UnitType[];
  /** Pending unlock choice: pick `draftPicks` of these with {t:'draft'}. Empty when nothing to pick. */
  draftOptions: UnitType[];
  draftPicks: number;
  /** Pending loot choice (3 items, 4 for Skylady). Null when nothing to pick. */
  lootOffer: Item[] | null;
  /** Your army. The Lord squad (type 'lord') is always squads[0] once a Lord is picked. */
  squads: Squad[];
  /** Unequipped items. */
  stash: Item[];
  /** Squads deployed this planning phase (not counting the Lord). */
  deploysUsed: number;
  /** New squads allowed this round (2, Marshal 3, + 'of Command' relics). */
  deployLimit: number;
  lordXp: number;
  ready: boolean;
  /** Did this player lose the last battle (catch-up gold and loot tier)? */
  lostLast: boolean;
  /** The army as it fought last battle — the only thing the opponent sees during planning. */
  lastArmy: Squad[] | null;
}

export interface RoundSummary {
  round: number;
  winner: Seat | null; // null = timeout / both wiped
  keepDamage: [number, number]; // damage dealt TO seat 0's and seat 1's keep
  survivors: [number, number]; // surviving squads per seat
  ticks: number;
}

export interface MatchState {
  v: 2;
  seed: number;
  round: number;
  phase: Phase;
  players: [PlayerState, PlayerState];
  terrain: Terrain;
  /** Set when phase = 'over'. */
  winner: Seat | 'draw' | null;
  history: RoundSummary[];
  nextId: number;
}

/** What one seat may see. `you` is full; `enemy` is filtered (see viewFor in index.ts). Spectators use viewFor(state, null). */
export interface PlayerView {
  seed: number;
  round: number;
  phase: Phase;
  seat: Seat | null;
  terrain: Terrain;
  winner: Seat | 'draw' | null;
  history: RoundSummary[];
  you: PlayerState | null;
  /** Spectator: both players' public info. */
  enemy: EnemyView;
  enemies?: [EnemyView, EnemyView];
}
export interface EnemyView {
  seat: Seat;
  lord: LordId | null;
  keepHp: number;
  keepMax: number;
  ready: boolean;
  /** The army exactly as it fought last round (positions, levels, items). Null in round 1. */
  lastArmy: Squad[] | null;
  // Gold, stash, unlocks, current squads/levels/items and loot are hidden.
}

// ---------------------------------------------------------------- Intents

export type Intent =
  | { t: 'pickLord'; lord: LordId }
  | { t: 'draft'; unit: UnitType }
  | { t: 'deploy'; unit: UnitType; pos: Vec2; facing?: number }
  | { t: 'move'; squad: number; pos: Vec2; facing?: number }
  | { t: 'sell'; squad: number }
  | { t: 'levelUp'; squad: number }
  | { t: 'pickLoot'; index: number }
  /** Equip an item (from the stash OR from another squad) onto `squad`, in the item's slot. Whatever was there goes where the item came from. */
  | { t: 'equip'; item: number; squad: number }
  /** Put an equipped item into the stash. */
  | { t: 'unequip'; item: number }
  /** Alias of equip, for drag-and-drop between squads. */
  | { t: 'moveItem'; item: number; squad: number }
  | { t: 'ready' }
  | { t: 'unready' };

export type IntentResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------- Battle result / replay

export interface BattleResult {
  round: number;
  /** null = timeout (both may have survivors) or both armies wiped. */
  winner: Seat | null;
  timeout: boolean;
  /** Keep damage dealt TO seat 0's keep and seat 1's keep (already clamped by nothing; applyBattle clamps at 0). */
  keepDamage: [number, number];
  /** Squad ids (MatchState ids) that had at least one survivor at battle end, per seat. Lord included. */
  survivors: [number[], number[]];
  /** Lord XP earned per seat. */
  lordXp: [number, number];
  /** Ticks of real fighting (up to the wipe or 1800); `replay.ticks` also includes the post-wipe march. */
  ticks: number;
  /** Per-seat stats (for tooltips / tournament): damage dealt, soldiers lost. */
  damageDealt: [number, number];
  soldiersLost: [number, number];
}

export type AnimState = 'idle' | 'move' | 'attack' | 'cast' | 'dead';
export const ANIM_STATES: readonly AnimState[] = ['idle', 'move', 'attack', 'cast', 'dead'];

/** Header row for one soldier. Soldier index = position in Replay.soldiers (stable for the whole replay). */
export interface ReplaySoldier {
  /** Soldier index in this replay. */
  id: number;
  /** MatchState squad id (skeletons: the id of the squad whose kill raised them, negative-free; see `summoned`). */
  squad: number;
  side: Seat;
  type: SoldierType;
  modelId: string;
  /** Lord id when type = 'lord'. */
  lord?: LordId;
  level: number;
  maxHp: number;
  /** Item ids/rarities/legendary on the squad, for glow VFX. */
  items: { slot: Slot; rarity: Rarity; base: BaseId; legendary: LegendaryId | null }[];
  /** Visual flags: 'flier', 'large', 'mounted', 'elite' (Lv3+), 'champion' (Lv5), 'legendary' (has a legendary), 'skeleton'. */
  flags: string[];
  /** Tick at which this soldier enters the replay (0, or the summon tick for skeletons). Before that it is not rendered. */
  spawnTick: number;
  summoned: boolean;
}

/**
 * Replay events (decoded form). `tick` is the sim tick (t = tick * 50 ms). `src`/`tgt` are soldier indices into
 * Replay.soldiers, or -1 (none), or a keep id: ids >= KEEP_SRC_BASE (= 1_000_000, exported from index.ts) are
 * keepSource(seat, n) = KEEP_SRC_BASE + seat * 4 + n, with n = 0/1 the keep's arrow towers and n = 2 the keep itself
 * (the target of survivors' attacks during the post-wipe march).
 *
 * Guarantees for playback:
 *  - Every 'projectile' has exactly one 'impact' with the same id (projectiles still flying when the battle ends get
 *    their impact on the final tick). Reflected projectiles (Mirror Aegis) are new projectiles with new ids.
 *  - Every 'attack' is emitted at swing / draw start and carries `hitTick`: melee = the tick its 'hit' events land
 *    (swing windup, 6 ticks max; 12 for trebuchet aiming), ranged = the projectile's landing tick (= its 'impact').
 *    A melee swing whose attacker or target dies during the windup produces no hit.
 *  - Events are sorted by tick; within a tick, in emission order.
 */
export type ReplayEvent =
  /** A soldier starts an attack. For melee the matching 'hit' follows after the windup. */
  | { k: 'attack'; tick: number; src: number; tgt: number; weapon: WeaponKind | 'tower'; projectile: ProjectileKind; hitTick: number }
  /** A projectile leaves `from` towards `to` (cm, ground plane) and lands at tick + flight. `id` pairs it with its 'impact'. */
  | { k: 'projectile'; tick: number; id: number; src: number; tgt: number; kind: ProjectileKind; arc: ArcType; from: Vec2; to: Vec2; flight: number }
  /** The projectile lands (on target, or on the ground for stones / misses). */
  | { k: 'impact'; tick: number; id: number; pos: Vec2; kind: ProjectileKind; splash: number }
  /** Damage on a soldier. triangle: 1 = attacker had the advantage, -1 disadvantage, 0 none. */
  | { k: 'hit'; tick: number; src: number; tgt: number; dmg: number; crit: boolean; effective: boolean; triangle: -1 | 0 | 1; miss: boolean }
  | { k: 'heal'; tick: number; src: number; tgt: number; amount: number }
  | { k: 'death'; tick: number; tgt: number; src: number }
  /** Lord abilities, legendary procs, burns, chain-lightning segments etc. `pos` = centre / landing point, `radius` in cm. */
  | { k: 'ability'; tick: number; src: number; tgt: number; ability: AbilityEventKind; pos: Vec2; radius: number; dur: number }
  /** Keep takes damage. `seat` = the OWNER of the keep that was hit. `final` = remainder settled at battle end. */
  | { k: 'keepHit'; tick: number; seat: Seat; src: number; dmg: number; hpAfter: number; final: boolean }
  /** Keep visual stage: 0 intact, 1 (<75%), 2 (<50%), 3 (<25%), 4 destroyed. */
  | { k: 'keepStage'; tick: number; seat: Seat; stage: number }
  | { k: 'revive'; tick: number; tgt: number; hp: number; cause: 'undying_oath' | 'phoenix' }
  /** A new soldier (header row `tgt`) appears at pos. */
  | { k: 'summon'; tick: number; tgt: number; src: number; pos: Vec2 };

export type AbilityEventKind =
  | 'rally' | 'meteor' | 'bulwark' | 'skyfall'
  | 'chain' /* chain lightning segment src->tgt */ | 'burn' /* burn applied, dur in ticks */ | 'frost' /* slow applied */
  | 'ember_burst' | 'reflect' | 'stomp' | 'charge' | 'brace' | 'earthshaker' | 'bloodthirst' | 'sunfire' | 'lifebinder' | 'levelup';

export const EVENT_KINDS = ['attack', 'projectile', 'impact', 'hit', 'heal', 'death', 'ability', 'keepHit', 'keepStage', 'revive', 'summon'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A Keep (and its 2 arrow towers) on the map. */
export interface KeepInfo { seat: Seat; pos: Vec2; hpBefore: number; hpMax: number; towers: [Vec2, Vec2] }

/**
 * The wire replay. JSON-serialisable and compact:
 *  - `soldiers`: header rows (see ReplaySoldier).
 *  - `frames`: base64 of the keyframe stream. Decode with decodeReplay() (replay.ts). Frame f is at tick f * KEYFRAME_TICKS.
 *    Encoding: per frame, per soldier alive-or-spawned (index order), a flags byte (bit0 pos, bit1 facing, bit2 hp, bit3 anim,
 *    bit7 = run of unchanged soldiers, low 7 bits = run length) followed by zigzag-varint deltas for x, y (cm), facing (0..255,
 *    wrapped delta), hp (absolute varint) and anim (1 byte). Soldiers not yet spawned are skipped.
 *  - `events`: base64 of the event stream: per event a header byte (kind | tickDelta << 4, delta 15 = escape + varint),
 *    then the fields per EVENT_CODEC in replay.ts (varints, refs as v+1, positions delta-coded). decodeReplay() turns it
 *    into ReplayEvent[] — clients should never parse it by hand.
 */
export interface Replay {
  v: 2;
  seed: number;
  round: number;
  /** Total ticks in the replay (fighting + post-wipe march to the keep). */
  ticks: number;
  frameTicks: number;
  frameCount: number;
  soldiers: ReplaySoldier[];
  keeps: [KeepInfo, KeepInfo];
  terrain: Terrain;
  frames: string;
  events: string;
  eventCount: number;
  result: BattleResult;
}

/** Decoded replay for playback (decodeReplay). Typed arrays, frame-major: index = frame * soldierCount + soldier. */
export interface DecodedReplay {
  replay: Replay;
  soldierCount: number;
  frameCount: number;
  x: Int16Array;
  y: Int16Array;
  facing: Uint8Array;
  hp: Uint16Array;
  /** Index into ANIM_STATES. 255 = not spawned yet. */
  anim: Uint8Array;
  events: ReplayEvent[];
}

/** Output buffers for sampleReplay — allocate once with makeTransforms(n) and reuse every frame. */
export interface SoldierTransforms {
  count: number;
  /** cm, float (interpolated). */
  x: Float32Array;
  y: Float32Array;
  /** radians, interpolated along the shortest arc; 0 = +x, PI/2 = +y. */
  facing: Float32Array;
  hp: Float32Array;
  /** ANIM_STATES index of the nearest-earlier keyframe (255 = not spawned / hidden). */
  anim: Uint8Array;
  /** 1 if the soldier should be drawn. Dead soldiers stay visible (anim = dead) for the corpse. */
  visible: Uint8Array;
}

export interface BattleOutput { replay: Replay; result: BattleResult }
export interface SimulateOptions {
  /** Skip building the replay (tournament speed). `replay.frames`/`events` are then empty. Default true. */
  record?: boolean;
}

// ---------------------------------------------------------------- Bots

export type BotStrategy = 'rush' | 'ranged' | 'armor' | 'air' | 'counter' | 'random' | 'best';
