# Oathbound v2: balance report

The numbers come from `node tools/tournament.ts --seeds 3 --best`. That run has 28 entries: 7 bot strategies × 4 Lords. Every entry plays every other entry from both seats, on 3 seeds each, for 2268 matches. It takes about 2 minutes on 18 worker threads. The report also prints the match-length histogram and the margin-of-victory distribution.

To re-tune, run `node tools/tournament.ts --seeds 1 --tune N`. It rewrites the multipliers in `src/sim/data/balance.ts`.

## Final report (DESIGN §8 targets)

Rules as of the QA pass: points-decided timeouts and early stalemates, the scaling comeback, slots at Lv1/2/4 with
usable-slot loot, deploy footprints, and the three vs-AI levels (`best` = `hard`).

| Metric | Result | Target |
|---|---|---|
| Side advantage (P0 win rate) | **50.4%** | < 52/48 ✅ |
| Average match length | **11.8 rounds** (median 11) | about 9–12 ✅ |
| Average battle length | 52.6 s; 20.7% end with both armies standing (15.3% as early stalemates) | 30–60 s ✅ |
| Lords | Marshal **49.8%**, Archmage **51.9%**, Warden **48.8%**, Skylady **49.5%** | 45–55% ✅ |
| Units (cost-normalised) | **44.2%** (clerics) to **57.2%** (dragon) | 40–60% ✅ |
| Legendaries | **43.1%** (Ember Crown) to **53.9%** (Bloodthirst) | 40–60% ✅ |

**Match length.** 8 rounds: 0.6%, 9: 8.4%, 10: 20.0%, 11: 25.8%, 12: 19.6%, 13: 11.9%, 14: 4.7%, 15 or more: 9.0%.

**Margin of victory.** This is the winner's keep HP left when the match ends; lower means closer games.

| | Mean | 0–24% | 25–49% | 50–74% | 75–100% (blowout) |
|---|---|---|---|---|---|
| Before (flat +75 catch-up, HEAD b13cedb) | 63.0% | 11.9% | 19.4% | 26.6% | **42.1%** |
| After (scaling comeback, points) | 56.2% | 15.0% | 23.3% | 32.4% | **29.3%** |

The old rules averaged 11.3 rounds, so the comeback makes games closer without making them much longer.

**Units.** Each figure is the cost-normalised share of the unit in the round winner's army, against its share in the loser's army.

| Unit | Win rate | Unit | Win rate |
|---|---|---|---|
| militia | 48.7 | mages | 49.3 |
| pikemen | 44.7 | clerics | 44.2 |
| berserkers | 48.9 | pegasus | 50.8 |
| archers | 55.4 | ballista | 51.9 |
| knights | 44.7 | trebuchet | 55.7 |
| cavaliers | 49.8 | golem | 52.1 |
| wyvern | 51.6 | dragon | 57.2 |

**Legendaries.**

| Legendary | Win rate | Legendary | Win rate |
|---|---|---|---|
| bloodthirst | 53.9 | frostheart | 49.5 |
| warhorn | 53.8 | mirror aegis | 48.3 |
| kingsbane | 53.4 | stormcaller | 48.1 |
| hydra volley | 53.4 | lifebinder | 48.1 |
| sunfire | 51.6 | undying oath | 47.5 |
| earthshaker | 51.5 | gravebloom | 46.3 |
| windrunner | 43.2 | ember crown | 43.1 |

Each legendary has n ≈ 310–950 samples. Legendaries are compared head-to-head, counting only battles where both armies hold the same number (at least one) of legendaries. Raw presence is biased because round losers roll one rarity tier higher, so legendaries pile up on the losing side and every one of them read 30–45%.

**Strategy matrix.** Win rate of the row strategy against the column strategy. `best` is the vs-AI Hard bot.

| | air | armor | best | counter | random | ranged | rush |
|---|---|---|---|---|---|---|---|
| air | 50 | 54 | 26 | 35 | 29 | 41 | 65 |
| armor | 46 | 50 | 18 | 39 | 50 | 58 | 47 |
| best | 74 | 82 | 50 | 63 | 83 | 71 | 81 |
| counter | 65 | 61 | 38 | 50 | 51 | 61 | 75 |
| random | 71 | 50 | 17 | 49 | 50 | 53 | 57 |
| ranged | 59 | 42 | 29 | 39 | 47 | 50 | 56 |
| rush | 35 | 53 | 19 | 25 | 43 | 44 | 50 |

Air beats rush, rush beats armor and armor beats air. Counter-picking pays off, which is the Mechabellum arms race the design asks for. Hard (`best`) is now clearly the strongest player (75.7% overall), because it gears squads by affix fit and re-forms its army every round. The classic flavoured bots are there to give the unit and Lord metrics varied opponents.

