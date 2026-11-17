# Oathbound UI style

The interface is built from the same things the world is built from: **forged steel, slate stone,
aged parchment and two heraldic liveries** (blue for your side, red for the enemy). The discipline is
borrowed from Total War: Warhammer III (carved stone and forged metal frames, restrained colour) and
Age of Empires IV (parchment, ink and heraldry, very readable). It is not "dark glass with gold
hairlines": gold is rare, and every colour on screen means something.

The tokens live at the top of `src/style.css`; the textures in `public/ui/kit/`; the fonts in
`public/ui/fonts/`.

## Palette

| Token | Hex | Role |
| --- | --- | --- |
| `--iron-900` | `#0d1014` | page background, deepest shadow, text on gold |
| `--iron-800` | `#151920` | tooltip plates, wells, inputs |
| `--iron-700` | `#1d232c` | raised dark surface |
| `--slate-600` | `#2a313b` | stone panel base (under `stone.webp`) |
| `--slate-500` | `#3a4350` | stone bevel, borders on dark |
| `--slate-400` | `#56616f` | hairlines, disabled metal |
| `--steel-300` | `#8d99a8` | dim text on dark (labels), icon strokes |
| `--steel-200` | `#b8c2ce` | secondary text on dark |
| `--steel-100` | `#e8ebef` | primary text on dark |
| `--parch-100` | `#f1e7cf` | parchment highlight, text on team colours |
| `--parch-200` | `#e2d3b0` | parchment base (under `parchment.webp`) |
| `--parch-300` | `#c9b68b` | parchment shade, rules on parchment |
| `--ink` | `#231b12` | primary text on parchment |
| `--ink-2` | `#57462f` | secondary text on parchment |
| `--me` | `#3b6fd8` | your livery (exactly `TEAM_COLORS[0]` in `src/render/crowd/archetypes.ts`) |
| `--me-hi` / `--me-deep` | `#94b6f6` / `#1f3f86` | blue text on dark / blue on parchment, bar shade |
| `--foe` | `#d8453b` | enemy livery (exactly `TEAM_COLORS[1]`) |
| `--foe-hi` / `--foe-deep` | `#f4a097` / `#8a231c` | red text on dark / red on parchment, bar shade |
| `--gold` | `#d9a441` | the one primary action, crowns, coin |
| `--gold-hi` / `--gold-deep` | `#f3d27f` / `#7d5516` | gold text on dark / gold shade, gold on parchment |
| `--good` / `--good-ink` | `#6cc487` / `#1f6035` | success, gains (on dark / on parchment) |
| `--bad` / `--bad-ink` | `#f27b6e` / `#a1271e` | danger, losses (on dark / on parchment) |

Rarity (Diablo order, always on a dark iron surface):

| Rarity | Token | Hex |
| --- | --- | --- |
| Common | `--common` | `#bfc3c9` (grey) |
| Magic | `--magic` | `#6f9dff` (blue) |
| Rare | `--rare` | `#e6bd3c` (yellow ochre) |
| Legendary | `--legendary` | `#f58b25` (orange gold) |

`RARITY_CSS` in `src/ui/gamedata.ts` mirrors these.

Lords carry a heraldic tincture (`LORD_HUE` in `src/ui/units.ts`): Or `#b98a2e` (Marshal), Purpure
`#6a4fb0` (Archmage), Vert `#3f7a48` (Warden), Azure `#3f86c4` (Skylady). It appears only as the
band under a Lord's portrait and behind a Lord crest with no art; it never colours text or frames.

### What each colour means

- **Blue / red**: side. Keep bars, names, kill feed edges, report columns, the deployment badge.
- **Gold**: the single primary call to action on a screen (Play, Begin, Ready, Play again), coin,
  crowns. Never a border, never a heading colour, never a second button. (On the title it is flat gold
  leaf, not the gold plate: see Title menu.)
- **Orange gold / ochre / blue / grey**: item rarity, nothing else.
- **Green / red-orange**: success and danger (can afford / cannot, gained / lost, ready / sell).
- Everything else is material: steel, stone, parchment, ink.

Surfaces set their own text tokens (`--text`, `--muted`, `--dim`, `--head`, `--rule`, `--good-c`,
`--bad-c`, `--me-c`, `--foe-c`, `--coin`), so a component reads correctly on stone and on parchment
without knowing which it is on. A parchment surface is any element with class `parch`.

## Type

Self-hosted, all SIL OFL 1.1 (`public/ui/fonts/OFL.txt`).

| Role | Face | Used for |
| --- | --- | --- |
| Display | **Grenze Gotisch** 600 | the wordmark, Victory/Defeat, round and ability banners, "VS". Nothing under 2rem |
| Heading | **Grenze** 600/700 (400 italic for flavour lines) | panel titles, unit and Lord names, large numerals |
| Body / UI | **Source Sans 3** 400/600/700 | every label, paragraph, button, table. `font-variant-numeric: tabular-nums` on all numbers |

