# Oathbound v2 — Design

**1v1 PvP fantasy army auto-battler in the browser.** It is Mechabellum's structure in a Fire Emblem-flavoured fantasy world:
- Each round, both players spend gold to deploy and upgrade squads on their half of a battlefield.
- The battle then plays out in real time with no input.
- Armies advance to destroy each other and push on to the enemy **Keep**.
- The army is permanent: every squad returns at full strength next round, in the place it was deployed.
- Mechabellum's reinforcement cards are replaced by **ARPG loot**: rarity-tiered items with random affixes and uniques, equipped onto squads and onto your Lord.

The target is an AAA-feeling presentation: animated textured models, crowds of soldiers, real VFX and cinematic battle playback.

The v1 co-op FE-grid design is archived in `../oathbound-v1-snapshot.tar`.

## 0. Equal conditions (the fairness principle)

Both players always face **identical conditions and identical options**. The outcome comes from their choices:
which units to unlock, what to deploy and where, which item to take and who wears it, what to level.

- **Nothing is rolled per player.** For a given match seed and round, both players see the same loot offer, may
  unlock from the same list, and get the same income and the same deployment limit. `tests/sim.rules.test.ts`
  checks this every round of whole bot matches.
- **No catch-up and no snowball rule.** Losing a round brings no gold, no extra deployment and no better loot;
  winning brings no keep-damage bonus. Pacing rules (the round bonus to keep damage, sudden death) apply to both
  seats alike.
- **What may differ is what a player chose:** the Lord (both may pick the same one) with its passive, the units
  unlocked, the items picked from the shared offer.
- **The battle rolls nothing.** No random crits, misses or procs: critical hits come on a counter, cover is a flat
  damage reduction. The same two armies always fight the same battle, and swapping the seats gives the exact mirror
  image (`tests/sim.mirror.test.ts`).
- The match seed only decides the (mirrored) terrain and the shared loot offers.

## 1. Match flow

- Each player has a **Keep** with **4000 HP**. You win when the enemy Keep reaches 0. If both reach 0 in the same round, the player with more HP left before the round wins; if that's equal, it's a draw.
- **Round** = Planning (simultaneous, 120 s, +15 s on rounds with a loot pick) → Battle (real-time playback, typically 30–60 s) → Results (5 s).
- **Hidden information (Mechabellum-style):**
  - During planning you see where the enemy's army stood *last* round.
  - You don't see what they buy, move or equip this round until the battle starts.
  - Round 1 shows nothing.
- **Battle end:** one army is wiped out, or 90 s of sim time pass, or the battle **stalls**, which ends it early:
  - neither side has anything that can target what is left of the other (e.g. ground melee against fliers);
  - one side has nothing that can target the other's remaining units for 10 s;
  - no damage is dealt by anyone for 10 s (or there is no contact at all by 60 s).
- **Round outcome** (one rule, one wording: `roundOutcomeText` in `src/sim/match.ts`):
  - **Wipe:** the side left standing wins the round ("Victory" / "Defeat"). Both wiped on the same tick is a "Draw".
  - **Timeout or stall:** decided **on points** ("Victory on points" / "Defeat on points"). A side's points are the
    percent of its army's value still standing: each squad's value (gold spent; the Lord 300 + 30 per level) times the
    share of its soldiers' HP left. A lead of 5 points or more wins; closer is a "Draw" (a stall that ends level is
    shown as "Stalemate").
  - A lost round costs keep life and nothing else is handed out for it: no catch-up gold, no better loot (§0).
- **Keep damage:** every surviving squad marches on the enemy Keep and attacks it on screen.
  - A wipe: the winner deals the sum of each surviving squad's `keepDamage` (its cost tier × its level factor, see §3),
    plus 50 × the round number as a base.
  - A points win counts in full: the winner's survivors deal their `keepDamage` plus the round base; the loser's deal none.
  - A points draw: both sides deal half damage from their survivors.
  - **Sudden death:** from round 8, all keep damage grows by 25% per round (round 8 ×1.25, round 9 ×1.5, ...), so
    late matches resolve (`suddenDeathPct`).
  - **Match length** comes from these numbers alone: there is no final round and no forced end. A surviving squad
    deals 55 × its cost tier × (1 + level) / 2 and the Lord 60 × (9 + level) / 10, so a clear win hurts much more
    than a narrow one. Matches average 8–9 rounds and almost never pass round 12 (see `docs/BALANCE.md`).
  - Keep damage is clamped to the life the Keep has left, in the result, the replay's `keepHit` events and the history.
