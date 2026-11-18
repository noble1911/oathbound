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

/** The three playable factions. Both players may pick any of them (also the same one); a Lord belongs to one faction. */
export type FactionId = 'kingdom' | 'ashen' | 'caliphate';

/**
 * Four per faction, one in each role (infantry, magic, armour, fliers). Kingdom: marshal, archmage, warden, skylady.
 * Ashen Covenant: deathknight, lich, ossuary, drakerider. Sun Caliphate: sultana, vizier, rajah, rocrider.
 */
export type LordId =
  | 'marshal' | 'archmage' | 'warden' | 'skylady' | 'lich' | 'sultana'
  | 'deathknight' | 'ossuary' | 'drakerider' | 'vizier' | 'rajah' | 'rocrider';

/** The Oathsworn Kingdom's 14 units. */
export type KingdomUnit =
  | 'militia' | 'pikemen' | 'berserkers' | 'archers' | 'knights' | 'cavaliers' | 'mages'
  | 'clerics' | 'pegasus' | 'ballista' | 'trebuchet' | 'golem' | 'wyvern' | 'dragon';
/** The Ashen Covenant (undead). 'skeleton' is also the model of skeletons raised in battle. */
export type AshenUnit = 'skeleton' | 'grave_knight' | 'bone_archer' | 'wraith_rider' | 'grave_acolyte' | 'bone_drake' | 'corpse_catapult' | 'bone_golem';
/** The Sun Caliphate (desert empire). */
export type CaliphateUnit = 'spear_levy' | 'scimitar' | 'camel_archer' | 'mamluk' | 'djinn_binder' | 'sun_priest' | 'djinn' | 'war_elephant' | 'sand_golem' | 'sun_mirror';
/** Every deployable unit type of every faction. The id is also the renderer model id. */
export type UnitType = KingdomUnit | AshenUnit | CaliphateUnit;

/** A squad is either one of the 14 unit types or the player's Lord (a 1-soldier squad). */
export type SquadType = UnitType | 'lord';
/**
 * A soldier's type in a replay. Skeletons raised in battle (Gravebloom, Grave Acolytes, the Lich-Priest) are type
 * 'skeleton' with `summoned` set; they exist only inside a battle, never in MatchState.
 */
export type SoldierType = SquadType;

export type Tag = 'mounted' | 'armored' | 'flier' | 'large' | 'infantry';
export type WeaponKind = 'sword' | 'axe' | 'lance' | 'bow' | 'tome' | 'staff' | 'bolt' | 'stone' | 'fists' | 'breath' | 'beam';
export type DamageType = 'physical' | 'magic';
/**
 * The counter wheel (DESIGN §3): every unit and every Lord belongs to exactly one class, and each class beats the next
 * one around the ring, dealing COUNTER_PCT% damage to it: Swarm > Giant > Line > Cavalry > Ranged > Air > Siege > Magic
 * > Swarm. WHEEL (data/wheel.ts) holds the ring order.
 */
export type WheelClass = 'swarm' | 'giant' | 'line' | 'cavalry' | 'ranged' | 'air' | 'siege' | 'magic';
/** What flies through the air. 'none' = melee swing (no projectile). */
export type ProjectileKind = 'none' | 'arrow' | 'bolt' | 'stone' | 'fireball' | 'firebreath' | 'lightning' | 'tower_arrow' | 'sunbeam';
/** Flight path for the renderer: 'arc' = ballistic parabola (arrows, stones), 'line' = straight (bolts, fireballs, breath). */
export type ArcType = 'line' | 'arc' | 'high_arc';

