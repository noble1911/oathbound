# Oathbound v2 art pipeline (AI models)

All v2 models are produced by scripts in `tools/art/`; nothing is hand-edited. Outputs land in
`public/models/v2/` with `manifest.json`. Large intermediates live in `art-work/` (git-ignored).
The v1 procedural pipeline (`tools/blender/`, `docs/MODELS.md`) is untouched and still serves `public/models/`.
Review renders and the pilot write-up are in `docs/art-review/`.

## 1. Commands

```
node tools/art/run.mjs militia,knight,keep_kingdom              # every stage for these ids (+ held weapons, rider/mount parts)
node tools/art/run.mjs knight --from cleanup --to vat   # re-run part of the chain
node tools/art/concept.mjs militia --n 4 --force        # more concept candidates only
node tools/art/manifest.mjs                             # rebuild public/models/v2/manifest.json
blender -b --factory-startup --python tools/art/blender/anim_library.py   # rebuild the shared clip library (once)
blender -b --factory-startup --python tools/art/blender/anim_strip.py -- out.png public/models/v2/cavalier.glb run:12:90 walk:8:90   # frame strips of clips
blender -b --factory-startup --python tools/art/blender/anim_audit.py -- golem militia   # ground contact / stride speed per clip
node e2e/anim-strips.mjs golem,cavaliers,pegasus,wyvern,dragon            # the same strips in the engine -> e2e/shots/anim-*.png
node e2e/anim-clips.mjs lord_warden,lord_marshal                          # every clip of a hero, side + RTS view -> e2e/shots/anim-<id>-clips-*.png
node e2e/unit-sweep.mjs after                                             # all units of both teams at RTS distance -> e2e/shots/sweep-after-*.png
blender -b --factory-startup --python tools/art/blender/cleanup.py -- berserker --regrade   # re-apply `grade` without re-baking
```

`run.mjs` packs and writes the manifest entries of **only the ids it rebuilt** (`pack.mjs --only`, `manifest.mjs --only`);
`node tools/art/manifest.mjs` on its own still rebuilds the whole file.

| stage | script | runs on | in -> out |
|---|---|---|---|
| concept | `concept.mjs` -> `matte.py` | Codex CLI `codex exec` (ChatGPT image generation, prompt on stdin) + WSL venv (BiRefNet matte) | `prompts/<id>.txt` + `prompts/_style_{character,object}.txt` -> `art-work/concepts/<id>/cand_<k>.png`, `_cut.png` (RGBA), `sheet.jpg`, `pick.json` |
| mesh | `mesh.mjs` | trellis-cpp 0.8.1 (Vulkan) + TRELLIS.2 q8 GGUF 1024 flows, `--res 1024 --atlas 4096 --steps 16 --seed 42`, one run per part (weapons / props 512); GPU lock + queue (section 10) | picked cut-out -> `art-work/mesh/<id>.glb` (~280k tris, 4096 atlas; v2 runs are kept in `art-work/mesh/v1/`) |
| cleanup | `blender/cleanup.py` | Blender 5.2 + Cycles (GPU when `art-work/fx_gpu.lock` is free, else CPU) | weld, drop floaters (<0.2 % faces), yaw-align, ground, scale, voxel remesh (hero tier ~1 cm, squads size/300), quadric decimate LOD0/LOD1, **box-projection unwrap** (LOD1: Smart-UV), bake basecolour + tangent normal + MR from the TRELLIS mesh(es), unsharp, team mask -> `art-work/blend/<id>_clean.blend`; props: final GLBs. Hero tier: the body + `parts` (TRELLIS pieces and authored trappings) into one 2048 atlas (section 10) |
| build | `blender/rig.py` humanoids + golem; `blender/creature.py` dragon + mounted/flier units (joint layout per mount in `creatures.json`); `blender/keep.py`; `blender/siege.py` | Blender | GLBs in `public/models/v2/` (`--stage`: `art-work/stage_v2/`, shipped by `ship.mjs`) |
| vat | `blender/vat.py` | Blender | squads: crowd mesh `<id>_lod1.glb` + `<id>.vat.json` / `.vat.pos.bin` + `<id>_lod1_tint.png` |
| review | `blender/render_review.py`, `blender/vat_check.py` | Blender EEVEE | re-imports the shipped files -> `docs/art-review/<id>.png`, `<id>_vat.png` (committed as JPEG to keep the repo small) |
| pack | `pack.mjs` | node + `npx gltfpack@0.22.0` | meshopt-compresses every GLB except squad crowd meshes (originals in `art-work/unpacked/`) |
| manifest | `manifest.mjs` | node | `art-work/clean/<id>.json` facts + sizes -> `manifest.json` (`models` + `props`) |

Reproducibility: prompts in `tools/art/prompts/`, roster + budgets in `tools/art/assets.json`, concept picks in
`tools/art/picks.json` (overrides the automatic pick), TRELLIS seed 42, every procedural step seeded. Codex image
generation has no seed, so the chosen concept PNG is the reproducible input (keep `art-work/concepts/` if you
need bit-exact rebuilds). `concept.py` is the older offline concept path (FLUX.1-schnell Q6_K GGUF via diffusers
in WSL), kept as a fallback.

Environment: Codex CLI 0.169 (logged in; <= 2-3 parallel calls); WSL Ubuntu `~/oathbound-art/.venv` (uv, Python
3.12, torch 2.11 cu128, diffusers 0.43, transformers, timm, kornia, scipy); `TRELLIS_CLI` / `TRELLIS_MODELS`
override the defaults in `mesh.mjs` (the q8 set only ships the 512 flows); `BLENDER` env or newest
`C:/Program Files/Blender Foundation/Blender*`. GPU jobs must not overlap (two models on 16 GB thrash).

## 2. Conventions (the client relies on these)

* **Units** metres, `scale` 1. Infantry 1.8 m (knight 1.9, lords 1.95-2.1, golem 4.5, mounted 2.6, Keep 16).
* **Axes** glTF +Y up, model faces **+Z** (Blender -Y), character's left hand at +X. Origin = ground centre of
  the footprint (feet at y = 0).
* **Materials** PBR metal/rough: basecolour (WebP), tangent normal (WebP, detail GLBs only), metallicRoughness
  (G = roughness, B = metal, WebP). Texture budget: 1024² heroes / large / Keep, 512² squads (detail and crowd
  atlases), 256² weapons.
* **Skeleton `oathbound_humanoid_v1`** (all humanoids, golem, riders): `root` (non-deform), `hips`, `spine1-3`,
  `neck`, `head`, `shoulder/upper_arm/forearm/hand.(L|R)`, `thigh/shin/foot/toe.(L|R)`. Rest pose = the mesh's own
  A-pose; each bone frame is the Quaternius frame rotated rigidly onto the fitted bone, so all clips play on every
  character. Mount bones are prefixed `m_`: `m_root`, `m_body` (pelvis -> mid back), `m_chest` (mid back ->
  withers), `m_neck`, `m_neck2`, `m_head`, `m_tail1..n`, `m_leg_{fl,fr,bl,br}_{1..k}` (front: scapula, humerus,
  forearm, cannon, pastern; hind: femur, tibia, cannon, pastern), `m_wing_{l,r}_{1..k}`; a rider's `root` is
  parented to `m_body`. The renderer never addresses mount bones by name.
* **Weapons** are separate rigid nodes parented to a bone (`weapon_sword_R` on `hand.R`, shields on `forearm.L`)
  in detail GLBs; in crowd meshes they are merged and skinned 100 % to that bone.
* **Clips** (every humanoid / mounted unit): `idle, walk, run, attack_melee_a, attack_melee_b, attack_bow, cast,
  hit, death_a, death_b, victory` (loops: idle, walk, run, victory). The manifest `clips` map gives the canonical
  renderer names: `idle, move, run, attack, attack2, cast, hit, death, death2, victory`. Clip sources per
  `clipset`: sword = upright procedural swings, sword arm held in the ready stance while running; spear =
  carry-forward idle/walk/run + thrusts driven from the chest; bow = draw-and-loose; cast = Quaternius spell;
  fist = jab/cross; greataxe (Warden) = two-handed port-arms carry, overhead chop, horizontal cleave, both arms
  solved by IK onto the shaft, walk / jog retimed 1.25x / 1.14x slower. `assets.json` `clips` overrides single
  slots (the Marshal and Archmage run on `jog` / `jog_sword`: the library jog with its leg swing cut to 58 %).
* **Clipsets after the animation audit** (`docs/art-review/ANIM-AUDIT.md`): `pike` = two-handed pike (pikemen); `staff` =
  staff gripped in the fist and carried upright, raised to cast, thrust head-first (clerics; `attack` = cast, `attack2` =
  strike); `spear` keeps its carry through hit / cast and releases it over the first 0.5 s of the deaths, thrusts lunge;
  `bow` / `cast` have a ranged `attack_melee_a` too (the renderer alternates `attack` / `attack2` per soldier, so both must
  be a shot / a cast); golem attacks are `slam` / `hook`; shield carriers run with the shield in guard. Every in-engine
  clip sheet: `node e2e/anim-audit.mjs <tag> [units]`; Keep stages: `node e2e/anim-keep.mjs`.
* **Clip ground speeds.** The mannequin's walk covers 1.06 m/s and its jog 5.9 m/s (x leg length / 0.92 m on a
  fitted rig); `anim_audit.py` prints what each unit's clips cover. `src/render/crowd/archetypes.ts`
  `walkSpeed` / `runSpeed` must be those numbers or planted feet slide (the Lords' and golem's are set from it).
