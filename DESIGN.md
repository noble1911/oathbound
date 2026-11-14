# Oathbound v2 — Design

**1v1 PvP fantasy army auto-battler in the browser.** It is Mechabellum's structure in a Fire Emblem-flavoured fantasy world:
- Each round, both players spend gold to deploy and upgrade squads on their half of a battlefield.
- The battle then plays out in real time with no input.
- Armies advance to destroy each other and push on to the enemy **Keep**.
- The army is permanent: every squad returns at full strength next round, in the place it was deployed.
- Mechabellum's reinforcement cards are replaced by **ARPG loot**: rarity-tiered items with random affixes and uniques, equipped onto squads and onto your Lord.

The target is an AAA-feeling presentation: animated textured models, crowds of soldiers, real VFX and cinematic battle playback.

The v1 co-op FE-grid design is archived in `../oathbound-v1-snapshot.tar`.

## 1. Match flow

- Each player has a **Keep** with **4000 HP**. You win when the enemy Keep reaches 0. If both reach 0 in the same round, the player with more HP left before the round wins; if that's equal, it's a draw.
- **Round** = Planning (simultaneous, 60 s, +15 s on rounds with a loot pick) → Battle (real-time playback, typically 30–60 s) → Results (5 s).
- **Hidden information (Mechabellum-style):**
  - During planning you see where the enemy's army stood *last* round.
  - You don't see what they buy, move or equip this round until the battle starts.
  - Round 1 shows nothing.
- **Battle end:** one army is wiped out, or 90 s of sim time pass.
- **Keep damage:** every surviving squad marches on the enemy Keep and attacks it on screen. Damage = the sum of each surviving squad's `keepDamage` (its cost tier × its level factor, see §3), plus 50 × the round number as a base, but only if you *won* the round (the enemy army is wiped). At the timeout, both sides deal half damage from their survivors.
- A Keep is also a structure on the map with its own HP and weak arrow towers. Survivors physically walk to it and hit it. The HP removed equals the formula above, not raw unit damage, so that balance stays predictable.

## 2. Economy and limits

- **Supply** (gold): 300 in round 1, then income of `200 + 25 × round`, capped at 500 per round.
  - Losing the round gives +75 catch-up gold.
  - Unspent gold carries over.
- **Deployment limit (the per-round unit limit):** you may *deploy at most 2 new squads per round*. Your Lord's passive and some items change this, e.g. Marshal makes it 3. Upgrades and equipping have no limit.
- **Army cap:** 16 squads.
- **Unit unlocks:** you start with 4 unit types unlocked: your Lord's 2 signature units plus 2 drafted from a random 3 of the basic pool. You unlock one more each round from a choice of 2. This produces the Mechabellum-style counter-picking arms race.
- **Squad level-ups:** gold upgrades a squad from Lv1 to Lv5. The cost is `unitCost × level`. Each level gives +25% HP and +20% damage, and Lv3 and Lv5 open item slots.
- Selling a squad refunds 50% (only during the planning phase of the round it was deployed; otherwise nothing).
- Squads can be moved freely within your half during planning, every round.

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
| Archers | 10 | ranged | bow | 100 | ×3 vs fliers; range 28 m |
| Knights | 4 | tank | lance | 200 | armor: −60% from arrows and physical; weak to magic and hammers |
| Cavaliers | 4 | flanker | sword | 200 | fast; charge: first hit ×2 |
| Mages | 4 | AoE | fire tome | 200 | 3 m splash; ignores armor |
| Clerics | 3 | support | staff | 150 | heal the nearest wounded ally squad; no attack |
| Pegasus Knights | 3 | air raider | lance | 200 | flier: ignores terrain, only hit by bows, magic and fliers |
| Ballista | 1 | anti-large | bolt | 200 | range 40 m; ×3 vs Large; pierces in a line |
| Trebuchet | 1 | artillery | stone | 300 | range 60 m; 6 m splash; slow turn; min range 12 m |
| Stone Golem | 1 | giant tank | fists | 400 | Large; huge HP; slow; stomp AoE |
| Wyvern Riders | 2 | heavy air | axe | 300 | flier + Large; melee vs ground and air |
| Dragon | 1 | late game | fire breath | 500 | flier + Large; cone AoE; unlockable from round 5 only |

- **Weapon triangle:** Sword > Axe > Lance > Sword. The winner deals +25% damage and the loser −25%. This applies within the sword/axe/lance families.
- **Tags:** `mounted`, `armored`, `flier`, `large`, `infantry`. Effectiveness multipliers key off these tags.
- **Stats:** the sim agent tunes HP, damage, attack interval, range, speed, armor and magic resist per soldier, and they live in `src/sim/data/units.ts`.
- **Balance target:** no unit's cost-normalised win-rate is outside 40–60% across the bot tournament (§8), and every unit has at least one hard counter.

