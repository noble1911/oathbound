import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { LORD_IDS } from '../src/sim/data/lords.ts';
import { VOICE_LINES, VOICE_LORDS, VoiceGate, allVoiceFiles, type VoiceEvent } from '../src/audio/voice-lines.ts';

const manifest = JSON.parse(readFileSync('tools/voice/manifest.json', 'utf8')) as {
  events: Record<string, string>;
  lords: Record<string, { lines: Record<string, string[]> }>;
};

// The rendered clips ship once tools/voice has run (needs the GPU); until public/audio/voice exists
// the file checks are skipped and the game simply plays no Lord lines.
const rendered = existsSync('public/audio/voice');

describe('Lord voice lines', () => {
  it.skipIf(!rendered)('the manifest, the runtime table and the shipped files agree', () => {
    expect([...VOICE_LORDS].sort()).toEqual([...LORD_IDS].sort());
    expect(Object.keys(manifest.lords).sort()).toEqual([...LORD_IDS].sort());
    expect(Object.keys(manifest.events).sort()).toEqual(Object.keys(VOICE_LINES).sort());
    for (const [lord, L] of Object.entries(manifest.lords)) {
      expect(Object.keys(L.lines).sort()).toEqual(Object.keys(VOICE_LINES).sort());
      for (const [ev, texts] of Object.entries(L.lines)) {
        expect(texts.length, `${lord}/${ev}`).toBe(VOICE_LINES[ev as VoiceEvent]);
        texts.forEach((_, i) => expect(existsSync(`public/audio/voice/${lord}/${ev}_${i + 1}.webm`), `${lord}/${ev}_${i + 1}`).toBe(true));
      }
    }
  });

  it.skipIf(!rendered)('the voice set stays within its 1.5 MB budget', () => {
    const bytes = allVoiceFiles().reduce((n, f) => n + statSync(`public/audio/${f}`).size, 0);
    expect(bytes).toBeLessThan(1.5e6);
  });

  it('variants rotate, cooldowns hold and priorities interrupt', () => {
    const g = new VoiceGate(() => 0);
    const seen: number[] = [];
    for (let k = 0; k < 6; k++) {
      const t = k * 10_000;
      const d = g.decide('marshal', 'deploy', t);
      if ('drop' in d) throw new Error('dropped');
      seen.push(d.n);
      g.started('deploy', t, 1000);
    }
    expect(seen).toEqual([1, 2, 3, 1, 2, 3]);
    expect('drop' in g.decide('marshal', 'deploy', 100_000)).toBe(false);
    g.started('deploy', 100_000, 1500);
    expect(g.decide('marshal', 'deploy', 100_500)).toEqual({ drop: 'cooldown' });
    expect(g.decide('warden', 'deploy', 100_500)).toEqual({ drop: 'busy' }); // equal priority waits
    const a = g.decide('warden', 'ability', 100_600);
    expect('drop' in a ? a : a.interrupt).toBe(true); // a Lord ability cuts a deploy bark short
  });
});
