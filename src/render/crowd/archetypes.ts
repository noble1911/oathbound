// Visual archetypes: which model + playback parameters each replay soldier uses. Keyed by the
// replay's `modelId` (unit id, lord_<id>, skeleton), falling back to `type`. Crowd archetypes are
// VAT-instanced; heroes (Lords, Large units, siege) are individual skinned meshes with a mixer.
import type { ModelBuild, HumanLook } from './models.ts';
import { buildHumanoid, buildHorse, buildGolem, buildDragon, buildBallista, buildTrebuchet } from './models.ts';

export const TEAM_COLORS: [string, string] = ['#3b6fd8', '#d8453b'];

export interface Archetype {
  key: string;
  render: 'crowd' | 'hero';
  /** Procedural stand-in (used when the art manifest has no model). */
  build: () => ModelBuild;
  /** Ground speed (m/s) at which the 'move' clip plays at rate 1; 'run' likewise. */
  walkSpeed: number;
  runSpeed: number;
  /** Above this speed the run clip is used. */
  runAbove: number;
  /** Fliers cruise at this height (m). */
  flyHeight: number;
  /** Height (m) projectiles leave from / impacts aim at. */
  muzzle: number;
  chest: number;
  scale: number;
  /** Seconds of the attack clip until the blow lands / the shot leaves. */
  attackImpact: number;
  /** Marching dust amount (0 = none). */
  dust: number;
}

const SKIN = ['#e2b48f', '#c99470', '#f0c9a6'];
const base = (o: Partial<HumanLook>): HumanLook => ({
  skin: SKIN[0], cloth: '#e4e1da', trim: '#c7a350', metal: '#9aa3ad', leather: '#5a4030',
  body: 'tunic', helmet: 'cap', weapon: 'sword', shield: null, ...o,
});

const looks: Record<string, HumanLook> = {
  militia: base({ helmet: 'cap', weapon: 'sword', shield: 'round', metal: '#8f969e' }),
  pikemen: base({ helmet: 'cap', weapon: 'pike', metal: '#a4abb4', skin: SKIN[1] }),
  berserkers: base({ body: 'bare', helmet: 'horned', weapon: 'axe2h', skin: SKIN[2], bulk: 1.12, leather: '#4a3426' }),
  archers: base({ helmet: 'hood', weapon: 'bow', quiver: true, leather: '#5e4430', cloth: '#dcd9cc' }),
  knights: base({ body: 'plate', helmet: 'greathelm', weapon: 'lance', shield: 'kite', metal: '#b9c1cb', bulk: 1.22, trim: '#d8b45a' }),
  mages: base({ body: 'robe', helmet: 'hat', weapon: 'staff', glow: '#ff7a2a', glowStrength: 7, trim: '#d8b45a' }),
  clerics: base({ body: 'robe', helmet: 'none', weapon: 'staff', glow: '#ffe9a0', glowStrength: 6, cloth: '#f2efe6', trim: '#d8b45a', skin: SKIN[2] }),
  skeleton: base({ body: 'bones', helmet: 'skull', weapon: 'sword', shield: 'round', metal: '#7d776b', cloth: '#8a8478' }),
  lord_marshal: base({ body: 'plate', helmet: 'crown', weapon: 'sword', shield: 'kite', cape: true, metal: '#d0d6de', trim: '#e6b84a', glowStrength: 3, bulk: 1.1 }),
  lord_archmage: base({ body: 'robe', helmet: 'crown', weapon: 'staff', cape: true, glow: '#ff5a1f', glowStrength: 10, trim: '#e6b84a', skin: SKIN[1] }),
  lord_warden: base({ body: 'plate', helmet: 'horned', weapon: 'axe2h', cape: true, metal: '#a7aeb6', bulk: 1.25, trim: '#e6b84a', skin: SKIN[2] }),
  lord_skylady: base({ body: 'plate', helmet: 'crown', weapon: 'lance', shield: 'round', cape: true, metal: '#e2e6ec', trim: '#e6b84a' }),
};

function human(key: string, render: 'crowd' | 'hero', o: Partial<Archetype> = {}, scale = 1): Archetype {
  return {
    key, render, build: () => buildHumanoid(key, looks[key], scale),
    walkSpeed: 1.5 * scale, runSpeed: 4.2 * scale, runAbove: 2.6, flyHeight: 0, muzzle: 1.45 * scale, chest: 1.25 * scale,
    scale: 1, attackImpact: 0.4, dust: 0.25, ...o,
  };
}

const riderLook = (o: Partial<HumanLook>): HumanLook => base({ body: 'plate', helmet: 'greathelm', metal: '#b9c1cb', ...o });