export interface UnitDef {
  id: UnitType;
  /** The faction that fields this unit (a player only ever unlocks units of their own faction). */
  faction: FactionId;
  /**
   * The Kingdom unit this one plays like (its role and counters); the Kingdom's own units name themselves.
   * Bots and tools use it so that every faction's roster is understood through one counter table.
   */
  like: KingdomUnit;
  /** Round-1 unit: may be unlocked from round 1 (others from round 2, or their minRound). */
  basic: boolean;
  /** Its class on the counter wheel. */
  class: WheelClass;
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
  /** Soldier body radius in cm (separation / melee reach). */
  radius: number;
  /** Heal per cast (clerics); 0 otherwise. */
  heal: number;
  /** Lifesteal percent of damage dealt. */
  lifesteal: number;
  /** Innate damage over time: attacks burn / plague for this many HP per second over 3 s (0 = none). */
  burn: number;
  /** Innate slow: attacks slow the target by this percent for 2 s (0 = none). */
  slow: number;
  /** Innate regeneration: tenths of a percent of maximum life per second (15 = 1.5%/s; 0 = none). */
  regen: number;
  /** Special rules, see data/units.ts. */
  traits: UnitTrait[];
  /** Earliest round in which the unit may be offered in the unlock draft. */
  minRound: number;
  /** Short role text for UI. */
  role: string;
}
export type UnitTrait =
  | 'brace' | 'charge' | 'pierce' | 'stomp' | 'cone' | 'slowTurn' | 'healer' | 'ignoresArmor' | 'crushing' | 'backline' | 'raider'
  /** raise: raises fallen soldiers as skeletons (Grave Acolytes). bless: its heals also quicken the target (Sun Priests). howdah: a melee unit that can also strike fliers (War Elephant). */
  | 'raise' | 'bless' | 'howdah';

export interface LordDef {
  id: LordId;
  faction: FactionId;
  name: string;
  title: string;
  modelId: string;
  weapon: WeaponKind;
  damageType: DamageType;
  projectile: ProjectileKind;
  signature: [UnitType, UnitType];
  /** Its class on the counter wheel: the class of its body or mount. */
  class: WheelClass;
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
export type AbilityId =
  | 'rally' | 'meteor' | 'bulwark' | 'skyfall' | 'necromancy' | 'radiance'
  | 'soul_reap' | 'grave_taunt' | 'plague_breath' | 'whirlwind' | 'stampede' | 'talon';

export interface FactionDef {
  id: FactionId;
  name: string;
  /** One word for tight UI: 'Kingdom', 'Covenant', 'Caliphate'. */
  short: string;
  /** One line of flavour, and what makes the faction play differently. */
  blurb: string;
  identity: string;
  /** Palette hint for the UI (hex): primary, secondary, accent. */
  colors: [string, string, string];
  lords: LordId[];
  /** The whole roster, cheapest role first. */
  units: UnitType[];
  /** Units that may be unlocked in round 1. */
  basic: UnitType[];
}

// ---------------------------------------------------------------- Items / loot

export type Slot = 'weapon' | 'armor' | 'relic';
export type Rarity = 'common' | 'magic' | 'rare' | 'legendary';
export type BaseId =
  | 'steel_blade' | 'ironbark_bow' | 'war_axe' | 'ash_spear' | 'grimoire'
  | 'mail_hauberk' | 'warded_robe' | 'plate_cuirass' | 'leather_jerkin'
  | 'bone_charm' | 'sun_medallion' | 'oath_ring' | 'war_banner';
export type AffixId =
  | 'keen' | 'vicious' | 'haste' | 'leech' | 'stalwart' | 'warding' | 'fleet' | 'thorns'
  | 'slaying' | 'embers' | 'frost' | 'farreach' | 'phoenix' | 'command' | 'plated' | 'marching';
export type LegendaryId =
  | 'stormcaller' | 'kingsbane' | 'undying_oath' | 'ember_crown' | 'mirror_aegis' | 'warhorn'
  | 'gravebloom' | 'bloodthirst' | 'earthshaker' | 'frostheart' | 'lifebinder' | 'hydra_volley'
  | 'windrunner' | 'sunfire';

/**
 * Unit classes gate skill items ("knights do not cast fireballs"). Every unit type has exactly one class
 * (UNIT_CLASS in data/skills.ts); a Lord has 'lord' plus the class of its fighting style (squadClasses).
 */
export type UnitClass = 'caster' | 'infantry' | 'ranged' | 'mounted' | 'flier' | 'siege' | 'giant' | 'lord';
/** Active skills granted by items (data/skills.ts). The squad auto-casts them in battle. */
export type SkillId =
  | 'fireball' | 'chain_lightning' | 'frost_nova' | 'mending_light'
  | 'shield_wall' | 'war_cry' | 'cleave'
  | 'fire_arrows' | 'pinning_shot' | 'rain_of_arrows'
  | 'thunderous_charge' | 'trample' | 'dive_strike' | 'incendiary_payload';

/**
 * One entry of a skill list (unitSkills / lordSkills / squadSkills): innate traits, the Lord's passive and
 * ability, legendary powers and item-granted skills, with tooltip text that uses the real numbers.
 */
export interface SkillInfo {
  /** Stable id: a trait-like key for innates ('brace', 'anti_flier', ...), the AbilityId, LegendaryId or SkillId. */
  id: string;
  name: string;
  kind: 'passive' | 'active';
  text: string;
  /** Seconds between casts (actives only). */
  cooldown?: number;
  source: 'innate' | 'lord' | 'item';
  /** For source 'item': the id of the item that grants it. */
  item?: number;
  /** Set for item-granted actives: the SkillId, as it appears in 'skill' replay events and SquadStats.skills. */
  skill?: SkillId;
}

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
  /**
   * Active skill this item grants (absent / null = none). A skill item can only be equipped on a squad whose
   * class is in SKILLS[skill].classes (applyIntent refuses otherwise; see canEquip).
   */
  skill?: SkillId | null;
}
export interface ItemSlots { weapon: Item | null; armor: Item | null; relic: Item | null }

