#!/usr/bin/env bash
# Run render.py until it exits cleanly (it resumes from the takes already on disk). The WSL GPU is
# shared and a CUDA "unknown error" poisons the process, so the only cure is a fresh process.
# Usage (inside WSL): bash tools/voice/render-loop.sh design|lines [lord…] [--only …]
here="$(cd "$(dirname "$0")" && pwd)"
for i in $(seq 1 12); do
  ~/breeze-tts/.venv/bin/python "$here/render.py" "$@" 2>&1 | grep -v -i -E 'warn|BackboneGraph|Loading checkpoint'
  [ "${PIPESTATUS[0]}" = 0 ] && exit 0
  echo "render.py failed (attempt $i), restarting in 15 s"; sleep 15
done
exit 1
