# Review: positioning, speed, lanes, repositioning, the Lord, bots and gold

Scope: the placement game and the economy, measured on the current build (`src/sim` as of 2026-11-15). This is a review: no gameplay
code was changed. Every number comes from headless bot runs; the scripts are in `tools/review/` and the commands are listed at the
end of each section and in the appendix. Bots stand in for players, so read the numbers as "what a competent planner experiences",
not as proof of what humans will do.

## Executive summary

**The short version.** Placement already decides a lot of battles, but mostly in ways nobody can plan for. Moving a whole army
**10 cm** sideways changes the round result in **11%** of battles (26% of close ones). Turning squads 90° changes it in 10%. Mirroring
the formation changes it in 38%, yet the average win rate stays at 50%. So most of the "placement effect" is noise that happens to be
deterministic. The one placement skill that is large, learnable and systematic is **timing by depth**: stagger melee squads by speed
so they reach the river together. That alone wins **74% of whole matches against the Hard bot**, and nothing in the UI teaches or
shows it. The economy has one line: **94% of all gold goes into new squads**. The average squad level is still 1.05–1.14 when
matches end. Level-ups are 2–5× less gold-efficient than a new squad, so armour and relic item slots are almost never opened, and by
round 8 about 30% of looted items sit idle in the stash.

Ranked by impact:

| # | Recommendation | Effort | Balance risk |
|---|---|---|---|
| 1 | **Show timing in planning:** draw each squad's march path and its seconds to the river and to first contact. Teach the speed-stagger. Make Hard use it, because Hard loses 26–74 to a copy of itself that does. | M | Low for the UI. Medium for the bot: the ladder and faction tuning are on Hard, so re-check them. |
| 2 | **Cut the reward for coin-flip rounds:** scale the flat round bonus (70 × round) by the winning margin. It is 49% of all keep damage and 63% in close rounds, where a 1 m nudge flips 32% of results. Add a "chaos index" (`tools/review/chaos.ts`) to the balance checks. | S rule, M sim | Medium: matches get longer, so re-tune the base or sudden death to keep 8–9 rounds. |
| 3 | **Make levelling a real alternative to recruiting:** use a flatter level-cost curve, or bigger gains per level, or open item slots earlier. Today the tall strategy loses 83% and banking loses 57.5%. | S code, M tuning | High: unit balance was tuned around Lv1 armies, so it needs a full re-tune. |
| 4 | **Planning UX for moving armies:** multi-select (box and Shift-click), group drag and group rotate, "mirror formation", "undo move", and an optional ~1 m snap. | M | None |
| 5 | **Keep repositioning free for now.** Revisit after #1 and #2 with a *relocation budget* (e.g. 3 older squads a round, the Lord always free) if you want the last-round intel to bite. Perfect intel on current positions is worth +15 points, so the intel game is real. | M | Medium |
| 6 | **Decide what the river is for.** Today it is a speed bump: 42% of ground soldiers wade, and removing it changes results only about twice as often as a 1 m nudge. Either make the crossings matter (slower water, always 3 crossings, terrain-aware bots), or keep it as scenery and say so. | M | Medium: a "hard river" raised stalls from 11% to 17% and battles from 46 s to 56 s. |
| 7 | **Facing is noise:** rotating changes results as often as a 10 cm nudge, with no mean effect. Replace it with a meaningful *wide / deep* formation choice, or drop it from the tooltips. | S–M | Low |
| 8 | **The Lord:** keep it freely movable in planning (it already is) and do not add in-battle control. Hiding the Lord costs 4–6 points, so it is not degenerate. A pre-battle Lord *stance* (follow a squad, hold, advance) is the safe way to add agency. | M | Low |