/** One tooltip line. `style` drives colour in the UI: name uses the rarity colour, legendary lines are orange. */
export interface ItemLine {
  text: string;
  style: 'name' | 'base' | 'implicit' | 'affix' | 'legendary' | 'flavor' | 'meta';
  /**
   * Finer role for the skill block of a skill item (the `style` stays one of the classic seven so older UIs
   * render it): 'skill' = "Grants Fireball (10 s cooldown)", 'skillText' = what it does, 'usable' = "Usable by: Casters".
   */
  kind?: 'skill' | 'skillText' | 'usable';
}

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
  /**
   * @deprecated Squads no longer turn: every squad faces the enemy (64 for seat 0, 192 for seat 1), and the sim never
   * reads this. Kept so older clients and saved states still type-check; the formation choice replaced it.
   */
  facing: number;
  /** Wide (the default; absent) or deep: see Formation. Only squads of FORMATION_MIN_SIZE or more soldiers have the choice. */
  formation?: Formation;
  items: ItemSlots;
  /** Round in which it was deployed (0 = the Lord). Until that round's battle it may be moved and sold back freely; afterwards it is locked in place and refunds nothing. */
  deployedRound: number;
  /** Gold spent on this squad (deploy + level-ups); used for selling and stats. */
  spent: number;
  /** The Lord squad only: how the Lord behaves in the coming battle (absent = 'advance'). See LordStance. */
  stance?: LordStance;
}

/**
 * The Lord's orders for the battle, chosen in planning ({t:'stance'}) and kept from round to round (DESIGN §4):
 *  - 'advance' (the default): he marches on the nearest enemy squad like any squad.
 *  - 'hold': he waits on the spot he was placed on until an enemy soldier comes within HOLD_WATCH (25 m) of it, or
 *    until no other squad of his army is left; from then on he advances. While he waits he strikes only what is in reach.
 *  - 'follow': he stays FOLLOW_BEHIND (6 m) behind own squad `squad` (towards his own Keep) and leaves that spot only
 *    for enemies within HOLD_LEASH of it (14 m; a ranged Lord: his range + 3 m). When the squad falls he advances.
 * It lives on the Lord's Squad, so the enemy sees it exactly like positions: as it was in the last battle
 * (EnemyView.lastArmy), never this round's.
 */
