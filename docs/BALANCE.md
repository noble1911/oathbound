# Oathbound v2: balance report

The gated numbers come from `node tools/tournament.ts --fields hard:60,normal:60,classic:2 --full --seed0 300000`: Hard
against Hard and Normal against Normal (12 Lords, 7920 matches each) and the classic tournament of the six bot
strategies (10 224 matches). Every entry plays every other entry from both seats. `--full` prints the whole report per
field: the match-length histogram, the margin of victory, and the per-unit and per-legendary tables.

To re-tune:
- the game's numbers, on Hard: `node tools/tournament.ts --fields hard:24 --tune N --tune-what units,lords,factions`;
- the weaker planners' per-Lord reserve: `--fields normal:40 --tune N --tune-what reserve` and `--fields classic:2 ...`.

Both rewrite `src/sim/data/balance.ts`. Run one tuner at a time.

## Addendum: the Sun Mirror (2026-11-17, not yet re-tuned)

The Caliphate's Siege unit (`sun_mirror`, DESIGN §4b) went in after the report below, with only its own `UNIT_POWER`
set (70). No other lever moved; the follow-up pass re-tunes `FACTION_POWER`, the Lords and the reserves. Sanity run:
`OB_THREADS=12 node tools/tournament.ts --fields hard:60,normal:60,classic:2 --full --seed0 300000`.

| | Hard | Normal | Classic | Gate |
|---|---|---|---|---|
| Sun Mirror (unit) | 55.4 (n=3004) | 55.9 (n=3341) | 50.1 (n=3502) | 40–60% |
| Kingdom | 47.6 | 44.6 ⚠ | 47.6 | 46–54% |
| Ashen | 46.9 | 46.5 | 48.2 | 46–54% |
| Caliphate | 55.5 ⚠ | 59.0 ⚠ | 54.2 ⚠ | 46–54% |
| Lords, lowest to highest | 44.0 (lich) to 56.4 (rajah) | 39.2 (archmage) to 62.3 (sultana) | 44.6 (archmage) to 56.4 (sultana) | 45–55% |
| Seat 0 / rounds | 48.8 / 8.76 | 49.6 / 8.70 | 50.2 / 8.81 | |

Deploy share among Caliphate deploys (`tools/review/picks.ts --seeds 4`): 6.8% on Hard, 7.5% on Normal (the Sand
Golem: 7.1% / 8.8%). Its `UNIT_POWER` was walked down from 100 (unit 62.4 / 61.5 / 56.2) through 82 (57.9 / 58.3 /
53.1) and 65 (52.1 / 53.0 / 49.8) on a small field (`hard:12,normal:12,classic:1`). On that field the Caliphate without
the Sun Mirror scored 50.5 / 49.1 / 48.6, and with it at 65 it scored 52.7 / 56.8 / 54.1. Most of the faction's gain
is therefore structural: the Caliphate now has an answer to Magic, which the planners use (Normal most of all). That is
`FACTION_POWER` work, not more cuts to this one unit.

## Current report: counter wheel and item rework (2026-11-17)

The balance pass after the counter wheel, weighted deploys, swarm levelling and the item rework (commit `c832694`,
`docs/reviews/GAMEPLAY-2026-11-16.md`). Three fields are gated, all on seeds tuning never saw (`--seed0 300000`):

```
node tools/tournament.ts --fields hard:60,normal:60,classic:2 --full --seed0 300000
```

`--fields` runs several fields in one go: `hard` and `normal` are one level against itself (12 Lords, 7920 matches
each), and `classic` is the mixed field of the six tournament strategies (`npm run tournament`, 72 entries, 10 224
matches).

### Gates

| Gate | Hard vs Hard | Normal vs Normal | Classic tournament | Target |
|---|---|---|---|---|
| Matches | 7920 | 7920 | 10224 | |
| Seat-0 win rate | **49.1%** | **49.6%** | **50.3%** | < 52% |
| Kingdom vs the other two | **50.9%** | **50.3%** | **51.0%** | 46–54% |
| Ashen vs the other two | **51.0%** | **49.7%** | **50.9%** | 46–54% |
| Caliphate vs the other two | **48.1%** | **49.9%** | **48.0%** | 46–54% |
| Lords, lowest to highest | 45.6 (vizier) to 53.5 (archmage) | 47.3 (archmage) to 54.0 (vizier) | 46.8 (vizier) to 52.5 (deathknight) | 45–55% |
| Units (n >= 100) | 43.2 (ballista) to 57.2 (wraith_rider) | 39.5 (pikemen) to 61.7 (djinn_binder) | 40.1 (wraith_rider) to 60.1 (war_elephant) | 40–60% |
| Legendaries (wearer win rate) | 44.2 (gravebloom) to 58.6 (lifebinder) | 43.8 (gravebloom) to 57.3 (sunfire) | 44.5 (gravebloom) to 55.6 (sunfire) | 40–60% |
| Average match length | **8.70** rounds | **8.68** rounds | **8.75** rounds | 8-11 |
| 95th percentile / longest | 10 / 12 | 11 / 16 | 11 / 17 | 95% done by round 12 |
| Past round 12 | 0.0% | 0.8% | 1.5% | rare |
| Blowouts (winner above 75% keep) | 28.8% | 46.2% | 50.1% | reported |
| Lord share of army damage | 15.5% | 17.8% | 17.7% | <= 25% |

Before this pass (commit `c832694`):
- Hard vs Hard was already inside the gates: Lords 44.5-55.5%, Kingdom 48.1, Ashen 51.2, Caliphate 50.6, 8.75 rounds.
- Normal vs Normal: Kingdom 34.8%, Ashen 60.5%, Caliphate 54.7%; Lords from 28.4% (Grand Vizier) to 77.3% (Death
  Knight, Roc Rider).
- Classic tournament: Kingdom 39.7%, Caliphate 62.8%; Sultana 77%, Roc Rider 64%, Ossuary Warden 61%, Marshal about 30%.

### What was wrong with Normal

The classic planner (Normal and the six tournament strategies) did not read the wheel the way Hard does. Four things,
found by swapping Hard's parts into Normal one at a time (`--strats normal`, 792 matches each):

| Normal with... | Kingdom | Ashen | Caliphate | Lord spread |
|---|---|---|---|---|
| nothing changed | 35.7 | 59.1 | 55.2 | 24-77 |
| Hard's unit score | 43.5 | 53.1 | 53.4 | 35-64 |
| Hard's re-forming | 35.4 | 64.6 | 50.0 | 23-80 |
| Hard's gearing | 36.7 | 59.1 | 54.2 | - |
| no reserve | 38.0 | 50.3 | 61.7 | 25-79 |

1. **Its own counter formula.** `unitScore` weighed a unit against the whole enemy army. Hard's score discounts every
   threat its own army already answers. Without that discount Normal bought the same counter class again and again
   and walked into the class that beats it. The Kingdom has the widest roster and the most ways to do this.
2. **Stale equalisers.** `CLASSIC_PREF`, the classic column of `LORD_PLAY`, `ARCHMAGE_CASTERS` and the Roc Rider's
   archer weight of 2.0 were tuned before the wheel to even the Lords out at Normal. Under the wheel they made Normal
   play Lords against their own passive (the Archmage wanted casters *less*, 0.9) while the game's numbers were
   re-tuned on Hard alone.
3. **Class-locked legendaries wasted.** Normal picked loot by fit but equipped by squad value, so a "Best on" legendary
   landed on a squad of the wrong class, where its power does nothing.
4. **Placement ignored the wheel.** A new squad went to the next lane in deploy order, whatever stood opposite.

### What changed

**Bots (`src/sim/bot.ts`).**
- **One unit score for every level** (`unitScore`). Hard, Normal and the tournament strategies now share the wheel
  reading: counter value against the part of the enemy's last army that the own army does not already answer, less
  what that army does to the unit. The levels differ in skill, not in rules: score noise (Hard 10%, tournament
  strategies 20%, Normal 30%), Hard's lean to the dearer unit, the reserve, re-forming and gearing.
  `CLASSIC_PREF`, `ARCHMAGE_CASTERS` and the classic column of `LORD_PLAY` are gone.
