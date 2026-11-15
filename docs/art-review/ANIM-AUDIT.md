# Animation audit (every unit, every clip)

Scope: all 19 unit models x every clip the renderer can play (154 clips). Each clip was captured **in the engine**
(`render-test.html`; crowd units through the VAT shader, heroes / siege through the AnimationMixer; one soldier alone,
the pose driven directly) as 8-frame strips: a close-up side view and the RTS view (3/4 from behind, the pixel size
a 1080p player sees from about 35 m). I looked at every `before` sheet. Tool: `node e2e/anim-audit.mjs <tag> [units]`.

Grades: **A** good, **B** fine at game distance with small flaws up close, **C** visibly wrong or weak, **F** broken
(reads as a bug in play). `X → Y` = before → after this pass.

## Summary

| grade | before | after |
|---|---|---|
| A | 3 | 3 |
| B | 91 | 145 |
| C | 49 | 6 |
| F | 11 | 0 |

## Humanoids, mounts, creatures

| unit | idle | move | run | attack | attack2 | cast | hit | death | victory |
|---|---|---|---|---|---|---|---|---|---|
| militia | B | B | C → B | B | B | – | B | B | C → B |
| pikeman | C → B | C → B | C → B | C → B | C → B | – | F → B | C → B | C → B |
| berserker | B | B | C → B | B | B | – | B | B | C → B |
| archer | B | B | C → B | B | F → B | – | B | B | C → B |
| knight | B | B | C → B | C → B | C → B | – | F → B | C → B | B |
| mage | B | B | C → B | B | F → B | B | B | B | C → B |
| cleric | C → B | C → B | C → B | C → B | F → B | – | C → B | B | C → B |
| skeleton | B | B | C → B | B | B | – | B | B | C → B |
| cavalier | B | B | C | B | B | – | B | B | A |
| pegasus | C | B | B | B | B | – | F → B | C → B | B |
| lord_marshal | B | B | B | B | B | B | B | B | C → B |
| lord_archmage | B | B | B | B | C → B | B | B | B | C → B |
| lord_warden | A | B | B | A | B | B | B | C → B | B |
| lord_skylady | B | B | C → B | C → B | C → B | F → B | F → B | C → B | B |
| golem | B | B | B | C → B | C → B | B | B | B | C → B |
| wyvern | B | B | B | C | C | B | B | B | B |
| dragon | B | B | B | C → B | C → B | C → B | B | B | B |

`attack` / `attack2` are what the renderer plays (it alternates them per soldier): sword / spear / pike units
`attack_melee_a` / `_b`, archers `attack_bow` / `attack_melee_a`, casters `cast` / `attack_melee_a`.

## Siege

| unit | idle | fire | reload | hit | death |
|---|---|---|---|---|---|
| ballista | B | C → B | F → B | F → C | C → B |
| trebuchet | B | B | B | F → C | C → B |

## What was wrong and what changed, per unit