/**
 * A squad's formation for the battle, chosen in planning ({t:'formation'}, or on deploy) and kept from round to round
 * (DESIGN §3). Free at any time, also for a squad that is locked in place: it changes how the squad stands, not where.
 *  - 'wide' (the default): a line, one to three ranks deep. Every soldier reaches the enemy at once, and a line is thin:
 *    a splash catches few of them.
 *  - 'deep': a column, one to four files wide. It marches DEEP_SPEED_PCT faster and its ranks brace each other
 *    (DEEP_GUARD_PCT less damage from melee blows), but it is packed: a splash catches most of it, and only its head
 *    fights at first.
 * Squads of one or two soldiers (and the Lord) have no formation. Like positions, the enemy sees it as it was in the
 * last battle (EnemyView.lastArmy).
 */
export type Formation = 'wide' | 'deep';

export type LordStance = { t: 'advance' } | { t: 'hold' } | { t: 'follow'; squad: number };
export type LordStanceKind = LordStance['t'];

export interface PlayerState {
  seat: Seat;
  /** Chosen with {t:'pickFaction'} during the Lord pick, or implied by the Lord picked. Null until then. */
  faction: FactionId | null;
  lord: LordId | null;
  gold: number;
  keepHp: number;
  keepMax: number;
  /** Unit types this player may deploy. */
  unlocked: UnitType[];
  /**
   * Pending unlock choice: pick `draftPicks` of these with {t:'draft'}. Empty when nothing to pick. Not random: it is
   * the full list of units the player may unlock this round, pick 1 (round 1: the basic pool; later: every locked
   * unit whose minRound has come), the same rule for both players.
   */
  draftOptions: UnitType[];
  draftPicks: number;
  /** Pending loot choice: one item per slot (plus a fourth for Skylady). Both players are offered the same items. Null when nothing to pick. */
  lootOffer: Item[] | null;
  /** Your army. The Lord squad (type 'lord') is always squads[0] once a Lord is picked. */
  squads: Squad[];
  /** Unequipped items. */
  stash: Item[];
  /** Deploy points used this planning phase: the sum of the deploy weights (deployWeight: 1, 2 or 3) of
   *  the squads deployed this round (the Lord costs nothing). */
  deploysUsed: number;
  /** Deploy points allowed this round: DEPLOY_BUDGET (4), +2 for the Marshal and +2 per
   *  'of Command' relic (at most +4). */
  deployLimit: number;
  lordXp: number;
  ready: boolean;
  /** Did this player lose the last battle? (Informational only: losing brings no gold and no better loot.) */
  lostLast: boolean;
  /** The army as it fought last battle — the only thing the opponent sees during planning. */
  lastArmy: Squad[] | null;
  /**
   * Relocation (DESIGN §2). Squads deployed in an earlier round are locked in place; `moveLimit` is how many of them
   * may be relocated this round: one per 'of the March' relic worn when the round began (at most MARCH_CAP), plus
   * MUSTER_MOVES once Muster is taken. Optional on states saved before the rule.
   */
  moveLimit?: number;
  /** May this player still take Muster this round ({t:'muster'}) instead of the round's unit unlock? */
  musterOffer?: boolean;
  /** Was Muster taken this round? */
  muster?: boolean;
  /**
   * Ids of the squads in `lastArmy` that stood somewhere else in the battle before it (the Lord included; squads new
   * in that battle are not "moved"). Public: the opponent watched both battles. Shown as intel on the enemy ghosts.
   */
  lastMoved?: number[];
  /** Always zeros: there is no comeback bonus (both players face identical conditions). Kept so older UIs keep working. */
  comeback: Comeback;
}

export interface Comeback {
  gold: number;
  deploys: number;
  /** Your keep-HP deficit in percentage points after the battle (0 = not behind). */
  deficit: number;
}

/**
 * How a battle ended.
 *  - 'wipe': one army was destroyed (the other side won and marched on the keep).
 *  - 'mutualWipe': both armies were destroyed on the same tick (a draw).
 *  - 'timeout': 90 s passed with both armies standing; the round is decided on points.
 *  - 'stalemate': ended early because neither side could damage the other (nothing able to target the
 *    remaining enemies, or no damage dealt for 15 s); decided on points like a timeout.
 */
