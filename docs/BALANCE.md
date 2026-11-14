# Oathbound v2: balance report

The numbers come from `node tools/tournament.ts --seeds 3 --best`. That run has 28 entries: 7 bot strategies × 4 Lords. Every entry plays every other entry from both seats, on 3 seeds each, for 2268 matches. It takes about 2 minutes on 18 worker threads. The report also prints the match-length histogram and the margin-of-victory distribution.

To re-tune, run `node tools/tournament.ts --seeds 1 --tune N`. It rewrites the multipliers in `src/sim/data/balance.ts`.

## Final report (DESIGN §8 targets)

The main run here is `node tools/tournament.ts --seeds 5 --best` (3780 matches), for larger item samples.

Rules as of the equal-conditions pass (DESIGN §0): no catch-up of any kind, one free unlock a round from the full
list, one shared loot offer per round on a fixed rarity schedule, a battle with no random rolls, plus the item skills
(DESIGN §5b), sudden death from round 10 and the three vs-AI levels (`best` = `hard`).

| Metric | Result | Target |
|---|---|---|
| Side advantage (P0 win rate) | **49.7%** | < 52/48 ✅ |
| Average match length | **10.3 rounds** (median 10, 95th percentile 12, longest 19) | 9–12 ✅ |
| Average battle length | 48.2 s; 17.7% end with both armies standing (14.4% as early stalemates) | 30–60 s ✅ |
| Lords | Marshal **49.0%**, Archmage **51.2%**, Warden **49.5%**, Skylady **50.3%** | 45–55% ✅ |
| Lord share of its army's damage | **21.1%** overall: Marshal 20.5%, Archmage 26.8%, Warden 17.6%, Skylady 19.6% | ≤ 25% on average ✅ (Archmage 26.8%, was 28.8%) |
| Units (cost-normalised) | **43.0%** (pikemen) to **59.2%** (dragon) | 40–60% ✅ |
| The `air` strategy | **41.5%** against the others (it was 21.4%) | 40–50% ✅ |
| Legendaries (wearer metric) | 12 of 14 in band; Hydra Volley **67.9%**, Bloodthirst **64.0%** | 40–60% ❌ for two, and not fixable by tuning: see below |
| Item skills (against a plain Rare) | 11 of 12 measurable within ±9; Thunderous Charge **+17.9** | ±9 ❌ for one, same cause: see below |
| Blowouts (winner above 75% keep life) | **51.5%** overall; **24.4%** hard vs hard, **46.9%** normal vs normal | reported |
| Ladder | Hard beats Normal **77%**, Normal beats Easy **93%**, Hard beats Easy 97% | > 65%, > 75% ✅ |

**Match length.** 8 rounds: 5.7%, 9: 23.7%, 10: 29.0%, 11: 25.4%, 12: 13.3%, 13: 2.2%, 14 or more: 0.7%.

**Blowouts: mostly a skill mismatch.** A blowout is a match the winner ends with more than 75% of its keep.

| Pairing | Mean keep left | 0–24% | 25–49% | 50–74% | 75–100% (blowout) |
|---|---|---|---|---|---|
| All 28 tournament entries (mixed bots) | 68.0% | 10.8% | 15.2% | 22.5% | **51.5%** |
| Hard vs Hard (360 matches) | 52.3% | 18.3% | 28.3% | 28.9% | **24.4%** |
| Normal vs Normal (360 matches) | 67.2% | 9.4% | 11.9% | 31.7% | **46.9%** |
| Easy / Normal / Hard ladder | 75.3% | 7.0% | 12.7% | 18.0% | 62.3% |
| For reference: old catch-up rules, mixed bots | 55.2% | 14.9% | 23.5% | 35.6% | 26.0% |

Two equally strong planners (Hard vs Hard) blow each other out as rarely as the old catch-up rules did overall
(24% against 26%), with no help for the loser. Normal vs Normal is still at 47%: Normal never re-forms its army,
so the side that falls behind keeps making the same placement.

**The symmetric lever was tried and rejected.** Halving the round bonus in rounds 1–4 (rising to the full bonus
from round 5) made equal-level blowouts no better:

| | Before | After (half round bonus in rounds 1–4) |
|---|---|---|
| Hard vs Hard | 25.3% | 26.9% |
| Normal vs Normal | 48.3% | 56.7% |

A gentler early curve mostly means the eventual winner has lost less keep by the time it wins, which is exactly what
the blowout figure counts. It was reverted; the keep-damage curve is unchanged.

**Units.** Each figure is the cost-normalised share of the unit in the round winner's army, against its share in the loser's army.

