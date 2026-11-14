# Oathbound v2: balance report

The numbers come from `node tools/tournament.ts --seeds 3 --best`. That run has 28 entries: 7 bot strategies × 4 Lords. Every entry plays every other entry from both seats, on 3 seeds each, for 2268 matches. It takes about 2 minutes on 18 worker threads.

To re-tune, run `node tools/tournament.ts --seeds 1 --tune N`. It rewrites the multipliers in `src/sim/data/balance.ts`.

## Final report (DESIGN §8 targets)

| Metric | Result | Target |
|---|---|---|
| Side advantage (P0 win rate) | **50.9%** | < 52/48 ✅ |
| Average match length | **11.3 rounds** | 7–12 ✅ |
| Average battle length | 54.7 s (11.7% timeouts) | 30–60 s ✅ |
| Lords | Marshal **48.9%**, Archmage **54.1%**, Warden **46.5%**, Skylady **50.6%** | 45–55% ✅ |
| Units (cost-normalised) | **44.6%** (pikemen) to **58.4%** (archers) | 40–60% ✅ |
| Legendaries | **42.3%** (Mirror Aegis) to **54.5%** (Warhorn) | 40–60% ✅ |

**Units.** Each figure is the cost-normalised share of the unit in the round winner's army, against its share in the loser's army.

| Unit | Win rate | Unit | Win rate |
|---|---|---|---|
| militia | 48.0 | mages | 51.3 |
| pikemen | 44.6 | clerics | 44.9 |
| berserkers | 47.6 | pegasus | 50.4 |
| archers | 58.4 | ballista | 53.9 |
| knights | 45.2 | trebuchet | 54.4 |
| cavaliers | 47.4 | golem | 50.6 |
| wyvern | 52.6 | dragon | 54.8 |

**Legendaries.**

| Legendary | Win rate | Legendary | Win rate |
|---|---|---|---|
| warhorn | 54.5 | sunfire | 50.4 |
| kingsbane | 54.1 | undying oath | 49.3 |
| hydra volley | 53.6 | ember crown | 49.2 |
| lifebinder | 53.5 | windrunner | 48.7 |
| bloodthirst | 50.8 | gravebloom | 48.5 |
| earthshaker | 50.6 | stormcaller | 47.4 |
| frostheart | 45.6 | mirror aegis | 42.3 |

Each legendary has n ≈ 300–760 samples. Legendaries are compared head-to-head, counting only battles where both armies hold the same number (at least one) of legendaries. Raw presence is biased because round losers roll one rarity tier higher, so legendaries pile up on the losing side and every one of them read 30–45%.

**Strategy matrix.** Win rate of the row strategy against the column strategy.

| | air | armor | best | counter | random | ranged | rush |
|---|---|---|---|---|---|---|---|
| air | 50 | 57 | 38 | 32 | 48 | 25 | 64 |
| armor | 43 | 50 | 45 | 33 | 48 | 50 | 44 |
| best | 63 | 55 | 50 | 48 | 45 | 48 | 58 |
| counter | 68 | 67 | 52 | 50 | 48 | 50 | 76 |
| random | 52 | 52 | 55 | 52 | 50 | 46 | 58 |
| ranged | 75 | 50 | 52 | 50 | 54 | 50 | 61 |
| rush | 36 | 56 | 42 | 24 | 42 | 39 | 50 |

Overall, strategy win rates range from 39.8% (rush) to 60.1% (counter). Air beats rush, rush beats armor and armor beats air. Counter-picking pays off, which is the Mechabellum arms-race the design asks for.

**Lord matrix.** Win rate of the row Lord against the column Lord.

| | archmage | marshal | skylady | warden |
|---|---|---|---|---|
| archmage | 50 | 53 | 57 | 52 |
| marshal | 47 | 50 | 44 | 55 |
| skylady | 43 | 56 | 50 | 53 |
| warden | 48 | 45 | 47 | 50 |

The vs-AI `best` bot is the counter-picker. It was the top strategy, so `botPlan(s, seat, 'best')` uses the counter logic.

## Fairness between the two seats

Seat fairness holds by construction, not just statistically. `tests/sim.mirror.test.ts` swaps the seats, mirrors both armies through the field centre and checks that the battle replays as the exact mirror image. It compares every soldier's position, HP, animation and facing on every keyframe, every round of 4 bot matches. How this works:

- **Positions.** A stored int `p` means `p + 0.5 cm`, so the mirror `x → 7999 − x` is an exact integer map with no fixed point.
- **Division.** All division truncates, which is sign-symmetric; there are no `>>` shifts on signed values. Squad centroids are kept in doubled, centred coordinates.
- **Order-independent ticks.** Each tick is "Jacobi": everything reads the tick-start snapshot, and damage, heals, buffs and deaths accumulate and apply at the end of the tick. So it doesn't matter which seat is processed first.
- **Seat-free RNG.** Random rolls are `hash(seed, tick, canonical key, salt)`. The key is built from the squad's index in its own army and the soldier's index in the squad, never from the seat.
- **Terrain and pathing.** Only seat 0's half of the terrain is generated; seat 1's half is its cell-for-cell mirror. Seat 1's flow field is seat 0's, mirrored.

The remaining 50.9% vs 49.1% split is sampling noise from the bots' seat-salted jitter.

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
   - Hero power multipliers: Marshal 174, Archmage 60, Warden 113, Skylady 78. These only scale the Lord hero unit; the passives and signature units are unchanged.
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

- **Keep damage.** Each surviving squad deals 22 × cost tier × (1 + level) / 2, the Lord deals 30 × (9 + lvl) / 10, and the round winner adds **70 × round** (DESIGN says 50 × round). The larger base was needed to bring matches from 13 rounds down to 7–12.
- **Post-wipe march.** After a wipe, survivors march on the keep at double speed for up to 15 s. Any keep damage not yet delivered is settled in a final `keepHit` event. The HP removed always equals the formula.
- **Lord level-up stats.** Each Lord level adds +10% HP and +8% damage.
- **Lord XP.** Lords earn XP from kills by the whole army plus a round bonus, not only from the Lord's own kills.
- **Warhorn.** +2 squad size became +3 / +1, or +35% stats for squads of 1–2. A flat +2 would triple a Golem.
- **Brace.** Pikemen negate the charge bonus and take 30% less melee damage from mounted units.
- **"Weak to hammers."** This is implemented as `crushing` attacks: the Golem and the Trebuchet ignore half of armour and deal ×1.5 to armored units.

## Known gaps

- The per-unit metric is still partly confounded by bot behaviour: archers are bought reactively and early. It is a design-health signal, not a proof of balance.
- Lord samples are about 1100 games each, so ±3% is noise. Re-run with `--seeds 6` before a release.
- Bots never reposition existing squads, sell, or move items between squads.
