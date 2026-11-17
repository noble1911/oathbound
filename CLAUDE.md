# Oathbound: notes for Claude

A 1v1 fantasy army auto-battler (Mechabellum-like rounds, Fire Emblem flavour). It runs in the
browser with three.js, and a Node server referees every match. The design spec is `DESIGN.md`. The
asset contract is `docs/ART.md`, balance is `docs/BALANCE.md`, and hosting is `docs/HOSTING.md`.

## Layout

- `src/sim/`: the deterministic simulation, shared by the server and the client. Rules:
  - integer/fixed-point maths only;
  - no `Math.random`, `Date`, trig or `sqrt` (use `fixed.ts`), and the PRNG is mulberry32;
  - positions are in cm on an 8000×12000 field, and facing runs 0..255.

  `tests/sim.mirror.test.ts` checks seat symmetry. Any balance change must be rechecked with
  `npm run tournament`.
- `src/net/`: the protocol (`protocol.ts`) and the client.
- `server/index.ts`: rooms, timers, the AI seat and replays. Use `room.phase`, not `view.phase`.
- `src/render/`: the `BattleView` engine. Its API is at the top of `src/render/index.ts`.
- `src/ui/`: screens. `engine-scene.ts` adapts the UI to the renderer, and `?scene=standin` is the
  fallback renderer.
- `public/models/v2/`: generated art and `manifest.json` (keys `models` and `props`). Don't
  hand-edit these. Regenerate them with `npm run art -- <ids>`. Large intermediates go to
  `art-work/`, which is git-ignored.

## Conventions

- Node 24+ runs the TypeScript directly, which is only possible with erasable syntax:
  - no enums or parameter properties;
  - imports use `.ts` extensions.
- **Power is a hard requirement.** Render on demand (0 fps when idle or when the tab is hidden).
  Keep the low and medium tiers cheap, and re-run `node e2e/render-power.mjs` after renderer changes.
  The battle behind the title menu (`src/ui/title-battle.ts`) has its own fixed budget and rest states; the `title`
  case of `render-power.mjs` enforces them.
- Storage keys must be prefixed `oathbound.`, because the origin is shared with other games.
- Asset and socket URLs must stay relative, because the game is served under `/oathbound/`.
- `npm test` and `npm run build` must pass, because the Docker build runs both.
- Deploy with `npm run deploy`, which uses the `homeserver` ssh alias and ships the committed HEAD.