export const ARCHETYPES: Record<string, Archetype> = {
  militia: human('militia', 'crowd'),
  // skirted/robed squads have short rigged legs: their walk clip covers ~0.8 m/s (see docs/art-review/PILOT.md)
  pikemen: human('pikemen', 'crowd', { walkSpeed: 0.9, runAbove: 2.0 }),
  berserkers: human('berserkers', 'crowd', { attackImpact: 0.42 }),
  archers: human('archers', 'crowd', { attackImpact: 0.64 }),
  knights: human('knights', 'crowd', { walkSpeed: 0.9, runAbove: 2.0, dust: 0.35 }),
  mages: human('mages', 'crowd', { walkSpeed: 0.9, runAbove: 2.0, attackImpact: 0.45, muzzle: 2.0 }),
  clerics: human('clerics', 'crowd', { walkSpeed: 0.9, runAbove: 2.0, attackImpact: 0.5, muzzle: 2.0 }),
  skeleton: human('skeleton', 'crowd', { dust: 0.1 }),
  cavaliers: {
    key: 'cavaliers', render: 'crowd',
    build: () => buildHorse('cavaliers', { coat: '#6b4a32', mane: '#2a1f18', barding: '#e4e1da', rider: riderLook({ weapon: 'sword', shield: 'round', cape: true }) }),
    walkSpeed: 2.2, runSpeed: 7, runAbove: 3.5, flyHeight: 0, muzzle: 2.0, chest: 1.6, scale: 1, attackImpact: 0.4, dust: 0.8,
  },
  pegasus: {
    key: 'pegasus', render: 'crowd',
    build: () => buildHorse('pegasus', { coat: '#f3f1ec', mane: '#d8d4cc', barding: '#e4e1da', wings: true, rider: riderLook({ weapon: 'lance', helmet: 'greathelm', metal: '#dfe3e8' }) }),
    walkSpeed: 3, runSpeed: 6, runAbove: 4, flyHeight: 6.5, muzzle: 2.0, chest: 1.6, scale: 1, attackImpact: 0.4, dust: 0,
  },
  lord_marshal: human('lord_marshal', 'hero', { dust: 0.3 }, 1.22),
  lord_archmage: human('lord_archmage', 'hero', { attackImpact: 0.45, muzzle: 2.4 }, 1.22),
  lord_warden: human('lord_warden', 'hero', { dust: 0.3 }, 1.25),
  lord_skylady: human('lord_skylady', 'hero', {}, 1.22),
  golem: {
    key: 'golem', render: 'hero', build: () => buildGolem('golem'),
    walkSpeed: 1.6, runSpeed: 3, runAbove: 99, flyHeight: 0, muzzle: 3.0, chest: 2.6, scale: 1, attackImpact: 0.5, dust: 1.5,
  },
  wyvern: {
    key: 'wyvern', render: 'hero',
    build: () => buildDragon('wyvern', { scale: 1.25, body: '#4e5a3c', belly: '#b9a878', wing: '#8a8170', rider: riderLook({ weapon: 'axe2h' }) }),
    walkSpeed: 3, runSpeed: 6, runAbove: 4.5, flyHeight: 7.5, muzzle: 2.2, chest: 1.6, scale: 1, attackImpact: 0.45, dust: 0,
  },
  dragon: {
    key: 'dragon', render: 'hero',
    build: () => buildDragon('dragon', { scale: 2.6, body: '#5e221c', belly: '#c98f4f', wing: '#9a6a52', glow: '#ffcf5a' }),
    walkSpeed: 3.5, runSpeed: 7, runAbove: 5, flyHeight: 10, muzzle: 4.8, chest: 3.2, scale: 1, attackImpact: 0.5, dust: 0,
  },
  ballista: {
    key: 'ballista', render: 'hero', build: () => buildBallista('ballista', '#e4e1da'),
    walkSpeed: 1, runSpeed: 2, runAbove: 99, flyHeight: 0, muzzle: 1.15, chest: 1.0, scale: 1, attackImpact: 0.1, dust: 0.5,
  },
  trebuchet: {
    key: 'trebuchet', render: 'hero', build: () => buildTrebuchet('trebuchet', '#e4e1da'),
    walkSpeed: 0.8, runSpeed: 1.5, runAbove: 99, flyHeight: 0, muzzle: 5.5, chest: 2.0, scale: 1, attackImpact: 0.35, dust: 0.6,
  },
};

const LORD_KEY: Record<string, string> = { marshal: 'lord_marshal', archmage: 'lord_archmage', warden: 'lord_warden', skylady: 'lord_skylady' };

/** The archetype for a replay header row. */
export function archetypeFor(s: { modelId: string; type: string; lord?: string }): Archetype {
  return ARCHETYPES[s.modelId] ?? (s.lord ? ARCHETYPES[LORD_KEY[s.lord]] : undefined) ?? ARCHETYPES[s.type] ?? ARCHETYPES.militia;
}