export type BattleEnd = 'wipe' | 'mutualWipe' | 'timeout' | 'stalemate';
/** A round from one seat's point of view. */
export type RoundOutcome = 'won' | 'lost' | 'draw';

export interface RoundSummary {
  round: number;
  /** The round winner (on points for timeouts / stalemates). null = a draw: no catch-up for anyone. */
  winner: Seat | null;
  keepDamage: [number, number]; // damage dealt TO seat 0's and seat 1's keep
  survivors: [number, number]; // surviving squads per seat
  ticks: number;
  end: BattleEnd;
  /** Points per seat: percent (0..100) of the army's value still standing at the end (see BattleResult.score). */
  score: [number, number];
  /** Stalemates only: BattleResult.helpless (which army could no longer harm the other). */
  helpless?: [boolean, boolean];
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
  /** Why the match ended: 'keep' (a keep fell), 'rounds' (the round limit) or 'concede' (a player gave up; see concede in match.ts). */
  overReason?: 'keep' | 'rounds' | 'concede';
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
  /** Set when phase = 'over': 'keep' (a keep fell), 'rounds' (round limit) or 'concede' (the loser gave up). */
  overReason?: 'keep' | 'rounds' | 'concede';
  history: RoundSummary[];
  you: PlayerState | null;
  /** Spectator: both players' public info. */
  enemy: EnemyView;
  enemies?: [EnemyView, EnemyView];
}
export interface EnemyView {
  seat: Seat;
  /** Hidden (null) during the Lord pick, like the Lord. */
  faction: FactionId | null;
  lord: LordId | null;
  keepHp: number;
  keepMax: number;
  ready: boolean;
  /** The army exactly as it fought last round (positions, levels, items). Null in round 1. */
  lastArmy: Squad[] | null;
  /**
   * Intel: ids of the squads in `lastArmy` that had moved since the battle before it (PlayerState.lastMoved). Both
   * battles were public, so this tells nothing the viewer could not have seen. Empty in rounds 1 and 2. Optional
   * for views recorded before the rule.
   */
  lastMoved?: number[];
  // Gold, stash, unlocks, current squads/levels/items and loot are hidden.
}

// ---------------------------------------------------------------- Intents

export type Intent =
  /**
   * Lord-pick phase, optional: choose a faction first (may be changed until the Lord is picked). The Lord picked
   * afterwards must belong to it. A client may skip this and send pickLord alone: the Lord implies the faction.
   */
  | { t: 'pickFaction'; faction: FactionId }
  | { t: 'pickLord'; lord: LordId }
  | { t: 'draft'; unit: UnitType }
  /**
   * Muster: taken INSTEAD of this round's unit unlock. Lets the player relocate up to MUSTER_MOVES squads deployed in
   * earlier rounds, this round only. Refused once the round's unlock is spent (or in round 1: nothing is locked yet).
   */
  | { t: 'muster' }
  | { t: 'deploy'; unit: UnitType; pos: Vec2; formation?: Formation; /** @deprecated ignored */ facing?: number }
  /**
   * Move a squad. The Lord and squads deployed this round move freely. A squad from an earlier round is locked unless
   * a relocation is left this round (PlayerState.moveLimit; see relocationsLeft in match.ts). Moving it back to where
   * it stood gives the move back.
   */
  | { t: 'move'; squad: number; pos: Vec2; /** @deprecated ignored */ facing?: number }
  /** Set a squad's formation (Formation). Free, any number of times, also for a locked squad. Refused for the Lord and for squads of one or two. */
  | { t: 'formation'; squad: number; formation: Formation }
  /**
   * The Lord's battle stance (LordStance): 'advance', 'hold', or 'follow' with the id of an own squad (not the Lord).
   * Free, any number of times while planning. Selling the followed squad puts him back on 'advance'.
   */
  | { t: 'stance'; stance: LordStanceKind; squad?: number }
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
  /**
   * The round winner. A wipe is won by the side left standing; a timeout or stalemate is won on points
   * (`score`, at least POINTS_MARGIN ahead). null = a draw (mutual wipe, or points within the margin).
   */
  winner: Seat | null;
  /** Both armies were still standing when the battle ended (end = 'timeout' or 'stalemate'). */
  timeout: boolean;
  end: BattleEnd;
  /**
   * Points per seat at the end of the battle: the percent (0..100) of the army's value still standing, each squad
   * weighted by its value (cost x level; the Lord 300) times the share of its soldiers' HP left.
   */
  score: [number, number];
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
  /** Damage dealt by each seat's Lord (attacks, ability, item skills), in HP like damageDealt. */
  lordDamage?: [number, number];
  /**
   * Stalemates only: per seat, whether that army could no longer damage the other when the battle was called (nothing
   * left that could reach what the enemy had standing). Both false = both could, but no blow had landed for a while.
   * Exactly one true: that side lost the round, whatever the points (battle.ts endOnPoints); otherwise the stalemate
   * was decided on points. The wording reads it too (stalemateCause, stalemateField).
   */
  helpless?: [boolean, boolean];
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
  /** Item-granted skills of the soldier's squad (casts appear as 'skill' events). */
  skills?: SkillId[];
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

