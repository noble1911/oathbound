"""Build the shipped Lord voice lines from the chosen Breeze takes (see tools/voice/render.py).

    python -I tools/voice/build.py            # every Lord
    python -I tools/voice/build.py warden     # just one

Reads art-work/voice/<lord>/take/<event>_<n>.wav (24 kHz mono, git-ignored) and writes
public/audio/voice/<lord>/<event>_<n>.webm: trimmed (leading/trailing silence), high-passed at 70 Hz,
faded, loudness-normalised to the dialogue target and encoded as 48 kHz mono Opus-in-WebM. It reuses
tools/audio/build.py (same loader, normaliser, limiter and encoder), so voice sits on the same scale as
the rest of the bank. Needs numpy + soundfile and ffmpeg (PATH or the imageio-ffmpeg wheel).
"""
import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
spec = importlib.util.spec_from_file_location('audio_build', os.path.join(ROOT, 'tools', 'audio', 'build.py'))
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)  # type: ignore[union-attr]

_E = 'E:/local/oathbound-art-work/voice'  # bulky intermediates (C: is tight); see render.py
WORK = os.environ.get('OATHBOUND_VOICE_WORK') or (_E if os.path.isdir(_E) else os.path.join(ROOT, 'art-work', 'voice'))
# Dialogue target (short-term dBFS, the same measure as T_UI -20 / T_SFX -15 / T_BIG -11 in
# tools/audio/build.py). Voice sits just under the SFX target; the runtime 'voice' bus and the
# music / SFX ducking (src/audio/voice.ts) make it read clearly over a battle.
T_VOICE = -16
KBPS = 40  # mono Opus; speech is transparent here and keeps the set well under budget


def main(only: list) -> None:
    man = json.load(open(os.path.join(HERE, 'manifest.json'), encoding='utf-8'))
    missing = []
    for lid, L in man['lords'].items():
        if only and lid not in only:
            continue
        for ev, texts in L['lines'].items():
            for i, _ in enumerate(texts):
                key = f'{ev}_{i + 1}'
                src = os.path.join(WORK, lid, 'take', f'{key}.wav')
                if not os.path.exists(src):
                    missing.append(f'{lid}/{key}')
                    continue
                x = ab.mono(ab.load(src))  # absolute path: load() resamples to 48 kHz stereo
                if L.get('varispeed'):  # optional per-Lord varispeed: pitch and tempo together (<1 = lower and slower)
                    x = ab.resample_rate(x, L['varispeed'])
                x = ab.trim_silence(x, -42, 0.09)
                if L.get('echo'):  # the Lich: a faint stone-crypt echo (short dark hall, low in the mix)
                    x = ab.reverb_tail(x, 0.7, -18, 2600)
                x = ab.highpass(x, 70)
                x = ab.fade(x, 0.006, 0.07)
                ab.write(f'voice/{lid}/{key}', ab.norm(x, T_VOICE), kbps=KBPS)
                # decode the shipped file back for `render.py verify` (ASR on exactly what players hear)
                chk = os.path.join(WORK, 'shipped', lid)
                os.makedirs(chk, exist_ok=True)
                subprocess.run([ab.FF, '-v', 'error', '-y', '-i', os.path.join(ab.OUT, 'voice', lid, f'{key}.webm'), '-ac', '1', '-ar', '24000', os.path.join(chk, f'{key}.wav')], check=True)
    tot = 0
    for n, b, d in ab.BUILT:
        tot += b
        print(f'{n:32s} {d:5.2f}s {b / 1024:6.1f} KB')
    print(f'built {len(ab.BUILT)} voice lines, {tot / 1e6:.3f} MB')
    if missing:
        print('MISSING takes (render them first):', ', '.join(missing))
        sys.exit(1)


if __name__ == '__main__':
    main(sys.argv[1:])
