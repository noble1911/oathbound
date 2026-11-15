import { describe, expect, it } from 'vitest';
import { abilityFx } from '../src/render/ability-fx.ts';
import { BLESS_TICKS } from '../src/sim/battle.ts';

describe('abilityFx (debuff / buff window events -> effect spec)', () => {
  it('frost: a chill for the slow the sim reports, cold with a burst for a single-target slow', () => {
    expect(abilityFx({ ability: 'frost', radius: 0, dur: 40 }, { srcType: 'mages' })).toEqual({ kind: 'chill', sec: 2, sand: false, burst: true });
  });

  it('frost from a Djinn-Binder or a Trample is sand, and an area skill draws no per-soldier burst', () => {
    expect(abilityFx({ ability: 'frost', radius: 0, dur: 40 }, { srcType: 'djinn_binder' })).toMatchObject({ kind: 'chill', sand: true, burst: false });
    expect(abilityFx({ ability: 'frost', radius: 0, dur: 40 }, { srcType: 'knights', srcSkill: 'trample' })).toMatchObject({ kind: 'chill', sec: 2, sand: true, burst: false });
    expect(abilityFx({ ability: 'frost', radius: 0, dur: 80 }, { srcType: 'mages', srcSkill: 'frost_nova' })).toEqual({ kind: 'chill', sec: 4, sand: false, burst: false });
  });

  it('burn: 60 ticks = 3 s of fire, or plague from the Corpse Catapult; src -1 still burns', () => {
    expect(abilityFx({ ability: 'burn', radius: 0, dur: 60 }, { srcType: 'archers' })).toEqual({ kind: 'burn', sec: 3, plague: false });
    expect(abilityFx({ ability: 'burn', radius: 0, dur: 60 }, { srcType: 'corpse_catapult' })).toEqual({ kind: 'burn', sec: 3, plague: true });
    expect(abilityFx({ ability: 'burn', radius: 0, dur: 60 })).toEqual({ kind: 'burn', sec: 3, plague: false });
  });

  it('a radius-0 war_cry is a per-soldier blessing for BLESS_TICKS, never the area shockwave', () => {
    const fx = abilityFx({ ability: 'war_cry', radius: 0, dur: BLESS_TICKS }, { srcType: 'sun_priest' });
    expect(fx).toEqual({ kind: 'bless', sec: (BLESS_TICKS * 50) / 1000 });
    // whoever the source is: radius 0 means one soldier
    expect(abilityFx({ ability: 'war_cry', radius: 0, dur: 40 }, { srcType: 'lord' })?.kind).toBe('bless');
  });

  it('an area war_cry (radius > 0) is the shockwave, at least 4 m', () => {
    expect(abilityFx({ ability: 'war_cry', radius: 1000, dur: 120 })).toEqual({ kind: 'warCry', radiusM: 10 });
    expect(abilityFx({ ability: 'war_cry', radius: 100, dur: 120 })).toEqual({ kind: 'warCry', radiusM: 4 });
  });

  it('other abilities are not windows', () => {
    expect(abilityFx({ ability: 'meteor', radius: 1000, dur: 30 })).toBeNull();
    expect(abilityFx({ ability: 'shield_wall', radius: 0, dur: 100 })).toBeNull();
  });
});