* **militia**: run: 25 deg sprint lean and the shield arm pumped like a fist, flinging the shield over the shoulder -> shield held in guard, torso 9 deg more upright. victory: frozen raised arm -> pumps with chest / head / bounce.
* **pikeman**: a 3.6 m pike carried and poked one-handed with no leg work; `hit` snapped the pike 60 deg to another grip and back; death popped it on frame 1 -> new two-handed `pike` clipset (carry, level-draw-thrust with a lunge, high thrust, hit, deaths that release the grip over 0.5 s, victory with the pike raised).
* **berserker**: run lean, static victory (shared clips, as militia).
* **archer**: attack2 was a PUNCH: the renderer alternates attack / attack2 per soldier, so every second archer loosed arrows by jabbing -> attack2 is now the same shot lofted 25 deg. Draw reworked (side-on stance, draw to the cheek, short follow-through instead of the arm flung straight back). run: full 5.8 m/s sprint clip at half rate -> contained jog. Bowstring still rigid.
* **knight**: thrusts had no legs (a statue poking) -> lunge step + hip drop; `hit` snapped the lance to the hanging-arm orientation; death popped it on frame 1 -> carry kept through hit, released over the first 0.5 s of the death; run: shield in guard, more upright.
* **mage**: attack2 was an empty-handed overhead sword chop (every second mage 'cast' by chopping the air) -> mirrored cast. run -> contained jog.
* **cleric**: the staff ran along the forearm with its head by the elbow: waved like a baton in every clip, and attack2 struck with the butt -> new `staff` clipset: gripped in the fist and carried upright, raised to cast, thrust head-first to strike, kept through hit, released in the deaths, held aloft in victory.
* **skeleton**: run lean, static victory (shared clips).
* **cavalier**: gallop: the tail lifted level as one plank -> lower, with a travelling ripple; it still reads as one sheet (the mesh tail is a single slab on 3 bones). Legs a little rubbery up close (750-tri horse).
* **pegasus**: `hit` snapped the lance from the carry to vertical; death popped it -> fixed by the spear clipset. Still weak: from the side the wings read small, and the trailing hind legs + tail look like three streaks in the hover.
* **lord_marshal**: victory static -> livelier. Everything else was already B.
* **lord_archmage**: attack2 was the empty-handed chop -> mirrored cast; victory livelier.
* **lord_warden**: death: the axe popped out of the two-handed grip on frame 1 -> both hands stay on the shaft for the first 0.6 s of the fall.
* **lord_skylady**: cast and hit snapped the lance out of the carry; thrusts had no legs; run sprint lean -> spear clipset fixes (carry kept, lunge, upright run, soft release in death).
* **golem**: attacks were a boxer's jab / cross: no weight for a 4.5 m stone giant -> overhead two-fist slam and a haymaker, both with a step and a crouch (1.6 s). victory livelier.
* **wyvern**: the mount's swoop under the rider's blow was nearly invisible -> 1.9x larger neck / pitch / lunge; honestly still subtle from the RTS camera (the rider's 0.9 m axe is the only weapon). Wing-root twist from below unchanged.
* **dragon**: strike too subtle -> the head rears back further, the body lunges 0.8-1.1 m forward and dips, wings flare on the wind-up. Wing-root twist from below unchanged.
* **ballista**: fire: the 12 cm recoil was invisible -> 30 cm kick with a pitch; reload: NOTHING moved for 2 s -> the bolt slides in from behind and the carriage rocks as the windlass is cranked; hit: invisible -> bigger jolt (still small at RTS distance); death: sank 25 cm -> keels over. Bow arms still do not flex.
* **trebuchet**: hit: invisible -> visible jolt (still small); death: only the arm moved, and it was not attached to the frame -> the arm is now a child of `frame`, the frame collapses to one side and settles; fire: the arm overshoots and settles, the frame rocks.

## Found by looking, not previously reported

* **Every second archer punched and every second mage chopped the air.** The renderer alternates `attack` / `attack2`
  per soldier, and `attack2` of the ranged units was the melee fallback clip.
* **Weapon pops.** Spear / lance / pike / great-axe carries were layered only on idle / walk / run / attack; `hit`,
  `cast` and the deaths used the bare library clips, so the weapon jumped up to 60 deg between two frames.
* **Squads skated.** The sim moves squads at 2.2-3.4 m/s; their walk clips cover 0.5-1.1 m/s and were played clamped at
  1.8x, i.e. half to a third of the ground actually covered. They now jog at a rate matched to their speed.
* **The trebuchet arm was not parented to its frame**, so the frame's death tilt left the arm hanging in the air.
* **Keep stage1-3 white caps** (not an animation): cut caps and rubble used an untextured material whose colour the
  renderer multiplies by 1.5 like the textured stone, which made it pure white. They now use the Keep's stone material
  on a patch of plain wall stone. Checked in the engine: `e2e/shots/anim-audit/keep-after.jpg` (`node e2e/anim-keep.mjs`).

## Pipeline changes (general: they apply to new units too)

* `anim_library.py`: new layers `weighted` (pose blend + hips shift = lunges), `fade` (release a carry over N frames),
  `upright`, a per-key grip distance in `two_handed`; about 45 new library clips (`pike_*`, `*_spear`, `*_staff`,
  `bow_a/b`, `cast_b`, `lunge_a/b`, `slam`, `hook`, `run_*_up`, `run_*_shield`, `jog_up`, `victory_b`, `death_*_axe`).
  Rebuild the library (`anim_lib.blend`) before building units.
* `retarget.py`: a procedural layer may move the hips (`rot['_hips_shift']`).
* `rig.py`: clipsets `pike` and `staff` are new; `spear` keeps the carry through hit / cast / death; `bow` and `cast`
  have a ranged `attack_melee_a`; the default run is the more upright one and the default victory is `victory_b`.
* `vat.py`, `manifest.mjs`: know the `pike` and `staff` clipsets (staff: `attack` = cast, `attack2` = strike).
* `creature.py`: larger dragon / wyvern strike, gallop tail. `siege.py`: ballista / trebuchet clips, arm parented.
* `keep.py`: `stone_caps`.
* Renderer (the only change): `src/render/crowd/archetypes.ts`, `walkSpeed` / `runSpeed` / `runAbove` of the eight
  foot squads set from `anim_audit.py` measurements.

## Still weak (honest)

* Mount legs are rubbery up close and the horse / pegasus tails are one slab: this needs more edge loops in the
  750-tri crowd horse and a re-split tail, i.e. a mesh change, not clips.
* Dragon / wyvern wing roots still twist the shoulder skin seen from below (the meshes hold the wings "displayed").
* Wyvern attacks are still subtle; the pegasus reads poorly from the side.
* The archer's bowstring does not flex (the bow is one rigid weapon node; it would need a string bone).
* Riders have no reins. Rider upper bodies still come from the foot-soldier clips.
* Ballista / trebuchet `hit` is a small jolt; ballista bow arms do not flex; the trebuchet counterweight is part of
  the static frame.
* Pikemen cover 4.3 m/s at rate 1 and move at 2.6: their run plays at the 0.7x clamp and still slides about 15 %.
* Victory is a livelier pump but still the same clip on every sword / bow / caster unit.
* Capes, cloaks, manes: no secondary motion.

## Strips

* Before: `e2e/shots/anim-audit/before/<unit>-side-a.jpg` (idle, move, run, hit, victory, reload),
  `<unit>-side-b.jpg` (attack, attack2, cast, death), `<unit>-rts.jpg` (all clips).
* After: `e2e/shots/anim-audit/after/` (same names). Keep: `e2e/shots/anim-audit/keep-after.jpg`.
* `e2e/shots/` is git-ignored, so the sheets are local. Regenerate with `node e2e/anim-audit.mjs after`.
* Caveats: in the `before` RTS sheets some tiles show the unit tiny or off-centre (the camera rig drifted between
  aiming and the screenshot); the grades rest on the side sheets. After-pass sheets I looked at directly: militia,
  pikeman, archer, knight, mage, cleric, cavalier, pegasus, skylady, warden, golem, wyvern, dragon, ballista,
  trebuchet. Berserker, skeleton, marshal and archmage share the clips graded on those and were not re-viewed.

## Faction foot squads: run sliding (in a real battle at 1x)

Measured in `?dev=battle` playbacks (Lich vs Sultana and mirrors, 4 battles, about 6000 samples): for every moving
soldier, the ground it covers against the ground its playing clip covers (`rate x walkSpeed / runSpeed`, the
renderer clamps the rate to 0.6-1.8 for the walk and 0.7-1.6 for the run). Mean / worst slide:

| unit | median speed | before | after |
|---|---|---|---|
| skeleton (Skeleton Spearmen) | 2.55 m/s | 1 % / 20 % | – |
| grave_knight | 1.98 m/s | **19 %** / 33 % | 6 % / 11 % (`runAbove` 1.6 -> 2.1) |
| bone_archer | 2.48 m/s | 1 % / 18 % | – |
| grave_acolyte | 2.41 m/s | 4 % / 28 % | – |
| lord_lich | 2.41 m/s | **22 %** / 49 % | 5 % / 14 % (`runAbove` 2.0 -> 2.7) |
| spear_levy | 2.55 m/s | 1 % (worst 83 % only while starting / stopping) | – |
| scimitar | not in the sampled battles; sim 3.4 m/s against a 3.6 m/s run, rate 0.94 | – | – |
| djinn_binder / sun_priest | 2.40 m/s | 1 % / 25 % | – |
| mamluk / camel_archer / wraith_rider (mounts) | 4.4-5.4 m/s | 1-9 % (spikes only at a standstill) | – |
| lord_sultana | 3.00 m/s | 1 % / 14 % | – |

* **Grave Knights** (sim 2.2 m/s, about 2.0 in formation) ran at the 0.7x clamp of a 3.4 m/s run, i.e. covered
  2.38 m/s. The walk (1.03 m/s at 1.8x = 1.85) and the clamped run are equally wrong at about 2.1 m/s, so
  `runAbove` is now 2.1: they march at a brisk walk, as the Kingdom's knights already do.
* **The Lich** (sim 2.6 m/s) has a long-striding 4.42 m/s run that could not slow below 3.1 m/s. Its walk at 1.8x
  (2.29) is the closer gait at its cruise speed, so `runAbove` is 2.7: it strides rather than runs, which suits it.
* Tool: a sampler over `view.units.slots` (`speed`, `anim.clip`, `anim.rate`, `arch`) in a `?dev=battle` page.
