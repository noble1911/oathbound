#!/usr/bin/env bash
# Run render.py until it exits cleanly (it resumes from the takes already on disk). The WSL GPU is
# shared and a CUDA "unknown error" poisons the process, so the only cure is a fresh process.
# One Breeze process at a time, and never while another job holds the GPU lock (art-work/fx_gpu.lock,
# written by the TRELLIS art queue). Usage (inside WSL): bash tools/voice/render-loop.sh design|lines [lord…] [--only …]
here="$(cd "$(dirname "$0")" && pwd)"
lock="$here/../../art-work/fx_gpu.lock"
for i in $(seq 1 12); do
  while [ -e "$lock" ]; do sleep 20; done
  ~/breeze-tts/.venv/bin/python "$here/render.py" "$@" > /dev/null 2>&1  # render.py logs to <work>/render.log
  [ "$?" = 0 ] && exit 0
  echo "render.py failed (attempt $i), restarting in 15 s"; sleep 15
done
exit 1