- **Conceding:** a player may give up at any time (`concede(state, seat)`; the `concede` message, or leaving a running
  match). The match ends at once, the opponent wins, and `overReason` is `'concede'`. A lost connection is not a
  concession: the AI plays the seat after the grace period until the player returns.
- A Keep is also a structure on the map with its own HP and weak arrow towers. Survivors physically walk to it and hit it. The HP removed equals the formula above, not raw unit damage, so that balance stays predictable.

## 2. Economy and limits

- **Supply** (gold): 300 in round 1, then income of `200 + 25 × round`, capped at 500 per round.
  - The schedule is the same for both players every round, whoever is ahead. There is no comeback gold and no
    underdog deployment (`PlayerState.comeback` is kept for older UIs and is always zeros).
  - Unspent gold carries over.
- **Deployment limit (the per-round unit limit):** you may *deploy at most 2 new squads per round*, the same for both players. Only choices change it: your Lord's passive (Marshal makes it 3) and an "of Command" relic you picked. Upgrades and equipping have no limit.
- **Army cap:** 16 squads.
- **Unit unlocks (no random drafts):** you start with your Lord's 2 signature units. Every round, round 1 included, you may unlock **any one** locked unit whose `minRound` has come: in round 1 any unit of the basic pool, from round 2 any unit at all (the Dragon from round 5). It is a free strategic choice from the full list, the same rule for both players (`unlockOptions`; `PlayerState.draftOptions` holds that list). This is the Mechabellum-style counter-picking arms race, without the luck of the draw.
- **Squad level-ups:** gold upgrades a squad from Lv1 to Lv5. The cost is `unitCost × level`. Each level gives +25% HP and +20% damage, and Lv2 and Lv4 open item slots.
- Selling a squad refunds 50% (only during the planning phase of the round it was deployed; otherwise nothing).
- Squads can be moved freely within your half during planning, every round.
- Squads may not overlap: each has a ground footprint (its formation's half-extent plus a body radius,
  `squadFootprint`), and a deploy or move onto another of your squads is refused ("overlaps another squad").

## 3. Units (squads)

The battlefield is continuous (not a grid): **80 m wide (x) × 120 m long (y)**.
- Player 0 deploys in y ∈ [4, 40] and their Keep is at y = 0.
- Player 1 deploys in y ∈ [80, 116] and their Keep is at y = 120.
- The field is **mirrored** for fairness: player 1's terrain is player 0's rotated 180°.

A squad is N identical soldiers with shared orders. Each soldier has its own HP and position.

| Unit | Squad size | Role | Weapon | Cost | Notes (FE flavour) |
|---|---|---|---|---|---|
| Militia | 12 | chaff screen | sword | 100 | cheap; absorbs splash |
| Pikemen | 8 | anti-cavalry | lance | 100 | ×2.5 vs mounted; brace |
| Berserkers | 6 | melee DPS | axe | 150 | lifesteal 20%; fast attack |
| Archers | 9 | ranged | bow | 100 | ×1.25 vs fliers; range 25 m |
| Knights | 4 | tank | lance | 200 | armor: −60% from arrows and physical; weak to magic and hammers |
| Cavaliers | 4 | flanker | sword | 200 | fast; charge: first hit ×2 |
| Mages | 4 | AoE | fire tome | 200 | 3 m splash; ignores armor |
| Clerics | 3 | support | staff | 150 | heal the nearest wounded ally squad; no attack |
| Pegasus Knights | 3 | air raider | lance | 200 | flier: ignores terrain, only hit by bows, magic and fliers |
| Ballista | 1 | anti-large | bolt | 200 | range 40 m; ×2 vs Large; pierces in a line |
| Trebuchet | 1 | artillery | stone | 300 | range 60 m; 6 m splash; slow turn; min range 12 m |
| Stone Golem | 1 | giant tank | fists | 400 | Large; huge HP; slow; stomp AoE |
| Wyvern Riders | 2 | heavy air | axe | 300 | flier + Large; melee vs ground and air |
| Dragon | 1 | late game | fire breath | 500 | flier + Large; cone AoE; unlockable from round 5 only |