| Unit | Win rate | Unit | Win rate |
|---|---|---|---|
| militia | 46.6 | mages | 49.7 |
| pikemen | 43.0 | clerics | 48.9 |
| berserkers | 50.1 | pegasus | 54.6 |
| archers | 50.5 | ballista | 50.2 |
| knights | 43.4 | trebuchet | 56.0 |
| cavaliers | 48.5 | golem | 50.4 |
| wyvern | 58.0 | dragon | 59.2 |

**Fliers are viable again.** With free unlocks everyone can take Archers, and the `air` strategy had fallen to 21%.
The changes: Archers ×2 → ×1.25 against fliers, Ballista ×2.5 → ×2 against Large, a new flat rule that shots from
the ground lose 15% against fliers, and Pegasus 138 → 150, Wyvern 130 → 140, Dragon 93 → 86. `air` now wins
41.5% against the field (70% against armor, 48% against rush, 44% against ranged, 38% against counter, 37% against
random, 12% against Hard). Archers fell from 58.3% to 50.5%. The price is at the other end: the `armor` strategy is
down to 33%, and knights and pikemen sit at 43%.

**Legendaries.** Both players are offered the same legendary in the same round, so the old head-to-head measure
(armies holding the same number of different legendaries) has almost no samples (n < 40). The figure is the round
win rate of an army wearing the legendary against one that does not, leaving out battles between Hard and a weaker bot.

| Legendary | Win rate | n | Legendary | Win rate | n |
|---|---|---|---|---|---|
| hydra volley | **67.9** | 134 | undying oath | 52.9 | 342 |
| bloodthirst | **64.0** | 136 | sunfire | 51.1 | 458 |
| stormcaller | 59.5 | 126 | warhorn | 48.6 | 210 |
| frostheart | 58.2 | 91 | mirror aegis | 46.5 | 391 |
| earthshaker | 56.0 | 141 | windrunner | 45.6 | 423 |
| lifebinder | 55.5 | 211 | gravebloom | 44.1 | 263 |
| kingsbane | 54.1 | 133 | ember crown | 42.6 | 202 |

- **Gravebloom** (39.1 → 44.1) and **Ember Crown** (40 → 42.6, and 32–35 in between) were buffed into the band:
  Gravebloom raises up to 14 skeletons (was 10) that are 40% tougher and stronger; Ember Crown deals
  90 + 12 per item level within 4.5 m (was 40 + 5 within 3.5 m).
- **Hydra Volley and Bloodthirst cannot be tuned into the band on this metric, because it does not measure their
  power.** The proof is a dud test: with Hydra Volley's extra hits set to 1% damage (no effect at all) it still
  read **63.4%**. At 55%, 40%, 30% and 25% it read 67.1, 66.7, 66.0 and 64.4. All six weapon legendaries read
  54–68%: the figure measures "an army that took the round's Legendary weapon and had a squad for it" against an
  army that took a Magic item instead. Hydra Volley's real contribution is the difference to the dud, about +4.5
  points at 40%. It was cut from 55% to 40% and left there; Bloodthirst went from 12% heal to 10%. The experimental
  cuts to Kingsbane, Frostheart and Stormcaller were reverted, since they were chasing the same artefact.

**Item skills.** "Wearer" is the round win rate of an army wearing the skill against one without it. "vs control"
compares it with armies wearing a plain Rare (no skill) in the same slot on a squad that could have used the skill
(same exclusion of Hard-vs-weaker battles).

| Skill | Wearer | vs control | Skill | Wearer | vs control |
|---|---|---|---|---|---|
| thunderous charge | 66.1 | **+17.9** | mending light | 53.9 | +3.3 |
| incendiary payload | 64.8 | +8.0 | frost nova | 51.8 | +1.7 |
| chain lightning | 60.7 | +2.3 | shield wall | 51.5 | −0.2 |
| dive strike | 59.4 | +1.1 | cleave | 51.2 | +2.1 |
| fireball | 57.6 | +0.6 | trample | 50.6 | +2.1 |
| pinning shot | 57.1 | (no control) | rain of arrows | 50.5 | −0.1 |
| fire arrows | 56.9 | (no control) | war cry | 54.7 | +0.6 |

- **Thunderous Charge is the same artefact.** With its damage set to 1 and no knockback it still read **+18.5**
  against the control (64.4% wearer). Its numbers were cut four times (45 + 8L down to 20 + 3L, radius 3 m → 2.5 m,
  cooldown 12 s → 16 s) and the figure went +11.4, +21.7, +18.4, +18.1. What the figure shows is that cavalry
  wearing a plain Rare weapon wins only 43%, not that the skill is strong. The skill's real contribution (the
  difference to the dud) is about +2 points. It is set to 30 + 5L within 3 m, a 2 m knockback and a 14 s cooldown.