Scale (rem; the root size follows the viewport): display 2.6 to 10, h1 2, h2 1.4, h3 1.15,
body 0.92, small 0.8, label 0.68 (uppercase, 0.12em tracking, weight 700). No text under 0.62rem.

## Materials (`public/ui/kit/`)

Generated as flat orthographic sheets (`tools/art/ui-kit.mjs`, prompts in
`tools/art/ui-kit-prompts/`) and cut, keyed and 9-sliced by `tools/art/ui-kit.py`.

| File | What | Used by |
| --- | --- | --- |
| `frame-steel.webp` | 9-slice forged steel frame, riveted corners | `.panel` and every dark HUD plate (`border-image`) |
| `stone.webp` | seamless slate tile | the fill of every stone panel |
| `parchment.webp` | 9-slice deckled parchment sheet | `.parch` documents: codex, report, dialogs, coach, cards |
| `btn-steel.webp`, `-hover`, `-down`, `-off` | steel plate, one file per state (a `border-image` cannot crop a sprite) | `.btn`, notices |
| `btn-gold.webp`, `-hover`, `-down`, `-off` | gold plate, 4 states | `.btn.cta`, `.ready-btn` |
| `btn-stone.webp`, `-hover`, `-down` | stone plaque | shop cards, the resource strip, the deploy badge, toasts |
| `boss.webp`, `-hover` | round steel boss | icon buttons, the clock, codex diagram nodes |
| `seal.webp` | crimson wax seal | the chosen Lord, dialogs |
| `shield-blue/red.webp` | heater shield caps in the two liveries | lobby seats |
| `crown.webp` | small gold crown | Lord crests |
| `ribbon.webp`, `ribbon-blue/red.webp` | swallowtail cloth ribbon | the draft banner, names on the VS reveal |
| `pennant-blue/red.webp` | hanging war banner | match over: the victor's banners |
| `divider.webp` | forged iron divider with a diamond boss | section breaks on stone panels |
| `slot-common/magic/rare/legendary.webp` | item socket per rarity | `.islot` |

Rules:
- Materials are textures, not gradients. CSS gradients are allowed only as light (a scrim over the
  battlefield, a vignette) or as a bar fill.
- Stone + steel is the **HUD**: anything floating over the battlefield, and anything that holds
  items (rarity needs a dark ground).
- Parchment is a **document**: anything you stop and read (rules, report, a decision, the coach).
- No glows as decoration. A glow means "this is Legendary" or "act on this now" and nothing else.
- Corners are square or barely eased (2px). No pills except chips that are literally tokens.

## Buttons

