// The faction UI's data: every unit and Lord of every faction has a name, a role, a painted
// portrait, a card line and a place in the codex; each faction's mechanics are named; counters are
// judged against the enemy faction when it is known; the pick screen's helpers hold.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FactionId } from '../src/sim/types.ts';
import { FACTIONS, FACTION_IDS, factionOfLord, factionOfUnit } from '../src/sim/data/factions.ts';
import { LORDS, LORD_IDS } from '../src/sim/data/lords.ts';
import { UNITS, UNIT_TYPES } from '../src/sim/data/units.ts';
import { unitSkills } from '../src/sim/data/skills.ts';
import { counters, rivals, setFactionContext, unitName } from '../src/ui/gamedata.ts';
import { factionAccent, factionMechanics } from '../src/ui/lordpick.ts';
import { draftLines } from '../src/ui/loot.ts';
import { codexFaction, codexPage } from '../src/ui/rules.ts';
import { LORD_HUE, unitTooltip } from '../src/ui/units.ts';

const UI = join(__dirname, '..', 'public', 'ui');
const manifest = new Set<string>(JSON.parse(readFileSync(join(UI, 'manifest.json'), 'utf8')));

describe('faction rosters in the UI', () => {
  it('every unit belongs to exactly one faction, and the three rosters cover them all', () => {
    const all = FACTION_IDS.flatMap((f) => FACTIONS[f].units);
    expect([...all].sort()).toEqual([...UNIT_TYPES].sort());
    expect(new Set(all).size).toBe(all.length);
    for (const u of UNIT_TYPES) expect(FACTIONS[factionOfUnit(u)].units).toContain(u);
    expect(FACTION_IDS.flatMap((f) => FACTIONS[f].lords).sort()).toEqual([...LORD_IDS].sort());
  });

  it('every unit of every faction has a name, a role, a painted portrait and a card line', () => {
    for (const f of FACTION_IDS) {
      for (const u of FACTIONS[f].units) {
        const d = UNITS[u];
        expect(d.name.trim().length, `${u} name`).toBeGreaterThan(0);
        expect(unitName(u, null), `${u} unitName`).toBe(d.name);
        expect(d.role.trim().length, `${u} role`).toBeGreaterThan(0);
        expect(existsSync(join(UI, `unit_${u}.webp`)), `public/ui/unit_${u}.webp`).toBe(true);
        expect(manifest.has(`unit_${u}`), `unit_${u} in ui/manifest.json`).toBe(true);
        const [first, second] = draftLines(u);
        expect(first.text.trim().length, `${u} card line 1`).toBeGreaterThan(0);
        expect(second.text.trim().length, `${u} card line 2`).toBeGreaterThan(0);
        // the tooltip names the faction and says what the unit does
        const tip = unitTooltip(u);
        expect(tip).toContain(FACTIONS[f].short);
        for (const k of unitSkills(u).filter((x) => ['raise', 'ethereal', 'plague', 'bless', 'regen', 'howdah', 'slowing'].includes(x.id))) expect(tip, `${u} tooltip names ${k.name}`).toContain(k.name);
      }
    }
  });

  it('every Lord has a name, a portrait, a hue, signature units of its own faction and an ability', () => {
    for (const l of LORD_IDS) {
      const L = LORDS[l];
      expect(`${L.title} ${L.name}`.trim().length).toBeGreaterThan(3);
      expect(existsSync(join(UI, `lord_${l}.webp`)), `public/ui/lord_${l}.webp`).toBe(true);
      expect(manifest.has(`lord_${l}`), `lord_${l} in ui/manifest.json`).toBe(true);
      expect(LORD_HUE[l]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(L.signature.length).toBe(2);
      for (const u of L.signature) expect(factionOfUnit(u), `${l} signature ${u}`).toBe(factionOfLord(l));
      expect(L.abilityName.length).toBeGreaterThan(0);
      expect(L.abilityText.length).toBeGreaterThan(0);
    }
  });

  it('the codex Factions tab names every unit and every Lord of all three factions', () => {
    const html = codexPage('factions');
    for (const f of FACTION_IDS) {
      expect(html).toContain(FACTIONS[f].name);
      for (const u of FACTIONS[f].units) expect(html, `${u} in the codex`).toContain(UNITS[u].name);
      for (const l of FACTIONS[f].lords) expect(html, `${l} in the codex`).toContain(LORDS[l].name);
    }
    expect(html).toContain('No healers');
  });

  it('the other codex tabs speak about one faction: yours in a match', () => {
    for (const f of FACTION_IDS) {
      setFactionContext(() => ({ mine: f, enemy: null }));
      expect(codexFaction()).toBe(f);
      const combat = codexPage('combat');
      expect(combat).toContain(FACTIONS[f].name);
      // the wheel table has one row per class, and the units it names in them are that faction's own
      expect([...combat.matchAll(/<div class="rl-row">/g)].length).toBe(8);
      const listed = [...combat.matchAll(/<div class="rl-prey">(.*?)<\/div><\/div>/g)].flatMap((m) => [...m[1]!.matchAll(/<\/div>([^<]+)<\/span>/g)].map((x) => x[1]));
      expect(listed.length).toBe(FACTIONS[f].units.length);
      const own = new Set(FACTIONS[f].units.map((u) => UNITS[u].name));
      for (const h of listed) expect(own.has(h!), `${h} listed for ${f}`).toBe(true);
      setFactionContext(() => ({ mine: f, enemy: null }));
      const air = codexPage('air');
      for (const u of FACTIONS[f].units.filter((x) => UNITS[x].tags.includes('flier'))) expect(air).toContain(UNITS[u].name);
      expect(combat.includes('has no healers')).toBe(!FACTIONS[f].units.some((u) => UNITS[u].traits.includes('healer')));
    }
    setFactionContext(() => ({ mine: null, enemy: null }));
  });
});

describe('faction mechanics and accents', () => {
  const ids = (f: FactionId) => factionMechanics(f).map((m) => m.id);
  it('each faction names what sets it apart', () => {
    expect(ids('ashen')).toEqual(expect.arrayContaining(['raise', 'ethereal', 'plague', 'lifesteal', 'no_heal']));
    expect(ids('ashen')).not.toContain('heal');
    expect(ids('caliphate')).toEqual(expect.arrayContaining(['bless', 'slowing', 'regen', 'howdah', 'heal']));
    expect(ids('caliphate')).not.toContain('no_heal');
    expect(ids('kingdom')).toContain('heal');
    expect(ids('kingdom')).not.toContain('no_heal');
    for (const f of FACTION_IDS) {
      for (const m of factionMechanics(f)) {
        expect(m.name.length).toBeGreaterThan(0);
        expect(m.text.length).toBeGreaterThan(0);
        for (const u of m.units) expect(factionOfUnit(u)).toBe(f);
      }
    }
  });
  it('the HUD accent is two of the faction colours, different per faction', () => {
    const seen = new Set<string>();
    for (const f of FACTION_IDS) {
      const [a, b] = factionAccent(f);
      expect(FACTIONS[f].colors).toContain(a);
      expect(FACTIONS[f].colors).toContain(b);
      expect(a).not.toBe(b);
      seen.add(`${a}${b}`);
    }
    expect(seen.size).toBe(FACTION_IDS.length);
  });
});

describe('counters against the enemy faction', () => {
  it('name only the enemy roster when it is known, and never the unit itself', () => {
    for (const mine of FACTION_IDS) {
      for (const enemy of FACTION_IDS) {
        for (const u of FACTIONS[mine].units) {
          const c = counters(u, enemy);
          for (const x of [...c.prey, ...c.threats]) {
            expect(factionOfUnit(x), `${u} vs ${enemy}: ${x}`).toBe(enemy);
            expect(x).not.toBe(u);
          }
          expect(rivals(u, enemy).every((x) => factionOfUnit(x) === enemy && x !== u)).toBe(true);
        }
      }
    }
  });
  it('fall back to every roster before the reveal, and follow the app context', () => {
    expect(rivals('militia', null).length).toBe(UNIT_TYPES.length - 1);
    setFactionContext(() => ({ mine: 'kingdom', enemy: 'caliphate' }));
    const c = counters('pikemen');
    for (const x of [...c.prey, ...c.threats]) expect(factionOfUnit(x)).toBe('caliphate');
    // pikes (Line) hunt the enemy's Cavalry, whatever it is called, and fear its Giants
    expect(c.prey).toEqual(['mamluk']);
    expect(c.threats).toEqual(['war_elephant', 'sand_golem']);
    // the Covenant's spectral riders carry no 'mounted' tag, but they are Cavalry on the wheel all the same
    expect(counters('pikemen', 'ashen').prey).toEqual(['wraith_rider']);
    setFactionContext(() => ({ mine: null, enemy: null }));
  });
  it('every unit still has two card lines against each enemy faction', () => {
    for (const enemy of FACTION_IDS) {
      setFactionContext(() => ({ mine: null, enemy }));
      for (const u of UNIT_TYPES) for (const l of draftLines(u)) expect(l.text.trim().length, `${u} vs ${enemy}`).toBeGreaterThan(0);
    }
    setFactionContext(() => ({ mine: null, enemy: null }));
  });
});