## 4. Lords (the "commander" / FE-Lord layer, also the ARPG hero)

At match start, each player picks one of 4 Lords. They are mirrored-available, so both players can pick the same one. The Lord:
- Is a single hero unit on the field, deployed like a squad. It does not count against the deployment limit.
- Gains XP from kills, levels up during the match (to Lv10), and has **3 item slots** (weapon, armor, relic) from the start.
- Has a passive and an active ability that fires automatically in battle.

| Lord | Signature units | Passive | Auto ability |
|---|---|---|---|
| **Marshal Aldric** (sword) | Militia, Cavaliers | +1 squad deployment per round | Rally: +30% attack speed to nearby squads for 8 s |
| **Archmage Sefa** (tome) | Mages, Clerics | Magic damage +15% | Meteor: a 10 m AoE at the densest enemy cluster |
| **Warden Hrolf** (axe) | Berserkers, Knights | Keep +800 HP; squads +10% HP | Bulwark: allies within 12 m take −40% damage for 6 s |
| **Skylady Ione** (lance) | Pegasus, Archers | Loot picks see 4 items instead of 3 | Skyfall: dive on the furthest enemy ranged squad |

If the Lord dies in battle, it respawns next round like everything else. The death only costs you its presence in that fight.

## 5. Loot (the core replacement for spell cards)

After every round, each player picks **1 item from 3**. The round's loser rolls one rarity tier higher, which is the catch-up mechanic. From round 1, the pick happens in the next planning phase.

**Rarity tiers and affix counts** (ARPG-style, Diablo-like naming and colours):

| Rarity | Colour | Affixes | Base roll weight |
|---|---|---|---|
| Common | white | 0 + base implicit | 40 |
| Magic | blue | 1–2 | 35 |
| Rare | yellow | 3–4 | 20 |
| Legendary | orange | 2 affixes + 1 legendary power | 5 (round ≥ 3) |

- **Slots:** a squad has Weapon at Lv1, Armor at Lv3 and Relic at Lv5. The Lord has all three from the start. An item applies to *every soldier in the squad*.
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
- **Unequipping:** items can be moved between squads freely during planning. A sold squad's items go to your stash.
- **Balance:** item power is budgeted, so one item ≈ 20–35% of the squad's base value. Legendaries are capped by a budget. Affix values scale with the round (item level). Rolls are seeded per match, so both players draw from the same distribution.

## 6. Battlefield

- Mirrored terrain features are seeded per match:
  - **Forest** patches give ranged units −40% hit against units inside and slow movement −30%.
  - **Hills** give +15% range and damage to ranged units standing on them.
  - **A river** across the middle (y ≈ 55–65) with 2–3 bridges/fords: −50% speed in the water; fliers ignore it.
  - **Ruins** (light cover, −25% ranged damage taken).
- Pathing uses a flow field per side over a 1 m nav grid, so 100+ soldiers path cheaply. Soldiers separate from each other (boids-style) and squads keep a loose formation until engaged.

## 7. Battle simulation (deterministic, server-authoritative)

- Fixed tick **20 Hz**. Integer / fixed-point math only. No `Math.random`, `Date`, `Math.sin`, `Math.sqrt` or `Math.hypot`; use integer approximations and lookup tables. A seeded PRNG per battle.
- The server simulates the whole battle at the end of planning and sends a **compact replay**, which the clients only play back. The clients never simulate.
  - The replay is a **keyframe stream**: every 4 ticks (0.2 s), the quantised positions, facing and HP of every soldier. It also carries an **event list**: attack (with projectile type), hit, death, ability, keep hit, item procs, at tick precision.
  - The size target is under 400 KB uncompressed for a 90 s battle with 200 soldiers. Use delta and RLE encoding if needed, and gzip via `permessage-deflate`.
- Targeting: nearest valid enemy, biased by the unit role (ballista → Large, archers → fliers in range, cavalry → backline after charging).

## 8. Balance process (required)

- `tools/tournament.ts`: a headless bot-vs-bot round robin. Bots use different strategies: rush, ranged-heavy, armor, air, and a "counter-picker" that reads the opponent's last army. They also use random-but-sensible play.
- The tournament reports the win rate per Lord, per unit (cost-normalised presence in winning armies), per item legendary, and P0 vs P1 side advantage.
- Targets:
  - Side advantage under 52/48.
  - Every Lord between 45% and 55%.
  - No unit or legendary outside 40–60%.
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
- A **vs AI** option uses the tournament's best bot.
- Spectators are allowed (read-only seats beyond 2).
- The server validates every intent with the shared rules. Hidden information is enforced *server-side*: planning snapshots sent to a player contain only the enemy's previous-round army, never their current changes.
