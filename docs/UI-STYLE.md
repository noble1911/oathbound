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
  crowns. Never a border, never a heading colour, never a second button.
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
| `ribbon.webp`, `ribbon-blue/red.webp` | swallowtail cloth ribbon | the title tagline, the draft banner, names on the VS reveal |
| `pennant-blue/red.webp` | hanging war banner | match over: the victor's banners |
| `divider.webp` | forged iron divider with a diamond boss | menu section breaks |
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
- Don't restyle the in-world squad plates here: the engine draws them (`src/render/plates.ts`).

## Battle HUD and inspector

- The battle HUD is stone: the lintel (Keep bars, round, the clock with its `/ 1:30` limit), a tally
  plaque with the two shields, the controls bottom right, and the **battle log bottom left** (newest
  at the bottom; entries are clickable). The engine is told the HUD insets, so the director frames
  the fight clear of them.
- The **inspector** (`src/ui/inspector.ts`, data in `src/ui/inspect-data.ts`) is a stone panel docked
  right, with the squad's livery on its top edge. It reads top to bottom as: who, life, performance,
  rank, life over time, damage by source, abilities (live casts), equipment, stats. Compare mode keeps
  the same panel and puts two squads in columns; the better number of a pair is green.
- It updates at 4 Hz at most and only while open; it never asks the renderer for a frame.
- On the results screen and the report overlay it floats over the other army's table.

## Portraits

Lord and unit portraits are **illuminated-manuscript miniatures** (gold leaf, tempera, decorated vine borders), chosen over Amiga pixel art, woodcut, stained glass and 80s module-cover styles. Prompt and process: `tools/art/ui-prompts/_style_manuscript.txt`. New portraits must match this style.
