# Hosting Oathbound (home server, Mac Mini 192.168.1.117)

Target: **https://games.noblehaus.uk/oathbound/**, one of the games on the games site. On the LAN
it is http://192.168.1.117:3011/ (the container) or http://192.168.1.117:3010/oathbound/ (through
the gateway).

- **Container** `oathbound` on the external `homeserver` Docker network, `restart: unless-stopped`,
  `/healthz` healthcheck. LAN port **3011** (container 3000). Docker on the box is
  `/usr/local/bin/docker` (not on the SSH PATH).
- The image build runs `npm run build` (typecheck + vite build) and `npx vitest run`.
- The source on the box is `~/oathbound`, a plain copy of a commit (no git); `.deployed-commit`
  records which.
- Rooms live in memory, so a deploy ends matches in progress.
- The image ships `server/`, `src/sim/` (the server runs the same deterministic sim), `src/net/protocol.ts`
  and the built `dist/`; Node runs the TypeScript directly.
- The page and the socket are relative (`vite base: './'`, `new URL('ws', location.href)`), so the
  gateway can strip the `/oathbound` prefix.
- Browser storage is shared by every game on the origin: Oathbound only uses the
  `oathbound.v2.seat` sessionStorage key.
- Server limits (env-overridable): `MAX_ROOMS` 300, `MAX_SOCKETS_PER_IP` 40 (address from
  `cf-connecting-ip` / `x-forwarded-for`), 40-message burst / 20 a second per socket, 8 KB max
  message. A seat opened in another tab closes the old socket with code 4000.
- Rooms (v2): 2 player seats (`pvp`, or `vsAI` with the bot in seat 1) plus up to 6 spectators.
  Every snapshot is filtered per socket with the sim's `viewFor` (hidden information is enforced
  server-side).
- Phase timers (ms, env-overridable): `LORD_PICK_MS` 30000, `PLANNING_MS` 120000, `LOOT_BONUS_MS`
  15000 (added when a loot pick is pending), `BATTLE_SLACK_MS` 10000 (battle = replay length + this,
  or earlier when both players sent `battleDone`), `BATTLE_CAP_MS` (no default; a hard cap, for tests),
  `RESULTS_MS` 6000, `DISCONNECT_GRACE_MS` 60000 (then the AI plays the seat until the player rejoins).
- **WebSocket compression:** the server enables `permessage-deflate` (replays are a few hundred KB).
  Browsers offer it on their own; Caddy's `reverse_proxy` passes the upgrade headers through untouched,
  and Cloudflare supports it. The deploy script prints the negotiated extensions through the gateway;
  if it says `none`, something in front is stripping `Sec-WebSocket-Extensions` (it still works,
  just uncompressed).

## Changes to make in the home-server repo (not done from here)

### 1. `games/Caddyfile`: add next to the other games with a server

```caddyfile
	redir /oathbound /oathbound/ 308
	handle_path /oathbound/* {
		reverse_proxy oathbound:3000
	}
```

### 2. `games/site/games.json`: append an entry (mind the comma after the previous one)

```json
  {
    "id": "oathbound",
    "name": "Oathbound",
    "path": "oathbound/",
    "tagline": "Raise an army, gear it with loot, and watch it clash with your rival's. Break their Keep to win.",
    "players": "1v1 online or vs AI, spectators welcome",
    "image": "img/oathbound.jpg",
    "repo": "https://github.com/noble1911/oathbound"
  }
```

Add a 640x400 `games/site/img/oathbound.jpg` (a 1280x800 screenshot of the opening screen at half
size; without one the card shows an initial on a gradient). Drop the `repo` line if there is no
public repo.

### 3. `registry/services.yaml`: add under the games section

```yaml
  - { name: oathbound, project: oathbound, container: oathbound, host_port: 3011 }  # Oathbound 1v1 army auto-battler (Node, /ws) — games.noblehaus.uk/oathbound/
```

Also add the game to `registry/REGISTRY.md` (Projects) and a row to the table at the top of
`docs/17-games.md`:

```
| Oathbound | `/oathbound/` | container `oathbound` (LAN `:3011`) | `~/oathbound` ← laptop `npm run deploy` |
```

and `Updating a game`: "From the laptop, a committed version: `npm run deploy` in the repo
(`scripts/deploy.sh`)."

## Apply

1. Commit the home-server changes and get them onto the box (however that repo is normally synced),
   then on the server: `cd ~/home-server && ./scripts/17-games.sh` (copies the hub files, reloads
   the gateway; it prints which games answer). Or just the reload:
   `docker exec games-gateway caddy reload --config /etc/caddy/Caddyfile`.
2. From the laptop, in this repo, with the work committed: `npm run deploy`. It exports `HEAD` to
   `192.168.1.117:oathbound/`, runs `docker compose up -d --build` there, waits for the container
   to be healthy, then checks `/oathbound/` and a room (`create` then `welcome`, plus the negotiated
   socket extensions) through the gateway (via an SSH forward to port 3010).
3. Run `registry/doctor.sh` in home-server.
4. Open https://games.noblehaus.uk/. The Oathbound card should say *Online*.

The first deploy can happen before step 1, but the gateway route (and so the deploy script's
gateway check) only works once the Caddyfile change is live. The container itself is reachable at
http://192.168.1.117:3011/ either way.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Blank page; 404s for `/assets/...` | Absolute asset URL somewhere | Keep `base: './'` and relative URLs; test with `npm run preview:path` |
| Battles take long to start on slow links | `permessage-deflate` not negotiated | Check the deploy script's `extensions:` line; make sure nothing in front strips `Sec-WebSocket-Extensions` |
| Game loads but online never connects | Socket URL built from `location.host` | Use `socketURL()` from `src/net/client.ts` |
| Card says *Resting* | Container down, or wrong name/port in the Caddyfile | `docker ps -a`, `docker logs oathbound`; the port is the one inside the container (3000) |
| `/oathbound` works but not with a slash, or vice versa | Missing `redir` line | Add `redir /oathbound /oathbound/ 308` |
| Caddyfile change has no effect | Not reloaded | `docker exec games-gateway caddy reload --config /etc/caddy/Caddyfile` |
