# Oathbound v2 art pipeline (AI models)

All v2 models are produced by scripts in `tools/art/`; nothing is hand-edited. Outputs land in
`public/models/v2/` with `manifest.json`. Large intermediates live in `art-work/` (git-ignored).
The v1 procedural pipeline (`tools/blender/`, `docs/MODELS.md`) is untouched and still serves `public/models/`.
Review renders and the pilot write-up are in `docs/art-review/`.

## 1. Commands

```
node tools/art/run.mjs militia,knight,keep              # every stage for these ids (+ held weapons, rider/mount parts)
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
| mesh | `mesh.mjs` | trellis-cpp 0.8.1 (Vulkan) + TRELLIS.2 q8 GGUF, `--res 512 --seed 42` | picked cut-out -> `art-work/mesh/<id>.glb` (~140k tris, 1024 atlas) |
| cleanup | `blender/cleanup.py` | Blender 5.2 + Cycles GPU | weld, drop floaters (<0.2 % faces), yaw-align, ground, scale, voxel remesh (size/300), quadric decimate LOD0/LOD1, Smart-UV, bake basecolour + tangent normal + MR from the 140k mesh, team mask -> `art-work/blend/<id>_clean.blend`; props: final GLBs |
| build | `blender/rig.py` humanoids + golem; `blender/creature.py` dragon + mounted/flier units (joint layout per mount in `creatures.json`); `blender/keep.py`; `blender/siege.py` | Blender | GLBs in `public/models/v2/` |
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
* **Keep** `keep.glb`: root with children `stage0` (intact) .. `stage3` (ruin); show exactly one. Cuts are a
  seeded noise surface (vertices above it removed, holes capped with `Rubble`), plus a rubble skirt.
* **Props** (manifest `props`): static, one mesh, LOD0 + LOD1 (`<id>_lod1.glb`), 512² atlas (LOD1 256²),
  origin at the base centre (rocks, ruins, arrow tower; vegetation and bridges are procedural, section 7). (The former art `bridge` spanned three.js **Z**, 8 m long x 4 m wide,
  non-uniform fit); `arrow_tower` (7 m) carries a team-tinted banner.
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
procedural sprites. Squad-plate portraits reuse `public/ui/unit_*.webp` / `lord_*.webp`; damage-number
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
  the sim keep point, 18.2 m wide). Re-measure them if `keep.glb` or `terrain/keep.ts` placement changes.