- **Fliers** ignore terrain and can only be hit by bows, magic, bolts and other fliers. Shots from the ground lose 30% against them (`FLIER_EVADE_PCT`), and Archers deal ×1.25 to fliers (it was ×2): with every unit freely unlockable, anti-air has to be an answer to an air army, not an automatic win over it.
- **Weapon triangle:** Sword > Axe > Lance > Sword. The winner deals +25% damage and the loser −25%. This applies within the sword/axe/lance families.
- **Tags:** `mounted`, `armored`, `flier`, `large`, `infantry`. Effectiveness multipliers key off these tags.
- **Stats:** the sim agent tunes HP, damage, attack interval, range, speed, armor and magic resist per soldier, and they live in `src/sim/data/units.ts`.
- **Balance target:** no unit's cost-normalised win-rate is outside 40–60% across the bot tournament (§8), and every unit has at least one hard counter.

## 4. Lords (the "commander" / FE-Lord layer, also the ARPG hero)

At match start, each player picks a faction (§4b) and one of its Lords: four for the Kingdom, one each for the Ashen Covenant and the Sun Caliphate. They are mirrored-available, so both players can pick the same one. The Lord:
- Is a single hero unit on the field, deployed like a squad. It does not count against the deployment limit.
- Gains XP from kills, levels up during the match (to Lv10), and has **3 item slots** (weapon, armor, relic) from the start.
- Has a passive and an active ability that fires automatically in battle.

| Lord | Signature units | Passive | Auto ability |
|---|---|---|---|
| **Marshal Aldric** (sword) | Militia, Cavaliers | +1 squad deployment per round | Rally: +40% attack speed to squads within 20 m for 10 s |
| **Archmage Sefa** (tome) | Mages, Clerics | Magic damage +70% | Meteor: a 10 m AoE at the densest enemy cluster (18 + 3 per Lord level) |
| **Warden Hrolf** (axe) | Berserkers, Knights | Keep +800 HP; squads +10% HP | Bulwark: allies within 12 m take −40% damage for 6 s |
| **Skylady Ione** (lance) | Pegasus, Archers | Loot picks see 4 items instead of 3 | Skyfall: dive on the furthest enemy ranged squad |
| **Lich-Priest Morthen** (tome; Ashen Covenant) | Skeleton Spearmen, Grave Acolytes | Squads deal +12% damage | Necromancy: raises 3 (+1 per 3 Lord levels) skeletons from the fallen within 25 m |
| **Sultana Zahira** (sword; Sun Caliphate) | Spear Levy, Camel Archers | Squads attack 8% faster | Radiance: 20 (+4 per Lord level) magic damage to enemies within 8 m, and as much life restored to allies |

If the Lord dies in battle, it respawns next round like everything else. The death only costs you its presence in that fight.

A Lord is strong but must not carry the army: the balance target is that a Lord deals 25% or less of its army's
damage on average (see `docs/BALANCE.md`). Lord power therefore sits in the passive and the army-wide ability
rather than in the hero's own stats, and Lord levels come slowly (Lv10 needs 1375 XP).

## 4b. Factions

There are three playable factions, so a match is no longer two copies of one army. Each player picks a faction at
match start, then one of its Lords. Either player can pick any faction, including the same one.

- **A faction is a roster and nothing else.** Only its units can be unlocked (`unlockOptions`), and its Lords start
  with two of them. Income, loot offers, the deployment limit, keep HP and every rule of battle are identical for all
  factions (§0). Items and skills are faction-neutral: every unit maps onto one of the existing skill classes.
