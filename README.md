# Oathbound

A 1v1 fantasy army auto-battler in the browser. Each round you get 2 minutes to deploy squads and
gear them with ARPG-style loot. Then both armies march across a mirrored field, and the battle plays
out on its own. Whoever tears down the other's Keep first wins.

**Play:** https://games.noblehaus.uk/oathbound/

You can play vs the computer (Easy, Normal, Hard), challenge a friend online with a room code or
invite link, or spectate a match (up to 6 spectators). New players can start with the guided
**Tutorial** on the title screen; the full rules are in the codex (F1).

## How it plays

1. **Pick a Lord.** Marshal Aldric (infantry), Archmage Sefa (magic), Warden Hrolf (armour) or
   Skylady Ione (fliers). Each has a passive and a battle ability.
2. **Plan (2 min).** Spend gold on squads. You get at most **2 new deploys a round** and an army cap of
   16. You can also level squads (Lv1–5; item slots open at Lv1, Lv2 and Lv4) or sell them. Squads
   from earlier rounds are locked in place (they still turn); take **Muster** instead of a round's
   unit unlock to relocate up to 3. You see only the enemy army as it stood *last* round.
3. **Battle (up to 90 s).** Everything advances. The weapon triangle, terrain (forests, hills, a
   river with fords and bridges) and items decide the fight. Survivors hit the enemy Keep.
4. **Spoils of war.** Choose 1 of 3 items: Common, Magic, Rare or Legendary, with affixes and
   Diablo-style tooltips. The loser of the round rolls one rarity tier higher.
5. Each round you also unlock one new unit type, picked from 2. There are 14 in all, from militia
   and pikemen to wyverns, siege and a dragon.

Balance is checked by bot tournaments: 2,268 matches, with seat 0 winning 50.9%, every Lord at
45–55% and every unit and legendary at 40–60% (`docs/BALANCE.md`).

## Tech

- **Simulation** (`src/sim`): deterministic fixed-point code, with no floats, `Math.random` or `Date`.
  The server runs every battle and sends a compact binary replay. Clients only play it back, so
  both players see the same fight. Hidden information is filtered server-side (`viewFor`).
- **Server** (`server/index.ts`): Node 24+, which runs the TypeScript directly, plus `ws` with
  permessage-deflate. Rooms live in memory. If a player disconnects, the AI takes their seat after
  60 s.
- **Renderer** (`src/render`): three.js. Crowds are GPU-instanced with vertex-animation textures.
  It has cascaded shadows, SSAO, bloom and a colour LUT, and four quality tiers plus a battery saver.
  **It draws nothing while idle** (0 fps in planning or when the tab is hidden) and only loads the
  models for unit types in play.
- **UI** (`src/ui`): plain DOM and CSS over the canvas.
- **Art** (`tools/art`):
  1. Concept images come from ChatGPT image generation.
  2. TRELLIS.2 turns them into 3D meshes.
  3. Headless Blender cleans up the meshes, makes LODs, rigs them and bakes the animation clips.
  4. Squads get vertex-animation textures, and everything is packed with gltfpack.

  See `docs/ART.md`. The animation clips are CC0 (Quaternius).

## Credits

Sounds and music: see `docs/AUDIO.md` (Sonniss GDC bundles, Kenney, OpenGameArt and others; CC0 /
CC-BY with attribution there). Environment textures: Poly Haven (CC0), see `docs/ART.md`.
Animation clips: Quaternius Universal Animation Library (CC0).

## Develop

```bash
npm install
npm run server        # game server on :3011
npm run dev           # Vite on :5173 (proxies /ws to :3011)
npm test              # sim, server and client tests
npm run build         # typecheck + build
npm run e2e           # online flow through a real server (puppeteer-core, uses local Chrome)
npm run tournament    # bot balance tournament
```

Dev routes: `?dev=planning|loot|battle|results|match`. The renderer showcase is at
`render-test.html?real=all`.

## Hosting

The game runs as the `oathbound` container (LAN :3011) on the home server, behind the games gateway
at `/oathbound/`. `npm run deploy` ships the committed HEAD, rebuilds the image (the build runs the
tests) and checks the page and a WebSocket room through the gateway. See `docs/HOSTING.md`.
