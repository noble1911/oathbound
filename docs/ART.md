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
```

| stage | script | runs on | in -> out |
|---|---|---|---|
| concept | `concept.mjs` -> `matte.py` | Codex CLI `codex exec` (ChatGPT image generation, prompt on stdin) + WSL venv (BiRefNet matte) | `prompts/<id>.txt` + `prompts/_style_{character,object}.txt` -> `art-work/concepts/<id>/cand_<k>.png`, `_cut.png` (RGBA), `sheet.jpg`, `pick.json` |
| mesh | `mesh.mjs` | trellis-cpp 0.8.1 (Vulkan) + TRELLIS.2 q8 GGUF, `--res 512 --seed 42` | picked cut-out -> `art-work/mesh/<id>.glb` (~140k tris, 1024 atlas) |
| cleanup | `blender/cleanup.py` | Blender 5.2 + Cycles GPU | weld, drop floaters (<0.2 % faces), yaw-align, ground, scale, voxel remesh (size/300), quadric decimate LOD0/LOD1, Smart-UV, bake basecolour + tangent normal + MR from the 140k mesh, team mask -> `art-work/blend/<id>_clean.blend`; props: final GLBs |
| build | `blender/rig.py` humanoids + golem; `blender/creature.py` dragon + mounted/flier units; `blender/keep.py`; `blender/siege.py` | Blender | GLBs in `public/models/v2/` |
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
  character. Mount bones are prefixed `m_` (`m_root`, `m_body`, `m_neck`, `m_head`, `m_tail1/2`,
  `m_leg_{fl,fr,bl,br}_{1,2}`, `m_wing_{l,r}_{1,2}`); a rider's `root` is parented to `m_body`.
* **Weapons** are separate rigid nodes parented to a bone (`weapon_sword_R` on `hand.R`, shields on `forearm.L`)
  in detail GLBs; in crowd meshes they are merged and skinned 100 % to that bone.
* **Clips** (every humanoid / mounted unit): `idle, walk, run, attack_melee_a, attack_melee_b, attack_bow, cast,
  hit, death_a, death_b, victory` (loops: idle, walk, run, victory). The manifest `clips` map gives the canonical
  renderer names: `idle, move, run, attack, attack2, cast, hit, death, death2, victory`. Clip sources per
  `clipset`: sword = upright procedural swings; spear = carry-forward idle/walk/run + thrusts; bow = draw-and-loose;
  cast = Quaternius spell; fist = jab/cross.
* **Siege** (rigid nodes, NLA clips `idle, fire, reload, hit, death`; manifest `fireTime` = projectile release):
  ballista `body`, `bolt`; trebuchet `frame`, `arm` (pivot at axle), `rope`, `stone`.
* **Keep** `keep.glb`: root with children `stage0` (intact) .. `stage3` (ruin); show exactly one. Cuts are a
  seeded noise surface (vertices above it removed, holes capped with `Rubble`), plus a rubble skirt.
* **Props** (manifest `props`): static, one mesh, LOD0 + LOD1 (`<id>_lod1.glb`), 512² atlas (LOD1 256²),
  origin at the base centre. Trees <= 3k / 600 tris. `bridge` spans along three.js **Z** (8 m long x 4 m wide,
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
* **Clips** (`clips[]`, contiguous frame ranges, per-clip `fps`): `idle` (10 fps, loop), `move` (12, loop),
  `run` (12, loop), `attack` (12), `attack2` (12), `cast` (12, casters only), `hit` (12), `death` (10),
  `victory` (8, loop). Loops have `round(duration * fps)` frames (no duplicate end frame), one-shots +1.
  `death2`: mirror the instance's X scale and play `death`.
* Reference decoder: `tools/art/blender/vat_check.py` (renders `docs/art-review/<id>_vat.png` from the shipped files).

## 5. Animation and asset licences

| asset | source | licence |
|---|---|---|
| Base clips (idle, walk, jog, sword attack, punches, spell, hits, death, sit) + reference rig | Quaternius *Universal Animation Library* [Standard], opengameart.org/content/universal-animation-library | CC0 1.0 |
| Extra clips (sword combos, knockback) | Quaternius *Universal Animation Library 2* [Standard], opengameart.org/content/universal-animation-library-2 | CC0 1.0 |
| Procedural clips (bow, swings, spear carry/thrusts, victory, all creature and siege motion) | authored in `tools/art/blender/*.py` | ours (project licence) |
| Concept images | Codex CLI / OpenAI image generation (outputs owned by the user per OpenAI terms) | n/a |
| Image -> 3D | TRELLIS.2 (Microsoft, MIT) via trellis-cpp q8 GGUF weights | MIT |
| Matte | BiRefNet (ZhengPeng7/BiRefNet) | MIT |
| Fallback concept model | FLUX.1-schnell (Black Forest Labs; mirror `unsloth/FLUX.1-schnell`, GGUF `city96/FLUX.1-schnell-gguf`) | Apache-2.0 |
| Tools | Blender 5.2 (GPL, tool only), diffusers / transformers / torch | Apache-2.0 / BSD |