- **Picking** (`lordPick` phase): `{t:'pickFaction', faction}` is optional and can be changed until the Lord is picked;
  `{t:'pickLord', lord}` must name a Lord of that faction, and a Lord picked without a faction implies its own. The
  enemy's faction and Lord stay hidden until both have picked.
- Every unit names the Kingdom unit it plays **like** (`UnitDef.like`), so the bots and the counter table understand
  all three rosters. Unit ids are also the renderer's model ids.
- **Balance levers** (`src/sim/data/balance.ts`): `UNIT_POWER` per unit, `LORD_POWER` per Lord, and `FACTION_POWER`
  per faction in per mille, applied to every unit of the faction. The target is equal-level play (Hard vs Hard), as
  two humans play; see `docs/BALANCE.md`.

**1. The Oathsworn Kingdom** (blue, steel, gold): the original 14 units and 4 Lords. The broadest roster, with healers.

**2. The Ashen Covenant** (bone white, ash grey, tarnished bronze, green soul-fire). No healers; the fallen rise instead.

| Unit (id) | Size | Cost | Class | Plays like | What it does |
|---|---|---|---|---|---|
| Skeleton Spearmen (`skeleton`) | 10 | 100 | infantry | Pikemen | chaff; ×2 against mounted, braces against charges |
| Grave Knights (`grave_knight`) | 4 | 200 | infantry | Knights | heavy armour (55%); drains 10% of its damage as life |
| Bone Archers (`bone_archer`) | 9 | 100 | ranged | Archers | 24 m bows; ×1.25 against fliers |
| Wraith Riders (`wraith_rider`) | 4 | 200 | mounted | Cavaliers | charge and raid the backline; **ethereal**: 45% less physical damage, 10% more magic damage; spectral steeds are not `mounted`, so anti-cavalry bonuses miss them (a braced spear wall still stops the charge) |
| Grave Acolytes (`grave_acolyte`) | 3 | 200 | caster | Mages | 18 m soul bolts that drain 30% as life; **raise the fallen** as skeletons (3 + squad level per battle) |
| Bone Drake (`bone_drake`) | 1 | 300 | flier | Wyvern | Large flier, 2 m sweep; arrows rattle through its ribs (40% armour), magic is the answer |
| Corpse Catapult (`corpse_catapult`) | 1 | 300 | siege | Trebuchet | 55 m, 5 m splash; **plague**: hits fester for 4 damage a second over 3 s |
| Bone Golem (`bone_golem`) | 1 | 400 | giant | Golem | Large, stomps, crushes armour |

Lord: the **Lich-Priest** (`lich`, model `lord_lich`), a soul-lantern caster. Raised skeletons (by Acolytes, the Lich
or the Gravebloom legendary) are summoned soldiers of type `skeleton` (120 life, 16 damage a blow): they fight until the
battle ends and are gone.
Each side can raise a given corpse once; Lords and Large units leave no usable corpse.

**3. The Sun Caliphate** (white, ochre, turquoise, gold). Fast, blessed and hard to pin down.

| Unit (id) | Size | Cost | Class | Plays like | What it does |
|---|---|---|---|---|---|
| Spear Levy (`spear_levy`) | 10 | 100 | infantry | Pikemen | chaff; ×2 against mounted, braces |
| Scimitar Guard (`scimitar`) | 6 | 150 | infantry | Berserkers | fast sword line (beats axes, loses to lances) |
| Camel Archers (`camel_archer`) | 4 | 200 | ranged | Archers | mounted bows: 18 m range, fast, tougher than foot archers; ×1.25 against fliers |
| Mamluk Lancers (`mamluk`) | 4 | 200 | mounted | Cavaliers | armoured shock cavalry: charge, raid the backline |
| Djinn-Binders (`djinn_binder`) | 4 | 200 | caster | Mages | whirlwind: 3 m splash that **slows 25%** for 2 s |
| Sun Priests (`sun_priest`) | 3 | 150 | caster | Clerics | heal; **bless**: what they heal attacks 15% faster for 4 s; **radiant**: their sunbolts deal 50% more to the undead |
| Bound Djinn (`djinn`) | 2 | 300 | flier | Pegasus | flier with wind-blades: a sword in the weapon triangle that deals magic damage; not Large (bolt-throwers get no bonus) |
| War Elephant (`war_elephant`) | 1 | 400 | giant | Golem | Large, tramples (3 m); **howdah archers** let it strike fliers in reach; from round 3 |
| Sand Golem (`sand_golem`) | 1 | 300 | giant | Golem | Large; **regenerates 1.5% of its life a second** |

