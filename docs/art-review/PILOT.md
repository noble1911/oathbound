# Pilot: militia, knight, Keep (honest assessment)

Images in this folder were rendered by re-importing the **exported** files, so they show what ships.
Team colour is previewed as red through the tint mask.

| file | what it shows |
|---|---|
| `militia.jpg`, `knight.jpg` | LOD0 detail model. Row 1: rest at 30° and from behind, walk, attack_melee_a, attack_melee_b, attack_bow. Row 2: cast, hit, death_a, death_b, victory, run. Row 3: the LOD1 crowd mesh. |
| `militia_vat.jpg`, `knight_vat.jpg` | The crowd mesh driven only by the shipped VAT (`.vat.json` + `.vat.pos.bin`), decoded the way the shader will: idle, move, attack, attack2, hit, death, victory. |
| `keep.jpg` | Keep stage0, stage1, stage2 and stage3, then stage0 and stage2 from behind. |

## What works

* **Concepts (Codex image generation)** are clean, symmetric A-poses on grey, with a consistent style.
  The "vivid royal blue" team-cloth keying works: masks cover 9–17% of each humanoid (tabards, the shield face, Keep banners).
* **TRELLIS.2** takes about 50 s per character and about 4 min for the Keep. It gives coherent volumes and believable materials (steel versus cloth versus leather).
  Silhouettes read clearly at RTS distance. The front/back guess (the rear tabard) is plausible.
* **Cleanup** welds the mesh, removes floaters and voxel-remeshes it, so every mesh is watertight. It then decimates and re-bakes basecolour, normal and MR from the 140k-triangle source.
  Results: militia LOD0 5.3k + sword = 5.9k triangles; knight 4.7k + lance + shield = 5.9k; crowd LOD1 1,474 triangles including weapons.
* **Rigging** is automatic:
  * The skeleton is fitted from the mesh by slicing the arm and leg centre lines.
  * Bone-heat weights succeed directly on the watertight LOD0 (0% unweighted verts), so the voxel proxy was never needed.
  * All 11 clips retarget without foot sliding or flipped limbs.
  * Weapons are separate meshes, so the hands are clean and there is no "sword fused to thigh".
* **VAT:** the crowd mesh is one skinned primitive with one 512² atlas.
  The VAT is 0.79 MB (militia) and 0.72 MB (knight), and the decoded frames match the skinned frames.
* **Keep:** the stages are deterministic (seeded noise cut plus a rubble skirt) and read as progressive destruction.

## What is weak

* **Detail ceiling.** TRELLIS at res 512 (the only resolution this q8 weight set ships) softens the concept.
  Faces become masks, fingers become mittens, and fine trim and quilting blur into the texture.
  At the game camera (60–150 px tall) this is fine and much better than the v1 primitives. At cinematic close-ups it looks "good indie", not AAA.
* **Hand-authored clips.**
  * attack_bow, the spear thrusts and victory are procedural poses layered on idle. They are readable but stiff compared with the Quaternius mocap-style clips.
  * The spear grip in idle/walk points the lance forward and down.
  * The crowd archer has no bow-pull on the string; the bow is rigid.
* **Crowd atlas re-bake.** It drops normal and MR maps, so in the VAT preview the knight's steel looks chalky.
  The renderer should give the crowd material roughness of about 0.45 and metalness of about 0.6 (or I can bake an MR map at 256² for about 15 KB).
* **The tint mask on the crowd mesh** comes from per-vertex data, so it is softer than on LOD0. Edges bleed about one triangle.
* **Keep stage cut caps** are flat rubble-coloured lids, and stage3 looks like a cut box from some angles.
  The Keep is the largest file (3.15 MB, about 41k triangles across the 4 stages, 1024² textures).
* **Codex concepts lean painterly-realistic** rather than chunky Warcraft. The silhouettes are fine; the stylisation is mild.

## Sizes (shipped)

