#!/usr/bin/env bash
# Deploy the committed HEAD to https://games.noblehaus.uk/oathbound/.
#
# The game runs as a container (`oathbound`, LAN :3011) on the home server (192.168.1.117): a
# small Node server that serves the built game and runs online rooms. The games-gateway Caddy
# container reverse-proxies /oathbound/* to it (prefix stripped, WebSockets included). This
# exports HEAD (never the working tree) to ~/oathbound on the box, builds the image there (the
# build runs the tests), waits for the container to be healthy, then checks the page and an
# online room through the gateway (and that permessage-deflate survives it). See docs/HOSTING.md.
set -euo pipefail

HOST=${DEPLOY_HOST:-homeserver}   # ssh alias (~/.ssh/config: 192.168.1.117, user ron)
DEST=oathbound
DOCKER='PATH=/usr/local/bin:$PATH docker'
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes are NOT deployed (deploying $(git rev-parse --short HEAD))"
fi
COMMIT=$(git rev-parse HEAD)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git archive HEAD | tar -x -C "$TMP"
echo "$COMMIT" > "$TMP/.deployed-commit"
ssh "$HOST" "mkdir -p ~/$DEST"
if command -v rsync >/dev/null; then
  rsync -az --delete "$TMP/" "$HOST:$DEST/"
else
  # Windows Git Bash has no rsync: stream a tarball and swap the directory (same effect as --delete)
  tar -C "$TMP" -czf - . | ssh "$HOST" "rm -rf ~/$DEST.new && mkdir -p ~/$DEST.new && tar -xzf - -C ~/$DEST.new && rm -rf ~/$DEST && mv ~/$DEST.new ~/$DEST"
fi
echo "copied $(git rev-parse --short HEAD) to $HOST:~/$DEST; building…"
ssh "$HOST" "cd ~/$DEST && $DOCKER compose up -d --build 2>&1 | tail -3"

state=''
for _ in $(seq 1 60); do
  state=$(ssh "$HOST" "$DOCKER inspect -f '{{.State.Health.Status}}' oathbound" 2>/dev/null || true)
  [ "$state" = healthy ] && break
  sleep 2
done
echo "container: ${state:-unknown}"
[ "$state" = healthy ]

# the gateway listens on the box's LAN port 3010: check through an SSH forward
ssh -o ExitOnForwardFailure=yes -N -L 13010:localhost:3010 "$HOST" &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:13010/oathbound/ || true)
echo "gateway /oathbound/ -> HTTP $code"
node -e '
  const WebSocket = require("ws");
  const ws = new WebSocket("ws://localhost:13010/oathbound/ws");
  const fail = setTimeout(() => { console.log("gateway socket: no answer"); process.exit(1); }, 5000);
  ws.on("open", () => ws.send(JSON.stringify({ t: "create", name: "deploy-check", mode: "pvp" })));
  ws.on("message", (d) => { const m = JSON.parse(d); if (m.t === "welcome") { console.log("gateway socket: ok (room " + m.code + ", extensions: " + (ws.extensions || "none") + ")"); clearTimeout(fail); ws.send(JSON.stringify({ t: "leave" })); setTimeout(() => process.exit(0), 100); } });
  ws.on("error", (e) => { console.log("gateway socket: " + e.message); process.exit(1); });
' && sock=ok || sock=fail
[ "$code" = 200 ] && [ "$sock" = ok ]