Lord: the **Sultana** (`sultana`, model `lord_sultana`), a sun-banner commander. Sunlight burns the dead: her blade and her
Radiance deal 25% more to the undead (Ashen units, the Lich-Priest, raised skeletons).

Future work: a second Lord for each new faction, and one or two faction-flavoured item skills.

## 5. Loot (the core replacement for spell cards)

After every round, each player picks **1 item from 3**, in the next planning phase. **Both players are offered
exactly the same items** (`rollLoot`, seeded by the match and the round only), and simply pick differently:

- **One item per slot** (weapon, armor, relic), so there is always something usable. The offer does not look at
  either army. Skylady's passive adds a fourth item of the round's lowest tier.
- **A fixed rarity schedule by round** (`lootSchedule`), with no rarity rolls and no bonus tier for the loser:

  | Rounds | Offer |
  |---|---|
  | 1–2 | Magic, Magic, Magic |
  | 3–5 | Rare, Magic, Magic |
  | 6–8 | Rare, Rare, Magic |
  | 9 on | Rare, Rare, Rare |
  | every 3rd round (3, 6, 9, 12) | the best item is a **Legendary** instead |

- The slot of the best item rotates (`lootTopSlot`): the Legendary rounds 3, 6 and 9 visit all three slots, and the
  match seed sets where the rotation starts, for both players alike.
- Affix values, legendary powers and skills still vary from round to round (rolled from the shared seed), and one
  offer never shows the same legendary power or skill twice.

**Rarity tiers and affix counts** (ARPG-style, Diablo-like naming and colours):

| Rarity | Colour | Affixes |
|---|---|---|
| Common | white | 0 + base implicit (not offered any more; kept for old items) |
| Magic | blue | 1–2 |
| Rare | yellow | 3–4 (or 2–3 and an active skill) |
| Legendary | orange | 2 affixes + 1 legendary power |

- **Slots:** a squad has Weapon at Lv1, Armor at Lv2 and Relic at Lv4. The Lord has all three from the start. An item applies to *every soldier in the squad*.
- **Bases** (by slot):
  - Weapon: e.g. "Steel Blade" with implicit +10% dmg, "Ironbark Bow" with +10% range.
  - Armor: "Mail Hauberk" with +12% HP, "Warded Robe" with +20% magic resist.
  - Relic: "Bone Charm", "Sun Medallion", "Oath Ring".
- **Affix pool** (prefix/suffix, rolled with ranges):
  - "Keen" +x% crit.
  - "Vicious" +x% damage.
  - "of Haste" +x% attack speed.
  - "of the Leech" x% lifesteal.
  - "Stalwart" +x% HP.
  - "of Warding" +x% magic resist.
  - "Fleet" +x% move speed.
  - "of Thorns" reflects x%.
  - "Slaying" +x% vs {mounted|armored|flier|large}.
  - "of Embers" attacks burn for x dps over 3 s.
  - "of Frost" attacks slow 20% for 2 s.
  - "Far-reaching" +x m range (ranged only).
  - "of the Phoenix" the first soldier death per battle is revived.
  - "of Command" +1 deployment next round (rare, Relic only).
- **Legendary powers** (examples; ~12 total):
  - **Stormcaller**: attacks chain lightning to 3 targets.
  - **Kingsbane**: ×3 damage vs Lords and Large.
  - **Undying Oath**: the squad's soldiers revive once at 30% HP.
  - **Ember Crown**: the squad's deaths explode for AoE fire.
  - **Mirror Aegis**: the first 3 projectiles per soldier are reflected.
  - **Warhorn of Valor**: +2 squad size.
  - **Gravebloom**: slain enemies rise as skeletons for you for the rest of the battle.
