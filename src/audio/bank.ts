// The sound bank: every shipped clip (public/audio/*.webm, built by tools/audio/build.py from the
// recorded sources credited in docs/AUDIO.md) with its bus, mix gain, variation, voice limit and the
// phase group that loads it. Pure data + maths so tests can check it without WebAudio.

export type Bus = 'ui' | 'sfx' | 'amb';
/** Load groups, fetched by phase: 'boot' after the first gesture, 'planning' and 'battle' while planning, 'end' during battle. */
export type LoadGroup = 'boot' | 'planning' | 'battle' | 'end';

export interface SoundDef {
  /** Variant files (paths under public/audio/, no extension). One is chosen at random, never the same twice in a row. */
  files: string[];
  bus: Bus;
  /** Mix gain in dB on top of the file's normalised loudness. */
  db: number;
  /** Random pitch spread in semitones (±). */
  pitch?: number;
  /** Random volume spread in dB (±). */
  vary?: number;
  /** Max simultaneous voices of this sound (and of its `group`, if set). */
  limit?: number;
  /** Shared voice pool (e.g. all melee clashes). */
  group?: string;
  /** Minimum ms between two starts. */
  cooldown?: number;
  load: LoadGroup;
  loop?: boolean;
  /** Reverb send (0..1) at the listener; distant sounds get more. */
  wet?: number;
}

