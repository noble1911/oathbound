// The twelve Lords on the client: every Lord ability is drawn (playback case + its own VFX), logged
// (a verb or the ability name), labelled in the inspector, iconed, heard and ringed in planning; every
// Lord has a hue, a portrait, a plate glyph, a pick card with its role, and a battlefield archetype
// that falls back to an existing model until its own GLB is in the art manifest.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACTIONS, FACTION_IDS } from '../src/sim/data/factions.ts';
import { LORDS, LORD_ABILITY_IDS, LORD_IDS, LORD_ROLE, LORD_ROLES, lordAuraRing } from '../src/sim/data/lords.ts';
import { STAT_CAUSES } from '../src/sim/replay.ts';
import { ABIL_VERB } from '../src/ui/battle.ts';
import { causeLabel } from '../src/ui/inspect-data.ts';
import { INNATE_ICON, LORD_HUE } from '../src/ui/units.ts';
import { codexPage } from '../src/ui/rules.ts';
import { ARCHETYPES, archetypeFor } from '../src/render/crowd/archetypes.ts';
import { Vfx } from '../src/render/vfx/index.ts';

const root = join(__dirname, '..');
const src = (f: string): string => readFileSync(join(root, f), 'utf8');
const NEW = ['soul_reap', 'grave_taunt', 'plague_breath', 'whirlwind', 'stampede', 'talon'] as const;
/** The Vfx method each newer ability plays. */
const VFX_OF: Record<(typeof NEW)[number], string> = {
  soul_reap: 'soulReap', grave_taunt: 'graveTaunt', plague_breath: 'plagueBreath', whirlwind: 'djinnWhirlwind', stampede: 'stampede', talon: 'talon',
};

describe('the twelve Lords on the client', () => {
  it('four Lords per faction, one in each role, in role order', () => {
    for (const f of FACTION_IDS) {
      expect(FACTIONS[f].lords.length, f).toBe(4);
      expect(FACTIONS[f].lords.map((l) => LORD_ROLE[l])).toEqual([...LORD_ROLES]);
    }
  });

  it('every Lord ability is played back, logged, labelled, iconed, heard and ringed', () => {
    const playback = src('src/render/battle-playback.ts');
    const audio = src('src/audio.ts');
    const director = src('src/render/camera/director.ts');
    for (const id of LORD_ABILITY_IDS) {
      expect(playback.includes(`case '${id}'`), `playback case ${id}`).toBe(true);
      expect(INNATE_ICON[id], `icon ${id}`).toBeTruthy();
      const ring = lordAuraRing(id);
      expect(ring.radius, `aura ${id}`).toBeGreaterThan(0);
      expect(ring.label.length).toBeGreaterThan(0);
      const lord = LORD_IDS.find((l) => LORDS[l].ability === id);
      expect(lord, `a Lord casts ${id}`).toBeTruthy();
      // the log says "<verb>" or "casts <Ability name>"
      expect(ABIL_VERB[id] ?? LORDS[lord!].abilityName).toBeTruthy();
    }
    for (const id of NEW) {
      expect(typeof (Vfx.prototype as unknown as Record<string, unknown>)[VFX_OF[id]], `vfx ${id}`).toBe('function');
      expect(playback.includes(`v.${VFX_OF[id]}(`), `playback plays ${VFX_OF[id]}`).toBe(true);
      expect(ABIL_VERB[id], `log verb ${id}`).toBeTruthy();
      expect(audio.includes(`${id}: [`), `sound ${id}`).toBe(true);
      expect(director.includes(`${id}:`), `camera ${id}`).toBe(true);
    }
  });

  it('every ledger cause of a Lord ability has an inspector label', () => {
    for (const c of STAT_CAUSES) if ((NEW as readonly string[]).includes(c)) expect(causeLabel(c), c).not.toBe(c);
  });

  it('every Lord has a hue, a portrait, a plate glyph and a row in the codex', () => {
    const ui = JSON.parse(src('public/ui/manifest.json')) as string[];
    const plates = (JSON.parse(src('public/ui/plates.json')) as { ids: string[] }).ids;
    const codex = codexPage('factions');
    for (const l of LORD_IDS) {
      expect(LORD_HUE[l], l).toMatch(/^#[0-9a-f]{6}$/);
      expect(ui.includes(`lord_${l}`), `portrait ${l}`).toBe(true);
      expect(plates.includes(`lord_${l}`), `glyph ${l}`).toBe(true);
      expect(codex.includes(LORDS[l].name), `codex ${l}`).toBe(true);
    }
  });

  it('each Lord gets its own archetype, and the newer six borrow an existing model until theirs lands', () => {
    const manifest = JSON.parse(src('public/models/v2/manifest.json')) as { models: Record<string, unknown> };
    for (const l of LORD_IDS) {
      const L = LORDS[l];
      const a = archetypeFor({ modelId: L.modelId, type: 'lord', lord: l });
      expect(a.key, l).toBe(L.modelId);
      // also when a replay row names an unknown model id
      expect(archetypeFor({ modelId: 'nope', type: 'lord', lord: l }).key).toBe(L.modelId);
      if (!manifest.models[L.modelId]) {
        const fb = ARCHETYPES[L.modelId].fallback ?? [];
        expect(fb.some((k) => manifest.models[k]), `${l} has a fallback model in the manifest`).toBe(true);
      }
    }
  });
});