- **Skill items:** a Rare item has a 50% chance to grant an **active skill** in place of its last affix (§5b). Skill
  items are class-locked and their tooltip shows the skill block and "Usable by: ...". The offer is the same for both
  players, so a skill item may suit one army better than the other: that is part of the choice.
- **Unequipping:** items can be moved between squads freely during planning. A sold squad's items go to your stash.
- **Balance:** item power is budgeted, so one item ≈ 20–35% of the squad's base value. Legendaries are capped by a budget. Affix values scale with the round (item level). Offers are rolled once per round from the match seed, so both players get the same items.

## 5b. Skills

Everything a squad can do is data, so the inspector can show it (`src/sim/data/skills.ts`):

- **Innate abilities** (`unitSkills(type)`): the unit's traits and counters with their real numbers, e.g. Brace,
  Charge, Heal (active, 1.5 s), "Flying bane ×2", Piercing bolt, Stomp, Fire breath, Crushing, Heavy armor.
- **Lord skills** (`lordSkills(lord, level)`): the passive and the auto ability with its cooldown
  (Rally 14 s, Meteor 15 s, Bulwark 17 s, Skyfall 18 s).
- **Item skills and legendary powers** (`squadSkills(squad, lord)` adds these to the two lists above).

**Unit classes** gate skill items. Every unit type has exactly one class; a Lord has `lord` plus the class of its
fighting style. Knights do not cast fireballs: `applyIntent` refuses to equip a skill item on the wrong class
("only Casters can use Fireball"), and the battle ignores a skill on the wrong class.

| Class | Units |
|---|---|
| caster | Mages, Clerics, Archmage Sefa |
| infantry | Militia, Pikemen, Berserkers, Knights, Marshal Aldric, Warden Hrolf |
| ranged | Archers |
| mounted | Cavaliers |
| flier | Pegasus Knights, Wyvern Riders, Dragon, Skylady Ione |
| siege | Ballista, Trebuchet |
| giant | Stone Golem |
| lord | all four Lords |

**Item skills.** It is an auto-battler, so a squad casts a skill by itself whenever its cooldown is up and its
trigger holds (checked 4 times a second; the first cast is possible 2 s into the battle). `L` is the item level
(the round the item dropped in). Flat damage goes through the usual armour and resistance rules.

| Skill | Slot | Classes | Cooldown | Trigger | Effect |
|---|---|---|---|---|---|
| Fireball | weapon | caster | 10 s | 3+ enemies bunched within 22 m | 36 + 6L magic damage within 3.5 m; burns 3 + L/2 per second for 3 s |
| Chain Lightning | weapon | caster | 8 s | an enemy within 20 m | 40 + 6L magic to the nearest enemy, leaps to 4 more at −20% each |
| Frost Nova | relic | caster | 10 s | 2+ enemies within 7 m of the squad | 28 + 5L magic and a 50% slow for 4 s within 7 m |
| Mending Light | relic | caster | 8 s | an allied squad within 18 m below 70% life | restores 14 + L % of max life to every soldier of the most wounded squad |
| Shield Wall | armor | infantry, giant | 14 s | in combat and below 85% life | the squad takes 28 + 2L % (max 50%) less damage for 5 s |
| War Cry | relic | infantry, lord | 16 s | an enemy within 8 m | allies within 10 m attack 14 + 2L % faster for 6 s (no stacking with Rally) |
| Cleave | weapon | infantry | 12 s | 4+ enemies within 4 m | for 4 s melee blows also hit enemies within 2.5 m of the target for 40 + 4L % damage |
| Fire Arrows | weapon | ranged | 10 s | enemies in bow range | an extra volley at full damage; each hit burns 4 + L per second for 3 s |
| Pinning Shot | weapon | ranged | 9 s | enemies in bow range | an extra volley at 60 + 5L % damage that slows by 50% for 4 s |
| Rain of Arrows | armor | ranged | 14 s | 5+ enemies bunched in bow range | 3 waves of 11 + 2L physical damage on a 5 m circle (hits fliers) |
| Thunderous Charge | weapon | mounted | 14 s | the first impact, then whenever ready | 30 + 5L physical within 3 m; ground enemies are thrown back 2 m |
| Trample | armor | mounted, giant | 10 s | 3+ ground enemies within 3.5 m | 36 + 6L physical and a 30% slow for 2 s within 3.5 m |
| Dive Strike | weapon | flier | 12 s | the squad reaches an enemy | every soldier strikes its target for 180 + 12L % damage, also hitting within 2 m |
| Incendiary Payload | weapon | siege | 14 s | 3+ ground enemies bunched in range | the ground within 4 m burns for 4 s, 6 + L magic damage per second |