* **Loops** end on a key equal to their first frame (clip duration = one cycle), in the GLBs and the VAT source.
* **Mount gaits** (`creature.py`, hand-authored): the horse walks a 4-beat lateral sequence (LH, LF, RH, RF,
  duty 0.6, 0.67 s) and gallops transverse (LH, RH, LF, RF, duty 0.27, 0.5 s) with a suspension phase; the
  stance sweep is `speed x stance time` for the renderer's `walkSpeed` 2.2 / `runSpeed` 7 m/s (keep them in
  step with `GAITS` or hooves slide). Fliers have no ground clips: `idle` hovers, `walk` / `run` cruise, every
  clip keeps the wings beating (downstroke 58 % of the cycle, outer wing folds and lags on the upstroke), the
  pegasus gallops on the air. The renderer supplies the flight height; death clips end lying on a flank at y = 0.
* **Wing roots** (`creature.py: clean_wing_root`, `add_wing_twist`): the meshes hold their wings "displayed", so every
  flight pose rolls `m_wing_*_1` 30-66 deg about its span (`wing_pron`). Bone heat had also bled the wing bones over
  the neck, head and back (the back midline followed both wings), and linear blend skinning across a ~120 deg seam
  wrapped the shoulder skin. Each wing's share of a vertex is now capped by a smoothstep across the shoulder along
  `m_wing_*_1` (none below -0.25, full from +0.8 wing_1 lengths; weight only ever leaves a wing), and 3 helper bones
  `m_wing_<k>_t1..3` (rest frame of wing_1, parent `m_chest`, keyed at 1/4 .. 3/4 of wing_1's rotation) carry the
  chest -> wing_1 ramp. `creatures.json` `wing_root_band` [lo, hi] / `wing_twist` (segments; 1 = off) override per mount.
  Rebuilt and shipped: dragon, wyvern, bone drake, Drake Rider, Roc Rider. Shoulder triangles squashed below half
  their rest area over the clips: dragon 2.2 -> 0.8 %, wyvern 0.6 -> 0.4 %, Drake Rider 2.7 -> 2.3 %, Roc Rider
  1.1 -> 0.9 %, bone drake 0.3 -> 0.4 % (noise; its root never collapsed much). The pegasus opts out (`wing_pron` 0, no
  roll to spread, no measurable gain) and keeps its shipped crowd VAT. Before / after renders:
  `docs/reviews/shots-2026-11-17/art/wingroot-*`.
* **Mount rig frame**: `creatures.json` gives a yaw / x shift per mount mesh (TRELLIS returned the wyvern 30 deg
  and the dragon 60 deg off axis) so every creature faces +Z, then its joints in metres. Author it with
  `creature_view.py` + `creature_grid.py` (orthographic views with a metric grid and the joints drawn in).
* **Hip height.** `rig.py` puts the hip joint 5 % of the height above the detected crotch. Under a long skirt it
  detects the hem; `assets.json` `hip` (fraction of the height) overrides it (Warden 0.45: he had 22 cm thighs).
* **Ground contact** (`rig.py: ground_fix`): after retargeting, toes that dip under the floor are un-pitched at
  the ankle and the hips are lifted by what the lowest body vertex still lacks (golem feet, bodies lying down).
* **Build checks** (the build fails, exit code 1): `creature.py` -- every leg / wing / tail / neck bone must own
  vertices on both LODs, hooves must travel >= 0.35 m (walk) / 0.45 m (run) against the body, wing tips >= 30 %
  of the span in every flier loop; `vat.py` repeats the hoof / wing-tip test on the baked VAT texels. A mount
  can no longer ship as a rigid block.
* **Siege** (rigid nodes, NLA clips `idle, fire, reload, hit, death`; manifest `fireTime` = projectile release):
  ballista `body`, `bolt`; trebuchet `frame`, `arm` (pivot at axle), `rope`, `stone`.
* **Keep** `keep_<faction>.glb` (+ `_lod1.glb`), one per faction (`kingdom`, `ashen`, `caliphate`): root with
  children `stage0` (intact) .. `stage3` (ruin); show exactly one. Built from geometry, not TRELLIS: section 9.
* **Props** (manifest `props`): static, one mesh, LOD0 + LOD1 (`<id>_lod1.glb`), 512² atlas (LOD1 256²),
  origin at the base centre (rocks, ruins; vegetation and bridges are procedural, section 7). (The former art `bridge` spanned three.js **Z**, 8 m long x 4 m wide,
  non-uniform fit.) Arrow towers are no longer props: `arrow_tower_<faction>` structures, section 9.
* **Metalness**: TRELLIS paints stone and cloth with mid metalness; cleanup keeps metal only where the bake is
  clearly metal (`smoothstep(0.5, 0.8, m)`), so stone/wood/cloth are ~0.
* **Squad albedo** is lifted (`rgb^0.8 * 1.1`, crowd atlas another `^0.85 * 1.08`) so units read at RTS distance.

## 3. Team tint contract

Concept prompts dress every unit in **"vivid royal blue" cloth** (tabards, sashes, banners, shield faces).
`cleanup.py` classifies that hue in the baked basecolour (HSV hue 0.49-0.74, sat > 0.32, value > 0.10, 3x3 open,
soft edge), **neutralises it to light grey** in the albedo, and records the mask. The renderer applies

```
albedo.rgb *= mix(vec3(1.0), teamColor, mask);     // blue team and red team both read cleanly
```

`mask` sources (pick one): `tintMask` texture (R channel, sampled at UV0, `flipY = false`) - crowd meshes use
`<id>_lod1_tint.png` (256², baked from the LOD0 mask), detail GLBs `<id>_team.png`; or the per-vertex float
attribute `_TEAM` (three.js `geometry.attributes._team`) - only on the crowd meshes (gltfpack strips custom
attributes from the packed files, so use `tintMask` everywhere). Untinted, team cloth shows as neutral off-white.

**Loading:** packed GLBs use `EXT_meshopt_compression` + `KHR_mesh_quantization` + `EXT_texture_webp`:
`gltfLoader.setMeshoptDecoder(MeshoptDecoder)` (`three/examples/jsm/libs/meshopt_decoder.module.js`). Packing
wraps each mesh in its named node (`weapon_sword_R`, `stage2`, ...): address nodes by name, not mesh name.

### Team colour that reads from the RTS camera

* `assets.json` `grade` (applied by `cleanup.py` after the bake, re-runnable with `--regrade`): `lift` /
  `sat` brighten dark TRELLIS bakes (wyvern, dragon); `fur` recolours white fur and turns the mantle above
  `zmin` into a team-tinted pelt (berserker, who showed only white from behind); `mask_open` removes team-mask
  speckle (blue-white shadows on white coats).
* `creatures.json` `team_wings`: wing membranes (texels skinned to the wing bones) are neutralised and added to
  the team mask -- the dragon's and wyvern's team colour from above.
* Mounted units: `creature.py` packs the rider and mount atlases side by side into one material and writes one
  mask, `art-work/clean/<id>_unit_team.png` (shipped as `<id>_team.png`). Before, the wyvern had no `tintMask`.
* `lod1_voxel_div`: crowd LOD1 from a filled voxel hull (`cleanup.py: solid_mesh`) for furry meshes whose
  decimated LOD1 fell apart into shards.

## 4. Crowd VAT contract (squads)

Squad units (militia, pikeman, berserker, archer, knight, mage, cleric, skeleton, cavalier, pegasus) ship:

* `<id>_lod1.glb` - ONE skinned primitive (LOD1 body + weapons; mounted units: rider + mount), <= 1.5k tris,
  one 512² basecolour + 256² MR atlas, all clips (usable with an AnimationMixer too). Point attribute `_VID`
  (three.js `_vid`, float) = the vertex's VAT column; UV-seam duplicates share the same `_vid`.
* `<id>.vat.json` - `VatMeta` of `src/render/crowd/vat.ts` (`version: 1`, `format: 'f16'`) plus:
  `nrm: null`, `normalEncoding: 'octPosW45'`, `vertexIndexAttribute: '_vid'`, `mesh`, `tintMask`.
* `<id>.vat.pos.bin` - RGBA float16 little-endian, `width = min(vertexCount, 4096)`,
  height = `rowsPerFrame * totalFrames`. Texel of vertex `v` at frame `f`: `(v % width, f * rowsPerFrame + v / width)`.
  * `.xyz` = object-space position (three.js space, metres) - already includes the weapons.
  * `.w` = normal, octahedral, quantised to a 45x45 grid: `w = ox * 45 + oy` with integers 0..44 (exact in f16).
    Decode: `ox = floor(w / 45.); oy = w - ox * 45.; e = vec2(ox, oy) / 44. * 2. - 1.;`
    `n = vec3(e, 1. - abs(e.x) - abs(e.y)); t = max(-n.z, 0.); n.xy += mix(vec2(t), vec2(-t), step(0., n.xy)); n = normalize(n);`
    Decode both frames, then lerp and renormalise.
* **Clips** (`clips[]`, contiguous frame ranges, per-clip `fps` -- read it, do not assume 12): `idle` (10 fps,
  loop), `move` (12, loop; raised so a short cycle still gets >= 10 samples: mounted walk 15, gallop 20),
  `run` (12, loop; same rule), `attack` (12), `attack2` (12), `cast` (12, casters only), `hit` (12), `death` (10),
  `victory` (8, loop). Loops have `round(duration * fps)` frames (no duplicate end frame), one-shots +1.
  `death2`: mirror the instance's X scale and play `death`.
* Reference decoder: `tools/art/blender/vat_check.py` (renders `docs/art-review/<id>_vat.png` from the shipped files).

## 5. Animation and asset licences

| asset | source | licence |
|---|---|---|
| Base clips (idle, walk, jog, sword attack, punches, spell, hits, death, sit) + reference rig | Quaternius *Universal Animation Library* [Standard], opengameart.org/content/universal-animation-library | CC0 1.0 |
| Extra clips (sword combos, knockback) | Quaternius *Universal Animation Library 2* [Standard], opengameart.org/content/universal-animation-library-2 | CC0 1.0 |
| Procedural clips (bow, swings, spear carry/thrusts, victory, all creature and siege motion: horse walk / gallop, wing beats, rider seat) | authored in `tools/art/blender/*.py`; gait timing from standard equine footfall references (no third-party animation data) | ours (project licence) |
| Concept images | Codex CLI / OpenAI image generation (outputs owned by the user per OpenAI terms) | n/a |
| Image -> 3D | TRELLIS.2 (Microsoft, MIT) via trellis-cpp q8 GGUF weights | MIT |
| Matte | BiRefNet (ZhengPeng7/BiRefNet) | MIT |
| Fallback concept model | FLUX.1-schnell (Black Forest Labs; mirror `unsloth/FLUX.1-schnell`, GGUF `city96/FLUX.1-schnell-gguf`) | Apache-2.0 |
| Tools | Blender 5.2 (GPL, tool only), diffusers / transformers / torch | Apache-2.0 / BSD |

## 6. VFX textures

Runtime files (committed, loaded by `src/render/vfx/atlas.ts`):

| file | size | contents |
|---|---|---|
| `src/render/vfx/assets/atlas.webp` | 2048², 170 KB | 8×8 cells of 256 px, RGB on black (shader coverage = luminance): explosion flipbook (cells 0-23, 20 used), smoke / dust flipbook (24-43), fire loop (44-59), dot / spark / ring / star (60-63) |
| `src/render/vfx/assets/decals.webp` | 1024×1536, 151 KB | 2×3 cells of 512 px, greyscale masks: scorch, ground cracks, heal sigil, rally sigil, arcane circle, frost burst |

Build: `python tools/vfx/build_atlas.py` (Pillow + numpy) packs the sources in `art-work/vfx/` (git-ignored):
it lowers the black floor, re-centres every flipbook frame, feathers the cell borders and draws the four
procedural sprites. Squad plates sample role glyphs from `public/ui/plates.webp` (index `plates.json`, built by
`tools/art/glyph-atlas.py`; see docs/UI-STYLE.md); damage-number
glyphs are drawn on a canvas at startup (Cinzel, falling back to Georgia).

| asset | source | licence |
|---|---|---|
| `explosion.png`, `smoke.png`, `fire.png` (flipbook sheets), `decals.png` (decal sheet) | Codex CLI / OpenAI image generation, prompts below (outputs owned by the user per OpenAI terms) | n/a |
| dot, spark, ring, star sprites | generated in `tools/vfx/build_atlas.py` | ours (project licence) |

Prompts (each prefixed "A game VFX flipbook sprite sheet ..., portrait 1024x1536, strict uniform grid, pure
black background, no grid lines, no text"):
* explosion - 4×6 grid, a single fiery explosion from white-hot ignition through roiling orange fire to sooty smoke wisps.
* smoke - 4×6 grid, greyscale billowing dust / smoke puff lit from the top, growing then thinning out.
* fire - 4×4 grid of 256×384 cells, a looping campfire-like flame, base near the bottom of the cell.
* decals - 2×3 grid of 512 px top-down white-on-black decals: blast scorch, impact cracks, healing sigil,
  heraldic rally circle (crowned sword, laurel), arcane rune circle, frost burst.

## 7. Environment: ground, vegetation (CC0 scans + procedural geometry)

TRELLIS cannot do foliage, so trees, bushes and reeds are **not** art-pipeline props any more (their GLBs,
prompts and `assets.json` entries are gone). `python tools/art/env.py` (Pillow + numpy) downloads CC0 Poly Haven
scans into `art-work/env/src/` and packs `public/textures/env/` (about 3.4 MB in the repo; a client downloads
2.2 MB on high / ultra, 1.6 MB on low / medium):

| file | content | used by |
|---|---|---|
| `ground_<layer>_a.webp` (1024²), `_a_512.webp` | RGB albedo (graded), A = 128 + height x 127 | ground splat, layers `grass, forest, dirt, mud, rock` (low / medium load the 512² set) |
| `ground_<layer>_n.webp` (512²) | L = normal Y (GL), A = 128 + normal X / 2 | ground normal maps (medium and up) |
| `veg_atlas.webp` (1024², RGBA) | leaf clusters composed from scanned leaves (oak, birch, bush), a fir bough, a procedural reed clump, 3 bark columns | every tree / bush / reed (cells: `VEG_CELLS` in `src/render/terrain/env-textures.ts`) |

Alpha is kept >= 128 in the ground files because the loader reads pixels through a 2D canvas (premultiplied):
colour keeps 7+ bits. The atlas is saved with `exact` RGB under transparent texels (bled leaf colour: no halos).

* **Ground** (`terrain/ground.ts`): two texture arrays (albedo + height, normal), splat map picks the layers,
  height-blended transitions, second texture scale + macro noise map against tiling, per-layer roughness (wet
  mud), triplanar rock on slopes. Only layers present at a pixel are sampled; low drops the normal maps, low and
  medium the second scale and the triplanar path.
* **Trees** (`terrain/trees.ts`, generated at startup, no download): tapered bark tubes (trunk, primary and
  secondary branches) + alpha-tested leaf-cluster cards. LOD0 ~300-400 tris, LOD1 ~110, far outskirts are
  camera-facing impostor quads (4-12 tris). Species: oak, broad oak, pine, fir, birch; plus bush and reeds.
  Shading (`terrain/foliage.ts`): normals bent away from the crown centre and never flipped, baked crown
  occlusion in vertex colours, leaf translucency / backlight, alpha coverage kept at distance, wind sway + leaf
  flutter in the vertex shader (shared `uTime`: it only advances while frames are drawn).
* **Planning**: trees standing in a visible deploy zone shrink to saplings in the vertex shader (and in the
  shadow depth material); there is no canopy dither any more.

Licences (all **CC0 1.0**, polyhaven.com): textures `sparse_grass`, `forest_leaves_03`, `rocky_trail`,
`brown_mud_03`, `mossy_rock`, `bark_brown_02`, `pine_bark`, `tree_bark_03`; leaf / twig scans from the models
`island_tree_02`, `shrub_01`, `shrub_03`, `fir_tree_01`. Tree geometry and the reed clump are ours.

* **Bridges** are procedural too (`terrain/bridge.ts`): a humped two-arch stone bridge with a mid-stream pier and
  pointed cutwaters, raised voussoir rings, string course, parapets with coping and capped end posts, a cobbled
  deck, fitted to each crossing. Masonry: `stone_wall_{a,n}.webp` / `stone_deck_{a,n}.webp` (512², albedo x AO +
  GL normal map; CC0 Poly Haven `medieval_blocks_05`, `cobblestone_floor_08`), weathered with vertex colours
  (damp and moss towards the water). The TRELLIS `bridge` GLB is gone. Only the largest rocks use the
  art `rocks` mesh (its LOD1 is shredded, so LOD0 at ~2.5k triangles is capped by a triangle budget); pebbles
  stay procedural.
* **Keep footprint contract**: the sim's siege constants (`KEEP_FRONT`, `KEEP_HALF_W`, `TOWER_FRONT` in
  `src/sim/battle.ts`) are measured from the art Keep as the renderer places it (front wall 3.4 m in front of
  the sim keep point, 18.2 m wide). Every faction Keep is built to that footprint (x +-9.1 m, z +-9.4 m) and the
  renderer uses one fixed body box for all of them (`ART_BOX` in `terrain/keep.ts`: the camera floor, the view
  fades and the hit points never depend on a model's spires). Re-measure the constants if that box or the
  placement in `terrain/keep.ts` changes.

## 8. Factions: the Ashen Covenant and the Sun Caliphate

Approved concept art: `docs/art-review/factions/{ashen,sun}_{1_lineup,2_battlefield}.png`. Review sheets:
`docs/art-review/<id>.jpg` (+ `<id>_vat.jpg` for squads). In-engine line-ups: `node e2e/faction-shots.mjs` ->
`e2e/shots/faction-{ashen,caliphate}-*.png`. Portraits: `node tools/art/ui-woodcut.mjs portrait` (woodcut style, docs/UI-STYLE.md)
-> `public/ui/unit_<id>.webp` (320) / `lord_<id>.webp` (512).

| id | kind | path | clipset / builder | notes |
|---|---|---|---|---|
| `skeleton` | squad | rig.py + VAT | spear (one-handed, shield) | restyled: bronze helm, mail, spear + teardrop shield |
| `grave_knight` | squad | rig.py + VAT | sword | bronze plate, plume + cape + shield face = team |
| `bone_archer` | squad | rig.py + VAT | bow | hooded, mantle + sash = team |
| `wraith_rider` | mounted squad | creature.py + VAT | spear; mount `skeletal_horse` | the renderer draws it as a spectre (screen-door): a pale soul-green body whose edge light burns in the team colour and whose team cloth glows (`vat.ts`, `vChill < 0`) |
| `grave_acolyte` | squad | rig.py + VAT | staff | hood + stole + sash = team (`grade.fur`) |
| `bone_drake` | flier, hero | faction.py -> creature.py | `dragon_like`, `flap` | wing membranes carry a light team tint (0.3) |
| `corpse_catapult` | siege | siege.py (trebuchet builder) | `flip` | bone throwing arm, skull-cage counterweight |
| `bone_golem` | large, hero | rig.py | fist (slam / hook) | `hip` 0.35 |
| `lord_lich` | Lord | rig.py | staff; staff R + lantern L | 2.25 m with the crown, albedo lifted |
| `spear_levy` | squad | rig.py + VAT | spear (shield) | sash + scarf = team |
| `scimitar` | squad | rig.py + VAT | sword | cloak + sash = team |
| `camel_archer` | mounted squad | faction.py -> creature.py + VAT | bow; mount `camel` | pace walk, gallop |
| `mamluk` | mounted squad | creature.py + VAT | spear; mount `mamluk_horse` | stock horse gaits |
| `djinn_binder` | squad | rig.py + VAT | staff | mantle = team |
| `sun_priest` | squad | rig.py + VAT | staff | veil + stole = team (`grade.fur`) |
| `djinn` | flier, hero (squad of 2) | faction.py -> rig.py | cast; `float` | legs = smoke tail, no stepping |
| `war_elephant` | large, hero | faction.py -> creature.py | `amble`, trunk chain | howdah + crew are part of the mesh (static) |
| `sand_golem` | large, hero | rig.py | fist (slam / hook) | |
| `lord_sultana` | Lord | rig.py | sword; scimitar R + banner on the back | sun banner is fixed turquoise, cloak = team |

### What is new in the pipeline (all optional keys; nothing changes for assets without them)

`assets.json`:
* `team_hue` [lo, hi] / `team_sat`: the team-cloth key per asset. **Both factions are keyed on "vivid magenta"**, so the
  Caliphate's turquoise and the Covenant's green fire can never land in the royal-blue window. TRELLIS turns magenta
  into a saturated red, so the window is `[0.93, 1.055]` (it wraps through red) with saturation > 0.42, measured in
  the stored (sRGB) texel values: leather and bronze sit at hue 0.06+ and saturation < 0.4, skin below 0.42.
* `hue_map` [[lo, hi, to]]: TRELLIS also shifts green to cyan and turquoise to blue. The Covenant maps 0.44-0.66 back
  to green (0.37), the Caliphate 0.54-0.72 back to turquoise (0.485); the Sultana's banner maps its red to turquoise.
* `metal_max`: scales the baked metalness. Heroes keep their MR map in the engine and there is no environment map,
  so fully metallic gold rendered black (the elephant's head plate, the banner). Faction heroes use 0.3.
* `hold` (weapons): `shield`, `lantern` (hangs from the fist along the arm), `back` (strapped to `spine3`, upright in
  every clip), default `fist`. `builder`: a per-asset build script (`faction.py`). `creature: true`: a standalone
  creature.py build. `flip` (siege): the front / back rule guessed wrong. `float`: see below.
* `hip` is needed on every unit with a tabard, loincloth or mail skirt between the legs (skeleton, spear levy, grave
  knight, bone archer were fitted with hips at 0.5-0.6 m and waddled); check `anim_audit.py`'s `hips` line.

`creatures.json` (read by `blender/faction.py`, which wraps creature.py without changing it): `gaits` (per-mount
overrides of the walk / run footfall tables, `T` also sets the clip length), `amble` (run = a faster walk, no gallop
rocking), `pace_roll`, `body_scale`, `flap`, `dragon_like`, `chains` (extra FK chains, e.g. the trunk).

| mount | walk | run | renderer walkSpeed / runSpeed |
|---|---|---|---|
| `skeletal_horse`, `mamluk_horse` | 4-beat lateral walk, 0.67 s | transverse gallop, 0.5 s | 2.2 / 7 |
| `camel` | pace (lateral pairs: LH 0, LF 0.08, RH 0.5, RF 0.58), duty 0.62, 0.92 s, body roll | gallop, 0.54 s | 1.8 / 5.5 |
| `war_elephant` | lateral-sequence walk, duty 0.72, 1.67 s | fast amble, duty 0.58, 1.08 s, never airborne | 1.3 / 2.6 |

Floaters (`float`, the Bound Djinn): rig.py with `retarget.bake` / `solve_and_key` wrapped: the leg chain follows the
pelvis rigidly with a travelling wave (the smoke tail), walk / run are the idle upper body tipped 11 / 22 degrees
into the flight direction with the tail trailing, the body bobs. The renderer's `flyHeight` lifts it.

Contained jogs with the carries were added to the clip library (`jog_staff`, `jog_spear_shield`,
`jog_sword_shield`): the faction squads move at 2.2-3.4 m/s and the full run covers 5-5.9 m/s.

### Sizes (shipped files per model, MB)

(v2 figures, before the remodel; the current sizes of every model are in section 10.z.)

| faction | id | tris LOD0 / LOD1 | all files | loaded at runtime |
|---|---|---|---|---|
| Ashen Covenant | `skeleton` | 5506 / 1410 | 1.56 | 1.10 |
| Ashen Covenant | `grave_knight` | 5908 / 1474 | 1.66 | 1.14 |
| Ashen Covenant | `bone_archer` | 5908 / 1474 | 1.60 | 1.17 |
| Ashen Covenant | `wraith_rider` | 7970 / 1391 | 2.97 | 1.25 |
| Ashen Covenant | `grave_acolyte` | 5908 / 1474 | 1.58 | 1.06 |
| Ashen Covenant | `bone_drake` | 14774 / 2954 | 1.55 | 1.12 |
| Ashen Covenant | `corpse_catapult` | 14806 / 2984 | 1.26 | 0.98 |
| Ashen Covenant | `bone_golem` | 14774 / 2954 | 1.84 | 1.42 |
| Ashen Covenant | `lord_lich` | 14772 / 2952 | 1.47 | 1.05 |
| **Ashen Covenant total** | 9 models | | **15.5** | **10.3** |
| Sun Caliphate | `spear_levy` | 5506 / 1412 | 1.56 | 1.13 |
| Sun Caliphate | `scimitar` | 5908 / 1474 | 1.61 | 1.12 |
| Sun Caliphate | `camel_archer` | 8370 / 1466 | 2.90 | 1.32 |
| Sun Caliphate | `mamluk` | 8370 / 1396 | 3.06 | 1.37 |
| Sun Caliphate | `djinn_binder` | 5908 / 1474 | 1.67 | 1.17 |
| Sun Caliphate | `sun_priest` | 5908 / 1474 | 1.70 | 1.20 |
| Sun Caliphate | `djinn` | 14774 / 2954 | 2.68 | 1.99 |
| Sun Caliphate | `war_elephant` | 14774 / 2954 | 1.43 | 1.04 |
| Sun Caliphate | `sand_golem` | 14774 / 2954 | 1.47 | 1.07 |
| Sun Caliphate | `lord_sultana` | 14772 / 2950 | 1.43 | 1.01 |
| **Sun Caliphate total** | 10 models | | **19.5** | **12.4** |

Portraits: Ashen 558 KB, Caliphate 625 KB. Runtime = crowd GLB + VAT + tint mask for squads, detail GLB + mask for heroes; the client only loads the units present in a match.

### Known limits

* No emissive: the renderer's art materials have no emissive channel, so soul-fire is bright green albedo only.
* Hero weapons are not team-tinted by the renderer (`isWeapon`), which is why the Sultana's banner is turquoise.
* The elephant's howdah crew, the catapult's counterweight cage and every cape / mantle are rigid or skinned to the
  nearest bones; a caster's raised arm drags the mantle with it.
* The corpse catapult's concept shows the arm released (counterweight down); it fires from that pose.

## 9. Keeps and arrow towers (real geometry, tiling materials)

The TRELLIS Keep (one blurry 1024 atlas on a 15k blob, the same castle for every faction) is gone. Each faction
has its own Keep and arrow tower, modelled procedurally in headless Blender and textured with tiling CC0 scans.

```
node tools/art/keep.mjs [kingdom,ashen,caliphate] [--tex [--fetch]] [--noao]   # textures, geometry, pack, manifest
python tools/art/keep_tex.py [--fetch]                                         # public/textures/keep/ only
node e2e/keep-shots.mjs <tag> [factions]                                       # e2e/shots/keep-<tag>-<faction>-<cam>-s<stage>-<w>x<h>.png
```

| file | role |
|---|---|
| `tools/art/blender/keep_kit.py` | the architecture kit: gridded walls with real niches (arrow slits, arched windows, gates), round / faceted shafts, machicolated battlements (corbels, parapet, merlons: square, coped, stepped, spiked), coursed cone / hip roofs, domes, lathes, sweeps (ribs, horns), buttress extrusions, banners, flags, flames, rocks, rubble; vertex AO + weathering; the damage cut |
| `tools/art/blender/keep_build.py` | the Kingdom design, the build / export loop; `keep_ashen.py`, `keep_caliphate.py`: the other two designs |
| `tools/art/keep_tex.py` | grades the scans into one albedo strip + one normal strip per faction (8 layers of 512 px) and draws the banner |
| `src/render/terrain/keep-art.ts` | texture arrays, the two materials, per-layer roughness / metalness / glow |
| `src/render/terrain/keep.ts` | `Keep.useArt`: LODs, stages, fades, the ground-contact mesh |

**Geometry contract.** `keep_<faction>.glb`: root -> `stage0..stage3`, each ONE mesh with two primitives, materials
`keep` and `cloth` (untextured in the file). `arrow_tower_<faction>.glb`: one mesh, same two materials, about 3.9 m
wide, arrow platform at 6 m (the shot leaves at 6.07 m), no stages. Both have a `_lod1.glb` (coarser grids, no
single corbels / courtyard props / window bars). The model faces +Z, origin at the ground centre, the plinth
reaches 1.8 m below ground.
* `TEXCOORD_0` carries the material: `u = local u + 8 * layer + 4` (`|local u| < 4`), layers `0 wall, 1 trim,
  2 roof, 3 wood, 4 metal, 5 accent, 6 floor, 7 plain, 8 glow` (glow = unlit emissive in the vertex colour:
  windows, torches, soul-fire). UVs are world-scale (`TILE` metres per repeat), so the scans never stretch.
* `COLOR_0` = tint x baked ambient occlusion (18 cosine rays per vertex against the model and the ground,
  3.2 m) x weathering (large blotches, dirt and damp towards the ground, moss, soot under a break). Cloth: red =
  sway weight.
* `pack.mjs` packs these with `-kv -vt 16` (gltfpack drops the UVs of untextured materials otherwise, and its
  default 12-bit UV grid smeared the textures on small faces).
* **Damage stages.** Every part is a *piece*: small ones (merlons, corbels, banners, finials) vanish whole when
  their anchor is above the stage's cut surface (noise + tilt + per-design dips and standing fragments), solid
  masonry is bisected by a tilted plane and capped, hollow masses (towers, halls, roofs, domes: `hollow=(wall,
  depth)`) get a wall-thick broken rim around a dark interior with fallen rubble. Rims are stepped down by whole
  courses. Stage N = `cuts[N]` of the design + its `damage()` rubble.

**Materials in the engine.** One draw for all masonry: a `MeshStandardMaterial` patched to sample two
`sampler2DArray`s (albedo sRGB, normal) by layer, with per-layer roughness / metalness; the low tier compiles
without the normal maps and never downloads them. A second draw for cloth: `<faction>_banner.webp` (RGB cloth,
A = 128 + team mask x 127; `albedo *= mix(1, teamColor, mask)`), double-sided, swaying in the shared wind (it only
moves while frames are drawn anyway). Each Keep and each arrow tower owns its material pair (they fade
separately when they block the view); programs and textures are shared.
* **LOD**: low loads only the `_lod1` files; the other tiers load both and switch at 92 m (back at 80 m), so
  in planning the own Keep is LOD0 and the far one LOD1.
* **Faction**: `BattleView.setKeepFactions([seat0, seat1])` (option `keepFactions`); the UI feeds it from the
  match view (planning) and from the replay's army (battle) through `SceneAdapter.setFactions`. Until the files
  arrive (or without a manifest) the procedural castle of `terrain/keep.ts` stands in.
* **Ground contact**: a draped vertex-alpha mesh darkens the dirt towards the plinth and under each tower.

Texture sources (all **CC0 1.0**, polyhaven.com; 1k maps graded by `keep_tex.py`): `medieval_blocks_03`,
`sandstone_blocks_08`, `sandstone_blocks_05`, `stone_wall_04`, `grey_roof_tiles_02`, `metal_plate_02`,
`rusty_metal_04`, `weathered_planks`, `medieval_wall_01`, `cobblestone_floor_08`. The Caliphate's glazed roof
tile and star tilework are generated in `keep_tex.py`. Banner emblems and the three concept sheets
(`docs/art-review/keep/`): Codex CLI / OpenAI image generation (outputs owned by the user per OpenAI terms).


## 10. Remodel v3: hybrid TRELLIS-1024 bodies + authored parts

The War Elephant A/B test (`art-work/elephant-ab/`) showed that the v2 blur came mostly from how TRELLIS was run and
unwrapped, and that the best result is a hybrid: **organic forms** (bodies, heads, anatomy, riders, mounts) from
TRELLIS pushed hard, **designed / hard-surface parts** (cloth, heraldry, barding, howdahs, shields, banners, siege)
from scripted Blender geometry with flat Codex art. Everything below is in `tools/art/`; `npm run art -- <ids>` is
still the entry point.

```
npm run art -- lord_marshal --stage                    # every stage, outputs to art-work/stage_v2/ (nothing shipped yet)
npm run art -- war_elephant --from cleanup --stage     # re-run from the cleanup (meshes exist)
node tools/art/mesh.mjs --queue art-work/remodel/gpu_queue.txt   # the GPU queue (TRELLIS 1024, one job at a time)
blender -b --factory-startup --python tools/art/blender/compare_review.py -- out.jpg art-work/unpacked/<id>.glb art-work/unpacked/stage/<id>.glb [yaws] [zoom]
node tools/art/ship.mjs lord_marshal,war_elephant [--dry]   # stage -> public/models/v2 + manifest entries (after review)
node tools/art/aset.mjs <id[,id]> key=<json> ...       # targeted assets.json edit (--new <id> appends an entry)
```

### What changed against v2

| step | v2 | v3 |
|---|---|---|
| TRELLIS | q8 512 flows, `--res 512`, one run for the whole unit | q8 1024 flows (`E:/local/red-portal-ai/trellis2-q8-1024`), `--res 1024 --atlas 4096 --steps 16`, **one run per separable part** from a clean concept of that part alone (weapons / props stay at 512) |
| LOD0 mesh | voxel remesh at size / 300, 15k triangles | ~1 cm voxel remesh (size / 450, clamped 0.6-2 cm), about 30k triangles for a Lord, 39k for the elephant |
| unwrap (LOD0, every tier) | smart project: thousands of crumbs on a bumpy TRELLIS surface, a third of the atlas lost to margins | **box projection** along the dominant axis of a smoothed normal field (`cleanup.py: unwrap_box`): a few hundred large islands at one texel density; only polygons that still overlap inside an island are smart-projected. The biggest single fix. LOD1 and the crowd atlas keep smart project (3k / 1.5k triangles: no crumbs there) |
| atlas (hero tier) | 1024 base + normal, 512 MR; LOD1 512 | **2048** base + normal, 1024 MR; LOD1 baked on its own from the high meshes at **512** (256 MR) |
| albedo | as baked | light unsharp mask before the team key (`unsharp` [radius px, amount]: [2, 0.6] at 2048, [1, 0.35] at 512, none on 256 weapons) |
| team mask (hero tier) | 256 | **1024**, keyed per asset with a tight hue window (`team_hue`, `team_sat`, `team_val`) |
| material | every GLB `doubleSided: true` (Blender's default, so the renderer cannot trust the flag) | hero-tier units: ONE single-sided material (`doubleSided: false`). Thin cloth: `two_sided` duplicates + flips its faces after the bake (no extra draw); a large piece can instead take `cloth_material` = a second material `<id>_cloth` (the renderer draws materials whose name contains `cloth` double-sided; +1 draw) |
| LOD1 team mask | none (LOD1 of a hero had no usable mask) | `<id>_lod1_team.png` (256) + manifest `lod1TintMask`: the low graphics tier draws `<id>_lod1.glb` of heroes above 20k triangles. Mounted heroes: `creature.py` packs one LOD1 atlas + mask as it does for LOD0. `grade` lift / sat also applies to the hero LOD1 atlas |
| GPU | Cycles on the GPU, no coordination | `art_lib.bake_device`: takes `art-work/fx_gpu.lock` when it is free, otherwise bakes on the **CPU** (about 1-3 min per hero; the TRELLIS queue hands the lock from run to run, so waiting would starve). `ART_BAKE=cpu|gpu|wait` forces a mode |
| output | written straight into `public/models/v2` | `--stage` (env `ART_OUT`) writes GLBs, masks, VAT files and a `manifest.json` to `art-work/stage_v2/` (a junction to E:); `ship.mjs` copies reviewed ids over and merges only their manifest entries |

### Tiers (`cleanup.py: tier`, `tex_cfg`)

| tier | who | LOD0 atlas | LOD1 atlas | team mask | unsharp |
|---|---|---|---|---|---|
| `hero` | not `squad`, not `part`, not a weapon / prop: Lords, large units, heroes. Rider / mount parts of a hero unit say `"tier": "hero"` | 2048 (MR 1024) | 512 (MR 256) | 1024 | [2, 0.6] |
| `squad` | `squad: true` and `part: true` assets | 512 (MR 256) | 256 | 256 | [1, 0.35] |
| `prop` / `weapon` | by kind | 512 / 256 | 256 | 256 | [1, 0.35] / none |

Hero-tier assets go through `cleanup.py: unit_main` (parts, one joined bake); the other tiers keep the v2 flow
(`make_lod`) with the box unwrap and the unsharp mask on LOD0.

### New `assets.json` keys (all optional)

| key | on | meaning (default) |
|---|---|---|
| `tier` | any | `hero` / `squad` (see above) |
| `tex`, `tex_lod1`, `mask`, `unsharp` | any | override the tier's texture sizes / sharpening (a mounted hero: mount 2048, rider `tex` 1024) |
| `mesh` `{res, atlas, steps, seed}` | any | TRELLIS settings (`mesh.mjs`; 1024 / 4096 / 16 / 42, weapons and props 512) |
| `voxel_div` | any | remesh voxel = largest dimension / N (hero: 450 with the voxel clamped to 0.6-2 cm; squads 300) |
| `direct` | hero, part | try quadric collapse without the remesh first (thin hard-surface detail; open shells may miss the budget, then it remeshes) |
| `cage` | hero | bake cage extrusion in metres (1.2 % of the height, clamped 1-3 cm) |
| `team_val` | any | minimum value of the team-cloth key (0.10) |
| `fix_yaw`, `align` | any, part | degrees added after the automatic yaw alignment; `align: false` skips the alignment |
| `body_height`, `feet_span`, `fore_y` | hero body | the animal's own height without its trappings; scale so fore and hind feet stand `feet_span` apart with the fore feet at y = `fore_y` (matches the joints in `creatures.json`) |
| `body` | hero | `false`: no TRELLIS body, the unit is only its `parts` (fully authored units) |
| `skin` | rigged | `"solid"`: bone heat on a filled voxel hull first (elephant: the plain proxy left legs unweighted) |
| `parts` | hero | the extra pieces of the unit, see below |
| `authored` | weapon / part | no concept / TRELLIS mesh / cleanup of its own (built by a trappings builder) |

`parts` entries: `{ "name", "id": <part asset id> | "builder": <trappings builder> + "args": {...}, "height" (overrides the
part asset's), "pos": [x, y, z] / "yaw" / "scale" or "instances": [{pos, yaw, scale}, ...] (Blender metres, the unit faces
-Y), "bone": <bone the piece follows rigidly; omitted = skinned with the body>, "lod0" (triangles per instance),
"uv_boost" (texel density factor, e.g. 1.3 for crew seen up close), "direct", "two_sided", "cloth_material", "voxel_div" }`.
Team-coloured authored pieces of a hero (banners, shield faces) must be `parts` on a `bone`, not `weapons`: meshes under a
`weapon_*` node get no tint mask in the renderer. Authored weapons without team colour stay weapons (`procedural: true`
+ `trap`, built by `proc_weapon.py` from the same kit).

* A part **id** is an ordinary assets.json entry (`"part": true`, `"kind": "part"` or its real kind for the yaw rule)
  with its own prompt, concept and TRELLIS mesh; `run.mjs` adds it to the concept + mesh stages of its unit and never
  cleans or builds it on its own.
* A part **builder** is an authored piece: `trappings.build(name, args, ctx)` (`tools/art/blender/trappings.py`,
  contract in its docstring and in `trappings_hook.py`) returns one mesh in unit space with clean UVs, a material
  whose Base Color is the flat art, and optionally `team_image` (its own team mask) / `double_sided` (= `two_sided`). `ctx` =
  `{id, unit, asset, body (the oriented TRELLIS body, for draping), height, parts}`. Authored pieces are both the bake
  source and the low mesh: their UV islands are packed into the unit atlas with everything else, their texels skip
  the hue map / unsharp / hue key, their metalness is taken as authored, and their team mask replaces the key there.
* Assembly (`unit_main`): every piece gets its own LOD0 (TRELLIS: remesh + collapse to its `lod0`; the body gets
  `lod0` minus weapons and parts) and its own box unwrap; all pieces are joined, brought to one texel density
  (x `uv_boost`), packed once and baked in one pass from all the high meshes. LOD1 is rebuilt per piece (remesh at
  size / 150, authored pieces collapsed directly; the `lod1` budget is shared by triangle count), smart-projected
  and baked from the same high meshes at 512.
* Authored pieces in the atlas: every piece's UV layout is scaled as a block to the unit's texel density and the
  single pack keeps overlapping islands stacked (`merge_overlap`), so instances inside an authored part (mirrored
  flanks, tassels, cloth linings) go on sharing texels. At LOD0 an authored piece is never ray-baked: its texels are
  **copied** from its authoring UVs by a self-bake (`bake_unit(copies=)`; a ray cannot tell a cloth face from the
  lining face lying in the same place), authored highs are left out of the ray bake (the body under a caparison
  keeps its own skin) and authored islands are not rotated (tangent normal maps are copied as they are). LOD1 of
  authored pieces is a voxel hull like every other piece: lining faces removed (`front_only`), a slab towards the
  body, pieces skinned with the body fused into the body's hull, rigid ones their own hull.
* `args.frame` on a builder part (`trappings_hook.py`) = `{"rig": true, "tilt": deg, "pivot": [x, y, z]}`: build the
  part with the body in the rig frame of `creatures.json` (its `yaw` / `dx`) and / or pitched level about X through
  `pivot` (the saddle of an upright wyvern / roc: tilt 50-60), then transform the part back.
* Rigid pieces: the point attribute `_PART` (index + 1 into the object's `part_bones`) survives into the clean
  `.blend`; `rig.py: skin` (used by `creature.py` too) leaves those vertices out of the bone-heat proxy and
  weights them 100 % to their bone on both LODs. The bone must be a deform bone of the unit (`m_body`, `spine3`, ...).

### Staging and shipping

`run.mjs --stage` sets `ART_OUT=art-work/stage_v2` for every stage: `art_lib.OUT`, `pack.mjs` (originals to
`art-work/unpacked/stage/`), `manifest.mjs` (a manifest of the staged ids only) and the review renders
(`art-work/review/stage/<id>.png`). Intermediates (`art-work/blend`, `art-work/clean`) are shared with unstaged
builds. `ship.mjs <ids>` backs the files it replaces up to `art-work/backup_v2/pre_remodel/` (once: the first
version is kept), copies `<id>.glb`, `<id>_lod1.glb`, `<id>_team.png`, `<id>_lod1_team.png` and the VAT files that exist in the stage,
removes shipped files the stage no longer has, and merges the ids' manifest entries; no other entry is touched.

### Budgets

Hero / large / Lord: LOD0 about 30k triangles (39k for the elephant with howdah and crew), one 2048 atlas, about
2-3 MB packed; LOD1 <= 3k triangles with a 512 atlas, 0.4-0.9 MB. Squads: unchanged per-instance cost (<= 1.5k
triangle crowd mesh, 512 atlas, 256 tint).

### Validation builds (staged, 11-15)

| id | parts | tris LOD0 / LOD1 | textures | packed GLB / LOD1 | cleanup + build |
|---|---|---|---|---|---|
| `lord_marshal` | body (TRELLIS 1024) + sword (512) | 29548 / 2951 | 2048 base + normal, 1024 MR, mask 1024; LOD1 512 / 256, mask 256 | 1.87 / 0.40 MB (v2: 0.82 / 0.36) | 63 s + 10 s, CPU bake |
| `war_elephant` | body + howdah + 2 crew (`m_body`), the A/B test's candidate A through the real pipeline | 38906 / 2933 | same | 2.99 / 0.40 MB (v2: 0.99 / 0.38; candidate A: 38906 tris, 3.01 MB) | 170 s + 28 s, CPU bake |

Review sheets: `art-work/review/stage/<id>_cmp.jpg` (old | new, `compare_review.py`), `art-work/review/stage/<id>.png`.
Known limits: a hole in a TRELLIS shell (the Marshal's cape at the left shoulder) bakes the surface behind it into a
patch; `two_sided` adds the duplicated faces on top of the triangle budget; a mounted hero's atlas is the mount's
2048 next to the rider's 1024 (3072 x 2048, not a power of two).

### 10.x Authored trappings and siege (scripted Blender, no image-to-3D)

Designed and hard-surface parts (cloth, heraldry, barding, howdahs, shields, banners, siege) are built as real
geometry with clean UVs and **flat Codex art copied at native resolution** (no ray bake, CPU only).

```
node tools/art/flat.mjs shield_sun,banner_sun [--force] | --all        # prompts/flat/<name>.txt -> art-work/flat/<name>.png
blender -b --factory-startup --python tools/art/blender/trappings.py -- sheet <out_dir> [label,...]     # every builder, 4 views + atlas
blender -b --factory-startup --python tools/art/blender/trappings.py -- test <builder> '<args json>' out.png ['<body json>']
blender -b --factory-startup --python tools/art/blender/trappings.py -- unit parts.json out.png '<body json>' ['<views json>']
blender -b --factory-startup --python tools/art/blender/siege.py -- ballista        # authored engines (assets.json `authored: true`)
blender -b --factory-startup --python tools/art/blender/proc_weapon.py -- weapon_shield_rajah    # authored weapons
```
`body json` = `{"glb": path, "height": m, "feet_span": m, "fore_y": m, "yaw": deg}` (placed as cleanup places a mount) or
`{"blend": path, "object": name}`. `SIEGE_STRIP=out.png [SIEGE_POSES=fire:0,fire:10,...] [SIEGE_YAW=-62]` renders clip
poses from the siege build scene. Review sheets: `art-work/remodel/review/trappings/`.

| file | role |
|---|---|
| `tools/art/blender/trappings_lib.py` | geometry helpers with authoring UVs (grid sheets, tubes, lathes, boxes, beams, spheres), `Drape` (taut cloth / ring bands / projection on a body BVH, or on a parametric barrel), `plate_grid` (a quad grid that follows the silhouette of art isolated on black), texture sources, and the composer `Kit` |
| `tools/art/blender/trappings.py` | the contract (`build(name, args, ctx)`), the builders, the test harness |
| `tools/art/blender/siege_kit.py` | the three engines on the same kit; `siege.py: authored()` exports them |
| `tools/art/flat.mjs`, `tools/art/prompts/flat/*.txt` | flat art generation (Codex CLI; no matte) |

**How a part is textured.** Every piece carries authoring UVs and a *source*: an image source (flat art, UV 0..1 over
the image) or a tile source (UV in metres; CC0 scans from `art-work/keep/src/` for wood / iron, numpy tiles for
cloth, leather, bronze, gold, bone, rope, scales). `Kit.finish()` finds the UV islands, sizes each from its real
surface size x the wanted texels per metre (x the piece weight), packs them (guillotine), and **resamples the
source into each rectangle** (mip-matched, tiles wrap with a random offset and a small brightness jitter per island),
writing basecolour, a tangent normal map from the source height, roughness / metal and the team mask in one pass.
Instances (mirrored flanks, repeated tassels and panels, the flipped back faces of thin cloth) share texels.
A strip longer than the atlas is squeezed along its length only. Metalness is capped at 0.3 (no environment map).

**Team cloth.** Flat art paints team cloth **vivid magenta** in every faction; `key_team` (hue 0.80-0.99, sat > 0.45)
neutralises it to light grey (keeping the weave shading) and writes the mask, so the mask edge is as sharp as the
art. Tile `cloth_team` is team cloth by construction. The object gets `team_image` (same UVs) and a `_TEAM` vertex
attribute; cleanup ORs the image into the unit mask.

**Contract** (top of `trappings.py`, used by `cleanup.py` `parts` through `trappings_hook.py`):
`build(name, args, ctx) -> one mesh object` in unit space (drape builders are already in place on `ctx['body']`) or
in the weapon frame (hand-held builders: +Z long axis, face -Y, grip at the origin); one `UVMap`, one material in the
`art_lib.build_material` layout (base, normal, MR), custom props `team_image`, `texel`, `atlas`, `double_sided` (always
0: thin cloth has flipped back faces instead). `ctx = {id, asset, body, faction}`; faction = `args.faction`,
`ctx.faction`, else from the asset `hue_map` (Ashen / Caliphate), else Kingdom. Common args: `tex` (atlas cap),
`texel` (px per metre, default 700), `metal_max`, `name`.

| builder | what | main args (all optional) |
|---|---|---|
| `caparison` | draped cloth over back and flanks, 3:2 flat-art panel up from the hem, team cloth to the spine, tassels | `y0`, `y1`, `hem` (z), `drop`, `off`, `cols`, `rows_top`, `rows_low`, `art`, `hem_shape` straight / scallop / tatter / dags, `wave`, `flare`, `tassels`, `barrel` |
| `barding` | scale / plate sheets over shoulders and haunches | `ranges` [[ya, yb]], `hem`, `hem_shape`, `tile`, `tint` |
| `band` | ornamental or leather bands around neck, barrel, legs | `rings` [{c0, c1, nseg, mirror, off, start_r}], `art` (3-strip band image) or `tile`, `tassels` |
| `saddle` | seat with pommel and cantle, saddle cloth with a trim band, girth, stirrups | `y`, `length`, `width`, `cloth_drop`, `cloth`, `trim`, `girth`, `stirrups` |
| `chamfron` | head plate from flat art projected on the head | `origin`, `down`, `ray`, `height`, `width`, `off`, `art`, `nu`, `nv` |
| `howdah` | floor, panelled walls, rails, posts with finials, team swags, skirt band, tassels, optional tented canopy | `half_w`, `y0`, `y1`, `z`, `wall`, `panel`, `swags`, `skirt`, `canopy`, `canopy_h` |
| `shield` | flat heraldic face (its silhouette is the outline), domed, wooden back, metal rim, strap | `kind` kite / round / grave / sun / tower, `art`, `height`, `bulge`, `thick`, `nu`, `nv` |
| `banner` | pole, finial, crossbar, hanging flat-art cloth (both sides) | `length`, `grip_at`, `cloth` [w, h], `art`, `tail`, `tatter`, `wave` |
| `pennant` | flying team pennant on a pole | `pole`, `size`, `tail`, `dir` |
| `quiver`, `lance` | leather quiver with arrows; shaft + steel head, optional vamplate and team pennon | `length`, `radius`, `head`, `vamplate`, `pennon` |

Looks per faction (`trappings.LOOK`): Kingdom = oak, steel, gold trim, lion / fleur-de-lis art; Ashen Covenant = dark
timber, corroded bronze with verdigris, bone, tattered cloth; Sun Caliphate = dark wood, burnished gold, turquoise,
sun art. Flat art in `art-work/flat/`: `caparison_{sun,kingdom,ashen}`, `band_{sun,kingdom,ashen}`,
`chamfron_{sun,kingdom,ashen}`, `howdah_panel_sun`, `shield_{kingdom_kite,kingdom_round,grave,sun,tower_ossuary}`,
`banner_{sun,kingdom,ashen}`, `tile_bone`, `skull_front` (a missing file becomes a grey checker, the build goes on).

**Authored weapons.** `proc_weapon.py` (assets with `procedural: true`) builds shields and banners from the kit:
`trap: [builder, args]` in assets.json, or by id (`weapon_shield_*ossuary*` = tower, `*rajah*` / `*sun*` = sun,
`*grave*`, `*round*`, `*kite*`; `weapon_banner_*` = banner); `length` is the shield height / pole length.
Hero weapons are not team-tinted by the renderer, so a hero shield whose field must show the team colour should be
a unit `part` (with `bone`), not a weapon.

**Siege.** `ballista`, `trebuchet`, `corpse_catapult` have `authored: true`: no concept / mesh / cleanup; `siege.py`
builds LOD0 and LOD1 from `siege_kit.py` (the same engine with coarser lathes, fewer spokes, no lashings) and writes
`<id>.glb`, `<id>_lod1.glb` to `ART_OUT` (`run.mjs --stage`; without it to `art-work/stage_v2/`, never straight into
`public/models/v2`), `art-work/clean/<id>_team.png` (1024), `<id>_lod1_team.png` (256) and the facts. All nodes of an
engine share one material (2048 atlas, LOD1 512). Clips are unchanged in name and length (`idle, fire, reload, hit,
death`); new child nodes animate with them (the renderer plays clips by node name and addresses none itself):
* ballista: `body`, `bolt`, + `arm_l`, `arm_r` (the bow arms spring forward 0.2 rad on `fire`, shiver on `hit`,
  let go on `death` and are drawn back during `reload`), `string_l`, `string_r` (children of the arms, rotate and
  stretch so the string stays attached). Torsion frame with rope skeins and iron washers, bolt trough, windlass with
  ratchet and draw rope. 2.56 x 2.9 m, 2.18 m to the pennant tip (the sim radius is 1.1 m); the bolt lies at
  1.15 m = the archetype's `muzzle`. `fireTime` 0.125 s (frame 3: the string has driven the bolt 1.9 m out).
* trebuchet / corpse catapult: `frame`, `arm`, `rope`, `stone`, + `weight` (the counterweight, hinged on the short
  arm, counter-rotates to stay plumb, sways in `idle`, swings after the drop and on `hit`). **Ready pose = arm up and
  back at 35 degrees with the loaded sling hanging from the tip** (the tall silhouette the RTS camera knows, like the
  model it replaces); `fire` is the last 90 degrees of the throw, over the top, the sling lags, comes into line at the
  release (frame 10) and whips over the front; `reload` winds the arm back with the sling hanging plumb, and a new
  shot appears in the pouch. Trebuchet 3.2 x 4.9 m footprint, rest height 5.98 m (manifest `height`), release point
  8.3 m up and 1.1 m in front of the axle; `fireTime` 0.417 s (frame 10 of 40). The corpse catapult is the same
  builder at 5/6 with the Ashen look: bowed, knobbed bones of varying size and tint lashed with sinew to dark timber,
  a spine and ribs over the trough, skulls on the skid ends and frame tops, corroded bronze with verdigris, a cage of
  skulls with soul-fire as the counterweight (its green light painted onto the surroundings), tattered team rags on
  the braces, a skull as the shot; rest height 4.99 m.
* **Detail** (`siege_kit.Eng`): every timber has end-grain caps (growth rings, checks), iron straps carry bolt heads
  on three faces, wheels have tyre nails, fittings are bolted plates; LOD1 drops the caps, bolts, lashings, ribs and
  rags and uses coarser lathes (2.1-3k tris).
* **Weathering** (`siege_weather.py`, CPU, about 1 min per engine; `SIEGE_NOWEATHER=1` skips it): the rest pose is
  baked with Cycles on the CPU into the kit's atlas -- AO (engine + ground), world position, world normal, a
  Bevel-node edge mask and bevelled normals -- and graded in numpy: contact darkening and crevice dirt, mud thrown up
  from the ground, sun-bleached tops and darker undersides, a world-space tone field so no two beams match, rust
  (Ashen: verdigris) on the iron with streaks on the timber below it, bone mottling, worn pale timber / bright metal
  edges, rounded-edge normals (the beams are plain boxes) combined with the kit's detail normals, then an exposure
  step that brings the timber's median luminance to that of the art it replaces (0.29, Ashen 0.25: the engine lights
  art albedo darkly). Instances that share texels are baked once. MR is written at half size.
* `siege.py` writes `height` (the real rest height), `release` (projectile release point, Blender model space) and
  `fireTime` to the facts; `manifest.mjs` passes `fireTime` and `release` ([x, y up, z forward]) through.

| engine | tris LOD0 / LOD1 | textures LOD0 (LOD1) | packed GLB LOD0 / LOD1 | team mask |
|---|---|---|---|---|
| ballista | 5292 / 2112 | base + normal 2048, MR 1024 (512, 256) | 1.47 / 0.19 MB | 1024 (LOD1 256) |
| trebuchet | 6922 / 2342 | same | 1.42 / 0.19 MB | same |
| corpse catapult | 11946 / 2986 | same | 1.55 / 0.18 MB | same |

Licences: flat art = Codex CLI / OpenAI image generation (outputs owned by the user per OpenAI terms); wood and iron
tiles = CC0 Poly Haven `weathered_planks`, `dark_wooden_planks`, `metal_plate_02`, `rusty_metal_04`; all geometry and
the other tiles are ours.

### 10.y Squads and crowds (remodel v3, batch 2)

Squads keep their per-instance cost (crowd mesh <= 1.5k triangles, one 512 basecolour + 256 MR crowd atlas, 256 tint
mask, the VAT contract of section 4, a 512 detail GLB); the gain is in sharpness and in how the atlas is used.

```
node tools/art/run.mjs militia --from cleanup --stage        # TRELLIS 1024 body -> 1024 bake source -> crowd + VAT
bash art-work/remodel/p4/build.sh <id> [from]                # the same + crowd atlas old | new sheet and coverage stats
bash art-work/remodel/p4/mount.sh <mount>                    # clean a bare mount, print landmarks, joint grid sheet
```

| step | v2 | v3 |
|---|---|---|
| source mesh | TRELLIS 512, one run for body + weapons | TRELLIS 1024 body (4096 source atlas); weapons as before; shields from the trappings kit |
| LOD0 (detail) bake | 512, smart project | **1024** (`cleanup.py: tex_cfg` squad tier) with the box unwrap: it is only the bake source of the crowd atlas; `vat.py` shrinks the detail images to `detail_tex` (512, MR 256) and re-exports `<id>.glb`, so the shipped detail GLB keeps today's texture size |
| crowd atlas layout | smart project (thousands of crumbs, ~30 % of the atlas covered) | `vat.py: crowd_unwrap`: box projection of the 1.5k crowd mesh (3 smoothing rings, edge threshold 0.06), overlapping folds moved out as a second layer instead of one-triangle crumbs, head / helmet islands x1.35 and shield faces x1.4 texel density, margin 0.004: about **48-50 %** of the atlas covered (militia 0.31 -> 0.49, cavalier 0.27 -> 0.48) and ~25 % fewer glTF vertices (fewer seams). `crowd_unwrap: "smart"` in assets.json restores the old layout |
| crowd albedo | lift `^0.85 * 1.08` | the same lift, then unsharp [1, 0.4] (`vat.py: CROWD_UNSHARP`) |
| shields | TRELLIS weapons (blurred heraldry, keyed team field) | `weapon_shield_round / kite / grave / sun` = `procedural: true`: trappings-kit shields (flat heraldry, exact team field). `proc_weapon.py` fits the LOD1 shield to the weapon's `lod1` budget and writes `art-work/clean/<weapon>_team.png`; `vat.py: source_mask` prefers an authored part's own team image (a stale TRELLIS mask png used to win) |
| mounts | TRELLIS mount with baked saddle / caparison | **bare** TRELLIS 1024 mount (new concept) + authored tack as `parts` (the mount is `tier: hero` with `tex` 1024 / `mask` 512 so `unit_main` assembles it, as P2 did for the pegasus): caparison (team cloth, flat faction art, hem above the knees so the legs stay free) + saddle on `m_body`. In the crowd mesh the tack is fused into the mount's LOD1 hull: no extra triangles |

`creatures.json` `pose_fix` {bone: [[axis X|Y|Z, rad], ...]} (`creature.py: pose_at`): a static correction added to every
pose of every clip. TRELLIS keeps the 3/4 concept's head turn of a horse (the bare `horse` looked 35 degrees to its
right); the joints follow the turned neck and `pose_fix` on `m_neck`, `m_neck2`, `m_head` straightens it in play (+Z turns
the head towards +X). Check it with the posed bone vectors, not the rest pose.

### 10.z What shipped (remodel v3, 2026-11-16) and how to ship more

Every unit and Lord model in `public/models/v2` was rebuilt (43 models: the 37 of v2 and six new Lords; Keeps and arrow
towers are untouched). The v2 files are kept in `art-work/backup_v2/pre_remodel/` with that date's `assets.json`,
`creatures.json` and `manifest.json`. The work log, per-unit decisions and problems: `art-work/remodel/PROGRESS.md`.

**Ship pass** (per batch; nothing reaches `public/` before it):
1. `node tools/art/run.mjs <ids> --stage`, review: `node e2e/with-gpu-lock.mjs "review" -- node e2e/model-compare.mjs <batch> <ids>`
   (old | new at the overhead, mid-battle and close-up cameras, both team colours, motion strips) and
   `node e2e/slide-check.mjs <tag> <ids>`.
2. Power gate: copy the ids' staged files + a manifest holding only their entries into a temporary stage folder, then
   `LORDS=a,b node e2e/with-gpu-lock.mjs "power-ab" -- node e2e/power-ab.mjs out.txt --stage <dir> --rounds 3 --tiers medium,low --sets cur,new`.
   Only the new / old ratio of one run means anything (absolute fps follows the machine load); idle and hidden must be 0.
3. `node tools/art/ship.mjs <ids>`, then `npx tsc --noEmit`, `npx vitest run`, `npx vite build`.

**GPU etiquette.** One GPU job at a time (`art-work/fx_gpu.lock`). `e2e/with-gpu-lock.mjs` also waits while a process in
`GPU_GATE` (default `Wow.exe`) runs: power numbers and captures are meaningless while the user plays. The mesh queue has
the same gate as an opt-in (`MESH_GATE=Wow.exe`).

**Rules the review enforced** (keep them for new units):
* A faction must read at a glance: Kingdom = steel, oak / leather, cool neutrals; Ashen Covenant = bone, grey, bronze,
  green soul-fire; Sun Caliphate = white, sand / terracotta, gold, turquoise accents. A 1024 TRELLIS bake drifts in hue
  and saturation against the 512 one (orange berserker pelt, crimson horse, red sand golem, brown bone drake): pull it
  back with `hue_map`, `grade.lift` / `sat`, `grade.tone` (hue window -> colour), `grade.glow` (dark soul-fire -> bright).
* Team colour must dominate from the RTS side (behind) AND from the front (the enemy faces the camera): shields carry a
  team-coloured FIELD and a team-cloth back; units with no cloth behind get `grade.fur.region`; mounts get an authored
  team caparison.
* Renderer side (`src/render/crowd/assets.ts`): low and medium draw a heavy hero's `lod1` file (8k triangles, own 1024
  atlas, needs manifest `lod1TintMask`) and cap hero textures at 1024; high and ultra draw LOD0 at 2048.

**Sizes, before -> after** (runtime = what a client on the high tier downloads for the unit: crowd mesh + VAT + tint for
squads, detail GLB + mask for heroes; low / medium load the hero `lod1` file + its mask instead, 0.9-1.3 MB):

| id | tris LOD0 / LOD1 before | after | all files MB before | after | high-tier runtime MB before | after |
|---|---|---|---|---|---|---|
| `militia` | 5906 / 1474 | 5994 / 1468 | 1.62 | 1.65 | 1.17 | 1.16 |
| `pikeman` | 5506 / 1412 | 5506 / 1412 | 1.46 | 1.43 | 1.11 | 1.04 |
| `berserker` | 5908 / 1474 | 5908 / 1474 | 1.69 | 1.70 | 1.12 | 1.14 |
| `archer` | 5908 / 1474 | 5908 / 1474 | 1.57 | 1.54 | 1.16 | 1.15 |
| `knight` | 5908 / 1474 | 5798 / 1464 | 1.69 | 1.65 | 1.22 | 1.15 |
| `mage` | 5908 / 1476 | 5908 / 1476 | 1.81 | 1.77 | 1.36 | 1.33 |
| `cleric` | 5908 / 1474 | 5908 / 1474 | 1.65 | 1.69 | 1.16 | 1.20 |
| `cavalier` | 8370 / 1474 | 9370 / 1472 | 2.77 | 1.93 | 1.28 | 1.24 |
| `pegasus` | 8370 / 1442 | 10354 / 1470 | 2.93 | 2.20 | 1.37 | 1.32 |
| `wyvern` | 14280 / 3239 | 28574 / 7876 | 2.19 | 3.87 | 1.63 | 2.58 |
| `ballista` | 14816 / 2978 | 5292 / 2112 | 1.15 | 1.68 | 0.90 | 1.48 |
| `trebuchet` | 14806 / 2986 | 6922 / 2342 | 0.97 | 1.64 | 0.73 | 1.45 |
| `golem` | 14774 / 2954 | 29550 / 7880 | 1.15 | 3.14 | 0.84 | 2.14 |
| `dragon` | 14774 / 2954 | 29550 / 7880 | 1.48 | 3.69 | 1.12 | 2.57 |
| `lord_marshal` | 14774 / 2953 | 29548 / 7878 | 1.23 | 2.98 | 0.86 | 2.04 |
| `lord_archmage` | 14774 / 2942 | 29548 / 7878 | 1.49 | 3.25 | 1.02 | 2.26 |
| `lord_warden` | 14774 / 2954 | 29548 / 7878 | 1.37 | 3.65 | 1.01 | 2.57 |
| `lord_skylady` | 14774 / 2920 | 29548 / 7878 | 1.35 | 2.97 | 0.97 | 1.99 |
| `skeleton` | 5506 / 1410 | 5396 / 1400 | 1.56 | 1.67 | 1.10 | 1.10 |
| `grave_knight` | 5908 / 1474 | 5798 / 1464 | 1.66 | 1.80 | 1.14 | 1.19 |
| `bone_archer` | 5908 / 1474 | 5908 / 1474 | 1.60 | 1.63 | 1.17 | 1.13 |
| `grave_acolyte` | 5908 / 1474 | 5908 / 1474 | 1.58 | 1.56 | 1.06 | 1.03 |
| `lord_lich` | 14772 / 2952 | 29548 / 7876 | 1.47 | 4.00 | 1.05 | 2.91 |
| `bone_golem` | 14774 / 2954 | 29550 / 7880 | 1.84 | 4.25 | 1.42 | 3.17 |
| `wraith_rider` | 7970 / 1391 | 8970 / 1400 | 2.97 | 2.07 | 1.25 | 1.17 |
| `bone_drake` | 14774 / 2954 | 29550 / 7880 | 1.55 | 3.95 | 1.12 | 2.79 |
| `corpse_catapult` | 14806 / 2984 | 11946 / 2986 | 1.26 | 1.77 | 0.98 | 1.58 |
| `spear_levy` | 5506 / 1412 | 5592 / 1406 | 1.56 | 1.57 | 1.13 | 1.11 |
| `scimitar` | 5908 / 1474 | 5994 / 1468 | 1.61 | 1.67 | 1.12 | 1.14 |
| `djinn_binder` | 5908 / 1474 | 5908 / 1474 | 1.67 | 1.64 | 1.17 | 1.15 |
| `sun_priest` | 5908 / 1474 | 5908 / 1474 | 1.70 | 1.68 | 1.20 | 1.20 |
| `lord_sultana` | 14772 / 2950 | 29560 / 7888 | 1.43 | 3.23 | 1.01 | 2.27 |
| `camel_archer` | 8370 / 1466 | 9370 / 1465 | 2.90 | 2.06 | 1.32 | 1.30 |
| `mamluk` | 8370 / 1396 | 10354 / 1421 | 3.06 | 2.29 | 1.37 | 1.37 |
| `war_elephant` | 14774 / 2954 | 39038 / 13915 | 1.43 | 3.96 | 1.04 | 2.90 |
| `sand_golem` | 14774 / 2954 | 29550 / 7880 | 1.47 | 3.79 | 1.07 | 2.67 |
| `djinn` | 14774 / 2954 | 29550 / 7880 | 2.68 | 2.76 | 0.72 | 1.79 |
| `lord_deathknight` | new | 29548 / 7878 | - | 3.76 | - | 2.70 |
| `lord_rajah` | new | 29554 / 7884 | - | 3.09 | - | 2.17 |
| `lord_vizier` | new | 29548 / 7874 | - | 3.66 | - | 2.52 |
| `lord_ossuary` | new | 29556 / 7885 | - | 4.57 | - | 3.27 |
| `lord_drakerider` | new | 28572 / 7880 | - | 3.96 | - | 2.71 |
| `lord_rocrider` | new | 28574 / 7859 | - | 4.51 | - | 3.18 |

**Known limits after v3.** No emissive channel (soul-fire is bright albedo). (Wing-root twist: fixed 2026-11-17, see
section 2 **Wing roots**.) Siege `hit` is a small jolt. Capes, cloaks and manes have no secondary motion. The in-engine slide
check cannot read contained jog clips and counts low cloth hems as planted points (archer, spear levy): trust the
Blender bone audit (`anim_audit.py`) there. The mamluk's gallop has a worst planted-hoof error of about 19 cm in the
build log (7 cm before; not visible in the run strip). Mounted heroes use a 3072 x 2048 atlas (mount 2048 + rider 1024).

