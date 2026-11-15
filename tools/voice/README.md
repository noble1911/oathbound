# Lord voices (tools/voice)

The six Lords' voice lines are rendered offline with Breeze-TTS-2 and shipped as
`public/audio/voice/<lord>/<event>_<n>.webm`. Licence and in-game use: `docs/AUDIO.md` (Voices).

## Files

| File | What |
| --- | --- |
| `manifest.json` | Each Lord's voice description, reference sentence, pitch range, pinned seed and lines; the per-event delivery directions |
| `render.py` | WSL: designs the voices, renders and auto-checks every line (Breeze + Whisper) |
| `render-loop.sh` | WSL: reruns `render.py` until it finishes (it resumes; the shared GPU sometimes faults) |
| `render.ps1` | Windows wrapper for `render.py` |
| `build.py` | Windows: trims, normalises and encodes the chosen takes for the game |

Working files go to `E:\local\oathbound-art-work\voice` (C: is tight; override with
`OATHBOUND_VOICE_WORK`, falling back to the git-ignored `art-work/voice/`): `<lord>/reference.wav` (the designed voice),
`design/seed<N>.wav` and `design.json` (the audition), `raw/` (the chosen takes; rejected ones are
deleted once scored), `take/` (the chosen take per line), `report.json` (every take's ASR and
measurements), `render.log`, and `shipped/` + `verify.json` (the built clips decoded and re-checked).

## Steps

```
# WSL (Ubuntu), Breeze in ~/breeze-tts with weights in ~/breeze-tts-2 (setup in render.ps1)
bash tools/voice/render-loop.sh design            # audition voices: 6 seeds per Lord, best kept
bash tools/voice/render-loop.sh lines             # every line: 3 takes, best kept, failures re-rendered
bash tools/voice/render-loop.sh lines warden --only ability --force   # redo some lines
# Windows
python -I tools/voice/build.py                    # -> public/audio/voice/**.webm (+ <work>/shipped/*.wav)
# WSL again
~/breeze-tts/.venv/bin/python tools/voice/render.py verify   # ASR on the shipped clips
npx vitest run tests/voice.test.ts                # every line shipped, under 2.3 MB
```

A changed line text is re-rendered automatically (the report remembers the text of each take).

## How a voice is made

1. **Design.** Breeze's voice design turns the Lord's text `voice` description into a voice speaking
   the `reference_text` (one sentence in character, ~6 s). No reference audio is involved. Each
   audition seed is scored, since nobody listens to the takes here:
   - Whisper (`openai/whisper-small.en`, on CPU) word error rate against the script;
   - median pitch (librosa pYIN) against the Lord's `f0` range: a deep bass for Hrolf, a bright
     soprano for Ione;
   - speaking rate against `rate` (Hrolf slow, Ione fast);
   - clipping, and a duration that fits the words.

   The best seed becomes `reference.wav`. Its seed is pinned in the manifest (`seed`), so a rerun
   designs the same voice without auditioning again.
2. **Lines.** Every line is cloned from that reference with voice direction: the event's delivery
   (`events`, e.g. "Shouting a battle cry over the noise of an army", or the Lord's own `delivery`
   override: Sefa never shouts) plus the Lord's `style`. So all
   of a Lord's lines are one person, delivered differently. Each line gets 3 seeds, each scored as
   above, and its pitch must also stay within ~0.35 octave of the reference (a drifting clone sounds
   like another speaker). The best passing take is kept. A line with no passing take gets up to 6
   more seeds.
3. **Build.** `build.py` reuses `tools/audio/build.py`: it trims leading and trailing silence, applies a
   70 Hz high-pass and short fades, normalises to the dialogue target `T_VOICE` = −16 dB short-term
   (the bank's scale: UI −20, SFX −15, big −11) with the same no-squash limiter, then encodes 48 kHz
   mono Opus at 40 kbps. An optional per-Lord `varispeed` (e.g. 0.95) lowers pitch and tempo together; none is set now. `echo`
   (the Lich) adds a short, dark, low-level hall tail before normalising.

## Writing lines

Lines are short (1–4 s), punchy, original and in character, with no real-world references. Inline
vocal events such as `(laugh)` work in Breeze; the ASR check ignores them. Avoid words Whisper can't
check, or the line will look like a failure: "Aye" transcribes as "I", so Hrolf's "Aye. Here." became
"Here. We hold.", and "Bah. Mend the shields." (heard as "Bow, man the shields") became "Mend the
shields. Again.". The Lords' own names ("Ione", "Sefa", "Aldric") come back misspelt ("Irony", "Safer",
"Aldrich"); those name-only misses are accepted by hand. Avoid a generic trailer
voice: each description names an age, a timbre, an accent and a manner.

## Rules

- Only voices designed from text descriptions. Never clone a real person's voice or use reference
  audio we do not own.
- The outputs fall under the BreezeBlue Research and Non-Commercial License: Oathbound must not be
  monetised with them (see `docs/AUDIO.md`).
- GPU: Breeze needs ~8 GB of VRAM and ~5 s per take on the RTX 4080 SUPER. The GPU is shared with
  other jobs, so `render.py` loads the weights straight to the GPU (the stock loader stages the
  whole model in WSL RAM, which a 12 GB VM cap can't fit), retries a failed load, and
  `render-loop.sh` restarts after a CUDA fault.