**How skills enter loot.** No new item bases: a Rare item has a 50% chance (`SKILL_CHANCE`) to grant a skill of its
slot instead of its last affix, so a skill Rare has 2–3 affixes plus the skill, and its name ends in the skill
("Doom Brand, Vicious Grimoire of Fireball"). Common and Magic items never grant skills, and a Legendary keeps its
legendary power instead, so the rarity tiers stay distinct. Offers are identical for both players and do not look
at their armies; one offer never shows the same skill twice.

**Bots.** All three levels choose from the same shared offer and the full unlock list. Easy ignores skills (random loot, random unlocks, random equips; the class gate simply refuses bad ones). Normal picks
the strongest usable item and puts it on its most valuable squad that can use it. Hard weighs each skill by how
often its trigger will hold against the enemy's last army (Frost Nova and Pinning Shot against cavalry and fliers,
area skills against infantry) and re-gears every round.

## 6. Battlefield

- Mirrored terrain features are seeded per match:
  - **Forest** patches: units inside take 40% less ranged damage (a flat reduction; nothing "misses"), and movement is slowed 30%.
  - **Hills** give +15% range and damage to ranged units standing on them.
  - **A river** across the middle (y ≈ 55–65) with 2–3 bridges/fords: −50% speed in the water; fliers ignore it.
  - **Ruins** (light cover, −25% ranged damage taken).
- Pathing uses a flow field per side over a 1 m nav grid, so 100+ soldiers path cheaply. Soldiers separate from each other (boids-style) and squads keep a loose formation until engaged.

## 7. Battle simulation (deterministic, server-authoritative)

- Fixed tick **20 Hz**. Integer / fixed-point math only. No `Math.random`, `Date`, `Math.sin`, `Math.sqrt` or `Math.hypot`; use integer approximations and lookup tables. The battle uses **no random numbers at all**:
  - a critical hit (×1.5) comes on a per-soldier counter: with 20% crit every fifth attack is critical;
  - forest and ruins cover are flat reductions of ranged damage;
  - first attacks are staggered by a soldier's place in its own army, not by a seed.