**Quick wins that are safe to do now** (no balance risk, or none that a tournament wouldn't catch at once):
- **Same-round sell refunds 100%.** It is an undo: nothing happened between buying and selling. Today a misclick costs 50%.
- **Planning UI:** box and Shift-click multi-select with group drag and rotate, plus an "undo last move".
- **Snap placement to a 0.5–1 m grid** in the UI, so a player can reproduce a formation exactly. Bots already place on a 1 m grid
  through `freeSpotNear`.
- **Add `tools/review/chaos.ts` to the balance routine** as the sensitivity check, next to `npm run tournament`.

---

## 1. Placement and unit speed

### How it works today
- **Deploy zones** are y 4–40 m (seat 0) and y 80–116 m (seat 1), x 2–78 m (`deployZone`, `src/sim/match.ts:65`), so there are 40 m of
  no-man's-land. The river is at y 55–65 m (`RIVER_Y0/1`, `src/sim/terrain.ts:14`).
- **A squad is placed as a point plus a facing.** In battle its soldiers are laid out in a grid of rows "across the facing"
  (`addSquad`, `src/sim/battle.ts:478-490`). The grid has 1–4 columns by squad size, and the spacing is fixed at 2 × radius + 50 cm.
  Squads may not overlap (`squadFootprint`, `match.ts:127`). There is no spacing or shape control.
- **Movement** (`squadPass`, `battle.ts:643-665`):
  - Each squad's anchor walks at **its own speed** towards its *macro target*. That is the nearest enemy squad, with biases: raiders
    prefer the backline, ballistae prefer Large targets, archers prefer fliers (`battle.ts:613-627`).
  - Ranged squads stop at range − 3 m (`:653`).
  - Ground squads use the flow field to cross the river (`:655`).
  - No army-level pacing exists. A squad pauses only for its own stragglers (`slotErr`, `:646`).
  - Once engaged, soldiers chase individually (`soldierPass`, `:1118`).
- **Facing** only rotates the soldier grid at spawn. Soldiers turn to their movement on the first tick (`separate`, `:1210`).

March speeds (m/s; ×20 / 100 of `speed` in `src/sim/data/units.ts`):

| Speed | Units |
|---|---|
| 5.6–6.4 | Cavaliers 6.4, Wraith Riders 6.0, Pegasus 5.6, Mamluks 5.6 |
| 4.4–4.8 | Camel Archers, Djinn 4.8, Wyvern 4.6, Bone Drake 4.4 |
| 2.6–3.4 | Berserkers / Scimitars 3.4, Militia 3.0, Archers / Skeletons / Levy 2.8, Pikemen / Mages / Clerics 2.6 |
| 1.4–2.2 | Knights 2.2, Ballista 1.8, all Golems 1.8, Trebuchet 1.4 (the War Elephant is 2.4) |

That is a **4.6× spread** between the fastest and slowest unit.

### Does placement decide battles? Yes, but mostly as noise

Experiment (`formations.ts`): 180 Hard-vs-Hard matches give 1,500 battles. Before each battle, one seat's army keeps the same squads,
levels and items but is re-placed in a different formation, and the battle is re-run against the same enemy. The formation is then
applied to the other seat as well. Win% counts a draw as half; 50 means "no better or worse than Hard's own layout".

| Variant (what changes) | Win % | Result changed | Mean keep swing vs base |
|---|---|---|---|
| `nudgeOne`: one squad moved 1 m | 50.1 | **6.9%** | +1 |
| `face90`: every squad turned 90° | 50.0 | **9.8%** | −3 |
| `nudge1m`: whole army 1 m sideways | 49.6 | 11.8% | −8 |
| `wide`: spread 1.6× | 49.2 | 17.2% | −11 |
| `forward` (+10 m) / `back` (−15 m) | 49.5 / 51.9 | 18.6% / 20.3% | −16 / +30 |
| `flatLine`: all squads in one depth band | 52.3 | 18.2% | +38 |
| `blob`: squeezed into the middle | 49.5 | 23.2% | −9 |
| `shuffle`: squads swap spots at random | 49.2 | 25.7% | −5 |
| `depthFlip`: front and back swapped | **43.6** | 25.8% | −88 |
| `hugLeft` / `hugRight`: corner hugging | 49.0 / 47.5 | 28.5% / 30.1% | −21 / −53 |
| `oneRow` (Easy's) / `lanes` (Normal's) | 47.3 / 47.6 | 31.6% / 31.8% | −33 / −35 |
| `mirrorX`: left-right mirror | 50.0 | **37.8%** | −7 |
| **`speedSync`**: melee staggered in depth by speed (below) | **60.4** (67.8 from round 7) | 22.8% | **+215** |

Two things stand out.

1. **Results are very sensitive to small moves, and the moves have no direction.** `chaos.ts` (1,019 battles) splits this by how
   close the unchanged battle was:

   | Unchanged battle | Share of battles | Whole army 10 cm | 1 m | 3 m | One squad 1 m |
   |---|---|---|---|---|---|
   | All | 100% | 10.7% | 13.9% | 17.3% | 7.8% |
   | Points margin < 20 | 28.8% | **25.9%** | **31.9%** | 35.0% | 22.5% |
   | Margin 20–49 | 47.2% | 6.1% | 8.3% | 12.8% | 2.5% |
   | Margin ≥ 50 | 24.0% | 1.4% | 3.3% | 4.9% | 0.6% |

   In a close battle, one squad moved 1 m flips the result about one time in four. The sim is deterministic (§0 holds), but to a player
   that is indistinguishable from dice. Of the rounds a side failed to win, **73%** could have been won by one of 13 army-wide
   formations, but no rule tells you which one in advance. That is not a skill a player can learn.
2. **The large, learnable effect is depth: when each squad arrives.** Turning the depth order upside down costs 6 points. Staggering
   melee by speed gains 10 points per battle (18 late), and over whole matches the gain is much larger (§5).

### Speed: who arrives when (`speed.ts`, 511 recorded battles)

Contact is the first tick a squad deals or takes damage. The *main body* is the value-weighted median contact time of its own army.

| Unit | m/s | Contact (s) | Arrives vs main body (s) | Wiped % | Wiped before its main body engaged |
|---|---|---|---|---|---|
| Cavaliers | 6.4 | 7.5 | 1.5 early | 95 | **10%** |
| Wraith Riders | 6.0 | 7.8 | 1.9 early | 93 | 8% |
| Pegasus | 5.6 | 7.3 | 1.2 early | 80 | 7% |
| Mages / Djinn-Binders | 2.6 | 10.3 / 9.7 | ~1 late | 71 / 62 | **13% / 18%** (raided) |
| Pikemen | 2.6 | 11.5 | 2.8 late | 86 | 0% |
| Knights | 2.2 | 14.1 | **4.5 late** | 74 | 0% |
| Stone / Bone / Sand Golem | 1.8 | 16.8 / 18.3 / 16.4 | **7.4–9.0 late** | 70 / 79 / 39 | 0% |

Other figures from the same run:
- First contact comes at 6.6 s on average, and a battle lasts 46.6 s.
- 33.5% of first contacts happen in the river band. About 48% happen inside a deploy zone; those are ranged fire and Lord abilities
  across the 40 m gap.

- **"Fast units arrive alone and die piecemeal" is real but mild.**
  - Raiders arrive only 1–2 s ahead, because the field is short. Contact comes about 7 s in, and the main body follows at about 9 s.
  - About 8–10% of cavalry squads die before their army engages.
- **The bigger problem is the other end: tanks arrive last.** Golems reach the fight 7–9 s after their own army has engaged, and
  Knights 4.5 s after. By then the cheap infantry in front has already taken the first blows. The units built to take hits are not the
  ones taking them. Hard puts all "front" units on one row at 36.5 m (`hardLayout`, `src/sim/bot.ts:490`), so nothing compensates.
- That is exactly why `speedSync` wins. It sets the slowest melee squad at the front edge and holds faster melee further back, so
  they all reach the river together. Ranged squads keep their spot.

### Are the formation tools meaningful?
- **Depth:** yes, and strongly (above). But the player gets no feedback about timing.
- **Facing:** no. `face90` changes 9.8% of results with a mean of exactly 50%, the same signature as a 10 cm nudge. Facing only decides
  whether a 12-man Militia grid starts 4-wide or 3-wide, and the soldiers re-face on the first tick.
- **Spacing:** there is no tool. Footprints are fixed.
- **Width and flanks:** corner hugging is *not* degenerate (47.5–49%), because the flow field heads for the enemy keep's centre and
  macro-targeting converges both armies. A narrow blob or a very wide line are both neutral.

### Counterplay to where the enemy stood last round
- Hard re-forms against the enemy's last formation. Counters line up opposite what they counter, raiders take the flank that holds the
  enemy backline, and archers stand under fliers (`bot.ts:440-496`).
- Against Hard (whole matches, `matches.ts`), knowing the enemy's *current* positions (`oracle`) wins **65.0%**. Never re-forming
  (`static`) wins 46.7%, which is within noise of 50.
- So reading positions is worth something only when the information is fresh. Last round's ghosts are mostly useful for
  *composition*: what to unlock and buy.

### What good players will find
- **Speed-stagger** (dominant today; see #1). It is a good skill to have in the game: it is Mechabellum's "timing of engagement".
  But it must be visible, and the AI must play it.
- **Fishing for coin flips:** re-arranging until something works. That is not possible inside one planning phase (you cannot test).
  The danger is the opposite: a player who *does* place well loses close rounds anyway and concludes that placement is random.
- No dominant corner, blob or line formation was found.

### Compared with Mechabellum
- **Lock-in.** Mechabellum locks a unit's position after the round it is deployed, apart from special cards and tech. Its intel ("their
  army last round") is therefore exact for every old unit. Oathbound lets you move everything every round (see §3).
- **Rotation and spacing.** Mechabellum has rotation and unit-specific formation footprints. Its main timing tool is also depth: fast
  units go back, slow tanks go forward.
- **Feedback.** Mechabellum players learn timing from very readable battles. Oathbound's battles are readable too, but its planning
  screen shows only range rings, with no march or arrival preview.

### Options and recommendation
- **A. Show timing (recommended).**
  - In planning, draw each squad's path along the flow field.
  - Label the seconds to the river line and to the enemy's last-round front.
  - Optionally add a "sync by speed" helper that staggers the selected squads in depth.
  - Teach it in the rules screen.
- **B. Make Hard time its army.** Add the stagger to `hardLayout`. It is a large strength gain (+24 points of match win rate), so it
  needs a re-check of the ladder and of the Hard-vs-Hard faction table.
- **C. Reduce noise (§ summary #2).**
  - Scale the flat round bonus by margin, which pays a narrow win less.
  - Investigate sim sensitivity. Likely sources are soldier-level nearest-target switching every 6 ticks, ties in the macro targeting,
    and the straggler gate. Use `chaos.ts` as the metric. A target to aim for: a 10 cm nudge flips fewer than 10% of close battles
    (today 26%).
- **D. Facing:** replace it with an explicit *line / column* formation, where a line engages more soldiers and a column paths and
  crosses faster. Or simply stop presenting it as a tactical choice.

---

## 2. The three lanes: river, bridges and fords

### How it works today
- `genTerrain` (`src/sim/terrain.ts:28-56`) makes the river a full-width band at y 55–65 m with one of two layouts:
  - (50% of seeds) a **central bridge** (x 36–44 m) plus a mirrored pair of **fords** (6–8 m wide, centred about 11–24 m from the
    edges): three crossings;
  - (50%) just a mirrored pair of **bridges**: two crossings.
- Speeds:
  - Water is not a wall. Wading costs **50% speed** for 10 m, a ford 80%, a bridge 100% (`MOVE_PCT`, `:9`).
  - The flow field prices water at 2× a plain step (`STEP_COST`, `:11`), so a squad detours to a crossing only when it is within
    about 10 m sideways.
- Fliers ignore terrain.
- Forest, hills and ruins are seeded per match and mirrored (fair by construction: only seat 0's half is generated).

### Measurements
Lane use (`speed.ts`), ground soldiers entering the river band:

| Crossing | Share |
|---|---|
| Wading | **41.8%** |
| Side bridges (two-crossing maps) | 24.2% |
| Centre bridge | 17.8% |
| Fords | 16.3% |
| Never reached the river (the fight came to them, or they died first) | 26.3% of all ground soldiers |

Same armies, other maps (`terrain.ts`, 1,021 battles). The 1 m nudge flip rate from §1 is the noise floor:

| Map | Result changed | Battle length | Timeouts and stalls |
|---|---|---|---|
| The match's own (base) | n/a | 46.2 s | 11.2% |
| No river (forests and hills kept) | 26.7% | 43.5 s | 10.2% |
| River with no crossings | 25.0% | 46.6 s | 9.7% |
| Completely flat | 30.7% | 41.9 s | 9.3% |
| "Hard river" (wading at 20% speed) | 26.2% | **55.5 s** | **17.0%** |

- **The river is a speed bump, not a lane structure.** Removing it, or removing all crossings, changes results only about twice as
  often as moving the army 1 m, and battles change by about 3 s.
- **Nobody plays the lanes.** No bot reads the terrain: `hardLayout` and `placeFor` have no terrain input. So terrain tactics have no
  AI opponent and no measured value. Those tactics are archers on hills (+15% range and damage) or in forest (−40% ranged damage
  taken), and the bridge as a chokepoint.
- **Fliers do not trivialise the map,** because the map barely constrains anyone. They reach contact at about 7–8 s, the same as
  cavalry.
- **Funnel and stall risk:** a stronger river (our "hard river") adds 9 s per battle and pushes stalls from 11% to 17%. That is the
  stall that DESIGN §1's stall rules then end on points, i.e. the noisy outcome above.

### Options
1. **Make crossings matter.**
   - Wading at 25–35% speed, every map with 3 crossings, crossings 6–10 m wide, and terrain-aware bot placement.
   - Pros: real lane choice, and bridges become timing tools ("hold the bridge with pikes").
   - Cons: longer battles and more stalls; the sudden-death and keep-damage curve needs re-tuning.
2. **Keep it soft, but readable (recommended first).**
   - Leave the numbers. Show the route each squad will take (the same overlay as §1-A) and the river delay in seconds.
   - Make Hard put ranged squads on hills and in forest when one is in reach.
   - Then measure whether terrain choices pay off before strengthening the river.
3. **Map variety.**
   - Per-match variety already exists and is fair: one seed, mirrored for both seats.
   - If you want more identity, use a small pool of hand-made mirrored layouts instead of fully random ones, so players can learn
     maps. Always mirror them, and show the layout before the Lord pick if it should influence the pick.
4. **Two or three crossings.** Today half the maps have no central crossing, and that is invisible to players as a choice. If the lane
   concept is a pillar, use three crossings on every map.

---

## 3. Moving already-placed units

### How it works today
- **Rules.**
  - Any squad, the Lord included, can be moved anywhere in your zone during every planning phase, for free and without limit
    (`applyIntent` `move`, `match.ts:359-368`; DESIGN §2).
  - Squads return to their own spot each round.
  - Selling refunds 50%, and only in the round of purchase (`sellRefund`, `match.ts:55`).
- **UX** (`src/ui/planning.ts`).
  - **Moving:** you drag one squad at a time (`:737-742`, `:854-866`). If you drop it on another squad, it snaps to the nearest free
    spot within 9 m (`spot`, `:822`). Tab cycles through your squads.
  - **Turning:** right-drag or Q/E while placing or dragging, and Shift+Q/E for the selected squad (`:723-728`, `:779-783`).
  - **Missing:** there is **no multi-select, box select, group move, group rotate, mirror, undo or formation preset**.
  - **The enemy:** its last-round army is shown as red ghosts that you can hover and inspect.
- **Intel.** You see where the enemy stood *last* round, and never what they do now (`viewFor`, `match.ts:458`).

### Is free repositioning good?
- **Repositioning against stale intel is worth little.** Against Hard, a player who never moves old squads wins **46.7%**, within
  noise of 50.
- **Fresh intel is worth a lot.** Knowing the enemy's current formation wins **65%** (`oracle`). Standing deliberately where the enemy
  is not (`flip`, mirroring your counter-formation) wins **36%**.

So free movement keeps the intel game shallow: the enemy can re-form completely, and the ghosts mostly tell you composition. Whether
that is bad depends on what you want the game to be:

| Option | What it does | For | Against |
|---|---|---|---|
| A. Free, unlimited (today) | Everything moves every round | Simple and forgiving; no punishment for early mistakes | Weak intel; re-forming 16 squads one drag at a time is busywork |
| B. Mechabellum lock | Squads lock after their deploy round | Intel becomes exact; early placement is a real commitment | With today's noise, a locked mistake feels unfair; a big change to UX and bots |
| C. Relocation budget | Move up to N older squads a round (e.g. 3); new squads and the Lord are always free | Intel is mostly accurate and you can still adapt; a real decision ("which 3?") | More rules to explain; bots need it; must be fair (same N for both) |
| D. Paid moves | Moving an old squad costs gold | Ties into the economy | Gold already has only one use, deploying (§6), so this taxes the same thing again |

**Recommendation.**
1. Keep A for now, and fix the UX first: box and Shift-click multi-select, group drag and group rotate, "mirror formation", "undo".
   Placement is meant to be the core skill, and today moving an army is 16 separate drags inside 120 s that also holds the draft, loot,
   levels and equips.
2. Once timing is visible (§1-A) and close rounds are less noisy (summary #2), prototype C with N = 3.
3. Measure it with `matches.ts`: give the `oracle` and `static` variants the budget and check that intel then matters, i.e. the gap
   between `oracle` and `hard` grows and `static` stays close to `hard`.
4. Do not do B unless the noise problem is fixed first.

---

## 4. The Lord: placement and movement

### How it works today
- **Placement and movement.**
  - The Lord starts at x 40 m, y 12 m, the centre back, facing forward (`setLord`, `match.ts:192`).
  - It is a squad of one, and it **can already be moved anywhere in your zone every planning phase**. The `move` intent does not
    exclude it, and the UI drags it like any squad.
  - It does not count against the deployment limit or the army cap.
- **Combat.**
  - It respawns every round.
  - Its ability fires automatically (`lordPass`, `battle.ts:692`).
  - Its value counts towards points (300 + 30 per level, `battle.ts:79`).
- **What the bots do.** Normal moves the Lord only in round 1, to y 15 m (ranged Lords) or 26 m (`placeFor`, `bot.ts:209`). Hard puts
  it in the support row at 25 m, behind its front (`hardLayout`).

### Measurements (`formations.ts`, the Lord moved, nothing else)

| Lord placement | Win % | Result changed |
|---|---|---|
| Hard's (support row, 25 m) | 50 (base) | n/a |
| Front edge (39 m) | 49.6 | 17.3% |
| Flank (x 76 m, y 32 m) | **45.9** | 18.0% |
| Hidden in the back corner (x 3 m, y 4.5 m) | **44.0** | 17.3% |

- Lords are wiped in 50–71% of battles (`speed.ts`: Warden 54%, Archmage 71%, Skylady 50%).
- **Hiding the Lord is a mistake, not an exploit.** It loses its aura and ability coverage (Rally 20 m, Bulwark 12 m, Radiance 8 m).
  The 300-point value it keeps does not make up for that.
- **Diving with it** is what happens anyway for melee Lords at the front. That placement is neutral.

### "Maybe the hero can move any time"
- **In planning,** it already can.
- **During the battle,** not without breaking the architecture. The server simulates the whole battle at the end of planning and sends
  a replay (DESIGN §7), and battles take no input. Live Lord control would mean a live, lock-step sim, latency handling and a new
  replay format. It would also turn the auto-battler into a micro game where the faster clicker wins, which goes against "the outcome
  comes from placement, items and unlocks".

**Recommendation.**
1. Keep free movement in planning.
2. Optionally add a pre-battle **Lord stance** that the sim obeys deterministically: *Follow squad X* (stay 6 m behind it), *Hold*
   (stay put and cast), or *Advance with the front*. It gives the "hero agency" feeling with no input during battle, and both players
   get the same options.
3. Show the ability radius as a ring when the Lord is selected. The range ring exists; the aura radius does not.

---

## 5. How the bots read your placement

| Level | Placement logic | Reads your formation? |
|---|---|---|
| Easy | One row across y 28 m, in deploy order (`planEasy`, `bot.ts:273`) | No |
| Normal | Fixed role lanes and depths (`placeFor`, `bot.ts:205`). Only its archers move under your last-round fliers (`antiAirPlacement`) | Barely |
| Hard | Re-forms the whole army against your last formation: its centre opposite your mean x, counters opposite what they counter, raiders on the flank with your backline and fewer pikes, archers under your fliers (`hardLayout`, `bot.ts:440`) | Yes, but last round only. It ignores terrain, facing and timing. |

All win rates below are over whole matches against the shipped Hard bot (`matches.ts`, 600 matches per variant: all 30 Lord pairings,
both seats, seeds 9000+). The 95% interval is about ±4.

| Variant | Match win % | Round win % | Reading |
|---|---|---|---|
| `hard` (control) | 50.0 | 50.0 | |
| `static`: never moves old squads | 46.7 | 46.9 | Hard's re-forming is worth ≤ 3–4 points |
| `shuffle`: own squads swap spots at random each round | 50.3 | 48.1 | Which squad stands where barely matters to Hard |
| `lanes`: Normal's fixed lanes | 38.7 | 43.4 | Where the army's mass stands matters |
| `flip`: Hard's layout mirrored left-right | 36.0 | 43.9 | Meeting the enemy head-on beats standing beside them |
| `oracle`: Hard laid out against your *current* positions | **65.0** | 58.8 | Fresh positional intel is valuable |
| **`sync`: Hard plus the speed-stagger** | **73.7** | 60.1 | **Hard's big blind spot** |

**How exploitable is it?**
- **Baiting does not work.** You might show a flank last round and attack the other side this round, but Hard mostly centres on your
  mean x, and standing away from the enemy loses (`flip`).
- **The real exploit is timing.** A player who staggers by speed beats Hard about three times in four. A human will find this in a few
  matches, especially with Golems and Knights.
- Hard also never uses terrain or facing, so a human gets those for free (facing is noise anyway).
- **Recommendation.** Since this is lower priority:
  - add the speed-stagger to Hard;
  - make Hard put ranged squads on hills when one is in reach;
  - re-tune.

  Normal should stay predictable. It is the ladder rung that Normal-vs-Normal balance was tuned on.

---

## 6. Gold every round

### How it works today (`match.ts`)
- **Income:** 300 in round 1, then 200 + 25 × round, capped at 500, the same for both players (`income`, `:49`). Unspent gold carries
  over. There is no interest and no catch-up.
- **Deploy limit** 2 a round, 3 for the Marshal, +1 per "of Command" relic up to +2 (`:225`, `:522`). **Army cap** 16 (`:19`).
- **Level-up:** Lv *n* → *n*+1 costs unit cost × *n*, so Lv5 is 10× the unit cost on top of the purchase (`levelUpCost`, `:52`). Each
  level gives +25% HP and +20% damage (`battle.ts:47-48`). Item slots: armour opens at Lv2 and relic at Lv4. Keep damage scales
  × (1 + level) / 2.
- **Selling** refunds 50%, and only in the round of purchase (`sellRefund`, `:55`).

Cumulative income by round: 300, 550, 825, 1125, 1450, 1800, 2175, 2575, 3000, 3450. Sixteen squads at about 190 gold each is about
3,000 gold, which is reached around round 9. Matches end at 8.4 rounds on average.

### The value of a level-up

Power is HP × damage for one squad. Lanchester-style mass makes two squads even better than this table suggests.

| Squad | Power | Total gold (× unit cost) | Power per gold |
|---|---|---|---|
| New Lv1 squad | 1.00 | 1 | **1.00** |
| Lv2 | 1.50 | 2 | 0.75 |
| Lv3 | 2.10 | 4 | 0.53 |
| Lv4 | 2.80 | 7 | 0.40 |
| Lv5 | 3.60 | 11 | 0.33 |

### Where the gold goes (`econ.ts`, Hard vs Hard, 300 matches)

| Round | Income | Gold at start | On deploys | On level-ups | Unspent after | Deploys used / limit | Limit hit | Army | Average level |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 300 | 300 | 267 | 0 | 33 | 1.67 / 2.17 | 50% | 1.7 | 1.00 |
| 3 | 275 | 313 | 261 | 8 | 44 | 1.64 / 2.17 | 54% | 4.8 | 1.02 |
| 5 | 325 | 355 | 303 | 16 | 36 | 1.77 / 2.18 | 67% | 8.2 | 1.04 |
| 7 | 375 | 382 | 310 | 9 | 63 | 1.64 / 2.21 | 51% | 11.6 | 1.05 |
| 9 | 425 | 488 | 396 | 82 | 10 | 1.58 / 2.23 | 50% | 14.9 | 1.08 |
| 10 | 450 | 463 | 212 | 216 | 35 | 0.82 / 2.24 | 19% | 15.7 | 1.14 |

- In total, **93.9% of spending goes to deploys and 6.1% to level-ups.** Unspent gold averages 37 for Hard and 90 for Normal; Normal
  keeps a 12% reserve by design.
- Level-ups start only when the army cap is reached, which is round 9–10, just as matches end.

Item use (same run):

| Round | Items owned | On the Lord | On squads | Idle in the stash |
|---|---|---|---|---|
| 5 | 4 | 2.76 | 0.55 | 0.69 |
| 8 | 7 | 2.93 | 1.90 | **2.17** |
| 10 | 9 | 2.82 | 3.90 | 2.28 |

Armour and relic items have nowhere to go, because squads stay at Lv1 and Lv2–Lv4 opens those slots. The Lord's three slots absorb
most loot. **"Items decide outcomes" is undercut by the economy.**

### Is there a real choice? Whole matches against Hard (`matches.ts`)

| Economic line | Match win % | |
|---|---|---|
| Hard (spend all, level only when nothing else fits) | 50.0 | |
| `wide`: never level, bank the rest | 47.7 | Within noise: levelling adds almost nothing |
| `lateLevel`: no levels before round 6 | 52.2 | Within noise |
| `bank`: hold back 40% of gold in rounds 1–4 | **42.5** | Saving is strictly worse: no interest, and the army fights every round |
| `tall`: one deploy a round, the rest into levels | **17.2** | Tall is not viable |

Rule what-ifs for **both** seats (`rules.ts`, Hard vs Hard, 300 matches each):

| Rule | Average rounds | Level-ups' share of spend | Winner's keep left |
|---|---|---|---|
| Today (deploy limit 2) | 8.44 | 6.1% | 57.1% |
| Deploy limit 3 | 8.50 | 5.0% | 55.2% |
| Deploy limit 1 | 8.00 | 25.6% | 69.3% (more blowouts) |
| +100 gold a round | 7.90 | 10.4% | 62.9% |

- **The deploy limit almost never binds.** Gold does. Raising the limit to 3 changes nothing, and lowering it to 1 forces levels but
  makes matches more lopsided.
- **The economy has one obvious line:** spend everything every round on new squads, and level only once you are capped. Wide against
  tall is not a decision. Save against spend is not a decision either: saving loses. The real gold decision is *which* units, and that
  belongs to the unlock and counter game, not the economy.

### Options
1. **Make level-ups competitive** (recommended; must be tournament-tuned).
   - Candidates, alone or combined:
     - a flatter cost: Lv *n* → *n*+1 costs unit cost × (*n* + 1) / 2, so 7× in total instead of 10×;
     - stronger levels: +30% HP and +25% damage;
     - the armour slot at Lv1 and the relic slot at Lv3.
   - Target: tall and wide within ±5 points of each other, with level-ups at 20–35% of spend.
   - This also brings the items pillar back.
2. **Interest on banked gold** (a TFT-style 10% of the bank, capped). It is fair, since the same rule applies to both seats, and it
   creates a save-or-spend choice. **Not recommended.** Without a comeback mechanism, a lead in board strength compounds anyway, and
   saving would mostly be a trap for new players. Revisit only if #1 is not enough.
3. **Keep the deploy limit at 2.** It is harmless and gives the Marshal and "of Command" a hook. Do not raise it; it does nothing.
4. **Same-round sell refunds 100%** (an undo). It is safe because nothing has happened in between. Today a misplaced buy costs 50%.
5. **The army cap (16)** is reached only at round 9–10. It is fine as a late-game ceiling. If levels become competitive, it will start
   to matter earlier, as it should.

---

## 7. Noise in close rounds (cross-cutting)

The fairness rule ("minimal randomness") is met in letter: nothing is rolled. But the battle is so sensitive that close rounds behave
like coin flips, and the reward structure pays a coin-flip win almost in full:

- The flat round bonus (70 × round × sudden death, `keepDamageOf`, `match.ts:90-96`) is **48.7% of all keep damage**. In close rounds
  (margin < 20 points, 25% of decided rounds) it is **63.2%** (`keepsplit.ts`).
- A close win deals 621 keep damage on average, against 719 for an average win. Narrow and clear wins pay almost the same.
- In those rounds, a 10 cm shift flips the result 26% of the time (§1).

**Recommendation.** Pay the round bonus in proportion to the margin, e.g. bonus × min(1, margin / 40 points). It applies to both seats
alike, and the keep-damage curve then rewards clear wins and placement skill rather than tie-breaks. Re-tune
`KEEP_DMG_BASE_PER_ROUND` or the sudden-death start so the match length stays at 8–9 rounds. In parallel, treat the flip rate as a
health metric: run `chaos.ts` with every balance pass and look for sim changes that lower it, such as stickier soldier targets and
squad-level target hand-offs.

---

## Appendix: reproducing the numbers

All scripts are analysis only and are not imported by the game. `tools/review/botx.ts` is a copy of `src/sim/bot.ts` with internals
exported and two knobs (`noLevel`, `noLayout`); re-copy it if the bot changes. Runs use the worker pool (`availableParallelism() − 4`
threads). The times are on a 20-thread machine.

| Section | Command | Size | Time |
|---|---|---|---|
| Baseline | `node tools/tournament.ts --strats hard --seeds 20` | 600 matches | 19 s |
| §1 formations | `node tools/review/formations.ts --seeds 6` | 1,500 battles × 18 variants × 2 seats | 4 min |
| §1 speed-sync | `node tools/review/formations.ts --seeds 6 --only speedSync,forward,back` | 1,500 battles | 2 min |
| §1 sensitivity | `node tools/review/chaos.ts --seeds 4` | 1,019 battles | 2 min |
| §1–2 speed and lanes | `node tools/review/speed.ts --seeds 2` | 511 recorded battles | 2 min |
| §2 maps | `node tools/review/terrain.ts --seeds 4` | 1,021 battles × 4 maps | 2 min |
| §3–6 whole matches | `node tools/review/matches.ts --seeds 10` (add `--variants sync,hard` for the stagger) | 600 matches per variant | 4 min |
| §6 economy | `node tools/review/econ.ts --seeds 10 --strat hard` (and `--strat normal`) | 300 matches | 30 s |
| §6 rule what-ifs | `node tools/review/rules.ts --seeds 10` | 300 matches per rule | 1 min |
| §7 round bonus | `node tools/review/keepsplit.ts` | 60 matches | 30 s |

Seeds are fixed in each script (`--seed0` overrides), so re-runs give the same numbers.

**Caveats.**
- The opponent in all whole-match tests is the shipped Hard bot. "+24 points against Hard" is not "+24 points against a strong human".
  The direction and size still show where the skill is.
- The 1,500-battle tables have about ±2.5 points of noise on win%, and the 600-match tables about ±4.
- The "hard river" test patches `MOVE_PCT` in-process only. The flow field still prices the water as today.
