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
  // ---- stand-ins for the Ashen Covenant / the Sun Caliphate (shown until the art model streams in)
  grave_knight: base({ body: 'plate', helmet: 'greathelm', weapon: 'sword', shield: 'kite', cape: true, metal: '#8a7a55', cloth: '#8a8478', bulk: 1.2 }),
  bone_archer: base({ body: 'bones', helmet: 'hood', weapon: 'bow', quiver: true, cloth: '#77736c', metal: '#7d776b' }),
  grave_acolyte: base({ body: 'robe', helmet: 'hood', weapon: 'staff', glow: '#5fe08a', glowStrength: 7, cloth: '#5d5a56', skin: '#d9d4c2' }),
  lord_lich: base({ body: 'robe', helmet: 'crown', weapon: 'staff', cape: true, glow: '#5fe08a', glowStrength: 10, cloth: '#3f4a44', trim: '#8a7a55', skin: '#d9d4c2' }),
  spear_levy: base({ helmet: 'cap', weapon: 'pike', shield: 'round', cloth: '#f2efe6', metal: '#c9a04a', skin: SKIN[1] }),
  scimitar: base({ body: 'plate', helmet: 'cap', weapon: 'sword', shield: 'round', cloth: '#f2efe6', metal: '#c9a04a', trim: '#2fb7b0', skin: SKIN[1] }),
  djinn_binder: base({ body: 'robe', helmet: 'hat', weapon: 'staff', glow: '#9fd8ff', glowStrength: 7, cloth: '#f2efe6', trim: '#2fb7b0', skin: SKIN[1] }),
  sun_priest: base({ body: 'robe', helmet: 'none', weapon: 'staff', glow: '#ffe9a0', glowStrength: 7, cloth: '#f7f3e8', trim: '#e6b84a', skin: SKIN[1] }),
  lord_sultana: base({ body: 'plate', helmet: 'crown', weapon: 'sword', cape: true, metal: '#d9b25a', trim: '#2fb7b0', cloth: '#f2efe6', skin: SKIN[1], glowStrength: 3 }),
  // stand-ins of the six Lords whose models ship ahead of the sim (see ARCHETYPES)
  lord_deathknight: base({ body: 'plate', helmet: 'greathelm', weapon: 'axe2h', cape: true, metal: '#6f6658', cloth: '#5d5a56', glow: '#5fe08a', glowStrength: 4, bulk: 1.2 }),
  lord_vizier: base({ body: 'robe', helmet: 'hat', weapon: 'staff', glow: '#9fd8ff', glowStrength: 8, cloth: '#f2efe6', trim: '#2fb7b0', skin: SKIN[1] }),
  lord_rajah: base({ body: 'plate', helmet: 'crown', weapon: 'sword', shield: 'round', cape: true, metal: '#d9b25a', trim: '#2fb7b0', cloth: '#f2efe6', skin: SKIN[1], bulk: 1.2 }),
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
  // Squads: walkSpeed / runSpeed are the ground speeds the art clips cover at rate 1 (tools/art/blender/anim_audit.py).
  // The sim moves them at 2.2-3.4 m/s, which no walk clip reaches (0.5-1.1 m/s), so they jog (`runAbove` is low) at a
  // rate matched to their speed instead of skating on a walk clip clamped at 1.8x.
  militia: human('militia', 'crowd', { walkSpeed: 0.63, runSpeed: 3.37, runAbove: 1.6 }),
  pikemen: human('pikemen', 'crowd', { walkSpeed: 0.8, runSpeed: 4.27, runAbove: 1.8 }),
  berserkers: human('berserkers', 'crowd', { attackImpact: 0.42, walkSpeed: 0.75, runSpeed: 4.03, runAbove: 1.8 }),
  archers: human('archers', 'crowd', { attackImpact: 0.64, walkSpeed: 1.07, runSpeed: 3.5, runAbove: 2.0 }),
  knights: human('knights', 'crowd', { walkSpeed: 0.64, runSpeed: 3.44, runAbove: 1.5, dust: 0.35 }),
  mages: human('mages', 'crowd', { walkSpeed: 1.04, runSpeed: 3.44, runAbove: 2.0, attackImpact: 0.45, muzzle: 2.0 }),
  clerics: human('clerics', 'crowd', { walkSpeed: 0.5, runSpeed: 2.76, runAbove: 1.4, attackImpact: 0.5, muzzle: 2.0 }),
  skeleton: human('skeleton', 'crowd', { dust: 0.1, walkSpeed: 0.93, runSpeed: 3.1, runAbove: 1.8 }),
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
  // Lords: walkSpeed / runSpeed are the ground speeds their clips actually cover at rate 1 (measured with
  // tools/art/blender/anim_audit.py), so planted feet do not slide at their sim speeds (3.2 / 2.8 / 2.6 / 5.2 m/s)
  lord_marshal: human('lord_marshal', 'hero', { dust: 0.3, walkSpeed: 1.15, runSpeed: 3.95, runAbove: 2.3 }, 1.22),
  lord_archmage: human('lord_archmage', 'hero', { attackImpact: 0.45, muzzle: 2.4, walkSpeed: 1.1, runSpeed: 3.65, runAbove: 2.2 }, 1.22),
  lord_warden: human('lord_warden', 'hero', { dust: 0.3, walkSpeed: 0.9, runSpeed: 2.45, runAbove: 1.65 }, 1.25),
  lord_skylady: human('lord_skylady', 'hero', { walkSpeed: 0.8, runSpeed: 4.7, runAbove: 2.2 }, 1.22),
  golem: {
    key: 'golem', render: 'hero', build: () => buildGolem('golem'),
    walkSpeed: 1.2, runSpeed: 3, runAbove: 99, flyHeight: 0, muzzle: 3.0, chest: 2.6, scale: 1, attackImpact: 0.5, dust: 1.5,
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
  // ---------------------------------------------------------------- The Ashen Covenant (docs/ART.md, "Factions")
  // walkSpeed / runSpeed = what the shipped clips cover at rate 1 (anim_audit.py for humanoids, creatures.json
  // gaits for mounts); runAbove sits under the unit's sim speed so squads jog instead of skating on the walk
  grave_knight: human('grave_knight', 'crowd', { walkSpeed: 1.03, runSpeed: 3.4, runAbove: 2.1, dust: 0.35, muzzle: 1.55, chest: 1.35 }),
  bone_archer: human('bone_archer', 'crowd', { walkSpeed: 0.98, runSpeed: 3.2, runAbove: 1.9, attackImpact: 0.64, dust: 0.1 }),
  wraith_rider: {
    key: 'wraith_rider', render: 'crowd',
    build: () => buildHorse('wraith_rider', { coat: '#d9d4c2', mane: '#5fe08a', barding: '#e4e1da', rider: riderLook({ weapon: 'lance', helmet: 'hood', metal: '#9fb8a4', cape: true }) }),
    walkSpeed: 2.2, runSpeed: 7, runAbove: 3.5, flyHeight: 0, muzzle: 2.0, chest: 1.6, scale: 1, attackImpact: 0.4, dust: 0.3,
  },
  grave_acolyte: human('grave_acolyte', 'crowd', { walkSpeed: 1.01, runSpeed: 3.49, runAbove: 1.9, attackImpact: 0.45, muzzle: 2.0, dust: 0.1 }),
  bone_drake: {
    key: 'bone_drake', render: 'hero',
    build: () => buildDragon('bone_drake', { scale: 2.4, body: '#d9d4c2', belly: '#b9b29c', wing: '#77736c', glow: '#5fe08a' }),
    walkSpeed: 3.5, runSpeed: 7, runAbove: 5, flyHeight: 7.5, muzzle: 4.2, chest: 3.0, scale: 1, attackImpact: 0.5, dust: 0,
  },
  corpse_catapult: {
    key: 'corpse_catapult', render: 'hero', build: () => buildTrebuchet('corpse_catapult', '#e4e1da'),
    walkSpeed: 0.8, runSpeed: 1.5, runAbove: 99, flyHeight: 0, muzzle: 4.6, chest: 1.8, scale: 1, attackImpact: 0.35, dust: 0.6,
  },
  bone_golem: {
    key: 'bone_golem', render: 'hero', build: () => buildGolem('bone_golem'),
    walkSpeed: 1.62, runSpeed: 3, runAbove: 99, flyHeight: 0, muzzle: 3.0, chest: 2.6, scale: 1, attackImpact: 0.5, dust: 1.2,
  },
  lord_lich: human('lord_lich', 'hero', { attackImpact: 0.45, muzzle: 2.4, walkSpeed: 1.27, runSpeed: 4.42, runAbove: 2.7, dust: 0.1 }, 1.22),
  // ---------------------------------------------------------------- The Sun Caliphate
  spear_levy: human('spear_levy', 'crowd', { walkSpeed: 0.91, runSpeed: 3.0, runAbove: 1.8 }),
  scimitar: human('scimitar', 'crowd', { walkSpeed: 1.09, runSpeed: 3.6, runAbove: 2.0, attackImpact: 0.42 }),
  camel_archer: {
    key: 'camel_archer', render: 'crowd',
    build: () => buildHorse('camel_archer', { coat: '#c9a56a', mane: '#a58450', barding: '#e4e1da', rider: riderLook({ weapon: 'bow', helmet: 'cap', metal: '#c9a04a', quiver: true }) }),
    walkSpeed: 1.8, runSpeed: 5.5, runAbove: 3.2, flyHeight: 0, muzzle: 2.6, chest: 1.9, scale: 1, attackImpact: 0.64, dust: 0.8,
  },
  mamluk: {
    key: 'mamluk', render: 'crowd',
    build: () => buildHorse('mamluk', { coat: '#e9e6df', mane: '#d8d4cc', barding: '#e4e1da', rider: riderLook({ weapon: 'lance', metal: '#d9b25a', cape: true }) }),
    walkSpeed: 2.2, runSpeed: 7, runAbove: 3.5, flyHeight: 0, muzzle: 2.0, chest: 1.6, scale: 1, attackImpact: 0.4, dust: 0.8,
  },
  djinn_binder: human('djinn_binder', 'crowd', { walkSpeed: 1.0, runSpeed: 3.38, runAbove: 1.9, attackImpact: 0.45, muzzle: 2.0 }),
  sun_priest: human('sun_priest', 'crowd', { walkSpeed: 0.97, runSpeed: 3.43, runAbove: 1.9, attackImpact: 0.5, muzzle: 2.0 }),
  // floats (no ground contact): the fly height lifts the smoke tail clear of the ground
  djinn: {
    key: 'djinn', render: 'hero', build: () => buildGolem('djinn'),
    walkSpeed: 3, runSpeed: 5, runAbove: 3.6, flyHeight: 6.5, muzzle: 2.4, chest: 2.2, scale: 1, attackImpact: 0.45, dust: 0,
  },
  war_elephant: {
    key: 'war_elephant', render: 'hero', build: () => buildGolem('war_elephant'),
    walkSpeed: 1.3, runSpeed: 2.6, runAbove: 1.9, flyHeight: 0, muzzle: 4.6, chest: 2.6, scale: 1, attackImpact: 0.42, dust: 2,
  },
  sand_golem: {
    key: 'sand_golem', render: 'hero', build: () => buildGolem('sand_golem'),
    walkSpeed: 1.59, runSpeed: 3, runAbove: 99, flyHeight: 0, muzzle: 3.0, chest: 2.6, scale: 1, attackImpact: 0.5, dust: 1.8,
  },
  lord_sultana: human('lord_sultana', 'hero', { dust: 0.3, walkSpeed: 1.13, runSpeed: 3.8, runAbove: 2.2 }, 1.22),
  // ---------------------------------------------------------------- Lords whose art ships ahead of the sim
  // Keyed by model id only (not in LORD_KEY: the sim does not know them yet), so `showArmy` / a replay row with
  // `modelId: 'lord_<id>'` can already display them (e2e/model-compare.mjs, e2e/anim-audit.mjs).
  // walkSpeed / runSpeed are placeholders: set them from tools/art/blender/anim_audit.py once the models are built.
  lord_deathknight: human('lord_deathknight', 'hero', { dust: 0.3, walkSpeed: 1.0, runSpeed: 3.0, runAbove: 1.9 }, 1.25),
  lord_ossuary: {
    key: 'lord_ossuary', render: 'hero', build: () => buildGolem('lord_ossuary'),
    walkSpeed: 1.4, runSpeed: 3, runAbove: 99, flyHeight: 0, muzzle: 2.4, chest: 2.0, scale: 1, attackImpact: 0.5, dust: 1.0,
  },
  lord_drakerider: {
    key: 'lord_drakerider', render: 'hero',
    build: () => buildDragon('lord_drakerider', { scale: 1.4, body: '#d9d4c2', belly: '#b9b29c', wing: '#77736c', glow: '#5fe08a', rider: riderLook({ weapon: 'lance', helmet: 'crown', metal: '#8a7a55' }) }),
    walkSpeed: 3, runSpeed: 6, runAbove: 4.5, flyHeight: 7.5, muzzle: 2.4, chest: 1.8, scale: 1, attackImpact: 0.45, dust: 0,
  },
  lord_vizier: human('lord_vizier', 'hero', { attackImpact: 0.45, muzzle: 2.4, walkSpeed: 1.1, runSpeed: 3.6, runAbove: 2.2, dust: 0.1 }, 1.22),
  lord_rajah: human('lord_rajah', 'hero', { dust: 0.4, walkSpeed: 1.0, runSpeed: 3.2, runAbove: 2.0 }, 1.25),
  lord_rocrider: {
    key: 'lord_rocrider', render: 'hero',
    build: () => buildDragon('lord_rocrider', { scale: 1.4, body: '#c9a04a', belly: '#e9d9a8', wing: '#d9b25a', rider: riderLook({ weapon: 'bow', helmet: 'cap', metal: '#d9b25a' }) }),
    walkSpeed: 3, runSpeed: 6, runAbove: 4.5, flyHeight: 7.5, muzzle: 2.4, chest: 1.8, scale: 1, attackImpact: 0.64, dust: 0,
  },
};

const LORD_KEY: Record<string, string> = { marshal: 'lord_marshal', archmage: 'lord_archmage', warden: 'lord_warden', skylady: 'lord_skylady', lich: 'lord_lich', sultana: 'lord_sultana' };

/** The archetype for a replay header row. */
export function archetypeFor(s: { modelId: string; type: string; lord?: string }): Archetype {
  return ARCHETYPES[s.modelId] ?? (s.lord ? ARCHETYPES[LORD_KEY[s.lord]] : undefined) ?? ARCHETYPES[s.type] ?? ARCHETYPES.militia;
}