/**
 * Skill casts and the statistics ledger travel in the same binary event stream but are decoded into their own
 * lists (DecodedReplay.skills / DecodedReplay.tallies), so `ReplayEvent` and DecodedReplay.events keep exactly the
 * classic eleven kinds for existing consumers.
 */
export type SkillEvent =
  /**
   * A squad casts an item skill. `src` = the casting soldier (the squad's leader), `squad` / `tgtSquad` = rows of
   * Replay.squads (tgtSquad -1 = none), `tgt` = the soldier aimed at (-1 = none), `pos` = the target point (cm),
   * `radius` = area of effect in cm (0 = single target / the caster's own squad) and `dur` = how long the effect
   * lasts in ticks (buffs, burning ground, the delay before a strike lands; 0 = instant). The damage, heals and
   * knockbacks it causes follow as ordinary 'hit' / 'heal' / 'projectile' / 'ability' events, and are totalled per
   * skill in the 'tally' stream.
   */
  { k: 'skill'; tick: number; src: number; squad: number; skill: SkillId; tgt: number; tgtSquad: number; pos: Vec2; radius: number; dur: number };
export type TallyEvent =
  /**
   * The statistics ledger: everything squad row `src` did to squad row `tgt` through `cause` during the
   * TALLY_TICKS ticks ending at `tick`, in centi-HP (100 = 1 HP). `dmg` is life actually removed (overkill is not
   * counted), `mit` the damage the target's armour / resistance / shields absorbed, `heal` life actually restored,
   * `n` the number of damaging hits. `src` is a row of Replay.squads, -1 (nobody) or a keep id (>= KEEP_SRC_BASE:
   * the arrow towers). Use squadStatsAt (stats.ts) instead of reading these by hand.
   */
  { k: 'tally'; tick: number; src: number; tgt: number; cause: StatCause; dmg: number; mit: number; heal: number; n: number };

/** What a ledger entry is attributed to: plain attacks, damage-over-time and procs, Lord abilities, heals, or an item skill. */
export type StatCause =
  | 'attack' | 'burn' | 'thorns' | 'tower' | 'chain' | 'ember_burst' | 'sunfire' | 'meteor' | 'skyfall'
  | 'heal' | 'leech' | 'lifebinder' | 'bloodthirst' | 'revive' | 'rout' | 'radiance' | 'regen' | SkillId
  | 'soul_reap' | 'plague_breath' | 'whirlwind' | 'stampede' | 'talon';

/** One squad of the battle (header row). Row index = position in Replay.squads; summoned skeleton bands get their own row. */
export interface ReplaySquad {
  row: number;
  /** MatchState squad id (skeleton bands: the id of the squad that raised them). */
  id: number;
  side: Seat;
  type: SoldierType;
  lord?: LordId;
  level: number;
  summoned: boolean;
  /** Indices into Replay.soldiers. */
  soldiers: number[];
  /** Item-granted skills. */
  skills: SkillId[];
  /** The Lord of the squad's owner (for the Lord's passive in replaySquadSheet). */
  ownerLord?: LordId | null;
  /** The squad's items in full (both armies are public once the battle starts), for the inspector. Absent on skeleton bands. */
  items?: ItemSlots;
}