| unit | detail `<id>.glb` | crowd `<id>_lod1.glb` | VAT bin | total |
|---|---|---|---|---|
| militia | 0.70 MB | 0.33 MB | 0.79 MB | 1.85 MB |
| knight | 0.73 MB | 0.36 MB | 0.72 MB | 1.92 MB |
| keep | 3.15 MB (4 stages) | n/a | n/a | 3.15 MB |

What one squad unit needs at runtime is the crowd GLB, the VAT and the mask: about 1.1 MB.
The detail GLB is optional (heroes and close-ups).

## Blockers

None. Logins worked:
* Codex for concepts.
* opengameart.org for the CC0 Quaternius libraries.
* The FLUX fallback is installed but no longer used.

Mounted and flier units need a quadruped rig (the plan is a single combined armature: mount bones plus rider bones under a saddle bone, so there is one skin and one VAT). Large monsters (dragon) get procedural clips. Both are batch-phase work.

---

# Batch (full roster) – status and honest notes

All 20 models from the coordinator's list ship, plus 13 props and the Keep, in `public/models/v2/manifest.json` (`models` and `props`).
* `<id>.jpg` is the review sheet for each model.
* Squads also have `<id>_vat.jpg`, which is decoded from the shipped VAT, with the tint mask applied.

Fixes made after the pilot review:
* Sword attacks are now upright procedural swings (`swing_a` overhead chop, `swing_b` sweep) on the sword-idle stance.
* Polearms use one grip, carried forward about 30° up in idle/walk/run and thrust on attack. The lance's vamplate sits at the hand.
* Squad albedo is lifted. The militia was regenerated with mostly-blue clothing and a team-painted round shield.
* The crowd atlas now carries a 256² MR map.
* Metalness is thresholded, so stone and cloth are about 0 and the Keep is no longer near-black.
* LOD1: if decimating LOD0 gives a degenerate mesh (vertex count too low for the triangle count) it falls back to a coarse remesh. This fixed the berserker and lords' shredded LOD1s.
* GLBs are meshopt-packed with gltfpack (about 45% smaller). Crowd GLBs stay unpacked because they need `_VID`.

Per-asset notes:
* **Squads** (militia, pikeman, berserker, archer, knight, mage, cleric, skeleton): readable and clearly team-coloured. The skeleton's tabard drifted teal in TRELLIS, so the hue window was widened to 0.49–0.74. Hands are mittens, faces are soft. The archer's bowstring does not deform.
* **Cavalier / pegasus / wyvern** (animation pass, see below):
  * Rider and mount are one armature (mount `m_*` bones). The rider sits astride (procedural leg pose), hips ride the saddle with the gait's bounce, and the seat follows only part of the mount's pitch.
  * The mount skeleton is laid out per mesh in `tools/art/creatures.json` (the first version guessed joints from slices, put the leg bones in the wrong place and shipped a horse that only rocked).
  * Horse: 4-beat walk and a transverse gallop with a suspension phase, hooves planted by IK. Fliers: asymmetric wing beat with a folding, lagging outer wing; the pegasus gallops on the air.
* **Golem:** short-legged proportions needed crotch detection and rigid wrists. Its legs used to splay 40° in every clip (the leg fit picked up the hanging fists); fixed, and toes / corpse now stay on the ground.
* **Dragon:** the mesh is very good. It now faces forward (TRELLIS returned it 60° off axis), flies level with its wings laid flat and its curled tail straightened, rears the head back and drives it forward to breathe, and falls onto its flank.
* **Lords:** the best-looking assets (15k triangles, 1024² textures). Capes are skinned to the spine only, with no cloth sim.
* **Ballista:** rigid nodes: body recoil, and a bolt that flies and reloads. The bow arms do not flex.
* **Trebuchet:** the throwing arm and bucket are split from the frame by RANSAC beam detection and pivot at about 28% along the beam. There are small open seams where the arm met the frame.
* **Keep:** 4 stages, vertex cut plus capped rubble.
* **Props:**
  * The oak, birch, pine and fir trees, rocks, ruins (3 pieces), bridge (8×4 m) and arrow tower are good.
  * The bush and reeds are "leaf-sheet" meshes and look somewhat shredded at LOD0.
  * The maple needed a finer remesh because TRELLIS models its trunk as a thin bark shell.