**Lord matrix.** Win rate of the row Lord against the column Lord.

| | archmage | marshal | skylady | warden |
|---|---|---|---|---|
| archmage | 50 | 50 | 53 | 52 |
| marshal | 50 | 50 | 46 | 53 |
| skylady | 47 | 54 | 50 | 48 |
| warden | 48 | 47 | 52 | 50 |

## vs-AI difficulty ladder

`node tools/tournament.ts --strats easy,normal,hard --seeds 10` has 12 entries (3 levels × 4 Lords). Each pair plays from both seats, for 1320 matches. Win rate of the row level against the column level:

| | easy | normal | hard |
|---|---|---|---|
| easy | 50 | 7 | 4 |
| normal | **93** | 50 | 26 |
| hard | 96 | **74** | 50 |

The targets are met: Hard beats Normal 74% (target over 65%), and Normal beats Easy 93% (target over 75%). Ablations of Hard against Normal (14 seeds) show what separates them:

- Item-aware gearing is worth about +7 points. Without it (using Normal's "most valuable squad" rule instead), Hard won 55%.
- Preferring the stronger affordable unit when scores are close is worth about +6 points.
- The counter-formation is roughly neutral against Normal's fixed lanes (±3 points, within noise). It stays because it answers a player who doesn't move squads (pikes in front of their cavalry, archers under their fliers), and it is what makes Hard re-form every round.
- Hard's level-ups use the simple "cheapest relative upgrade first" order, and a squad that opens a slot for a waiting item jumps the queue. A "counter merit per gold" order tested about 4 points worse.

All three levels see only `viewFor`: their own state plus the enemy's previous-round army. `tests/sim.rules.test.ts` checks that changing the enemy's hidden current state does not change Hard's plan.

## Fairness between the two seats

Seat fairness holds by construction, not just statistically. `tests/sim.mirror.test.ts` swaps the seats, mirrors both armies through the field centre and checks that the battle replays as the exact mirror image. It compares every soldier's position, HP, animation and facing on every keyframe, every round of 4 bot matches. How this works:

- **Positions.** A stored int `p` means `p + 0.5 cm`, so the mirror `x → 7999 − x` is an exact integer map with no fixed point.
- **Division.** All division truncates, which is sign-symmetric; there are no `>>` shifts on signed values. Squad centroids are kept in doubled, centred coordinates.
- **Order-independent ticks.** Each tick is "Jacobi": everything reads the tick-start snapshot, and damage, heals, buffs and deaths accumulate and apply at the end of the tick. So it doesn't matter which seat is processed first.
- **Seat-free RNG.** Random rolls are `hash(seed, tick, canonical key, salt)`. The key is built from the squad's index in its own army and the soldier's index in the squad, never from the seat.
- **Terrain and pathing.** Only seat 0's half of the terrain is generated; seat 1's half is its cell-for-cell mirror. Seat 1's flow field is seat 0's, mirrored.

The remaining 50.9% vs 49.1% split is sampling noise from the bots' seat-salted jitter.

## QA-pass changes (round outcomes, comeback, slots, AI levels)

1. **Stalemates end early, and timeouts are decided on points.** A battle where one side had nothing that could target the other's remaining units used to run the full 90 s, for example a lone wyvern over golems with no anti-air. Now the battle ends early in three cases:
   - neither side can target the other;
   - one side has been helpless for 15 s;
   - nobody has dealt damage for 15 s.

   Timeouts and stalls are decided on points: the percent of army value still standing, with a 5-point margin. The points winner's survivors deal their keep damage without the round base. The wording, the catch-up gold and the loot tier now always agree: only a lost round pays catch-up.
2. **Comeback.** The flat +75 catch-up became `75 + 10 × round + 3 × keep-HP deficit (points)`. A player 25 or more points behind also gets an extra squad deployment. Blowouts (the winner above 75% keep HP) fell from 42% to 29% of matches.
3. **Item slots** now open at Lv1 / Lv2 / Lv4 (they were Lv1 / Lv3 / Lv5), and loot leans toward usable slots, so items stop piling up in the stash.
4. **Lord hero multipliers re-tuned** after the changes above: Marshal 174 → 205, Archmage 60 → 48, Warden 113 → 118. Before the re-tune Marshal was at 43.8%, because the extra underdog deployment narrowed his +1 deploy edge. Archmage was at 57.7%, because her mages gained from the earlier armour slot.
5. **Deploy footprints.** A player's squads may not overlap. All bots place squads through `freeSpotNear`.

## Big changes and their rationale

1. **Global damage ×2.0 (`DMG_SCALE`).** At ×1.0, 26% of battles timed out and the average battle ran 62 s. Stalls were cleric-healed blobs and armoured knights against archers.
2. **Clerics got a weak staff attack** (9 magic, used when nobody needs healing). Armies reduced to clerics only could otherwise never finish a battle.
3. **Cavaliers and Pegasus are backline raiders** (the new `raider` trait). They pick ranged, healer and artillery targets with a large bias and a longer search radius. Before this change, backline mages dealt over 5000 damage while taking 0, and the ranged strategy beat rush 100%.
4. **Bots play "sensibly":**
   - Every flavoured strategy multiplies its preferences by √(counter score against the enemy's last army).
   - Every strategy answers fliers with anti-air and cavalry with pikes.
   - Without this, the per-unit metric mostly measured which bot bought the unit. For example, archers at 25% power still showed 64%.
5. **Counter multipliers trimmed:**
   - Archers ×3 vs fliers became ×2.0, with range 28 m → 25 m, squad 10 → 9, and damage 9 → 6 at a slower attack interval.
   - Ballista ×3 vs Large became ×2.5.
   - Trebuchet splash 6 m → 5 m.
   - Mage damage 30 → 19 and splash 3 m → 2.5 m.
   - Even after these cuts, archers remain the strongest unit by the metric. A cheap backline is valuable in early, small armies.
6. **Lords:**
   - Meteor damage (70+14·lvl) → (50+10·lvl). Meteor wiped militia blobs, so Marshal lost to Archmage 76%.
   - Archmage stats trimmed.
   - Rally widened from 15 m / 8 s to 20 m / 10 s, with a shorter cooldown.
   - Hero power multipliers: Marshal 205, Archmage 48, Warden 118, Skylady 78 (re-tuned in the QA pass, see above). These only scale the Lord hero unit; the passives and signature units are unchanged.
7. **Legendaries:**
   - Bloodthirst: heal per kill 30% → 12%, stacks 5 → 3.
   - Undying Oath: revive at 30% → 50% HP.
   - Hydra Volley: extra hits at 55% damage.
   - Lifebinder: 2% → 1.5% HP per second.
   - Ember Crown: now 40+5·ilvl damage in a 3.5 m radius.
   - Sunfire: now 20+2·ilvl dps in a 4 m radius.
   - Windrunner: also +25% attack speed, and its first strike deals ×3.
   - Warhorn: +3 soldiers for squads of 6 or more; +35% stats for squads of 1–2.
   - Gravebloom: cap 6 → 10 skeletons.
8. **Per-unit power multipliers.** `src/sim/data/balance.ts` holds a multiplier per unit. Each one is applied to HP, damage and heal, so a unit's power scales with the square of its multiplier. The tuner clamps them to [70, 150] so no unit becomes useless in duels:
   - archers 70, mages 70, ballista 70, trebuchet 73, dragon 106, golem 110
   - pikemen 111, knights 115, wyvern 126, pegasus 128, clerics 128
   - militia 133, berserkers 144, cavaliers 150

## Deviations from DESIGN

- **Keep damage.** Each surviving squad deals 22 × cost tier × (1 + level) / 2, the Lord deals 30 × (9 + lvl) / 10, and the winner of a wipe adds **70 × round** (DESIGN says 50 × round; a points win deals the survivors' damage only). The larger base was needed to bring matches from 13 rounds down to 7–12.
- **Post-wipe march.** After a wipe, survivors march on the keep at double speed for up to 15 s. Any keep damage not yet delivered is settled in a final `keepHit` event. The HP removed always equals the formula.
- **Lord level-up stats.** Each Lord level adds +10% HP and +8% damage.
- **Lord XP.** Lords earn XP from kills by the whole army plus a round bonus, not only from the Lord's own kills.
- **Warhorn.** +2 squad size became +3 / +1, or +35% stats for squads of 1–2. A flat +2 would triple a Golem.
- **Brace.** Pikemen negate the charge bonus and take 30% less melee damage from mounted units.
- **"Weak to hammers."** This is implemented as `crushing` attacks: the Golem and the Trebuchet ignore half of armour and deal ×1.5 to armored units.

## Known gaps

- The per-unit metric is still partly confounded by bot behaviour: archers are bought reactively and early. It is a design-health signal, not a proof of balance.
- Lord samples are about 1100 games each, so ±3% is noise. Re-run with `--seeds 6` before a release.
- Only Hard repositions squads and moves items between squads. No bot sells.
- About 15% of battles end as early stalemates, mostly fliers against an army with no anti-air left. These battles used to time out at 90 s, so battles are now shorter on average, but more rounds are decided on points.