export type AbilityEventKind =
  | 'rally' | 'meteor' | 'bulwark' | 'skyfall' | 'necromancy' | 'radiance'
  /**
   * The six newer Lord abilities. Each has one event from the Lord (`src`) at cast time: 'soul_reap' and 'grave_taunt'
   * at the Lord (radius = reach, dur = ticks); 'plague_breath' and 'whirlwind' at the impact point (dur = ticks until it
   * lands / lasts); 'stampede' at the end of the charge (radius = trample width); 'talon' at the drop point, `tgt` = the
   * soldier seized. A taunted soldier also gets a 'grave_taunt' event with `tgt` = it and radius 0.
   */
  | 'soul_reap' | 'grave_taunt' | 'plague_breath' | 'whirlwind' | 'stampede' | 'talon'
  | 'chain' /* chain lightning segment src->tgt */
  /**
   * Debuff windows, one event when the debuff STARTS on soldier `tgt` (refreshes are not repeated), `src` = the soldier
   * that applied it, `dur` = ticks it lasts: 'burn' = a burn or the Corpse Catapult's plague (3 s; its damage ticks
   * are not events, they are in the ledger under cause 'burn' or the skill that lit it), 'frost' = a slow.
   * A burn or slow kept alive by refreshes gets a follow-up event the tick the previous window ends, `dur` = what is
   * left of it then, so the windows chain without overlapping for as long as the debuff lasts.
   * A Sun Priest's blessing is a 'war_cry' event with `tgt` = the blessed soldier and radius 0.
   */
  | 'burn' | 'frost'
  | 'ember_burst' | 'reflect' | 'stomp' | 'charge' | 'brace' | 'earthshaker' | 'bloodthirst' | 'sunfire' | 'lifebinder' | 'levelup'
  /** Skill effects on one soldier `tgt`: thrown to `pos` (knockback), or buffed for `dur` ticks. */
  | 'knockback' | 'shield_wall' | 'war_cry' | 'cleave';

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
 *    into ReplayEvent[] (plus SkillEvent[] and TallyEvent[]) — clients should never parse it by hand.
 */
export interface Replay {
  /** Wire version (REPLAY_VERSION). 3 added `squads` and the 'skill' and 'tally' events; decodeReplay rejects other versions. */
  v: 3;
  seed: number;
  round: number;
  /** Total ticks in the replay (fighting + post-wipe march to the keep). */
  ticks: number;
  frameTicks: number;
  frameCount: number;
  soldiers: ReplaySoldier[];
  /** One row per squad (and per summoned band), referenced by 'skill' and 'tally' events. */
  squads: ReplaySquad[];
  keeps: [KeepInfo, KeepInfo];
  terrain: Terrain;
  frames: string;
  events: string;
  /** Number of classic events (DecodedReplay.events.length); skill casts and ledger entries are not counted. */
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
  /** Item-skill casts, tick-ordered. (Optional only so hand-built test replays stay valid; decodeReplay always sets it.) */
  skills?: SkillEvent[];
  /** The statistics ledger, tick-ordered (one window every TALLY_TICKS). Read it through squadStatsAt. */
  tallies?: TallyEvent[];
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

/**
 * Tournament strategies plus the three vs-AI difficulties: 'easy', 'normal', 'hard' ('best' = 'hard').
 * 'counter' is the plain counter-picker the 'normal' level builds on.
 */
export type BotStrategy = 'rush' | 'ranged' | 'armor' | 'air' | 'counter' | 'random' | 'best' | 'easy' | 'normal' | 'hard'
  /** Experimental, for strength tests only (tools/tournament.ts): Hard with the other counter table. Not offered to players. */
  | 'hardx';