## Animation pass (after play-testing)

Frame strips: `e2e/shots/anim-*.png` (in the engine) and `anim_strip.py` (Blender, from the shipped GLBs).

* **Golem "legs at 45°".** `rig.py` fitted the leg centre line from slices up to 0.42 H; above the golem's crotch the nearest off-centre segment is a hanging fist, so the hip joints landed 1.2 m outside the body and the rest thigh bones sloped 40°. The retarget copies the mannequin's bone orientations, so the mesh legs were swung 40° outward in every clip. The fit now stops at the crotch, follows one continuous segment and rejects slopes over 20°. The archmage had the same fault hidden under her robe (both hips on one side); she falls back to the mannequin's legs.
* **Ground contact.** Hips travel now scales with leg length instead of body height, and a post-pass un-pitches toes that go under the floor and lifts the hips by what the body still lacks. Before, the golem's 0.8-leg-length feet went 40 cm into the ground at toe-off and its corpse lay 75 cm under it.
* **Mounts.** The old creature rig put two short bones per leg at the wrong height and placed them from point clouds, so bone-heat gave the legs almost no weight: the horse rocked as one piece. The wyvern and dragon also faced 30° / 60° off axis. Mounted units also shipped a rider-only `idle` (the mount froze) with the real clip exported as `idle.001`.
* **Checks.** `creature.py` and `vat.py` now fail the build when a limb bone owns no vertices or when hooves / wing tips do not move against the body in the locomotion clips.

### Second pass (QA build + the Lords)

* **Berserkers** were white from behind and their crowd mesh was shards with no thighs: the fur mantle is now a
  team-tinted pelt, boot / bracer fur is brown, and LOD1 is a filled voxel hull.
* **Wyvern, dragon**: albedo lifted (mean 0.11 -> 0.26, 0.10 -> 0.20), wing membranes carry the team colour,
  and the wyvern finally has a tint mask (rider + mount share one atlas).
* **Warden**: his hip joint sat at the hem of his armoured skirt (0.5 m on a 2.1 m lord), so he waddled on
  22 cm thighs, and he swung a great axe one-handed. He now strides from a 0.92 m hip, carries the axe at port
  arms in both hands, chops overhead and cleaves across, and keeps both hands on it when hit. Mesh and textures
  are unchanged; only the rig fit, skin weights and clips.
* **Lords' speed**: no library clip fitted their 2.6-3.2 m/s (walk 1.1, jog 5.9), so they shuffled or skated.
  Marshal, Archmage and Warden now move on a shortened jog that covers 4.0 / 3.7 / 2.4 m/s at rate 1, and the
  renderer's Lord speeds are set from the measured clips.
* **Sword flip**: running swung the blade point-down behind the runner; the sword arm now stays in the ready
  stance. Spear thrusts are driven from the chest.

Still weak:
* Everything on the mounts is hand-authored, not captured. The gallop reads well at game distance; close up the legs are a little rubbery (the crowd horse is 750 triangles, with few edge loops at the joints) and the tail moves as one sheet.
* Horse and pegasus manes, barding and the rider's cloak are skinned to the nearest bones: no secondary cloth motion.
* The dragon's and wyvern's wings are rolled ~65° / ~30° at the root to lie flat in flight (the meshes hold them "displayed"), which twists the shoulder skin if you look closely from below.
* Rider upper bodies still come from the foot-soldier clips: no reins, and the staff-wielders' melee swing strikes with the butt of the staff.
* Skirted squads have short rigged legs (the hip joint sits at the hem), so their walk covers less ground than the renderer's `walkSpeed` assumes; see the audit numbers from `anim_audit.py`.
