"""Render the Lord voice lines (tools/voice/manifest.json) with Breeze-TTS-2. Runs inside WSL (Breeze is Linux-only).

    ~/breeze-tts/.venv/bin/python tools/voice/render.py design  [lord…]   # audition reference voices
    ~/breeze-tts/.venv/bin/python tools/voice/render.py lines   [lord…]   # render every line, best take kept
    ~/breeze-tts/.venv/bin/python tools/voice/render.py lines marshal --only ability,keep --force

(tools/voice/render.ps1 wraps this from Windows.)

How it works (after gaming-bot-test's scripts/render_barks.py):
1. design: the Lord's text description designs a voice (no reference audio) speaking the manifest's
   `reference_text`, once per audition seed. Each take is scored objectively, since nobody listens here:
   Whisper ASR word error rate against the script, median pitch against the Lord's `f0` range, speaking
   rate against `rate`, clipping and duration. The best seed is copied to art-work/voice/<lord>/reference.wav.
   Put that seed in the manifest's `seed` to pin it (a pinned seed skips the audition).
2. lines: every line is cloned from that reference with a per-event delivery direction (manifest `events`
   plus the Lord's `style`), so all lines sound like one person. Each line gets `--takes` seeds; each take is
   scored the same way (pitch must also stay near the reference's); the best is kept as
   art-work/voice/<lord>/take/<event>_<n>.wav. A line whose best take still fails gets more seeds.
   The report (art-work/voice/<lord>/report.json) lists every take and its scores.

Everything here is git-ignored output under art-work/voice/. tools/voice/build.py then trims, normalises and
encodes the takes for the game. ~5 s per take and ~8 GB VRAM for Breeze, ~1 GB for Whisper.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
import os
from pathlib import Path

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "tools" / "voice" / "manifest.json"
# Bulky intermediates live on E: when it is there (C: is tight); else the git-ignored art-work/voice/.
_E = Path("/mnt/e/local/oathbound-art-work/voice")
WORK = Path(os.environ.get("OATHBOUND_VOICE_WORK") or (_E if _E.parent.exists() else ROOT / "art-work" / "voice"))
BREEZE_SRC = Path("~/breeze-tts").expanduser()
BREEZE_MODEL = Path("~/breeze-tts-2").expanduser()
ASR_MODELS = ["openai/whisper-small.en", "openai/whisper-base.en"]

DESIGN_SEEDS = [11, 23, 37, 41, 53, 67]
WER_OK = 0.25  # a take passes when its ASR matches this well (and pitch / duration are sane)


# ---------------------------------------------------------------- text


NUM = {"one": "1", "two": "2", "three": "3"}


def words(s: str) -> list[str]:
    s = re.sub(r"\([^)]*\)", " ", s)  # vocal events like (laugh)
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    out = []
    for w in s.split():
        w = w.strip("'")
        w = {"ok": "okay", "honor": "honour", "armour": "armor"}.get(w, w)
        out.append(NUM.get(w, w))
    return [w for w in out if w and w not in ("hm", "hmm", "mm", "uh", "um", "ah", "oh", "ha", "huh")]


def wer(ref: str, hyp: str) -> float:
    r, h = words(ref), words(hyp)
    if not r:
        return 0.0
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return d[len(h)] / len(r)


# ---------------------------------------------------------------- engines


class Breeze:
    """Breeze-TTS-2 loaded once (same setup as gaming-bot-test voice/breeze.py)."""

    def __init__(self) -> None:
        sys.path.insert(0, str(BREEZE_SRC))
        import torch
        from transformers import AutoTokenizer
        from breeze_infer.runtime import BreezeForConditionalGeneration, resolve_device, update_generation_config_for_breeze
        from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig
        from qwen_tts import Qwen3TTSTokenizer

        # Like breeze_infer.runtime.load_runtime, but the weights go straight to the GPU (device_map):
        # its load-to-CPU-then-.to(cuda) needs ~2x the model in WSL RAM and fails under a 12 GB VM cap.
        dev = resolve_device()
        torch.cuda.set_device(dev)
        self.tokenizer = AutoTokenizer.from_pretrained(BREEZE_MODEL, fix_mistral_regex=False)
        self.model = BreezeForConditionalGeneration.from_pretrained(BREEZE_MODEL, dtype=torch.bfloat16, attn_implementation="eager", device_map=dev).eval()
        self.audio_tokenizer = Qwen3TTSTokenizer.from_pretrained(str(BREEZE_MODEL / "audio_tokenizer"), device_map=dev)
        update_generation_config_for_breeze(self.model)
        cfg = FastStreamingConfig(max_new_tokens=900, max_seq_len=2048, repetition_penalty=1.1, fast_all=False)
        self.runtime = FastBreezeStreamingRuntime(self.model, self.audio_tokenizer, cfg, tokenizer=self.tokenizer)
        self.sr = self.runtime.sample_rate

    def render(self, out: Path, text: str, *, instruction: str | None, reference: Path | None = None, ref_text: str | None = None, cfg: float = 4.0, seed: int = 42) -> np.ndarray:
        import soundfile as sf
        from breeze_infer.runtime import set_all_seeds
        from breeze_infer.templates import get_template, prepare_inputs, select_template_name

        req = {"id": out.stem, "speaker": "S0", "text": text}
        if instruction:
            req["instruction"] = instruction
        if reference:
            req["ref_audio_path"] = str(reference)
            req["ref_text"] = ref_text
        set_all_seeds(seed)
        inputs = prepare_inputs(self.tokenizer, self.audio_tokenizer, self.model, [req], get_template(select_template_name(req)), guidance_scale=cfg, guidance_scale_ref=None, guidance_scale_ins=None)
        chunks = [c.audio for c in self.runtime.iter_audio_chunks(inputs, request_id=out.stem, seed=seed)]
        x = np.concatenate(chunks).astype(np.float32) if chunks else np.zeros(1, np.float32)
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(out, x, self.sr, subtype="PCM_16")
        return x


class Asr:
    def __init__(self) -> None:
        import torch
        from transformers import pipeline

        torch.set_num_threads(6)

        last = None
        for m in ASR_MODELS:
            try:
                # CPU: short clips decode in ~1 s, and the GPU stays free for Breeze (shared with other jobs)
                self.pipe = pipeline("automatic-speech-recognition", model=m, device=-1, dtype=torch.float32)
                self.name = m
                return
            except Exception as e:  # noqa: BLE001 (offline: fall back to the cached model)
                last = e
        raise RuntimeError(f"no ASR model: {last}")

    def __call__(self, x: np.ndarray, sr: int) -> str:
        import librosa

        y = librosa.resample(x, orig_sr=sr, target_sr=16000) if sr != 16000 else x
        return self.pipe({"raw": y, "sampling_rate": 16000})["text"].strip()


# ---------------------------------------------------------------- measures


def trimmed(x: np.ndarray, sr: int, db: float = -40) -> np.ndarray:
    n = max(1, int(0.02 * sr))
    if len(x) < n:
        return x
    frames = np.sqrt(np.convolve(x.astype(np.float64) ** 2, np.ones(n) / n, mode="same"))
    thr = frames.max() * 10 ** (db / 20)
    idx = np.nonzero(frames > thr)[0]
    return x[idx[0]: idx[-1] + 1] if len(idx) else x


def measure(x: np.ndarray, sr: int) -> dict:
    import librosa

    t = trimmed(x, sr)
    dur = len(t) / sr
    f0 = 0.0
    voiced = 0.0
    if dur > 0.2:
        y = librosa.resample(t, orig_sr=sr, target_sr=16000) if sr != 16000 else t  # pYIN is slow; 16 kHz is plenty
        f, vflag, _ = librosa.pyin(y, fmin=50, fmax=500, sr=16000, frame_length=1024, hop_length=320)
        v = f[vflag & ~np.isnan(f)]
        f0 = float(np.median(v)) if len(v) else 0.0
        voiced = float(len(v) / max(1, len(f)))
    pk = float(np.abs(x).max()) if len(x) else 0.0
    return {"dur": round(dur, 2), "f0": round(f0, 1), "voiced": round(voiced, 2), "peak_db": round(20 * np.log10(pk + 1e-9), 1), "clip": int(np.sum(np.abs(x) > 0.985))}


def octave_off(f0: float, lo: float, hi: float) -> float:
    if f0 <= 0:
        return 2.0
    if f0 < lo:
        return float(np.log2(lo / f0))
    if f0 > hi:
        return float(np.log2(f0 / hi))
    return 0.0


def score(text: str, hyp: str, m: dict, *, f0_range: tuple, rate: float | None, ref_f0: float | None) -> tuple[float, list[str]]:
    """Lower is better. Returns (score, failure reasons)."""
    w = wer(text, hyp)
    n = max(1, len(words(text)))
    fails = []
    s = 3.0 * w
    if w > WER_OK:
        fails.append(f"wer {w:.2f}")
    off = octave_off(m["f0"], *f0_range)
    s += 4.0 * off
    if off > 0.15:
        fails.append(f"f0 {m['f0']} outside {f0_range}")
    if ref_f0:
        drift = abs(np.log2(max(m["f0"], 1) / ref_f0))
        s += 2.0 * max(0.0, drift - 0.1)
        if drift > 0.35:
            fails.append(f"f0 {m['f0']} drifts from reference {ref_f0:.0f}")
    # duration: clips are 1-4 s; a line much longer than its words suggests babble or a stuck tail
    max_dur = 1.2 + n * 0.75 + (1.0 if "(" in text else 0)
    if m["dur"] > max_dur or m["dur"] < 0.25:
        fails.append(f"dur {m['dur']}s")
        s += 2.0
    if rate:
        r = n / max(0.3, m["dur"])
        s += 0.5 * abs(np.log2(r / rate))
    if m["clip"] > 20:
        fails.append(f"clipping {m['clip']}")
        s += 1.0
    return round(float(s), 3), fails


# ---------------------------------------------------------------- jobs


def lord_dir(lid: str) -> Path:
    return WORK / lid


def design(tts: Breeze, asr: Asr, man: dict, lid: str, force: bool) -> None:
    L = man["lords"][lid]
    d = lord_dir(lid)
    ref = d / "reference.wav"
    seeds = [L["seed"]] if L.get("seed") is not None else DESIGN_SEEDS
    rows = []
    for seed in seeds:
        out = d / "design" / f"seed{seed}.wav"
        t0 = time.perf_counter()
        if out.exists() and not force:
            import soundfile as sf

            x, _ = sf.read(out, dtype="float32")
        else:
            x = tts.render(out, L["reference_text"], instruction=L["voice"], cfg=man["cfg_scale"], seed=seed)
        hyp = asr(x, tts.sr)
        m = measure(x, tts.sr)
        s, fails = score(L["reference_text"], hyp, m, f0_range=tuple(L["f0"]), rate=L.get("rate"), ref_f0=None)
        rows.append({"seed": seed, "score": s, "fails": fails, "asr": hyp, "wer": round(wer(L["reference_text"], hyp), 3), **m})
        print(f"{time.perf_counter() - t0:5.1f}s {lid} design seed {seed}: score {s} {m} {fails} | {hyp}", flush=True)
    rows.sort(key=lambda r: r["score"])
    best = rows[0]
    shutil.copyfile(d / "design" / f"seed{best['seed']}.wav", ref)
    (d / "design.json").write_text(json.dumps({"chosen": best["seed"], "takes": rows}, indent=2))
    print(f"== {lid}: reference voice = seed {best['seed']} (score {best['score']}, f0 {best['f0']} Hz)", flush=True)


def lines(tts: Breeze, asr: Asr, man: dict, lid: str, takes: int, only: set | None, force: bool) -> None:
    import soundfile as sf

    L = man["lords"][lid]
    d = lord_dir(lid)
    ref = d / "reference.wav"
    if not ref.exists():
        raise SystemExit(f"{lid}: no reference voice yet, run `render.py design {lid}` first")
    rx, rsr = sf.read(ref, dtype="float32")
    ref_f0 = measure(rx, rsr)["f0"]
    rep_path = d / "report.json"
    report = json.loads(rep_path.read_text()) if rep_path.exists() else {}
    base = 100 + (L.get("seed") or 0)
    for ev, texts in L["lines"].items():
        if only and ev not in only:
            continue
        # a Lord may override an event's delivery (Sefa never shouts her battle cry)
        instruction = f"{L.get('delivery', {}).get(ev) or man['events'][ev]} {L['style']}"
        for i, text in enumerate(texts):
            key = f"{ev}_{i + 1}"
            final = d / "take" / f"{key}.wav"
            prev = report.get(key)
            if final.exists() and not force and prev and prev.get("text") == text:
                continue
            rows = []
            seeds = [base + 7 * k + 31 * i for k in range(takes)]
            extra = [base + 1000 + 13 * k + 31 * i for k in range(takes * 2)]
            while seeds:
                seed = seeds.pop(0)
                out = d / "raw" / f"{key}.s{seed}.wav"
                t0 = time.perf_counter()
                x = tts.render(out, text, instruction=instruction, reference=ref, ref_text=L["reference_text"], cfg=man["cfg_scale"], seed=seed)
                hyp = asr(x, tts.sr)
                m = measure(x, tts.sr)
                s, fails = score(text, hyp, m, f0_range=tuple(L["f0"]), rate=None, ref_f0=ref_f0)
                rows.append({"seed": seed, "score": s, "fails": fails, "asr": hyp, "wer": round(wer(text, hyp), 3), **m})
                print(f"{time.perf_counter() - t0:5.1f}s {lid}/{key} s{seed}: {s} {fails} | {hyp}", flush=True)
                if not seeds and not any(not r["fails"] for r in rows) and extra:
                    seeds.append(extra.pop(0))  # re-render failures with fresh seeds
            rows.sort(key=lambda r: (bool(r["fails"]), r["score"]))
            best = rows[0]
            final.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(d / "raw" / f"{key}.s{best['seed']}.wav", final)
            report[key] = {"text": text, "chosen": best["seed"], "ok": not best["fails"], "best": best, "takes": rows}
            for r in rows[1:]:  # rejected takes: only their scores are kept (report.json)
                (d / "raw" / f"{key}.s{r['seed']}.wav").unlink(missing_ok=True)
            rep_path.write_text(json.dumps(report, indent=2))
    bad = [k for k, r in report.items() if not r["ok"]]
    print(f"== {lid}: {len(report)} lines, {len(bad)} still failing {bad}", flush=True)


def verify(asr: Asr, man: dict, lids: list) -> None:
    import soundfile as sf

    out, bad = {}, []
    for lid in lids:
        L = man["lords"][lid]
        for ev, texts in L["lines"].items():
            for i, text in enumerate(texts):
                key = f"{ev}_{i + 1}"
                f = WORK / "shipped" / lid / f"{key}.wav"
                if not f.exists():
                    bad.append(f"{lid}/{key} missing")
                    continue
                x, sr = sf.read(f, dtype="float32")
                hyp = asr(x, sr)
                m = measure(x, sr)
                w = wer(text, hyp)
                out[f"{lid}/{key}"] = {"text": text, "asr": hyp, "wer": round(w, 3), **m}
                flag = "" if w <= WER_OK else "  <-- CHECK"
                if flag:
                    bad.append(f"{lid}/{key}")
                print(f"{lid}/{key:12s} {m['dur']:4.2f}s f0 {m['f0']:5.1f} wer {w:.2f} | {hyp}{flag}", flush=True)
    (WORK / "verify.json").write_text(json.dumps(out, indent=2))
    print(f"== verify: {len(out)} clips, {len(bad)} flagged {bad}", flush=True)


def load_breeze() -> Breeze:
    """The WSL GPU is shared (other jobs, the desktop); a big allocation can fail transiently. Retry."""
    import torch

    for k in range(6):
        try:
            return Breeze()
        except (torch.OutOfMemoryError, RuntimeError) as e:
            print(f"Breeze load failed ({type(e).__name__}), retry {k + 1}/6 in 20 s", flush=True)
            torch.cuda.empty_cache()
            time.sleep(20)
    raise SystemExit("could not load Breeze onto the GPU")


class _Tee:
    """Mirror stdout/stderr into art-work/voice/render.log (fsynced), so a crash of the WSL VM keeps the log."""

    def __init__(self, stream, f):
        self.stream, self.f = stream, f

    def write(self, s):
        self.stream.write(s)
        self.f.write(s)
        if "\n" in s:
            self.f.flush()
            os.fsync(self.f.fileno())
        return len(s)

    def flush(self):
        self.stream.flush()
        self.f.flush()


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    log = open(WORK / "render.log", "a", encoding="utf-8")
    sys.stdout, sys.stderr = _Tee(sys.stdout, log), _Tee(sys.stderr, log)
    print(f"---- {time.strftime('%H:%M:%S')} render.py {' '.join(sys.argv[1:])}", flush=True)
    ap = argparse.ArgumentParser()
    ap.add_argument("job", choices=["design", "lines", "asr", "verify"])
    ap.add_argument("lords", nargs="*")
    ap.add_argument("--takes", type=int, default=3)
    ap.add_argument("--only", help="comma-separated events (lines job)")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    lids = a.lords or list(man["lords"])
    tts = load_breeze() if a.job in ("design", "lines") else None  # Breeze first: it needs the big contiguous allocation
    asr = Asr()
    print(f"ASR: {asr.name}", flush=True)
    if a.job == "verify":  # ASR + measures on the shipped clips (build.py decodes them to <work>/shipped)
        verify(asr, man, lids)
        return
    if a.job == "asr":  # re-check the chosen takes only (no Breeze)
        import soundfile as sf

        for lid in lids:
            for f in sorted((lord_dir(lid) / "take").glob("*.wav")):
                x, sr = sf.read(f, dtype="float32")
                print(f"{lid}/{f.stem}: {asr(x, sr)}")
        return
    for lid in lids:
        if a.job == "design":
            design(tts, asr, man, lid, a.force)
        else:
            lines(tts, asr, man, lid, a.takes, set(a.only.split(",")) if a.only else None, a.force)


if __name__ == "__main__":
    main()