- Twelve skills have a usable control and eleven are within ±9 of it. Archers almost never wear a plain Rare weapon,
  so Fire Arrows and Pinning Shot have no control (n = 28).
- The reliable way to measure one item is the dud test: run the tournament twice, once with the item's effect
  disabled, and compare the wearer's win rate. That would be a small tournament option; it is not built yet.

**Strategy matrix.** Win rate of the row strategy against the column strategy. `best` is the vs-AI Hard bot.

| | air | armor | best | counter | random | ranged | rush |
|---|---|---|---|---|---|---|---|
| air | 50 | 70 | 12 | 38 | 37 | 44 | 48 |
| armor | 30 | 50 | 21 | 33 | 35 | 61 | 17 |
| best | 88 | 79 | 50 | 79 | 81 | 84 | 75 |
| counter | 62 | 68 | 21 | 50 | 51 | 63 | 59 |
| random | 63 | 65 | 19 | 49 | 50 | 58 | 49 |
| ranged | 56 | 39 | 16 | 38 | 42 | 50 | 53 |
| rush | 52 | 83 | 25 | 41 | 51 | 48 | 50 |

Hard (`best`) wins 81.1% overall. With free unlocks and a shared loot offer, planning matters more than before.

**Lord matrix.** Win rate of the row Lord against the column Lord.

| | archmage | marshal | skylady | warden |
|---|---|---|---|---|
| archmage | 50 | 53 | 51 | 49 |
| marshal | 47 | 50 | 49 | 51 |
| skylady | 49 | 51 | 50 | 51 |
| warden | 51 | 49 | 49 | 50 |

## vs-AI difficulty ladder

`node tools/tournament.ts --strats easy,normal,hard --seeds 10` has 12 entries (3 levels × 4 Lords). Each pair plays from both seats, for 1320 matches. Win rate of the row level against the column level:

| | easy | normal | hard |
|---|---|---|---|
| easy | 50 | 7 | 3 |
| normal | **93** | 50 | 23 |
| hard | 97 | **77** | 50 |

The targets are met: Hard beats Normal 77% (target over 65%), and Normal beats Easy 93% (target over 75%). All
three levels play by the new rules: they choose from the same shared loot offer and from the full unlock list
(Easy at random, Normal and Hard by counter value). Easy ignores skill items, Normal equips each on its most
valuable squad that can use it, and Hard weighs every skill by how often its trigger will hold against the enemy's
last army. Earlier ablations of Hard against Normal (14 seeds) show what separates them:

- Item-aware gearing is worth about +7 points. Without it (using Normal's "most valuable squad" rule instead), Hard won 55%.
- Preferring the stronger affordable unit when scores are close is worth about +6 points.
- The counter-formation is roughly neutral against Normal's fixed lanes (±3 points, within noise). It stays because it answers a player who doesn't move squads (pikes in front of their cavalry, archers under their fliers), and it is what makes Hard re-form every round.
- Hard's level-ups use the simple "cheapest relative upgrade first" order, and a squad that opens a slot for a waiting item jumps the queue. A "counter merit per gold" order tested about 4 points worse.

All three levels see only `viewFor`: their own state plus the enemy's previous-round army. `tests/sim.rules.test.ts` checks that changing the enemy's hidden current state does not change Hard's plan.

## Equal-conditions pass (what changed and why)

The user's principle: both players always face identical conditions and options, and the outcome comes from their
choices. Everything that helped one player, or rolled something for one player only, is gone.

1. **Economy.** Removed: catch-up gold (`75 + 10 × round + 3 × deficit`), the underdog's extra deployment, the
   loser's loot-rarity bump and the win-streak mercy multiplier. Income is one schedule for both. `CATCHUP_*` are 0
   and `PlayerState.comeback` is always zeros (kept so older UI code keeps working).
2. **Unlocks.** No random drafts: every round, round 1 included, a player unlocks any ONE locked unit whose
   `minRound` has come (round 1: from the basic pool). A match now starts with 3 unit types, not 4. The anti-air
   guarantee went with the drafts (anyone can pick Archers).
3. **Loot.** One shared offer per round (seeded by the match and the round): one item per slot, on a fixed rarity
   schedule (Magic ×3; from round 3 one Rare; from round 6 two; from round 9 three; a Legendary every 3rd round,
   visiting each slot in turn). No usable-slot or class bias, no rarity rolls. Common items are no longer offered.
4. **Battle.** No random rolls at all. Critical hits come on a per-soldier counter (+crit% per attack, critical at
   100), forest cover is a flat −40% ranged damage instead of a 40% miss chance, and the first-attack stagger no
   longer uses the seed. Expected damage is unchanged.
5. **Lords re-tuned** for the new rules (no underdog deployments made Marshal's +1 deploy much stronger: he read
   64% untouched):
   - Marshal: hero multiplier 165 → 142, Rally +45% → +40%;
   - Archmage: hero 48 → 43, Meteor (26 + 4·lvl) → (18 + 3·lvl), passive magic damage +30% → +76%. Her share of
     her army's damage went 28.8% → 26.8%; it is still the highest, because her own fireballs splash;
   - Warden: hero 118 → 135; Skylady: 78 → 70 (the flier changes lift her signature Pegasus).
6. **Units:** militia 133 → 139, pikemen 111 → 114, berserkers 144 → 142, knights 115 → 118, clerics 128 → 127,
   pegasus 128 → 150, trebuchet 73 → 72, golem 110 → 103, wyvern 126 → 140, dragon 106 → 86; Archers ×2 → ×1.25
   against fliers, Ballista ×2.5 → ×2 against Large, shots from the ground −15% against fliers.
7. **Skills:** Trample 28 + 5L → 36 + 6L, Rain of Arrows 9 + 2L → 11 + 2L per wave, Thunderous Charge 40 + 7L on a
   12 s cooldown with a 2.5 m knockback → 30 + 5L on 14 s with 2 m.
8. **Legendaries:** Hydra Volley 55% → 40%, Bloodthirst 12% heal → 10%, Gravebloom 10 → 14 stronger skeletons,
   Ember Crown 40 + 5·ilvl within 3.5 m → 90 + 12·ilvl within 4.5 m.

## Skills pass and QA pass 2 (earlier; what still stands)

1. **Item skills** (DESIGN §5b): 14 class-gated active skills granted by Rare items, auto-cast on a cooldown when
   their trigger holds. Tuning on the way: Frost Nova 16 + 3L within 6 m → 28 + 5L within 7 m; Mending Light
   8 + L % every 10 s → 14 + L % every 8 s, triggered below 70% instead of 60%; Rain of Arrows moved from the relic
   slot (Lv4) to the armor slot (Lv2); Incendiary Payload 9 + 2L for 5 s → 6 + L for 4 s on a 14 s cooldown.
2. **Stalemates no longer stall the match.** A points win counts in full (survivors plus the round bonus), and the
   stall windows are 10 s instead of 15 s.
3. **Sudden death.** Keep damage grows 25% a round from round 10, for both seats alike. (The mercy rule and the
   anti-air draft guarantee from that pass were removed again by the equal-conditions pass.)
4. **Lords are strong but do not carry.** Lord XP thresholds are 1.6 times higher (Lv10 at 1375 XP), and Lord power
   moved from the hero's stats to the passive and the army-wide ability. A Lord deals 21.1% of its army's damage.
5. **Siege.** Trebuchet damage 120 → 105.
6. **Keep damage is clamped** to the life the Keep has left (result, `keepHit` events and history).
7. **Conceding** ends the match with the opponent as the winner (`concede`, `overReason: 'concede'`).

## Fairness between the two seats

Seat fairness holds by construction, not just statistically. `tests/sim.mirror.test.ts` swaps the seats, mirrors both armies through the field centre and checks that the battle replays as the exact mirror image. It compares every soldier's position, HP, animation and facing on every keyframe, every round of 4 bot matches. How this works:

- **Positions.** A stored int `p` means `p + 0.5 cm`, so the mirror `x → 7999 − x` is an exact integer map with no fixed point.
- **Division.** All division truncates, which is sign-symmetric; there are no `>>` shifts on signed values. Squad centroids are kept in doubled, centred coordinates.
- **Order-independent ticks.** Each tick is "Jacobi": everything reads the tick-start snapshot, and damage, heals, buffs and deaths accumulate and apply at the end of the tick. So it doesn't matter which seat is processed first.
- **No RNG in the battle.** Nothing is rolled. The crit counter and the first-attack stagger are keyed by the squad's index in its own army and the soldier's index in the squad, never by the seat or the seed.
- **Identical offers.** Loot, unlock options, income and the deployment limit are the same for both players each round (`tests/sim.rules.test.ts`, "equal conditions").
- **Terrain and pathing.** Only seat 0's half of the terrain is generated; seat 1's half is its cell-for-cell mirror. Seat 1's flow field is seat 0's, mirrored.

The remaining 48.9% vs 51.1% split is sampling noise from the bots' seat-salted jitter.

## QA-pass changes (round outcomes, comeback, slots, AI levels)

1. **Stalemates end early, and timeouts are decided on points.** A battle where one side had nothing that could target the other's remaining units used to run the full 90 s, for example a lone wyvern over golems with no anti-air. Now the battle ends early in three cases:
   - neither side can target the other;
   - one side has been helpless for 15 s;
   - nobody has dealt damage for 15 s.

   Timeouts and stalls are decided on points: the percent of army value still standing, with a 5-point margin. The points winner's survivors deal their keep damage, and since the skills pass the round base too. (The catch-up this pass tied to a lost round no longer exists.)
2. **Comeback** (removed again by the equal-conditions pass). The flat +75 catch-up became `75 + 10 × round + 3 × keep-HP deficit (points)`, and a player 25 or more points behind also got an extra squad deployment. Blowouts fell from 42% to 29% of matches while it lasted.
3. **Item slots** now open at Lv1 / Lv2 / Lv4 (they were Lv1 / Lv3 / Lv5). (The usable-slot loot bias of that pass is gone: every offer now holds one item per slot.)
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
   - Meteor damage (70+14·lvl) → (50+10·lvl), then (26+4·lvl), now (18+3·lvl). Meteor wiped militia blobs, so Marshal lost to Archmage 76%.
   - Archmage stats trimmed.
   - Rally widened from 15 m / 8 s to 20 m / 10 s, with a shorter cooldown.
   - Hero power multipliers: Marshal 142, Archmage 43, Warden 135, Skylady 70 (Marshal was 205 until the skills pass). These only scale the Lord hero unit; the passives and signature units are unchanged.
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
   - archers 70, mages 70, ballista 70, trebuchet 72, dragon 86, golem 103
   - pikemen 114, knights 118, clerics 127, wyvern 140
   - militia 139, berserkers 142, cavaliers 150, pegasus 150

## Deviations from DESIGN

- **Keep damage.** Each surviving squad deals 22 × cost tier × (1 + level) / 2, the Lord deals 30 × (9 + lvl) / 10, and the round winner (by a wipe or on points) adds **70 × round** (DESIGN says 50 × round). The larger base was needed to bring matches from 13 rounds down to 7–12.
- **Post-wipe march.** After a wipe, survivors march on the keep at double speed for up to 15 s. Any keep damage not yet delivered is settled in a final `keepHit` event. The HP removed always equals the formula.
- **Lord level-up stats.** Each Lord level adds +10% HP and +8% damage.
- **Lord XP.** Lords earn XP from kills by the whole army plus a round bonus, not only from the Lord's own kills. Lv10 needs 1375 XP.
- **Skill loot.** No new item bases: a Rare item has a 50% chance to grant a skill in place of its last affix (the UI's base-icon table stays complete). Legendaries keep their power instead of a skill.
- **Warhorn.** +2 squad size became +3 / +1, or +35% stats for squads of 1–2. A flat +2 would triple a Golem.
- **Brace.** Pikemen negate the charge bonus and take 30% less melee damage from mounted units.
- **"Weak to hammers."** This is implemented as `crushing` attacks: the Golem and the Trebuchet ignore half of armour and deal ×1.5 to armored units.

## Known gaps

- The per-unit metric is still partly confounded by bot behaviour: archers are bought reactively and early. It is a design-health signal, not a proof of balance.
- Lord samples are about 1100 games each, so ±3% is noise. Re-run with `--seeds 6` before a release.
- Only Hard repositions squads and moves items between squads. No bot sells.
- About 16% of battles end as early stalemates, mostly fliers against an army with no anti-air left. They are decided on points, and a points win now deals full keep damage, so they no longer slow the match down.
- **Blowouts** are 51.5% with mixed bots but 24.4% between two Hard bots: mostly a skill mismatch. Normal vs Normal is 46.9%. A gentler early keep-damage curve was tried and made it worse (see the blowout tables).
- **Hydra Volley (67.9%), Bloodthirst (64.0%) and Thunderous Charge (+17.9)** read outside their bands, and dud tests show the readings do not depend on their power. A per-item ablation option in the tournament (run with the item's effect off, compare) is the missing tool.
- **The `armor` strategy wins 33%** and knights and pikemen are at 43%, the low end of the band, after the flier buffs. That is the next thing to look at.
- **The Archmage** deals 26.8% of her army's damage (the four-Lord average is 21.1%; the target is 25%).
- A match starts with 3 unit types now (the Lord's two plus one unlock), so round 1 armies are narrower.
- The item metrics are confounded by who takes and can use the round's best item; the control column is the better guide when tuning a skill.