- **Normal places by the wheel** (`wheelLane`): a new squad goes to its role's row, opposite the enemy squads its
  class beats. It still never re-forms squads already placed (that is Hard's skill), except archers under fliers.
- **Normal gears by fit** (`bestSquadFor`): a class-locked legendary is worth 35% on a squad it does not work on.
- **Saving up** (`saveFor`, every level). Income is 225-500 a round, so a bot that spends everything every round can
  never afford a 500-gold Dragon: Hard unlocked it 158 times and fielded it 0 times. A bot now holds back this round's
  change when the unit it wants most is out of reach now, in reach next round, and scores 1.2 times the best unit it
  can afford. Hard with saving beats Hard without it 60:40. The classic planner also pays for the Dragon out of its
  reserve.
- **Healers are scored for what they do** (`HEALER_WORTH`). A healer counters nothing, so the counter score never
  wanted one (Clerics: 13 deploys in 264 matches). A first healer is now worth 1.3 plus 1.6 times the share of the army
  that fights hand to hand.
- **Inside a class** (`wheelCv`): a braced unit is worth 0.7 more against a charge, a raider 0.7 more against a
  backline unit. This is what tells Pikemen from Knights and Pegasus Knights from Wyverns: Pikemen went from 58
  deploys to 138, Pegasus Knights from 34 to 231 (528 Hard matches).
- **A flier the enemy cannot reach** is worth 0.5 more (`AIR_FREE_CV`).
- **Flavoured strategies read the wheel in full.** `rush`, `ranged`, `armor` and `air` used to take the square root of
  the counter value, so `air` bought fliers into a wall of bows and the units it loves read 30-40% in the field for
  the strategy's sake. They now multiply the full counter value by a milder taste (4 → 2.2-2.5, the rest 0.7).
- **The reserve per Lord** (`NORMAL_RESERVE`, `CLASSIC_RESERVE` in `src/sim/data/balance.ts`, per mille of gold).
  The game's numbers are balanced on Hard against Hard. A weaker planner still gets more out of some Lords than
  others, and the share of gold it keeps back is the one lever that moves a Lord's rate predictably at that level
  (about one point per 1% of reserve; Hard with a 12% reserve wins 39% against Hard, with 25% it wins 27%). It
  replaces the unit-preference tables that did this job before. `--tune-what reserve` tunes it.

  | Lord | Normal | Tournament strategies |
  |---|---|---|
  | marshal | 28.3% | 6.1% |
  | archmage | 30.7% | 27.8% |
  | warden | 23.6% | 8.2% |
  | skylady | 11.9% | 3.0% |
  | lich | 26.1% | 29.6% |
  | deathknight | 32.6% | 32.8% |
  | ossuary | 15.4% | 22.9% |
  | drakerider | 31.2% | 25.8% |
  | sultana | 32.5% | 38.6% |
  | vizier | 0.0% | 0.5% |
  | rajah | 27.3% | 32.7% |
  | rocrider | 30.3% | 11.9% |

  The Grand Vizier is the floor of both tables: Normal plays him about 20 points worse than Hard does at equal
  reserve, so the others keep more instead and the tables' means are high (Normal 24%). That makes Normal a
  little weaker overall than before, but the ladder holds.

**Numbers.**
- `FACTION_POWER`: Kingdom 964 → 914, Ashen 1045 → 1008, Caliphate 1006 → 1097.
- `LORD_POWER`: marshal 171 → 135, archmage 40 → 61, warden 125 → 126, skylady 65 → 54, lich 94 → 83, deathknight 161 → 146, ossuary 78 → 77, drakerider 85 → 105, sultana 172 → 158, vizier 42 → 60, rajah 91 → 113, rocrider 123 → 77.
- `UNIT_POWER` was re-tuned to the mean of the three fields (`--fields hard:24,normal:24,classic:1 --tune N
  --tune-what units`); its range is now 60-170. The multipliers are in `src/sim/data/balance.ts`.
- **Clerics** heal 34 → 46. With 34, Hard with Clerics won exactly 50% against Hard without them: fielding a healer
  was worth nothing. With 46 it is worth about 4 points (Hard without healers wins 46%, Kingdom Lords, 512 matches).
  Sun Priests were already worth it (Hard without them wins 39% among Caliphate Lords) and are unchanged.
- **Archmage**: magic damage +70% → **+55%**. Her body was at the floor of `LORD_POWER` (40) and she still read 58%
  at Hard. **Sultana**: squads attack 8% → **12%** faster. Her body was at the ceiling (180) and she read 37%.
- The Dragon is worth its price once bots can buy it: Hard without the Dragon wins 46% among Kingdom Lords.
- No rule changed. The Ossuary Warden stays a **Giant** (his body is the largest Lord model, DESIGN §3): Swarm beats
  him, he beats Line, and with `LORD_POWER` 77 he reads 50.3% at Hard, 49.3% at Normal and 49.7% in the tournament.

### Lords, units and legendaries

| Lord | Hard | Normal | Classic |
|---|---|---|---|
| Marshal Aldric | 49.0 | 53.0 | 51.1 |
| Archmage Sefa | 53.5 | 47.3 | 51.6 |
| Warden Hrolf | 51.1 | 49.9 | 50.3 |
| Skylady Ione | 49.0 | 50.7 | 50.1 |
| Lich-Priest Morthen | 51.8 | 50.6 | 50.4 |
| Death Knight Vaelric | 52.7 | 51.4 | 52.5 |
| Ossuary Warden Gorrath | 50.3 | 49.3 | 49.7 |
| Drake Rider Nyssara | 48.0 | 47.9 | 50.1 |
| Sultana Zahira | 50.5 | 48.2 | 50.1 |
| Grand Vizier Kasim | 45.6 | 54.0 | 46.8 |
| Rajah Bahadur | 49.3 | 50.0 | 49.3 |
| Roc Rider Amira | 49.1 | 47.7 | 48.2 |

| Unit | Hard | Normal | Classic |
|---|---|---|---|
| militia | 47.6 | 45.9 | 53.7 |
| knights | 45.7 | 52.2 | 54.8 |
| cavaliers | 47.8 | 46.8 | 52.5 |
| mages | 49.5 | 54.0 | 53.1 |
| golem | 51.0 | 52.9 | 54.5 |
| trebuchet | 45.1 | 46.6 | 54.3 |
| clerics | 46.5 | 45.7 | 49.7 |
| ballista | 43.2 | 45.1 | 49.9 |
| pegasus | 48.1 | 47.2 | 45.2 |
| archers | 47.1 | 48.2 | 51.5 |
| wyvern | 51.8 | 47.7 | 40.2 |
| dragon | 55.3 | 56.8 | 53.2 |
| berserkers | 45.8 | 54.2 | 55.1 |
| skeleton | 48.3 | 41.9 | 48.8 |
| grave_acolyte | 45.3 | 48.4 | 54.9 |
| bone_golem | 51.4 | 51.6 | 49.7 |
| bone_drake | 52.6 | 47.9 | 45.9 |
| bone_archer | 47.6 | 47.8 | 52.5 |
| wraith_rider | 57.2 | 56.9 | 40.1 |
| spear_levy | 52.3 | 47.3 | 41.4 |
| camel_archer | 52.8 | 46.7 | 47.4 |
| mamluk | 48.9 | 57.7 | 53.2 |
| djinn_binder | 51.8 | **61.7** ⚠ | 50.0 |
| corpse_catapult | 49.7 | 47.7 | 57.6 |
| grave_knight | 49.6 | 45.4 | 52.3 |
| djinn | 55.6 | 54.2 | 42.0 |
| sand_golem | 53.8 | 54.5 | 50.4 |
| sun_priest | 48.4 | 50.9 | 50.0 |
| war_elephant | 46.0 | 56.0 | **60.1** ⚠ |
| scimitar | 55.4 | 55.7 | 46.2 |
| pikemen | 50.5 | **39.5** ⚠ | 49.0 |

| Legendary | Hard | Normal | Classic |
|---|---|---|---|
| bloodthirst | 51.5 | 49.8 | 49.5 |
| earthshaker | 45.8 | 49.7 | 50.1 |
| ember_crown | 50.5 | 48.4 | 51.4 |
| frostheart | 52.6 | 51.5 | 51.3 |
| gravebloom | 44.2 | 43.8 | 44.5 |
| hydra_volley | 50.8 | 52.1 | 53.2 |
| kingsbane | 48.7 | 48.0 | 48.5 |
| lifebinder | 58.6 | 55.4 | 54.0 |
| mirror_aegis | 48.0 | 48.9 | 46.4 |
| stormcaller | 48.6 | 48.7 | 51.1 |
| sunfire | 51.4 | 57.3 | 55.6 |
| undying_oath | 53.4 | 50.3 | 50.6 |
| warhorn | 47.8 | 50.9 | 50.1 |
| windrunner | 46.8 | 44.5 | 44.9 |

Match lengths:
- Hard: 6r 1.6%, 7r 10.2%, 8r 30.2%, 9r 36.4%, 10r 18.2%, 11r 3.1%, 12r 0.2%.
- Normal: 6r 4.0%, 7r 16.3%, 8r 25.9%, 9r 28.1%, 10r 16.9%, 11r 6.6%, 12r 1.5%, 13r 0.5%, 14r 0.2%, 15r 0.1%, 16r 0.0%.
- Classic: 6r 4.0%, 7r 17.5%, 8r 25.2%, 9r 25.0%, 10r 15.9%, 11r 8.0%, 12r 3.0%, 13r 1.2%, 14r 0.2%, 15r 0.0%, 16r 0.0%, 17r 0.0%.

Faction pairings (row beats column):
- Hard: Kingdom v Ashen 49.6%, Kingdom v Caliphate 52.2%, Ashen v Caliphate 51.5%.
- Normal: Kingdom v Ashen 54.3%, Kingdom v Caliphate 46.4%, Ashen v Caliphate 53.7%.
- Classic: Kingdom v Ashen 51.2%, Kingdom v Caliphate 50.9%, Ashen v Caliphate 53.0%.

Classic strategies: ranged 68.8%, counter 59.5%, armor 49.2%, rush 45.2%, random 44.9%, air 32.4%.

### Ladder

`node tools/tournament.ts --strats easy,normal,hard --seeds 4 --seed0 600000` (5040 matches):

| | Twelve-Lord report | Now | Target |
|---|---|---|---|
| Hard beats Normal | 83% | **85%** | > 65% |
| Normal beats Easy | 95% | **92%** | > 75% |
| Hard beats Easy | 98% | 98% | |

### Every unit gets used

`node tools/review/picks.ts --seeds 4` (528 matches; `--strat normal` for Normal). Share of each unit among the
deploys of its own faction:

| Unit | Hard: deploys (share) | Normal: deploys (share) | `counter` strategy: deploys (share) | Hard before (264 matches) |
|---|---|---|---|---|
| militia | 1082 (27.4%) | 1115 (25.0%) | 1187 (23.1%) | 415 |
| pikemen | 138 (3.5%) | 352 (7.9%) | 450 (8.7%) | 58 |
| berserkers | 47 (1.2%) | 202 (4.5%) | 236 (4.6%) | 137 |
| archers | 524 (13.3%) | 655 (14.7%) | 863 (16.8%) | 323 |
| knights | 235 (6.0%) | 196 (4.4%) | 192 (3.7%) | 234 |
| cavaliers | 353 (8.9%) | 301 (6.8%) | 329 (6.4%) | 149 |
| mages | 309 (7.8%) | 287 (6.4%) | 384 (7.5%) | 181 |
| clerics | 227 (5.8%) | 297 (6.7%) | 315 (6.1%) | 13 |
| pegasus | 231 (5.9%) | 308 (6.9%) | 374 (7.3%) | 34 |
| ballista | 66 (1.7%) | 199 (4.5%) | 231 (4.5%) | 92 |
| trebuchet | 179 (4.5%) | 96 (2.2%) | 109 (2.1%) | 103 |
| golem | 335 (8.5%) | 287 (6.4%) | 340 (6.6%) | 145 |
| wyvern | 96 (2.4%) | 45 (1.0%) | 56 (1.1%) | 70 |
| dragon | 123 (3.1%) | 113 (2.5%) | 80 (1.6%) | 0 |
| skeleton | 1183 (31.1%) | 1177 (28.6%) | 1326 (26.4%) | 490 |
| grave_knight | 374 (9.8%) | 495 (12.0%) | 600 (11.9%) | 327 |
| bone_archer | 685 (18.0%) | 876 (21.3%) | 1208 (24.0%) | 387 |
| wraith_rider | 296 (7.8%) | 306 (7.4%) | 363 (7.2%) | 123 |
| grave_acolyte | 328 (8.6%) | 348 (8.4%) | 473 (9.4%) | 159 |
| bone_drake | 371 (9.7%) | 329 (8.0%) | 365 (7.3%) | 87 |
| corpse_catapult | 279 (7.3%) | 289 (7.0%) | 324 (6.4%) | 182 |
| bone_golem | 290 (7.6%) | 301 (7.3%) | 365 (7.3%) | 146 |
| spear_levy | 812 (23.4%) | 748 (21.2%) | 992 (22.3%) | 273 |
| scimitar | 369 (10.6%) | 450 (12.7%) | 598 (13.4%) | 219 |
| camel_archer | 289 (8.3%) | 302 (8.6%) | 430 (9.7%) | 131 |
| mamluk | 417 (12.0%) | 445 (12.6%) | 525 (11.8%) | 179 |
| djinn_binder | 327 (9.4%) | 375 (10.6%) | 466 (10.5%) | 200 |
| sun_priest | 324 (9.3%) | 337 (9.5%) | 406 (9.1%) | 37 |
| djinn | 438 (12.6%) | 414 (11.7%) | 441 (9.9%) | 182 |
| war_elephant | 194 (5.6%) | 97 (2.7%) | 197 (4.4%) | 142 |
| sand_golem | 297 (8.6%) | 362 (10.3%) | 392 (8.8%) | 204 |

The least used unit is berserkers at Hard (1.2%), wyvern at Normal (1.0%) and wyvern for the `counter` strategy (1.1%).

### Economy and placement checks

- **Loot** (Hard, `picks.ts`): pick share by slot: weapon 32.9%, armor 36.1%, relic 31.0%. Take rate per legendary when offered: ember_crown (15.4%) to earthshaker (52.8%); none is taken more than 60% of the time. Normal: pick share by slot: weapon 25.0%, armor 53.9%, relic 21.1%.
- **Tall vs wide** (`matches.ts --variants wide,tall --seeds 4`, a variant against shipped Hard): wide | 46.5 ± 3.0 | 53.4 | 8.80 | 3.4; tall | 0.8 ± 0.5 | 10.1 | 6.50 | -93.1 (columns: match win %, round win %, average rounds, keep margin).
- **Economy** (`econ.ts`): Totals: deploys 69.7% of spend, level-ups 30.3%; mean unspent after planning 30 gold.
- **Chaos** (`chaos.ts --seeds 2`): how often the round result flips when a whole army is shifted by 1 cm / 10 cm / 1 m / 3 m, or one squad by 1 m (columns: share of battles, then the five flip rates). All battles: `all battles               | 100.0% | 10.9% | 12.4% | 15.7% | 19.7% | 8.5%`.

### Tried and rejected

| Change | Result |
|---|---|
| Tuning one set of numbers to the mean of Hard and Normal | The levels disagree by 8 points per faction and up to 17 per Lord (Vizier 45 at Hard, 28 at Normal); no shared number fits both |
| Normal's Lords evened out by score noise instead of reserve | Hard with Normal's noise still wins 48%: too weak a lever |
| The classic planner saves as eagerly as it buys (margin 1.0), or pays for 400-gold giants out of its reserve | Normal's Lords move by up to 12 points and swing 10 points between seed sets |
| Hard without its cost lean, its re-forming, its gearing or its giant unlock bonus | None of them explains why Hard plays the Caliphate worse than Normal does (Caliphate 39-44% in each) |
| No Lord affinity for Normal's Vizier | +5 points for him; not kept, one more per-level table for one Lord |

### Open

- **Three unit rates sit on the edge of 40–60%.** Normal: Pikemen 39.5% and Djinn-Binders 61.7%. Tournament: War
  Elephant 60.1%. All three are inside the band at Hard (Pikemen 51, Djinn-Binders 52, War Elephant 46), so they are
  how those planners use the unit, not the unit: more Pikemen power (117 to 136) moved Normal's rate by one point.
- **The reserve tables are high.** Normal keeps nothing (Grand Vizier) to about a third of its gold, 24% on average,
  because the Vizier is so much weaker in Normal's hands than in Hard's. A reserve is a delay, not a loss (unspent gold
  carries over), and the ladder holds, but a Normal that understood the Vizier would let the whole table come down.
  The tournament strategies' table is as wide; those bots are a yardstick, nobody plays against them.
- **The Caliphate has no Siege unit**, so nothing in its roster beats Magic on the wheel (noted in the gameplay
  review; no unit was added). It is covered by numbers: its `FACTION_POWER` is the highest (1097 against the Kingdom's
  914), and it reads 48-50% at all three levels. Against casters it leans on Mamluks and Djinn reaching the backline.
- **Tall still loses to wide** (0.8% for one deployment a round against shipped Hard): the deploy points are the
  binding limit, as before this pass.
- **Seed and chaos sensitivity.** The Lord matrix is rock-paper-scissors (single pairings read 5-95%), so a Lord's
  rate moves in steps of a matchup: the same configuration reads up to 4 points apart on two seed sets, and a small
  change to any planner moves several Lords at once. Re-check at 60 seeds before trusting a change.
- **Legendaries**: Gravebloom (44) and Windrunner (44-47) are the weakest and Lifebinder (58.6 at Hard) the strongest;
  all are inside 40–60% at every level.
- **Flavoured strategies** still spread widely in the tournament (see the strategy line above); they are not gated.

## Previous report: twelve Lords (2026-11-15)

Six Lords joined, so each faction now has four, one in each role (DESIGN §4). Each new Lord mirrors the Kingdom Lord
of the same role, so the numbers stay comparable. Its passive and its ability each have one distinct mechanic.

| Lord | Role (mirrors) | Passive | Ability (cooldown) |
|---|---|---|---|
| Death Knight Vaelric (Ashen) | infantry (Marshal) | Infantry squads (and he) +15% damage | **Soul Reaping** (15 s): allies within 20 m drain 35% of the damage they deal as life for 10 s |
| Ossuary Warden Gorrath (Ashen) | armour (Warden) | Keep +500 HP; squads +12 armour | **Grave Taunt** (17 s): if 3 or more enemies are within 10 m, they must attack him for 5 s, and he takes 40% less damage meanwhile |
| Drake Rider Nyssara (Ashen) | fliers (Skylady) | Squads move 10% faster | **Plague Breath** (17 s): dives onto the densest cluster within 30 m; 120% of her damage as magic in 4.5 m, then a plague of 10 (+1 per level) a second for 3 s |
| Grand Vizier Kasim (Caliphate) | magic (Archmage) | Magic squads attack 20% faster | **Djinn Whirlwind** (16 s): spins 4 s on the densest cluster within 40 m; 10 (+2 per level) magic a second in 5 m, and a 40% slow |
| Rajah Bahadur (Caliphate) | armour and giants (Warden) | Giants (and he) +20% life and +10 armour | **Stampede** (15 s): charges through the nearest ground enemy within 12 m; 40 (+6 per level) to everything within 2.8 m of the path, thrown 2 m aside |
| Roc Rider Amira (Caliphate) | fliers (Skylady) | Archer squads +25% damage | **Talon Strike** (17 s): seizes the toughest enemy within 30 m that is not Large; 250% of her damage, dropped 8 m towards her lines, stunned 1.5 s |

Every Ashen Lord is now undead, not only the Lich-Priest, so sunlight burns all of them for 50% more. The abilities
are integer-only and seat-symmetric. `tests/sim.lords.test.ts` covers the effect and determinism of each, and
`tests/sim.mirror.test.ts` covers the mirror (eight ability arenas and six bot matches).

There are now 12 Lords and 144 Lord pairings. Hard vs Hard and Normal vs Normal are
`node tools/tournament.ts --strats hard --seeds 100` (and `--strats normal`), on fresh seed sets (`--seed0 300000`
and `500000`) that tuning never saw. Each run is 13 200 matches: n = 3200 per cross-faction pairing (about ±1.8
points) and 2200 per Lord (about ±2.1).

### Gates

| Gate | Hard vs Hard | Normal vs Normal | Target |
|---|---|---|---|
| Kingdom vs Ashen | **51.5%** | **49.2%** | 45–55% ✅ |
| Kingdom vs Caliphate | **49.5%** | **53.0%** | 45–55% ✅ |
| Ashen vs Caliphate | **54.7%** | **45.6%** | 45–55% ✅ |
| Factions vs the other two | Kingdom 50.5, Ashen 51.6, Caliphate 47.9 | Kingdom 51.1, Ashen 48.2, Caliphate 50.7 | |
| Seat advantage | **49.2%** | **49.5%** | < 52% ✅ |
| Average match length | **8.43** rounds | **8.71** rounds | 8–9 ✅ |
| Past round 12 | 0.0% (longest 14) | 0.7% (longest 15) | rare ✅ |
| Lord share of army damage | 13.7% | 14.9% | ≤ 25% ✅ |
| Blowouts (winner above 75% keep) | 36.6% | 51.8% | reported |

| Lord | Hard | Normal |
|---|---|---|
| Marshal Aldric | 51.2 | 53.9 |
| Archmage Sefa | 49.5 | 51.0 |
| Warden Hrolf | 50.0 | 47.7 |
| Skylady Ione | 50.8 | 50.6 |
| Death Knight Vaelric | 49.4 | 46.7 |
| Lich-Priest Morthen | 51.7 | 54.7 |
| Ossuary Warden Gorrath | 54.2 | **44.6** ⚠ |
| Drake Rider Nyssara | 49.4 | 48.7 |
| Sultana Zahira | 52.2 | 51.8 |
| Grand Vizier Kasim | 45.3 | 49.8 |
| Rajah Bahadur | 47.9 | 49.5 |
| Roc Rider Amira | 48.5 | 50.8 |

Every Lord is within 45–55% at both levels except the Ossuary Warden at Normal, at 44.6% (0.4 below the band, inside
the ±2.1 error). Hard's Grand Vizier, at 45.3%, is at the edge.

Match lengths:
- Hard: 6r 5.0%, 7r 17.2%, 8r 29.5%, 9r 29.8%, 10r 15.6%, 11r 2.7%, 12r 0.2%.
- Normal: 6r 5.2%, 7r 16.2%, 8r 24.6%, 9r 25.1%, 10r 17.8%, 11r 7.9%, 12r 2.5%, 13r+ 0.7%.

**Ladder** (`--strats easy,normal,hard --seeds 10 --seed0 600000`, 12 600 matches):

| | Now | Target |
|---|---|---|
| Hard beats Normal | **83%** | ≥ 65% ✅ |
| Normal beats Easy | **95%** | ≥ 75% ✅ |
| Hard beats Easy | 98% | |

**Units** (n ≥ 100):
- Hard: 38.9% (scimitar) to 57.8% (archers). Outside that: militia at 28% (n = 188, rarely bought at Hard), and the
  Dragon at 71% (n = 43).
- Normal: 39.0% (ballista) to 61.0% (grave knights). Outside that: clerics at 30.5% (n = 291), which were already the
  outlier in the last pass at 29%.
- Wraith Riders read 57% at both levels, and Bone Drakes 59% at Normal.

**The Lord matrix is rock-paper-scissors.** Single Lord pairings range from 5% to 96%. Each cell is n = 200 here, and
because the bots are deterministic, one pairing tends to go the same way. Some examples at Hard:
- the Ossuary Warden beats the Drake Rider 96%;
- the Grand Vizier beats the Ossuary Warden 92%;
- the Rajah loses to the Death Knight 9%.

The gates are per Lord and per faction, and those even out. A human player sees the enemy's Lord before planning and
can answer it. The full 12 × 12 matrices are in the tournament output.

### What changed

**Rules and numbers.** No rule of the last pass moved: the margin-scaled round bonus, the level costs and slots, and
Hard's speed stagger are unchanged.
- `FACTION_POWER`: Kingdom 964 → 962, Ashen 1062 → 1066, Caliphate 976 → 987.
- `LORD_POWER`:
  - Marshal 125 → 118, Archmage 43 → 40, Warden 130 → 135, Skylady 65 → 68, Lich 95 → 99, Sultana 115 → 126.
  - New: Death Knight 113, Ossuary Warden 130, Drake Rider 73, Grand Vizier 45, Rajah 108, Roc Rider 98.
- The ability numbers in the table above were set over about 30 tournament runs. For example, the Vizier's haste went
  from 40% to 20%, the Rajah's giant life from 20% to 10% and back to 20%, and Plague Breath from 120% to 150% and back
  to 120%.

**Bots** (`src/sim/bot.ts`):
- **Lord pick.** All levels pick uniformly from the 12 Lords, which is a third per faction. The server's timer pick
  stays within the chosen faction.
- **Playing to the passive** (`LORD_PLAY`). Under a new Lord, each level wants that Lord's favoured units more: the Death
  Knight's infantry, the Ossuary Warden's armour, the Drake Rider's fast units, the Vizier's magic, the Rajah's giants
  and the Roc Rider's archers. The weights are per level, Hard first and then the classic planner:
  - Death Knight 1.2 / 0.9
  - Ossuary Warden 1.2 / 1.3
  - Drake Rider 1.1 / 1.0
  - Grand Vizier 1.35 / 1.2
  - Rajah 1.5 / 0.8
  - Roc Rider 1.3 / 2.0

  At Normal a higher weight often meant a lower win rate, because Normal over-concentrates. For example, the Roc
  Rider read 75% at 1.0 and 55% at 2.0. So these weights also even out a Lord's Hard and Normal rates.
- **Lord placement.** Hard places a Lord by role: the Skylady flanks; the Drake Rider flies with the army, because
  Plague Breath wants a melee crowd; the Roc Rider stands with the bows. Normal (`placeFor`) starts a flying or
  shooting Lord behind the army; a lone flier sent ahead met every bow, which put the Skylady and the Drake Rider at
  35–41% at Normal. It also puts the Ossuary Warden in the front line.
- **Normal answers a flying or Large enemy Lord.** `lordStandIn` treats the Skylady, the Drake Rider and the Roc Rider
  as a Pegasus worth 300 gold, and the Rajah as a Golem. Normal's anti-air placement now covers a flying Lord who
  shoots (the Roc Rider), because she hangs over her backline all battle. Hard's archers weigh a flying Lord at a
  third of a flier squad.
- **Gear.** The tank Lords (the Warden, the Ossuary Warden and the Rajah) share the Warden's gear valuation
  (`TANK_LORDS`).
- **`CLASSIC_PREF`** was re-tuned for Normal by a coordinate search (`tournament --strats normal` on a fixed seed set,
  each knob ×1.25 or ×0.8 in turn, minimising the gate deviations), then by hand:

  | Unit | Before | Now |
  |---|---|---|
  | djinn-binder | 1.35 | 0.95 |
  | scimitar | 1.25 | 1.1 |
  | djinn | 1.2 | 1.05 |
  | skeleton | 0.7 | 1.0 |
  | bone drake | 1.3 | 1.1 |
  | bone archer | 1.3 | 1.25 |

  `ARCHMAGE_CASTERS` went from 1.15 to 0.9.

### Tried and rejected

| Change | Result |
|---|---|
| Rajah's signature Scimitar + Sand Golem (not a basic unit), or Scimitar + Spear Levy | 67% / 14% at Hard; Scimitar + Mamluk kept |
| Hard places the Ossuary Warden or the Rajah in the front row | Ossuary 57 → 64%, Rajah 44 → 38% at Hard |
| No Lord affinity at all | Rajah 30% at Hard, Ossuary 74% |
| Hard Rajah giant weight 1.15 / 2.0 | 38% / 30% (1.5: 44–51%) |
| Lowering Wraith Rider preference at Normal (0.75–0.8) | Ashen collapses at Normal (Kingdom vs Ashen 55–58%) |

### Open

- **Normal's cycle.** At Normal the factions form a mild cycle: Ashen edges the Kingdom, the Caliphate beats the
  Ashen, and the Kingdom edges the Caliphate. It is inside the band now (49 / 53 / 46), but small changes to the
  classic planner swing it by 5 or more points.
- **The Ossuary Warden at Normal** reads 44.6%. He needs the enemy around him, and the classic planner does not fight
  for that.
- **Seed sensitivity.** The same configuration read up to 4 points apart on two 40-seed sets. Re-check every Lord
  number at 100 seeds before trusting a change.
- **Older open items.** Clerics at Normal (31%), and tall against wide (see below).

## Previous report: after the positioning-and-economy pass (2026-11-15, six Lords)

The numbers in this section are from before the six new Lords; the section above is current.


This pass worked through the balancing items of `docs/reviews/POSITIONING-AND-ECONOMY.md`: a full refund for a
same-round sale, a round bonus scaled by the winning margin, flat level-up costs with earlier item slots, bots that
level, and Hard's speed stagger. Every figure below is from the final build. Hard vs Hard and Normal vs Normal are
`node tools/tournament.ts --strats hard --seeds 200` (and `--strats normal`): 6000 matches, n = 1600 per Kingdom
pairing and 400 for Ashen vs Caliphate (about ±2.5 and ±5 points).

### Rule changes (DESIGN §1, §2, §5)

| Rule | Before | Now |
|---|---|---|
| Selling in the round of purchase | refunds 50% | refunds everything spent on the squad (an undo); later rounds still refund nothing |
| Round bonus to keep damage | 70 × round for any win | 70 × round × min(1, margin / 40 points) (`roundBonus`, `ROUND_BONUS_FULL_MARGIN`); the survivors' own damage is unchanged |
| Level-up cost | unit cost × current level (Lv5 = 11× in all) | 40% of the unit cost at every level (`LEVEL_COST_PCT`; Lv5 = 2.6× in all) |
| Item slots | armour at Lv2, relic at Lv4 | armour at Lv1, relic at Lv3 |
| Per-level gains | +25% life, +20% damage | unchanged |

`KEEP_DMG_BASE_PER_ROUND` (70) and sudden death (+25% a round from round 8) did not need re-tuning. Cheaper levels
make survivors hit the keep harder, which made up for the smaller bonus on narrow wins.

### Hard vs Hard: every gate met

| Metric | Before this pass | Now | Target |
|---|---|---|---|
| Kingdom vs Ashen | 45.6% | **54.3%** | 45–55% ✅ |
| Kingdom vs Caliphate | 51.4% | **49.9%** | 45–55% ✅ |
| Ashen vs Caliphate | 47.0% | **51.5%** (n = 400) | 45–55% ✅ |
| Lords | Marshal 52.5, Archmage 47.4, Warden 49.5, Skylady 48.1, Lich 52.9, Sultana 49.5 | Marshal **52.3**, Archmage **52.0**, Warden **49.8**, Skylady **49.3**, Lich **46.9**, Sultana **49.8** | 45–55% ✅ |
| Seat advantage | 49.9% | **49.5%** | < 52% ✅ |
| Match length | avg 8.41, nothing past 11 | avg **8.49**; 6r 4.2%, 7r 15.0%, 8r 29.6%, 9r 33.7%, 10r 14.2%, 11r 2.9%, 12r 0.4%; 0.0% past 12 | avg 8–9 ✅ |
| Battle length | 46.3 s | 42.6 s | reported |
| Blowouts (winner above 75% keep) | 33.6% | 30.2% | reported |
| Level-ups' share of spend | 6.1% | **26.8%** (`econ.ts`) | 20–35% ✅ |

Units at Hard (n ≥ 100): 39.4% (mages) to 59.9% (bone golem). Mages (39.4) and cavaliers (41.5, already at the
150 cap) sit at the bottom edge, where they were before this pass too (38.7 and 43.2). The Dragon reads 72% on n = 30.

### Normal vs Normal: every gate met

| Metric | Before this pass | Now | Target |
|---|---|---|---|
| Kingdom vs Ashen | 47.8% | **49.4%** | 45–55% ✅ |
| Kingdom vs Caliphate | 47.3% | **49.3%** | 45–55% ✅ |
| Ashen vs Caliphate | 46.0% | **51.5%** (n = 400) | 45–55% ✅ |
| Lords | Marshal 51.5, Archmage 47.0, Warden 50.9, Skylady 46.6, Lich 50.9, Sultana 53.0 | Marshal **53.3**, Archmage **52.1**, Warden **46.6**, Skylady **46.9**, Lich **50.8**, Sultana **50.2** | 45–55% ✅ |
| Seat advantage | 51.1% | **50.3%** | < 52% ✅ |
| Match length | avg 8.57, 0.1% past 12 | avg **8.83**; 6r 4.1%, 7r 16.5%, 8r 23.3%, 9r 24.2%, 10r 18.1%, 11r 9.0%, 12r 3.4%, 13r 1.0%, 14r+ 0.4%; **1.4%** past 12 | avg 8–9 ✅ |
| Blowouts | 41.9% | 51.2% | reported |
| Level-ups' share of spend | (not measured) | **20.2%** | 20–35% ✅ |

Units at Normal (n ≥ 100): 43.8% (trebuchet) to 62.6% (bone archers), except **clerics at 29% (n = 205)**. Archers
(61.4) and bone archers (62.6) are both at the 70 floor of `UNIT_POWER`. Clerics were already the weakest Normal unit
before the cleric rule below (31% on n = 1670). Normal now skips a healer while its army is under three squads,
which is when most of those losing clerics were bought.

### Ladder and mixed field

| | Before | Now | Target |
|---|---|---|---|
| Hard beats Normal | 76% | **84%** | ≥ 65% ✅ |
| Normal beats Easy | 91% | **96%** | ≥ 75% ✅ |
| Hard beats Easy | 96% | 99% | |

The ladder is `--strats easy,normal,hard --seeds 10` (3060 matches). The mixed field (`--seeds 3 --best`, 5166
matches) is secondary: factions 49.6–50.5%, seat 50.8%, 8.40 rounds, and Lords from 44.2 (Warden) to 55.7 (Skylady).
The `air` strategy fell to 20.8% (was 36.8%) and `rush` reads 37.3%, so the flavoured strategies are the open item there.

### Economy and levelling (`tools/review/matches.ts`, `econ.ts`)

Whole matches against the shipped Hard bot (20 seeds, 1200 matches per variant, ±2.8):

| Line | Before | Now |
|---|---|---|
| `wide`: never level | 47.7% | **50.0%** |
| `tall`: one deployment a round, the rest into levels | 17.2% | **43.4%** |
| `lateLevel`: no levels before round 6 | 52.2% | 58.0% |
| `bank`: hold back 40% in rounds 1–4 | 42.5% | 50.7% (10 seeds) |

- Tall and wide are 6.6 points apart (target about ±5). At the 10-seed check they read 51.5 and 42.8, and before the
  final re-tune 47.8 and 45.0.
- Idle items in the stash at round 8 fell from 2.17 to 0.04. The average squad level at round 10 rose from 1.14 to
  2.12.
- `lateLevel` shows that Hard levels a little too early. A Hard that levels nothing before round 4 wins 56–58%
  against the shipped one. But it moved the Hard faction and Lord table by up to 18 points (Ashen vs Caliphate 68%,
  Archmage 60%), so it waits for a re-tune of its own (`HARD_LEVEL_FROM` is 1).

### What changed for the bots (src/sim/bot.ts)

- **Hard levels instead of recruiting when it pays.** At each spending step it compares the best new squad with the
  best level-up (`hardLevelPick`). A level-up is valued by the squad's counter value against the enemy's last army,
  a little less for every level the squad already has, and more when the next level opens a slot for an item that is
  waiting. The level-up wins when its value × 0.5 (`HARD_LEVEL_BIAS`) beats the buy. The bias sets the level share:
  0.4 gives 21%, 0.6 gives 34% and 1.0 gives 48%.
- **Hard staggers its melee by speed** (`speedStagger`). The slowest melee squad stands at the front row, and a squad
  twice as fast starts twice as far from the river, so the whole line arrives together. Against the pre-pass Hard
  under the new rules, this alone is worth +15.5 points (57.7% → 73.2%). The review's `sync` variant no longer beats
  Hard (73.7% → 48.5%).
- **Normal** changed in four ways:
  - It levels a squad instead of making a weak buy (`NORMAL_LEVEL_BIAS` 0.7).
  - When it deploys, slow melee goes half-way forward and fast melee half-way back, measured against a Knight's pace
    (`normalDepth`).
  - It skips clerics while its army is under three squads.
  - Its learnt preferences moved. Ashen: Skeleton Spearmen 0.7, Grave Knights 1.0, Wraith Riders 1.0, Bone Archers
    1.3, Bone Drakes 1.3. Caliphate: Djinn-Binders 1.35, Scimitars 1.25, Spear Levy 0.8. The Archmage's caster
    preference is 1.15 (it was 1.5).

### Numbers changed

- **Wraith Riders:** magic resistance −10 → **−40**, so they take 40% more magic damage. This moves Ashen against both
  magic-using factions, and it was the lever that took Ashen vs Caliphate from 63% to 51% at Hard.
- **The Sultana's sunlight** against the undead: +25% → **+50%** (`SULTANA_HOLY` 150). It moves Ashen vs Caliphate alone.
- `FACTION_POWER`: Kingdom 976 → 964, Ashen 1046 → 1062, Caliphate 966 → 976.
- `LORD_POWER`: Warden 160 → 130, Skylady 56 → 65. The Archmage is back at 43 after a detour; the others are unchanged.
- `UNIT_POWER` was tuned on Hard and Normal together (`--strats hard,normal --same --tune 5 --tune-what
  units,lords,factions`), then by hand:
  - Kingdom: militia 140 → 136, pikemen 134 → 129, berserkers 147 → 150, knights 125 → 110, cavaliers 140 → 150,
    mages 70 → 86, clerics 129 → 150, pegasus 140 → 119, ballista 75 → 92, trebuchet 74 → 73, golem 93 → 98,
    wyvern 138 → 122.
  - Ashen: skeleton 134 → 129, grave knight 126 → 130, wraith rider 130 → 123, grave acolyte 135 → 137,
    bone drake 71 → 70.
  - Caliphate: spear levy 140 → 124, scimitar 147 → 150, camel archer 115 → 127, mamluk 132 → 119,
    djinn-binder 84 → 100, djinn 95 → 94, sand golem 150 → 141.
- The tuner (`tools/tournament.ts --tune`) no longer moves a unit seen in fewer than 100 round-winner samples.

### Tried and rejected

| Change | Result | Why rejected |
|---|---|---|
| Stickier soldier targets: keep the target unless another is 1.5 m or 4 m nearer, or never switch while in reach | close-battle 10 cm flip 26.3%, 31.7%, 24.4% (base 25.9%) | no effect beyond noise (±5) |
| Macro-target hysteresis (5 m); squad focus on the macro target (4 m or 10 m bonus); retarget every 20 ticks | 23.3–33.0% | no effect |
| No straggler gate, or a proportional slow-down instead of the stop | 26.0% and 25.9% | no effect |
| A **1 cm** nudge of the whole army | flips 28.0% of close battles, the same as 10 cm | not a fix, a diagnosis: close battles are saturated chaos, and any perturbation randomises them |
| Ranged squads on hills or in forests within 15 m (Hard) | 50.3 ± 2.8% head-to-head (hills only: 50.6%) | not measurably good |
| Level costs of unit cost × (n + 1) / 2, +35/30% gains, and combinations (against the old Hard) | tall 11–19%, wide 40–52% | tall stayed hopeless: a squad with twice the stats is worth far less than two squads |
| Flat level cost of 35% (instead of 40%) | levels at 50% of spend beat the rest by 10 points | levels too strong; at 45% they became a trap |
| Normal's stagger at full strength, or none | Kingdom 65% at Normal, or Caliphate 64% | half strength balances them |
| Hard levelling only from round 4 | +6 points for Hard | moved the Hard table by up to 18 points; left for a re-tune |

### Open

- **Close battles remain coin flips.** A 10 cm nudge still flips 25% of them (the target is under 10%). The
  margin-scaled bonus makes such a flip cost less: a close win now deals 410 keep damage on average, against 733 for
  any win (it was 621 against 719). But no local targeting change reduced the flip rate itself.
- Tall and wide are 6.6 points apart, slightly outside ±5. Hard's levelling timing (above) is the next lever.
- Units: clerics at Normal (29%); bone archers and archers at the 70 floor (61–63% at Normal); mages at Hard (39%).
- The mixed field's `air` (21%) and `rush` (37%) strategies.

## Previous report: equal-level balance first (before the positioning-and-economy pass)

The rules, bots and numbers in this section are from before 2026-11-15; the section above is current.


Two humans play at the same level, so **equal-level play is the target** and the mixed bot field is secondary.

- Hard vs Hard: `node tools/tournament.ts --strats hard --seeds 200` (6 Lords, 6000 matches; n = 1600 per Kingdom
  pairing, 400 for Ashen vs Caliphate, about ±2.5 points). Normal vs Normal: the same with `--strats normal`.
- Mixed field: `--seeds 3 --best` (42 entries, 5166 matches). `--same` restricts any run to equal-level pairs,
  `--tune N --tune-what factions,lords` tunes on it, and `--strats hard,hardx` is the strength test below.

### Hard vs Hard (the proxy for two good players): every target met

| Metric | Result | Target |
|---|---|---|
| Kingdom vs Ashen Covenant | **45.6%** (n = 1600) | 45–55% ✅ (at the edge) |
| Kingdom vs Sun Caliphate | **51.4%** (n = 1600) | 45–55% ✅ |
| Ashen Covenant vs Sun Caliphate | **47.0%** (n = 400) | 45–55% ✅ |
| Lords | Marshal 52.5, Archmage 47.4, Warden 49.5, Skylady 48.1, Lich-Priest 52.9, Sultana 49.5 | 45–55% ✅ |
| Archmage's share of her army's damage | 23.3% | ≤ 25% ✅ |
| Seat advantage | **49.9%** (was 51.5–53.6% before the seat fix below) | < 52% ✅ |
| Match length | avg 8.41; 6r 4.0%, 7r 13.3%, 8r 34.3%, 9r 35.4%, 10r 12.3%, 11r 0.7%; nothing longer | avg 8–9 ✅ |
| Blowouts (winner above 75% keep) | 33.6% | reported |

### Strength test: Hard with the corrected counter table is the better player, and is now Hard

`hardx` is Hard with the other counter table. Head-to-head, every Lord pairing from both seats (n = 2160 cross matches):

| | Win rate |
|---|---|
| Corrected counters (`cvReal`) against the plain table, before adoption | **54.0%** |
| The adopted Hard against the old one (`hardx`), after re-tuning | **55.8%** |

So Hard now reads the counter table corrected by what units really are (no anti-cavalry value against a target that
is not mounted, steel is poor against heavy armour and ethereal riders, magic is good against them, and so on), and
the factions and Lords were re-tuned for it.

### Normal vs Normal: every target met

200 seeds, 6000 matches (n = 1600 per Kingdom pairing, 400 for Ashen vs Caliphate, about ±2.5 points). "Before" is
the start of this pass, on the same seeds.

| Metric | Before | Now | Target |
|---|---|---|---|
| Kingdom vs Ashen | 47.2% | 47.8% | 45–55% ✅ |
| Kingdom vs Caliphate | 56.1% | **47.3%** | 45–55% ✅ |
| Ashen vs Caliphate | 46.5% | 46.0% | 45–55% ✅ |
| Marshal | 44.8 | **51.5** | 45–55% ✅ |
| Archmage | 47.1 | 47.0 | 45–55% ✅ |
| Warden | 60.3 | **50.9** | 45–55% ✅ |
| Skylady | 50.4 | 46.6 | 45–55% ✅ |
| Lich-Priest | 51.5 | 50.9 | 45–55% ✅ |
| Sultana | 45.8 | **53.0** | 45–55% ✅ |
| Flier unit rates | Pegasus 58.3, Wyvern 58.1, Bone Drake 54.6, Djinn 50.0, Dragon 72 (n = 35) | Pegasus 58.1, Wyvern 57.7, Bone Drake 56.7, Djinn 56.3, Dragon 69 (n = 47) | ≤ 60% ✅ (the Dragon is too rare at Normal to judge) |
| Seat advantage | 50.8% | 51.1% | < 52% ✅ |
| Match length | 8.54 | 8.57; 6r 1.6%, 7r 14.9%, 8r 31.5%, 9r 32.5%, 10r 16.7%, 11r 2.5%, 0.1% past 12 | avg 8–9 ✅ |
| Blowouts | 45.1% | 41.9% | reported |

Hard vs Hard was re-run after the change and is identical to the table above, match for match (Hard does not use any
of the code that moved). Ladder (`--strats easy,normal,hard --seeds 10`): **Hard beats Normal 76%** (target ≥ 65%),
**Normal beats Easy 91%** (≥ 75%), Hard beats Easy 96%.

**Diagnosis.** Two hypotheses were given for the Caliphate's poor Normal play: fixed lanes waste its mobile units, and
Normal keeps no anti-air against fliers. A per-unit diagnostic (gold share, survival and placement per unit, by round)
and cross-planner matches (Normal against Hard on each side) showed:

- **The Caliphate deficit was one pairing.** The Sultana was 46–53% against the Marshal, the Archmage and the Skylady,
  and 25% against the Warden. Kingdom vs Caliphate at 56% was almost all of that one pairing. At Hard the same pairing
  goes 78% the other way, so it is the Sultana's planning, not her numbers.
- **"No anti-air" was half right.** Normal did buy anti-air, but it counted every flier of its own as an answer to
  fliers, and gave own fliers a bonus against a Large flier. Against the Warden's Wyverns the Sultana bought Djinn
  (anti-air bonus × Large-flier bonus × her 1.2 preference). The Warden answered with five or six Archers, which
  shred Djinn, and her real anti-air, the Camel Archers, came only in round 7. Hard's Sultana buys half as many Djinn.
- **"Fixed lanes waste the cavalry" was not the lever.** Reactive flanking is Hard's flank row, which chooses its
  side from the enemy's last formation (unlike the fixed wings rejected last pass). On its own, for the Caliphate
  only, it fixed Kingdom vs Caliphate (50.6%). On top of the anti-air fix it changed nothing within noise. For every
  faction's ground raiders it broke Ashen vs Caliphate (32%), because the Wraith Riders gain most.
- **The Marshal was starved of his passive.** His passive is an extra deployment, and Normal's 12% reserve held him a
  squad short most rounds.
- **The Warden's edge is his gear.** Normal puts each item on its "most valuable squad", which is the hero, and the
  Warden is the one hero who survives every round to use it (below).

**What changed (src/sim/bot.ts, the classic planner, so Normal and every flavoured strategy).**

1. **Only Large fliers count as an answer to fliers.** Anti-air is ranged fire (bows, bolts, casters) or a Dragon,
   Wyvern or Bone Drake of one's own. A Pegasus or a Djinn is no longer bought "against" a Wyvern. Both halves are
   needed: either half alone left Kingdom vs Caliphate at 55–57%.
2. **Archers move under the enemy's fliers.** When the enemy's last-round army had flier squads, Normal's archer-type
   squads (Archers, Bone Archers, Camel Archers) take Hard's formation spot, under where the fliers were. The rest of
   the army keeps its lanes. A flying Lord alone (the Skylady) does not count: tracking her hero stripped her army
   (Skylady 44.3% → 46.6% on 100 seeds when she was left out). Pegasus went from 61.9% to 58.1% with this rule.
   It is pinned by a test in `tests/sim.factions.test.ts`.
3. **The Marshal keeps half the reserve** (6% instead of 12%). Earlier he spent everything and read 62%; now he reads 49–52%.
4. **The Warden shares his gear.** When the classic planner chooses who wears an item, a Warden bot values its own
   hero at 25% of his usual value (`WARDEN_GEAR`), so most items go to his squads. Only a Warden bot's own choice
   changes; no stat moves. Also pinned by a test.

The flavoured strategies share the classic planner, so rules 1, 2 and 4 apply to the mixed field too (rule 3 does
not: those bots keep no reserve).

**Tried and rejected in this pass** (100 seeds, 3000 Normal-vs-Normal matches each, on the same seeds; the baseline
on those seeds was Kingdom vs Caliphate 57.6%, Warden 60.5%, Sultana 44.6%):

| Change | K v C | A v C | Warden | Notes |
|---|---|---|---|---|
| Count the enemy Lord in the counter score (as the unit he fights like), every round | 53.6 | 65.0 | 73.2 | the Warden counter-picks other Lords too |
| Same, round 1 only (the Lord is public before any army is) | 37.1 | 20.0 | 82.2 | one round-1 unlock cascades through the match |
| Same, only against an armoured Lord (the Warden), weight 150–450 | 46.6–49.5 | 46–49 | 60–63 | his pairings reshuffle; total unchanged |
| Hard's whole formation for Normal | | | 67.4 | Kingdom 64%, Ashen 37.5% |
| Hard's flank row, every faction's raiders and fliers | 53.6 | 33.0 | 57.6 | Marshal 36% |
| Hard's flank row, ground raiders only | 52.9 | 32.0 | 59.0 | Wraith Riders gain most |
| Hard's flank row, Caliphate only (with rules 1 + 3) | 52.9 | 46.0 | 60.3 | neutral on top of rule 1 |
| Archers boosted further against Pegasus-like raiders (×1 + 2–4 × share) | 53.0–53.5 | 49.0 | 59 | Pegasus unmoved (61.4–61.9) |
| No items on the Lord | 52.6 | 74.5 | 47.9 | Archmage 66%, Lich 60%, Skylady 36% |
| Hard's item-aware gearing for Normal | 51.0 | 49.0 | 58.9 | no gain |
| Reserve 6% or 0% for everyone | | | 65.5 / 60.5 | (Warden pairings only) |
| Warden placed back (y 15 m) or forward (y 35 m) | | | 60.0 / 63.5 | Bulwark coverage is not it |
| A Warden bot puts no gear on its hero | 42.0 | 46.0 | 29.5 | overshoot: the Kingdom falls to 42.5% |
| A Warden bot values its hero at 70% / 50% / 35% / **25%** for gear | 50.9 / 50.2 / 49.1 / 47.4 | 46.0 | 59.1 / 57.8 / 54.2 / **50.0** | 25% adopted (rule 4) |
| No signature bonus for the Warden | | | 69–76 / 73 | against the Sultana / Archmage, on 100 matches each: no effect |

**The Warden at Normal.** The cross-planner matches located it. Normal Warden against Hard opponents won 51–61%,
while any other Normal Lord against Hard won roughly 20–25%, and Hard Warden against Hard is 50%. Every
opponent-side rule only moved his pairings around. The +800 keep decides about 6 points of his matches at both Normal
and Hard, so it is not the gap. The gap was his gear. The Warden is the one hero who survives every round, so he kept
everything Normal gave its most valuable squad. A Warden bot with no gear on the hero falls to 29.5%. Valuing the
hero at a quarter for gear (rule 4) puts him at 50.9% and moves no other Lord or faction out of band. His hero
multiplier (160) and his stats are untouched, so Hard is unchanged.

**The Skylady** fell from 50.4% to 46.6% (44.3% before rule 4). That is the price of rule 2: her army is fliers, and
the Caliphate in particular now meets them with Camel Archers underneath.

### Mixed field (secondary)

| Metric | Before this Normal pass | Now | Target |
|---|---|---|---|
| Side advantage | 49.7% | 50.0% | < 52% ✅ |
| Match length | avg 8.23 | avg **8.17** | avg 8–9 ✅ |
| Ladder (`--strats easy,normal,hard --seeds 10`) | Hard beats Normal 81% (mixed run) | Hard beats Normal **76%**, Normal beats Easy **91%**, Hard beats Easy 96% | ≥ 65%, ≥ 75% ✅ |
| The `air` strategy | 38.3% | **36.8%** | ≥ 40% ❌ |
| Kingdom vs Ashen | 42.7% | **43.5%** | 45–55% ❌ |
| Kingdom vs Caliphate | 57.1% | **53.3%** | 45–55% ✅ |
| Ashen vs Caliphate | 51.4% | 48.6% | 45–55% ✅ |
| Lords | Marshal 42.2, Archmage 44.8, Warden 62.0, Skylady 50.8, Lich 56.1, Sultana 44.1 | **Marshal 41.2**, Archmage 46.4, **Warden 57.5**, Skylady 52.3, Lich 55.0, Sultana 47.6 | 45–55% ❌ for two |
| Units | 42.4% to 62.2% (bone archer) | 43.2% (scimitar) to 61.8% (bone archer); Pegasus 60.2 | 40–60% (two at the top edge) |

The flavoured bots share the classic planner, so the anti-air rules and the Warden's gear rule apply to them. They brought
Kingdom vs Caliphate into band and the Sultana and Lich-Priest rows with it. The Marshal's half reserve does not
reach them (they keep no reserve), and his row in this field (41%) was not investigated in this pass.

**Fliers.** Shots from the ground lose **30%** against fliers (it was 15%): less effective anti-air rather than stronger
fliers. Two other levers were tried in the previous pass:
- letting Wyverns, Bone Drakes and Djinn dive on the backline like Pegasus Knights made the factions
  rock-paper-scissors at Hard (each beating the next by 55–60%), so it was reverted;
- raising flier power lifted `air` by 3 points and broke Kingdom vs Caliphate.

Flier unit rates at Hard: Pegasus 58.0, Dragon 61.7, Wyvern 52.7, Bone Drake 56.3, Djinn 52.5. The Dragon is just
over the top of the unit band there.

### What changed in this pass

- **Hard uses the corrected counters** (strength test above).
- **Seat fairness bug fixed.** When Hard's flank choice was a tie it sent seat 0's raiders left and seat 1's right
  *in their own frames*, which put both on the same side of the map; seat 0 then won 51.5–53.6% of Hard mirrors. A
  tie now resolves the same way in both frames, the two plans are exact mirror images, and the seat split is 49.9%.
  `freeSpotNear` also searches in mirrored order for seat 1.
- **A replay corruption bug fixed.** Negative magic resistance (Wraith Riders) made Sunfire Mantle write a negative
  "mitigated" amount into the unsigned ledger, which broke `decodeReplay` for that battle. Amounts are clamped and
  there is a test.
- **Faction scalars** (`FACTION_POWER`, per mille): Kingdom 976, Ashen 1046, Caliphate 966.
- **Sunlight burns the dead:** the Sultana (blade and Radiance) deals 25% more and Sun Priests 50% more to the
  undead (Ashen units, the Lich-Priest, raised skeletons). It is the lever for Caliphate vs Ashen alone, which no
  faction scalar can reach (the three pairings were cyclic).
- **Ashen:** raised skeletons are 120 life / 16 damage (they were dealing next to nothing); Wraith Riders take 10%
  more magic damage (was 30%); Bone Drake armour 40%.
- **Lords:** Marshal 125, Archmage 43, Warden 160, Skylady 56, Lich-Priest 95, Sultana 115.
- **Bots:** Normal's reserve holds for deployments; fliers are not a frontline; the Archmage's bots buy casters.
- **Normal pass (bots only; no unit, faction or Lord number moved):** only Large fliers count as an answer to
  fliers; archer-type squads move under the enemy's last-round flier squads; the Marshal keeps half of Normal's
  reserve; a Warden bot spreads its gear over its squads instead of its hero. See the Normal-vs-Normal section for the diagnosis and the rejected alternatives.

### Open

- Normal vs Normal: every target met; the Skylady (46.6%) and Ashen vs Caliphate (46.0%) are the nearest the edge.
- The mixed field: the `air` strategy (37%), Kingdom vs Ashen (43.5%), the Marshal (41%) and Warden (57.5%) rows,
  and Bone Archers (62%).
- Kingdom vs Ashen at Hard is at the edge of the band (45.6%).
- Legendaries and item skills were not re-tuned; no faction-flavoured item skills yet; one Lord each for the new factions.

## Kingdom-only report before the factions (historical)

The numbers in this section and the one after it are from before the factions and the match-length pass (matches
then averaged 10.3 rounds). They are kept for the reasoning; the table above is current.

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

- **Keep damage.** Each surviving squad deals 55 × cost tier × (1 + level) / 2, the Lord deals 60 × (9 + lvl) / 10, and the round winner (by a wipe or on points) adds the round bonus, **70 × round** scaled by the winning margin (in full from 40 points). The larger base (DESIGN once said 50) was needed to bring matches from 13 rounds down to 7–12.
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