- The server simulates the whole battle at the end of planning and sends a **compact replay**, which the clients only play back. The clients never simulate.
  - The replay is a **keyframe stream**: every 4 ticks (0.2 s), the quantised positions, facing and HP of every soldier. It also carries an **event list**: attack (with projectile type), hit, death, ability, keep hit, item procs, at tick precision.
  - Replay version 3 adds, in the same binary stream but decoded into their own lists so the classic event list is unchanged:
    - **skill casts** (`DecodedReplay.skills`): the casting soldier and squad, the skill, the target point, soldier and squad, the radius and the duration;
    - the **statistics ledger** (`DecodedReplay.tallies`): every 0.5 s, per (source squad, target squad, cause), the life removed (no overkill), the damage mitigated, the life restored (no overheal) and the hit count. Causes are plain attacks, burns, thorns, towers, legendary procs, Lord abilities, heals and each item skill.
    - a `squads` header (one row per squad, with its soldiers, skills and items).
  - **Debuff windows** are `ability` events emitted once when the debuff starts on a soldier (`tgt`), with `src` = the
    soldier that applied it and `dur` in ticks: `burn` (a burn, or the Corpse Catapult's plague; the damage ticks
    themselves are not events), `frost` (a slow), and `war_cry` with radius 0 (a Sun Priest's blessing).
  - `squadStatsAt(decoded, tick)` reads the ledger into per-squad statistics (damage dealt, taken and mitigated, healing done and received, kills, losses, soldiers, skill casts and totals, HP over time). It is the single source of truth for the inspector and the battle report. `squadSheet` / `replaySquadSheet` give a squad's stats "base → effective", items and skills.
  - The size target is under 400 KB uncompressed for a 90 s battle with 200 soldiers. Use delta and RLE encoding if needed, and gzip via `permessage-deflate`.
- Targeting: nearest valid enemy, biased by the unit role (ballista → Large, archers → fliers in range, cavalry → backline after charging).

## 8. Balance process (required)

- `tools/tournament.ts`: a headless bot-vs-bot round robin. Bots use different strategies: rush, ranged-heavy, armor, air, and a "counter-picker" that reads the opponent's last army. They also use random-but-sensible play.
- The tournament reports the win rate per Lord, per unit (cost-normalised presence in winning armies), per item legendary, and P0 vs P1 side advantage.
- Targets:
  - Side advantage under 52/48.
  - Every Lord between 45% and 55%.
  - No unit, legendary or item skill outside 40–60%.
  - A Lord deals 25% or less of its army's damage on average.
  - Average match 9–12 rounds, 95th percentile 15 rounds or fewer.
- Run it in CI tests at a small sample size, and fully by hand before tuning commits.

## 9. Presentation (AAA-in-browser targets)

- three.js WebGL2:
  - PBR materials with an HDR environment and ACES tone mapping.
  - Cascaded shadows. Bloom, SSAO (or GTAO), colour grading, vignette and depth-of-field in the battle cinematic camera.
- **Models:** an AI pipeline in which a local image model makes concept art and TRELLIS.2 turns it into a textured mesh. Blender then cleans up, decimates, auto-rigs the humanoids to a shared skeleton and retargets a CC0 animation set (idle, walk, run, attack variants, hit, death). Units carry LODs.
- **Crowds:** GPU-instanced skinned meshes using baked vertex-animation textures (VAT), so 200+ animated soldiers stay smooth.
- **VFX:** projectiles with trails, fire, lightning chains, heal glows, hit sparks, dust from marching, death ragdoll-ish falls, Keep destruction stages, and loot beams (rarity coloured) on the pick screen.
- **Camera:** free RTS camera in planning. During battle, a cinematic auto-director that cuts between the frontline, big hits and Lord abilities; you can override it.
- **UI:** a premium dark-fantasy HUD. The loot screen looks like an ARPG tooltip (rarity colours, affix lines, legendary orange text).

## 10. Multiplayer

The same infrastructure as v1 (cue-club pattern):
- Rooms have 2 seats with codes and invite links, plus token rejoin.
- A **vs AI** option with three levels, all limited to what a player may see (`viewFor`):
  - **Easy** under-spends (about 65% of its gold), rarely levels up, drafts, loots and equips at random, doesn't
    counter-pick, and lines its army up in one naive row.
  - **Normal** counter-picks the enemy's last army, keeps a frontline, spends sensibly (about a 12% reserve), equips
    each item on its most valuable squad and uses fixed role lanes. It knows each faction's roster (which units pay
    off without flanking) and keeps an answer to fliers, a single Dragon included.
  - **Hard** spends everything, re-forms its whole army each round against the enemy's last formation (counters
    opposite what they counter, raiders on the flank holding the enemy backline), gears squads by affix fit, and
    makes slot-aware level-ups and counter drafts.
  - A disconnected player's seat is played by Hard after the grace period, until they rejoin.
- Spectators are allowed (read-only seats beyond 2).
- **Conceding:** the `concede` message (or leaving a running match) ends the match with the opponent as the winner;
  `RoomView.over = { reason: 'concede', by: seat }`. A disconnect keeps the AI takeover.
- **Asset caching:** JSON metadata (`manifest.json`, VAT `.json`, `/asset-versions.json`) is `no-cache`; the server
  appends a `hashes` map to every `manifest.json` it serves and lists every art, texture and audio file's content hash
  in `/asset-versions.json`. A file requested with `?v=<hash>` is immutable for a year; without it, it revalidates.
- The server validates every intent with the shared rules. Hidden information is enforced *server-side*: planning snapshots sent to a player contain only the enemy's previous-round army, never their current changes.