| Level | Class | Material | When |
| --- | --- | --- | --- |
| Primary | `.btn.cta`, `.ready-btn` | gold plate | one per screen: Play vs AI, Begin the war, Ready, Play again |
| Standard | `.btn` | steel plate | everything else |
| Affirm | `.btn.primary` | polished steel plate, white label | the confirming choice in a set (Claim, Level up, a dialog's Yes) |
| Danger | `.btn.danger` | steel plate, red label and edge | Sell, Leave, Concede |
| Quiet | `.linkish` | ink / steel text, underline on hover | tertiary navigation |
| Icon | `button.icon` | steel boss | corner tools, close |

States are separate plates (idle, hover, pressed, disabled), not opacity alone. Focus is a
2px `--me-hi` outline.

## Do / don't

Do
- Put team colour on anything that belongs to a side, and nowhere else.
- Use parchment for reading, stone for playing.
- Keep one gold button per screen.
- Use tabular lining numerals for every number (set once on `*`, because the `font` shorthand
  resets it); align numbers right in tables.
- Hold text contrast at WCAG AA or better: `--ink` on parchment is 11.5:1, `--ink-2` 6.1:1,
  `--steel-100` on stone 11:1, `--steel-200` 7.3:1, `--steel-300` 4.5:1 (labels only).

Don't
- No gold gradients, gold borders or gold headings. No amber glow behind text.
- No gradient text (`background-clip: text`).
- No Cinzel, no wide-tracked serif caps for body labels.
- No near-black glass panels with a hairline border; a panel is stone in a steel frame.
- No new colour without a meaning in the table above.
- Don't restyle the in-world squad plates in CSS: the engine draws them (`src/render/plates.ts`; see Portraits and battlefield glyphs).

## Title menu and menu backdrops

There is no painted key art in the game (`public/ui/keyart.webp` survives only as the link-preview image). What stands
behind a menu is the game itself, or a print of it:

- **Title: a live battle.** A real sim battle between two bot armies plays on the canvas behind the menu
  (`src/ui/title-battle.ts`): a slow side-on dolly, no plates, numbers or sound, graded by a plain CSS scrim. It is a
  guest: low tier, 3/4 resolution, 30 fps at most whatever the settings; one still frame and 0 fps under the battery
  saver, with reduced motion, after 3 minutes without input, in a hidden tab or an unfocused window
  (`node e2e/render-power.mjs` checks all of it).
- **The woodcut field** (`public/ui/scene_field.webp`, a night print in black, cream and the two liveries): on screen
  before the battle has loaded, between battles, and for good when there is no renderer.
- **Lobby and Lord pick**: the title battle's last frame, held as a still (`--still`), else the woodcut field
  (`--field`), under the same dark scrim as before.

The scenes are made like the portraits: `node tools/art/ui-scene.mjs` (prompts `tools/art/ui-prompts/scene_*.txt`, the
`scene:` and `paper:` lines of `_style_woodcut.txt`), then `python tools/art/ui-scene.py`.

The title menu is **print, not forged metal**: flat ink, paper and rules, no plates, bevels or gradients. It has three
styles on one markup (`?menustyle=1|2|3`; the default, `DEFAULT_MENU_STYLE` in `src/ui/title.ts`, is 1):

| # | Style | What it is |
| --- | --- | --- |
| 1 | Broadside | a printed sheet at the left: woodcut headpiece, a cut initial O, a rubric line, ink-block buttons |
| 2 | Campaign table | the wordmark over the field, the orders in three columns on a campaign map along the bottom |
| 3 | Ink band | a dark band at the left with the wordmark and a plain list of entries; the battle has the screen |

Rules that hold in all three:
- **Gold is flat leaf on the one primary action** (Play vs AI; Join when an invite link filled the code in): a flat
  `--gold` block in ink on paper, `--gold-hi` text on the dark band. Never a gradient, never a second gold thing.
- **Madder red (`--rubric`, `#9c2a1f`) is the printer's second ink**: the rubric line and the cut initial of the
  broadside, nothing else. It is not the enemy livery and never marks a control.
- Blue and red appear only as the two sides (the herald's band and the duel shields of style 2).
- Fields are ruled lines or paper wells, the difficulty is three words with the chosen one inked, and every control
  keeps the 2px `--me-hi` focus outline.

## Battle HUD and inspector

- **No top bar.** Two slim corner plaques (portrait, name and Lord on one line, a thin Keep bar) and
  a centre medallion (round, clock, phase) float over the field under a soft vignette. Nothing spans
  the width and nothing is taller than `--hud-h` (3rem: 63px at 1080p). In planning, gold and army
  sit left of the medallion and the intel label right of it; below 4:3 they tuck under it.
- The battle HUD is stone: those plaques (the clock shows its `/ 1:30` limit), a tally
  plaque with the two shields beside the medallion, the controls bottom right, and the **battle log bottom left** (newest
  at the bottom; entries are clickable). The engine is told the HUD insets, so the director frames
  the fight clear of them.
- The **inspector** (`src/ui/inspector.ts`, data in `src/ui/inspect-data.ts`) is a stone panel docked
  right, with the squad's livery on its top edge. It reads top to bottom as: who, life, performance,
  rank, life over time, damage by source, abilities (live casts), equipment, stats. Compare mode keeps
  the same panel and puts two squads in columns; the better number of a pair is green.
- It updates at 4 Hz at most and only while open; it never asks the renderer for a frame.
- On the results screen and the report overlay it floats over the other army's table.

## Portraits and battlefield glyphs

Units and Lords are drawn twice, as two layers of one **woodcut** set (it replaced the illuminated-manuscript
miniatures, which were too yellow, too busy and too alike). Prompts and process:
`tools/art/ui-prompts/_style_woodcut.txt`; the subject table is `tools/art/woodcut-spec.py`.

**Faction palettes** (strict; this is how a faction is told apart at a glance, in menus and on the field):

| Faction | Panel / disc | Figure / glyph | Accent |
| --- | --- | --- | --- |
| Kingdom | ultramarine `#1b2ea0` | cream `#f4ead0` | steel grey `#9fadc6` |
| Covenant | charcoal `#16171a` | bone `#e8e1ca` | soul-green `#6ce062` |
| Caliphate | terracotta `#b24427` | sand `#f2dca8` | turquoise `#2ac4b6` |

### Menus: woodcut portraits (`public/ui/unit_*.webp` 320 px, `lord_*.webp` 512 px)

Hand-carved woodcut prints: bold black carved lines and hatching on cream paper, the faction's three colours only,
slightly off-register, on one flat faction-coloured panel (no pattern, no scenery, no border). The figure fills the
frame, and every unit has its own pose and silhouette and shows its weapon or mount. Make them with
`node tools/art/ui-woodcut.mjs portrait [ids]` then `python tools/art/ui-webp.py`. Lords take a character reference
(`art-work/refs/portrait/lord_<id>.png`), units a per-faction style anchor (`_<faction>.png`).

Caliphate panels are pulled to one terracotta-red by `python tools/art/panel-normalise.py` (run it before
`ui-webp.py` after generating any Caliphate portrait).

**Small crests show the glyph, not the portrait.** Every crest (`crest()` in `src/ui/units.ts`) carries both images;
the stylesheet ("glyph crests" in `src/style.css`) swaps to the battlefield glyph in a round disc wherever a crest is
drawn under about 40 px: every `sm` crest (battle log, kill feed, results rows, codex and Lord-pick chips, group
lists, tooltips of field squads), the HUD Lord plaques and the two-row compact shop. Portraits stay on `md` / `lg`
crests (shop cards, recruit cards, inspector, unit tooltips) and the Lord cards. The glyph disc has a neutral steel
ring in menus: the blue disc / red diamond belongs to the battlefield, where it means side.

### Battlefield: role glyphs on the squad plates (`public/ui/plates.webp` + `plates.json`)

The plate over each squad (`src/render/plates.ts`) answers three questions with three separate signals:

- **What is it? The glyph is the ROLE**, drawn the same way in every faction, so it is learnt once:

  | Role | Glyph | Units |
  | --- | --- | --- |
  | Light infantry | footman striding in profile, short weapon, round shield | Militia |
  | Shock infantry | warrior lunging in profile, big weapon overhead, no shield | Berserkers, Scimitar Guard |
  | Heavy infantry | armoured figure from the front behind a big shield | Knights, Grave Knights |
  | Spear | footman with a tall upright spear | Pikemen, Skeleton Spearmen, Spear Levy |
  | Ranged | archer in profile at full draw | Archers, Bone Archers, Camel Archers (on a camel) |
  | Cavalry | rider on a galloping mount, lance levelled | Cavaliers, Wraith Riders (skeletal horse), Mamluk Lancers |
  | Caster | robed figure raising a staff with a flame or burst | Mages, Grave Acolytes, Djinn-Binders |
  | Healer | robed figure from the front, arms raised under a rayed sun | Clerics, Sun Priests |
  | Flier | creature from the front with both wings spread | Pegasus, Wyvern, Dragon, Bone Drake; the Bound Djinn (smoke tail) |
  | Siege | wheeled machine in profile, no crew | Ballista, Trebuchet, Corpse Catapult |
  | Giant | hulking block from the front, tiny head, fists low | Stone / Bone / Sand Golem, War Elephant |
  | Lord | half-length commander defined by a signature object or companion (banner, meteor, horns and axe, wings, lantern, greatsword, tower shield, drake, scimitar, smoke djinn, elephant, roc), so no two Lords share a silhouette; the plate adds a gold crown and is larger | every Lord |

- **Whose faction? The disc colour** (table above), with the glyph in the faction's light colour.
- **Whose side? The crest's shape and ring**, which no faction colour can be mistaken for: **yours is a round
  disc with a sky-blue ring, the enemy's is a diamond with a scarlet ring**, each ring held off the faction colour
  by an ink line. The health bar repeats the side colour.

Glyphs are flat three-colour stamps (no lines thinner than a stroke, no hatching). `tools/art/glyph-atlas.py`
forces each generated glyph into its faction's three colours, thickens hairlines, and scales it to one enclosing
circle, so the set is uniform; it writes the 1024 px atlas (128 px cells) and its index. Make them with
`node tools/art/ui-woodcut.mjs glyph [ids]` then `python tools/art/glyph-atlas.py`. The plate shader undoes the
grade pass, so the atlas colours are the colours on screen; do not brighten them in the shader.
`python tools/art/woodcut-sheet.py <dir>` writes contact sheets of both layers (with 40 px and 28 px versions).

All twelve Lords have a portrait (`public/ui/lord_<id>.webp`) and a glyph in the atlas, keyed by the Lord id
(`tests/client.lords.test.ts` checks both).

## Factions

- Team colour is still the side: blue is you, red is the enemy, whatever the factions are.
- A faction shows as a **small heraldic band** in its own colours (`FACTIONS[f].colors`): three
  stripes across the top of its banner on the pick screen and its card in the codex, and a two-colour
  band on the outer edge of a HUD plaque (`factionAccent`: steel and blue for the Kingdom, bone and
  soul-green for the Covenant, turquoise and ochre for the Caliphate). It never colours text, frames
  or buttons, and the Caliphate's ochre is not the primary-action gold.
- The pick screen is one flow: three banners, the chosen faction's identity and mechanics, then its
  four Lords, one per role (infantry, magic, armour, fliers), each card tagged with its role.
- The codex speaks about one faction at a time (yours in a match) and says so in a scope line; the
  Factions tab describes all three.
