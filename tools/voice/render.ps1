# Render the Lord voice lines with Breeze-TTS-2 inside WSL (~8 GB VRAM; not while gaming).
# One-time WSL setup (Ubuntu), as in gaming-bot-test scripts/render_barks.ps1:
#   git clone https://github.com/breezeblue-ai/breeze-tts.git ~/breeze-tts && cd ~/breeze-tts
#   curl -LsSf https://astral.sh/uv/install.sh | sh
#   ~/.local/bin/uv venv --python 3.12 .venv && ~/.local/bin/uv pip install --python .venv -r requirements.txt "huggingface_hub[cli]" librosa
#   .venv/bin/hf download BreezeBlue/Breeze-TTS-2 --local-dir ~/breeze-tts-2
# Usage:
#   powershell -File tools\voice\render.ps1 design [lord...]
#   powershell -File tools\voice\render.ps1 lines [lord...] [--only ability,keep] [--force]
#   python -I tools\voice\build.py            # then trim, normalise and encode for the game
$script = (wsl -e wslpath -a ($PSScriptRoot + "\render.py")).Trim()
wsl -e bash -lc "~/breeze-tts/.venv/bin/python '$script' $args"