const v = (base: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${base}_${i + 1}`);

export const BANK = {
  // ---------------------------------------------------------------- interface
  click: { files: v('ui/click', 4), bus: 'ui', db: -4, pitch: 0.6, vary: 1, limit: 3, cooldown: 25, load: 'boot' },
  hover: { files: v('ui/hover', 3), bus: 'ui', db: -14, pitch: 0.8, vary: 1.5, limit: 2, cooldown: 55, load: 'boot' },
  pick: { files: v('ui/pick', 3), bus: 'ui', db: -3, pitch: 0.5, vary: 1, limit: 2, cooldown: 40, load: 'boot' },
  error: { files: v('ui/error', 2), bus: 'ui', db: -4, limit: 1, cooldown: 120, load: 'boot' },
  tick: { files: ['ui/tick'], bus: 'ui', db: -8, limit: 1, load: 'boot' },
  tickUrgent: { files: ['ui/tick_urgent'], bus: 'ui', db: -4, limit: 1, load: 'boot' },
  whoosh: { files: v('ui/whoosh', 2), bus: 'ui', db: -8, pitch: 0.8, limit: 1, cooldown: 150, load: 'boot' },
  deploy: { files: v('ui/deploy', 3), bus: 'ui', db: 0, pitch: 0.8, vary: 1, limit: 2, cooldown: 60, load: 'boot', wet: 0.15 },
  drop: { files: v('ui/drop', 2), bus: 'ui', db: -3, pitch: 0.8, limit: 2, cooldown: 50, load: 'boot' },
  coin: { files: [...v('ui/coin', 3), 'ui/coin_pouch'], bus: 'ui', db: -2, pitch: 0.7, vary: 1, limit: 2, cooldown: 60, load: 'boot' },
  equip: { files: v('ui/equip', 3), bus: 'ui', db: -1, pitch: 0.7, vary: 1, limit: 2, cooldown: 60, load: 'boot', wet: 0.1 },
  open: { files: ['ui/open'], bus: 'ui', db: -5, pitch: 0.5, limit: 1, cooldown: 100, load: 'boot' },
  page: { files: ['ui/page'], bus: 'ui', db: -6, pitch: 0.5, limit: 1, cooldown: 100, load: 'boot' },
  levelUp: { files: ['ui/levelup'], bus: 'ui', db: -2, limit: 1, cooldown: 200, load: 'boot', wet: 0.2 },
  ready: { files: ['ui/ready'], bus: 'ui', db: -2, limit: 1, cooldown: 300, load: 'boot', wet: 0.25 },
  draft: { files: ['ui/draft'], bus: 'ui', db: 0, limit: 1, cooldown: 1500, load: 'boot' },
  reveal: { files: ['sting/reveal'], bus: 'ui', db: -1, limit: 1, cooldown: 1500, load: 'boot', wet: 0.2 },
  // ---------------------------------------------------------------- loot (rarity stings)
  lootLand: { files: ['loot/land'], bus: 'ui', db: -2, pitch: 0.5, limit: 2, load: 'boot' },
  lootCommon: { files: ['loot/common'], bus: 'ui', db: -3, pitch: 0.5, limit: 2, load: 'boot' },
  lootMagic: { files: ['loot/magic'], bus: 'ui', db: -2, limit: 1, cooldown: 120, load: 'boot', wet: 0.2 },
  lootRare: { files: ['loot/rare'], bus: 'ui', db: -1, limit: 1, cooldown: 150, load: 'boot', wet: 0.25 },
  lootLegendary: { files: ['loot/legendary'], bus: 'ui', db: 1, limit: 1, cooldown: 400, load: 'boot', wet: 0.2 },
  // ---------------------------------------------------------------- ambience loops
  ambForest: { files: ['amb/forest'], bus: 'amb', db: -6, loop: true, load: 'planning' },
  ambWind: { files: ['amb/wind'], bus: 'amb', db: -10, loop: true, load: 'boot' },
  ambRiver: { files: ['amb/river'], bus: 'amb', db: -4, loop: true, load: 'planning' },
  ambBattle: { files: ['amb/battle'], bus: 'amb', db: -8, loop: true, load: 'battle' },
  // ---------------------------------------------------------------- battle: melee
  clash: { files: [...v('battle/clash', 8)], bus: 'sfx', db: -5, pitch: 1.2, vary: 2.5, limit: 5, group: 'melee', cooldown: 35, load: 'battle', wet: 0.15 },
  clashHeavy: { files: v('battle/clash_heavy', 5), bus: 'sfx', db: -4, pitch: 1.2, vary: 2.5, limit: 5, group: 'melee', cooldown: 35, load: 'battle', wet: 0.15 },
  fist: { files: v('battle/fist', 3), bus: 'sfx', db: -3, pitch: 1.5, vary: 2, limit: 2, cooldown: 90, load: 'battle' },
  bedSkirmish: { files: ['battle/bed_skirmish'], bus: 'sfx', db: -4, loop: true, load: 'battle' },
  bedMelee: { files: ['battle/bed_melee'], bus: 'sfx', db: -3, loop: true, load: 'battle' },
  grunt: { files: v('battle/grunt', 3), bus: 'sfx', db: -9, pitch: 1.5, vary: 3, limit: 2, cooldown: 350, load: 'battle', wet: 0.2 },
  death: { files: v('battle/death', 3), bus: 'sfx', db: -8, pitch: 1.5, vary: 2.5, limit: 3, cooldown: 70, load: 'battle' },
  wipe: { files: ['battle/wipe'], bus: 'sfx', db: -3, pitch: 0.8, limit: 2, cooldown: 500, load: 'battle', wet: 0.25 },
  // ---------------------------------------------------------------- battle: ranged & siege
  volleySmall: { files: v('battle/volley_small', 3), bus: 'sfx', db: -5, pitch: 1, vary: 1.5, limit: 3, group: 'volley', cooldown: 90, load: 'battle' },
  volleyLarge: { files: v('battle/volley_large', 3), bus: 'sfx', db: -3, pitch: 1, vary: 1.5, limit: 3, group: 'volley', cooldown: 90, load: 'battle' },
  arrowHit: { files: v('battle/arrowhit', 4), bus: 'sfx', db: -8, pitch: 1.2, vary: 2, limit: 3, cooldown: 80, load: 'battle' },
  ballista: { files: v('battle/ballista', 3), bus: 'sfx', db: -3, pitch: 1, vary: 1.5, limit: 2, cooldown: 100, load: 'battle' },
  treb: { files: v('battle/treb', 3), bus: 'sfx', db: -3, pitch: 1, vary: 1.5, limit: 2, cooldown: 150, load: 'battle' },
  stone: { files: v('battle/stone', 3), bus: 'sfx', db: -1, pitch: 1.2, vary: 1.5, limit: 3, cooldown: 90, load: 'battle', wet: 0.3 },
  // ---------------------------------------------------------------- battle: magic & monsters
  fireball: { files: v('battle/fireball', 3), bus: 'sfx', db: -6, pitch: 1, vary: 1.5, limit: 3, cooldown: 160, load: 'battle' },
  boom: { files: v('battle/boom', 3), bus: 'sfx', db: -4, pitch: 1.2, vary: 1.5, limit: 3, cooldown: 160, load: 'battle', wet: 0.3 },
  boomBig: { files: ['battle/boom_big'], bus: 'sfx', db: 0, pitch: 0.6, limit: 2, cooldown: 250, load: 'battle', wet: 0.3 },
  zap: { files: v('battle/zap', 3), bus: 'sfx', db: -5, pitch: 1.2, vary: 1.5, limit: 3, cooldown: 80, load: 'battle', wet: 0.2 },
  heal: { files: v('battle/heal', 2), bus: 'sfx', db: -9, pitch: 1, vary: 1.5, limit: 2, cooldown: 300, load: 'battle', wet: 0.3 },
  breath: { files: v('battle/breath', 2), bus: 'sfx', db: -2, pitch: 0.8, vary: 1, limit: 2, cooldown: 400, load: 'battle', wet: 0.2 },
  roar: { files: ['battle/roar_1', 'battle/roar_3', 'battle/roar_2'], bus: 'sfx', db: -1, pitch: 0.8, limit: 1, cooldown: 3500, load: 'battle', wet: 0.35 },
  screech: { files: ['battle/screech'], bus: 'sfx', db: -4, pitch: 1.2, limit: 1, cooldown: 3000, load: 'battle', wet: 0.3 },
  stomp: { files: v('battle/stomp', 2), bus: 'sfx', db: -2, pitch: 1, vary: 1.5, limit: 2, cooldown: 150, load: 'battle', wet: 0.2 },
  summon: { files: ['battle/summon'], bus: 'sfx', db: -4, pitch: 0.8, limit: 1, cooldown: 1500, load: 'battle', wet: 0.3 },
  cast: { files: ['battle/cast'], bus: 'sfx', db: -6, pitch: 1, limit: 2, cooldown: 200, load: 'battle' },
  // ---------------------------------------------------------------- battle: big moments
  keepHit: { files: v('battle/keephit', 3), bus: 'sfx', db: -2, pitch: 1, vary: 1.5, limit: 2, cooldown: 140, load: 'battle', wet: 0.3 },
  collapse: { files: v('battle/collapse', 2), bus: 'sfx', db: 1, pitch: 0.5, limit: 1, cooldown: 800, load: 'battle', wet: 0.35 },
  horn: { files: ['battle/horn'], bus: 'sfx', db: -1, limit: 1, cooldown: 2000, load: 'boot', wet: 0.3 },
  charge: { files: ['battle/charge', 'battle/warcry'], bus: 'sfx', db: -4, limit: 1, cooldown: 2000, load: 'battle', wet: 0.3 },
  meteor: { files: ['battle/meteor'], bus: 'sfx', db: 1, limit: 1, cooldown: 500, load: 'battle', wet: 0.3 },
  rally: { files: ['battle/rally'], bus: 'sfx', db: 0, limit: 1, cooldown: 500, load: 'battle', wet: 0.3 },
  bulwark: { files: ['battle/bulwark'], bus: 'sfx', db: -1, limit: 1, cooldown: 500, load: 'battle', wet: 0.3 },
  skyfall: { files: ['battle/skyfall'], bus: 'sfx', db: 1, limit: 1, cooldown: 500, load: 'battle', wet: 0.3 },
  roundWon: { files: ['sting/round_won'], bus: 'sfx', db: -3, limit: 1, cooldown: 1000, load: 'battle' },
  roundLost: { files: ['sting/round_lost'], bus: 'ui', db: -3, limit: 1, cooldown: 1000, load: 'battle', wet: 0.2 },
  victory: { files: ['sting/victory'], bus: 'ui', db: 0, limit: 1, cooldown: 2000, load: 'end' },
  defeat: { files: ['sting/defeat'], bus: 'ui', db: 0, limit: 1, cooldown: 2000, load: 'end' },
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof BANK;

/** Music tracks, streamed from <audio> elements (public/audio/music/*.webm). */
export const MUSIC = {
  menu: 'audio/music/menu.webm',
  planning: 'audio/music/planning.webm',
  battle_a: 'audio/music/battle_a.webm',
  battle_b: 'audio/music/battle_b.webm',
} as const;
export type MusicId = keyof typeof MUSIC;

/** Every file the bank references (tests check each exists). */
export function bankFiles(): string[] {
  const s = new Set<string>();
  for (const d of Object.values(BANK) as SoundDef[]) for (const f of d.files) s.add(`${f}.webm`);
  return [...s];
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/**
 * Distance attenuation for a battle sound `d` metres (ground plane) from the camera focus, with the
 * camera `camDist` metres away. Sounds inside the framed area play full; beyond it they fall off
 * smoothly to a floor, so the whole battle stays audible as a bed but the focus reads clearly.
 */
export function attenuate(d: number, camDist: number): number {
  const inner = Math.max(12, camDist * 0.35);
  const fall = Math.max(10, camDist * 0.6);
  const g = 1 / (1 + Math.max(0, d - inner) / fall);
  return Math.max(0.06, g * g);
}

/** Low-pass cutoff (Hz) for an attenuation gain: distant sounds lose their top end. */
export function distanceCutoff(g: number): number {
  return g >= 0.7 ? 20000 : Math.max(900, 20000 * Math.pow(g / 0.7, 1.6));
}

/** Smoothstep 0..1 between edges (bed fades by contact count). */
export function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
