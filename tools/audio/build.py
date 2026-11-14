"""Build the shipped game audio (public/audio/) from the recorded sources in art-work/audio-src/.

Sources (licences and URLs in docs/AUDIO.md) are downloaded by hand into art-work/audio-src/, which
is git-ignored. This script trims, slices multi-take recordings into single hits, layers, makes
loops seamless (equal-power crossfade of the tail into the head), loudness-normalises every clip
to a per-category target, then encodes Opus-in-WebM (48 kHz) with ffmpeg.

    python -I tools/audio/build.py            # everything
    python -I tools/audio/build.py clash horn # only ids that start with these prefixes

Needs numpy + soundfile, and ffmpeg (PATH, or the imageio-ffmpeg wheel).
"""
import io
import os
import shutil
import subprocess
import sys

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'art-work', 'audio-src')
OUT = os.path.join(ROOT, 'public', 'audio')
TMP = os.path.join(ROOT, 'art-work', 'audio-tmp')
SR = 48000
RNG = np.random.default_rng(7)


def ffmpeg() -> str:
    exe = shutil.which('ffmpeg')
    if exe:
        return exe
    import imageio_ffmpeg  # type: ignore

    return imageio_ffmpeg.get_ffmpeg_exe()


FF = ffmpeg()

# ---------------------------------------------------------------- io


_cache: dict = {}


def load(rel: str) -> np.ndarray:
    """Decode any source to float32 stereo at 48 kHz (n, 2)."""
    if rel in _cache:
        return _cache[rel]
    path = os.path.join(SRC, rel)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    raw = subprocess.run([FF, '-v', 'error', '-i', path, '-ac', '2', '-ar', str(SR), '-f', 'wav', '-acodec', 'pcm_f32le', '-'], capture_output=True, check=True).stdout
    x, _ = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    _cache[rel] = x
    return x


def cut(x: np.ndarray, start: float = 0.0, dur: float | None = None) -> np.ndarray:
    a = int(start * SR)
    b = len(x) if dur is None else min(len(x), a + int(dur * SR))
    return x[a:b].copy()


def fade(x: np.ndarray, fi: float = 0.003, fo: float = 0.05) -> np.ndarray:
    x = x.copy()
    ni, no = min(len(x), int(fi * SR)), min(len(x), int(fo * SR))
    if ni:
        x[:ni] *= np.linspace(0, 1, ni)[:, None] ** 2
    if no:
        x[-no:] *= np.linspace(1, 0, no)[:, None] ** 2
    return x


def mono(x: np.ndarray) -> np.ndarray:
    m = x.mean(axis=1, keepdims=True)
    return np.repeat(m, 2, axis=1)


def trim_silence(x: np.ndarray, db: float = -50, tail: float = 0.05) -> np.ndarray:
    env = np.abs(x).max(axis=1)
    thr = env.max() * 10 ** (db / 20)
    idx = np.nonzero(env > thr)[0]
    if not len(idx):
        return x
    a = max(0, idx[0] - int(0.002 * SR))
    b = min(len(x), idx[-1] + int(tail * SR))
    return x[a:b]


def short_loudness(x: np.ndarray, win: float = 0.4) -> float:
    """Max RMS (dBFS) over a sliding window: a cheap short-term loudness for one-shots."""
    m = x.mean(axis=1)
    n = max(1, int(win * SR))
    if len(m) <= n:
        return 20 * np.log10(np.sqrt(np.mean(m ** 2)) + 1e-9)
    c = np.cumsum(np.concatenate([[0.0], m.astype(np.float64) ** 2]))
    rms = np.sqrt((c[n:] - c[:-n]) / n)
    return float(20 * np.log10(rms.max() + 1e-9))


def integrated(x: np.ndarray) -> float:
    m = x.mean(axis=1)
    return float(20 * np.log10(np.sqrt(np.mean(m.astype(np.float64) ** 2)) + 1e-9))


def limit(x: np.ndarray, ceil_db: float = -1.0) -> np.ndarray:
    """Soft-knee peak limiter (tanh above the knee) so normalising never clips."""
    c = 10 ** (ceil_db / 20)
    knee = c * 0.7
    a = np.abs(x)
    over = a > knee
    y = x.copy()
    y[over] = np.sign(x[over]) * (knee + (c - knee) * np.tanh((a[over] - knee) / (c - knee)))
    return y


def norm(x: np.ndarray, target: float, mode: str = 'short') -> np.ndarray:
    """Loudness-normalise, but never push transients more than 2 dB into the limiter: peaky hits
    (clashes) end up a little under target rather than squashed. Ceiling -1.5 dBFS leaves room for
    the Opus encoder's overshoot."""
    lv = short_loudness(x) if mode == 'short' else integrated(x)
    pk = 20 * np.log10(np.abs(x).max() + 1e-9)
    g = min(target - lv, -1.5 + 2.0 - pk)
    return limit(x * 10 ** (g / 20), -1.5)


def loopify(x: np.ndarray, xf: float = 1.0) -> np.ndarray:
    """Seamless loop: crossfade (equal power) the last `xf` seconds into the first."""
    n = int(xf * SR)
    head, body, tail = x[:n], x[n:-n], x[-n:]
    t = np.linspace(0, np.pi / 2, n)[:, None]
    blended = tail * np.cos(t) + head * np.sin(t)
    return np.concatenate([blended, body])


def mix(*layers: tuple) -> np.ndarray:
    """layers: (signal, offset_seconds, gain_db[, pan -1..1])."""
    end = max(int(o * SR) + len(s) for s, o, *_ in layers)
    out = np.zeros((end, 2), np.float32)
    for s, o, g, *rest in layers:
        p = rest[0] if rest else 0.0
        a = int(o * SR)
        lg = np.cos((p + 1) * np.pi / 4) * np.sqrt(2)
        rg = np.sin((p + 1) * np.pi / 4) * np.sqrt(2)
        s = s * 10 ** (g / 20)
        out[a:a + len(s), 0] += s[:, 0] * lg
        out[a:a + len(s), 1] += s[:, 1] * rg
    return out


def lowpass(x: np.ndarray, hz: float) -> np.ndarray:
    """Spectral 2nd-order-style low-pass (distance / muffling), zero phase, offline."""
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= (1 / np.sqrt(1 + (f / hz) ** 4))[:, None]
    return np.fft.irfft(X, n=len(x), axis=0).astype(np.float32)


def highpass(x: np.ndarray, hz: float) -> np.ndarray:
    """Spectral high-pass (cheap, offline): removes rumble from UI clicks and thin sources."""
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= (1 / np.sqrt(1 + (hz / np.maximum(f, 1)) ** 4))[:, None]
    return np.fft.irfft(X, n=len(x), axis=0).astype(np.float32)


def resample_rate(x: np.ndarray, ratio: float) -> np.ndarray:
    """Varispeed (pitch + time) by linear interpolation; ratio > 1 = higher/faster."""
    n = int(len(x) / ratio)
    t = np.arange(n) * ratio
    i = np.minimum(t.astype(int), len(x) - 2)
    f = (t - i)[:, None]
    return (x[i] * (1 - f) + x[i + 1] * f).astype(np.float32)


def hits(rel: str, thresh_db: float = -24, maxlen: float = 0.8, min_peak_db: float = -12) -> list:
    """Slice a multi-take recording into single hits (onset → next onset or maxlen)."""
    x = load(rel)
    m = np.abs(x).max(axis=1)
    hop = int(SR * 0.005)
    n = len(m) // hop
    env = m[: n * hop].reshape(n, hop).max(axis=1)
    pk = env.max()
    db = 20 * np.log10(env / pk + 1e-9)
    ons = []
    armed = True
    for i, v in enumerate(db):
        if armed and v > thresh_db:
            ons.append(i)
            armed = False
        elif not armed and v < thresh_db - 12:
            armed = True
    out = []
    for k, o in enumerate(ons):
        a = max(0, o * hop - int(0.004 * SR))
        nxt = ons[k + 1] * hop - int(0.01 * SR) if k + 1 < len(ons) else len(x)
        b = min(nxt, a + int(maxlen * SR))
        seg = x[a:b]
        p = 20 * np.log10(np.abs(seg).max() / pk + 1e-9)
        if p >= min_peak_db and b - a > 0.04 * SR:
            out.append((p, fade(trim_silence(seg, -45, 0.02), 0.002, min(0.12, (b - a) / SR * 0.4))))
    out.sort(key=lambda t: -t[0])
    return [s for _, s in out]


def reverb_tail(x: np.ndarray, secs: float = 1.6, wet_db: float = -14, bright: float = 3500) -> np.ndarray:
    """A small offline hall (noise IR) to glue layered stings."""
    n = int(secs * SR)
    ir = RNG.standard_normal((n, 2)).astype(np.float32) * np.exp(-np.linspace(0, 7, n))[:, None]
    ir = lowpass(ir, bright)
    L = len(x) + n
    X = np.fft.rfft(np.pad(x, ((0, n), (0, 0))), axis=0)
    H = np.fft.rfft(np.pad(ir, ((0, len(x)), (0, 0))), axis=0)
    wet = np.fft.irfft(X * H, n=L, axis=0).astype(np.float32)
    wet *= 10 ** (wet_db / 20) / (np.abs(wet).max() + 1e-9) * np.abs(x).max()
    out = np.pad(x, ((0, n), (0, 0))) + wet
    return trim_silence(out, -60, 0.05)


# ---------------------------------------------------------------- encode

BUILT: list = []


def write(name: str, x: np.ndarray, kbps: int = 48, stereo: bool = False) -> None:
    os.makedirs(TMP, exist_ok=True)
    sub = os.path.dirname(name)
    os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    wav = os.path.join(TMP, name.replace('/', '_') + '.wav')
    out = os.path.join(OUT, name + '.webm')
    if not stereo:
        x = x.mean(axis=1, keepdims=True)
    sf.write(wav, np.clip(x, -1, 1), SR, subtype='FLOAT')
    subprocess.run([FF, '-v', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', f'{kbps}k', '-vbr', 'on', '-application', 'audio', '-frame_duration', '20', out], check=True)
    BUILT.append((name, os.path.getsize(out), len(x) / SR))


# ---------------------------------------------------------------- recipes

K = 'kenney'
SN = 'sonniss'
OG = 'oga'

# loudness targets (short-term dBFS): the runtime mixer sets the balance on top of these
T_UI = -20
T_SFX = -15
T_BIG = -11
T_BED = -22


def k(pack: str, f: str) -> str:
    return f'{K}/{pack}/Audio/{f}'


def snm(f: str) -> str:
    d = 'snm_wow1' if os.path.exists(os.path.join(SRC, OG, 'snm_wow1', f)) else 'snm_wow2'
    return f'{OG}/{d}/{f}'


def son(year: str, lib: str, f: str) -> str:
    return f'{SN}/{year}/{lib}/{f}'


RECIPES: dict = {}


def recipe(name):
    def deco(fn):
        RECIPES[name] = fn
        return fn

    return deco


# ---- UI ---------------------------------------------------------------------


@recipe('ui/click')
def _click():
    """Tactile click: a mechanical click with a quiet wooden tap underneath for body."""
    srcs = [k('ui-audio', 'click1.ogg'), k('ui-audio', 'click3.ogg'), k('interface-sounds', 'click_001.ogg'), k('ui-audio', 'click2.ogg')]
    for i, f in enumerate(srcs):
        c = highpass(trim_silence(load(f)), 300)
        w = lowpass(trim_silence(load(k('impact-sounds', f'impactWood_light_00{i}.ogg'))), 2200)
        x = mix((c, 0, 0), (cut(w, 0, 0.12), 0, -13))
        write(f'ui/click_{i + 1}', norm(fade(x, 0.0005, 0.04), T_UI))


@recipe('ui/hover')
def _hover():
    for i, f in enumerate(['tick_001.ogg', 'tick_002.ogg', 'tick_004.ogg']):
        x = highpass(load(k('interface-sounds', f)), 600)
        write(f'ui/hover_{i + 1}', norm(fade(trim_silence(x), 0.001, 0.015), T_UI - 6))


@recipe('ui/pick')
def _pick():
    # a soft leather/wood pick: book place + a quiet bright tick
    for i, f in enumerate(['bookPlace1.ogg', 'bookPlace2.ogg', 'bookPlace3.ogg']):
        x = mix((trim_silence(load(k('rpg-audio', f))), 0, 0), (trim_silence(load(k('interface-sounds', 'select_002.ogg'))), 0.0, -10))
        write(f'ui/pick_{i + 1}', norm(fade(x, 0.001, 0.05), T_UI))


@recipe('ui/error')
def _error():
    for i, f in enumerate(['error_004.ogg', 'error_006.ogg']):
        x = mix((trim_silence(load(k('interface-sounds', f))), 0, 0), (trim_silence(load(k('impact-sounds', 'impactWood_light_002.ogg'))), 0, -6))
        write(f'ui/error_{i + 1}', norm(fade(x, 0.001, 0.05), T_UI))


@recipe('ui/tick')
def _tick():
    write('ui/tick', norm(fade(trim_silence(load(k('interface-sounds', 'tick_002.ogg'))), 0.001, 0.02), T_UI - 2))
    write('ui/tick_urgent', norm(fade(trim_silence(load(k('interface-sounds', 'tick_001.ogg'))), 0.001, 0.02), T_UI + 2))


@recipe('ui/whoosh')
def _whoosh():
    lib = 'Coll Anderson - Sliding Whoosh By'
    for i, (f, s, d) in enumerate([('EFX SD Sliding Whoosh By 06.flac', 0.0, 1.6), ('EFX SD Sliding Whoosh By 15.flac', 0.0, 1.8)]):
        x = trim_silence(cut(load(son('2015', lib, f)), s, d), -40)
        write(f'ui/whoosh_{i + 1}', norm(fade(x, 0.01, 0.3), T_UI + 2), stereo=True, kbps=56)


@recipe('ui/deploy')
def _deploy():
    """A squad planted: a low war-drum hit + armour/leather rustle + chainmail settle."""
    drums = hits(f'{OG}/wardrums.wav', thresh_db=-10, maxlen=1.2, min_peak_db=-4)[:3]
    rust = load(son('2017', 'Double Trouble Audio - Medieval Armor and Impacts', 'LeatherArmor_Rustle_03.flac'))
    chain = load(son('2017', 'Double Trouble Audio - Medieval Armor and Impacts', 'Chainmail_Impact_Hard_03.flac'))
    cloth = [load(k('rpg-audio', f)) for f in ['cloth1.ogg', 'cloth2.ogg', 'cloth3.ogg']]
    for i in range(3):
        x = mix((trim_silence(cloth[i]), 0, -6), (rust, 0.02, -2), (drums[i % len(drums)], 0.03, 0), (chain, 0.07, -9))
        write(f'ui/deploy_{i + 1}', norm(fade(x, 0.002, 0.25), T_UI + 3))


@recipe('ui/drop')
def _drop():
    for i, f in enumerate(['dropLeather.ogg', 'bookPlace2.ogg']):
        write(f'ui/drop_{i + 1}', norm(fade(trim_silence(load(k('rpg-audio', f))), 0.001, 0.06), T_UI))


@recipe('ui/coin')
def _coin():
    lib = 'CB Sound Design - Essential Sounds Vol.01 Coins'
    for i, f in enumerate(['many_coins_12.flac', 'handling_coins_7.flac', 'falling_coins_rotation_1.flac']):
        x = trim_silence(load(son('2023', lib, f)), -45)
        write(f'ui/coin_{i + 1}', norm(fade(cut(x, 0, 1.2), 0.001, 0.15), T_UI + 1))
    x = trim_silence(load(son('2018', 'Effectsworks - COINAGE', 'Coins_Pouch_Leather_Drop_Into_Takes_3.flac')), -45)
    write('ui/coin_pouch', norm(fade(cut(x, 0, 1.0), 0.001, 0.2), T_UI + 1))


@recipe('ui/equip')
def _equip():
    """Item equip: a metal clank (plate / chainmail) + buckle."""
    dt = 'Double Trouble Audio - Medieval Armor and Impacts'
    plate = load(son('2017', dt, 'Plate_Impact_Hard_02.flac'))
    chain = load(son('2017', dt, 'Chainmail_Impact_Hard_03.flac'))
    latch = load(k('rpg-audio', 'metalLatch.ogg'))
    buckle = [load(f'{OG}/vehicle_weapons/belt-buckle-0{i}.wav') for i in (1, 2, 3)] if os.path.exists(os.path.join(SRC, OG, 'vehicle_weapons', 'belt-buckle-01.wav')) else [latch] * 3
    write('ui/equip_1', norm(fade(mix((plate, 0, 0), (trim_silence(buckle[0]), 0.05, -6)), 0.001, 0.15), T_UI + 2))
    write('ui/equip_2', norm(fade(mix((chain, 0, 0), (trim_silence(latch), 0.03, -5)), 0.001, 0.15), T_UI + 2))
    write('ui/equip_3', norm(fade(mix((resample_rate(plate, 0.9), 0, -2), (chain, 0.02, -4), (trim_silence(buckle[2]), 0.06, -6)), 0.001, 0.15), T_UI + 2))


@recipe('ui/levelup')
def _levelup():
    """Level up: a bright harp run + a soft chime, short."""
    harp = trim_silence(load(son('2023', 'CB Sound Design - Dreamcatcher - The Sound of Dreams & Magic', 'Harp_Glissando_10b.flac')), -40)
    x = fade(cut(harp, 0, 1.8), 0.005, 0.6)
    chime = trim_silence(load(son('2026', 'Epic Stock Media - Fantasy Game 2 - Sound Kit for Enchanted Realms', 'MAGAngl_Magic Light Spell Enchantment Potion Effect Tonal Bright 03_ESM_FG2.flac')), -40)
    out = mix((x, 0, 0), (fade(cut(chime, 0, 2.0), 0.01, 0.8), 0.25, -6))
    write('ui/levelup', norm(fade(out, 0.002, 0.6), T_UI + 2), stereo=True, kbps=64)


@recipe('ui/ready')
def _ready():
    """Ready: a single call on a real hunting horn (CC0, Wikimedia Commons)."""
    h = load('commons/hunting_horn_tone.ogg')
    x = cut(h, 3.45, 1.45)
    write('ui/ready', norm(fade(reverb_tail(highpass(x, 120), 1.4, -16), 0.02, 0.5), T_UI + 3), stereo=True, kbps=56)


@recipe('ui/draft')
def _draft():
    """New recruits: an orchestral entrance sting + war drums."""
    s = load(f'{OG}/stinger_entrance.wav')
    x = fade(cut(s, 0, 4.2), 0.005, 1.2)
    write('ui/draft', norm(x, T_UI + 5), stereo=True, kbps=72)


@recipe('ui/open')
def _open():
    x = trim_silence(load(son('2026', 'Epic Stock Media - Fantasy Game 2 - Sound Kit for Enchanted Realms', 'CLOTHFlp_Action Inventory Open Flip Cloth Canvas Bag Slide Light 02_ESM_FG2.flac')), -45)
    write('ui/open', norm(fade(x, 0.002, 0.1), T_UI))
    write('ui/page', norm(fade(trim_silence(load(k('rpg-audio', 'bookFlip2.ogg'))), 0.002, 0.08), T_UI - 1))


# ---- loot -------------------------------------------------------------------


@recipe('loot')
def _loot():
    """A drop lands (leather pouch thump), then a sting per rarity: magic = a soft chime, rare = a harp
    run, legendary = a riser, a cinematic boom, a bell tree shimmer and a choir-like orchestral swell."""
    thud = trim_silence(load(k('impact-sounds', 'impactSoft_heavy_001.ogg')))
    leather = trim_silence(load(k('rpg-audio', 'dropLeather.ogg')))
    land = mix((thud, 0, 0), (leather, 0.01, -3))
    write('loot/land', norm(fade(land, 0.001, 0.1), T_UI + 1))
    write('loot/common', norm(fade(mix((land, 0, 0), (trim_silence(load(k('rpg-audio', 'handleSmallLeather.ogg'))), 0.08, -6)), 0.001, 0.15), T_UI))
    chime = trim_silence(load(son('2026', 'Epic Stock Media - Fantasy Game 2 - Sound Kit for Enchanted Realms', 'MAGAngl_Magic Light Spell Enchantment Potion Effect Tonal Bright 03_ESM_FG2.flac')), -40)
    write('loot/magic', norm(fade(cut(chime, 0, 2.2), 0.005, 0.9), T_UI + 1), stereo=True, kbps=56)
    harp = trim_silence(load(son('2023', 'CB Sound Design - Dreamcatcher - The Sound of Dreams & Magic', 'Harp_Glissando_10b.flac')), -40)
    write('loot/rare', norm(fade(mix((cut(harp, 0, 3.0), 0, 0), (cut(chime, 0, 2.5), 0.4, -8)), 0.005, 1.2), T_UI + 3), stereo=True, kbps=64)
    bells = load(son('2023', 'CB Sound Design - Dreamcatcher - The Sound of Dreams & Magic', 'Enchanting_Bells_4.flac'))
    boom = load(son('2019', 'Federico Soler Fernández - Effective Trailer Booms', 'Boom 091.flac'))
    swell = load(son('2023', 'InspectorJ - RPG Orchestral Essentials (Music FX)', 'Mystery_01-11_Ensemble-Large_WET.flac'))
    riser = trim_silence(load(son('2015', 'Coll Anderson - Sliding Whoosh By', 'EFX SD Sliding Whoosh By 21.flac')), -40)
    r = fade(cut(riser, 0, 0.9), 0.4, 0.05)
    leg = mix(
        (r, 0, -6),
        (boom, 0.85, 0),
        (fade(cut(bells, 2.0, 4.5), 0.05, 2.0), 0.88, -6),
        (fade(cut(swell, 0, 4.5), 0.02, 2.0), 0.9, -7),
        (cut(harp, 0, 3.0), 1.0, -10),
    )
    write('loot/legendary', norm(fade(leg, 0.01, 1.5), T_BIG), stereo=True, kbps=80)


# ---- battle: melee ------------------------------------------------------------


def clash_pool():
    files = ['Sabre Norse Sword Blade on Blade.wav', 'Norse Sword Katana Blade on Blade.wav', 'Spear Norse Sword Blade on Blade.wav', 'Sabre Katana Blade on Blade.wav', 'Seax Norse Sword Blade on Blade.wav']
    heavy = ['Axe Norse Sword Blade on Blade.wav', 'Mace Norse Sword Blade.wav', 'Axe Sabre Blade on Blade.wav', 'Mace Katana Blade.wav', 'Axe Katana Blade on Blade.wav']
    light = [h for f in files for h in hits(snm(f), maxlen=0.7)[:3]]
    hv = [h for f in heavy for h in hits(snm(f), maxlen=0.8)[:3]]
    return light, hv


@recipe('battle/clash')
def _clash():
    light, hv = clash_pool()
    for i in range(6):
        write(f'battle/clash_{i + 1}', norm(light[i * 2 % len(light)], T_SFX))
    for i in range(5):
        write(f'battle/clash_heavy_{i + 1}', norm(mix((hv[i * 2 % len(hv)], 0, 0), (trim_silence(load(k('impact-sounds', f'impactPlate_heavy_00{i}.ogg'))), 0.0, -9)), T_SFX + 1))
    # body hits / parries from the pro libraries
    dt = 'Double Trouble Audio - Medieval Armor and Impacts'
    write('battle/clash_7', norm(load(son('2017', dt, 'Weapon_Impact_Parry_01.flac')), T_SFX))
    write('battle/clash_8', norm(trim_silence(load(son('2020', 'SmartSoundFX - Medieval', 'SWORD Hit Metal 02.flac'))), T_SFX))


@recipe('battle/bed')
def _bed():
    """Clash beds: 14 s seamless loops of many layered melee hits at two densities, over a real
    recorded crowd fight. The runtime fades them by the number of melee contacts."""
    light, hv = clash_pool()
    pool = light + hv
    crowd = load(son('2019', 'Rock The Speakerbox - Hero', 'HERO - CK - CROWD Fight 02.flac'))
    steady = load(son('2015', 'Coll Anderson - Battle Crowd', 'EFX EXT GROUP Battle Steady Fighting 03 A.flac'))
    L = 14.0
    for name, rate, base, off in [('bed_skirmish', 3.5, steady, 6.0), ('bed_melee', 11.0, crowd, 12.0)]:
        layers = [(cut(base, off, L + 1.0), 0, 0 if name == 'bed_skirmish' else -4)]
        t = 0.0
        while t < L:
            t += RNG.exponential(1 / rate)
            h = pool[RNG.integers(len(pool))]
            h = resample_rate(h, float(RNG.uniform(0.88, 1.1)))
            dist = float(RNG.uniform(0, 1))
            if dist > 0.6:
                h = lowpass(h, 2500)
            layers.append((h, t, -6 - dist * 14 + (6 if name == 'bed_skirmish' else 0), float(RNG.uniform(-0.8, 0.8))))
        x = mix(*layers)[: int((L + 1.0) * SR)]
        x = loopify(x, 1.0)
        write(f'battle/{name}', norm(x, T_BED, 'int'), stereo=True, kbps=64)


@recipe('battle/fist')
def _fist():
    for i in range(3):
        x = mix((trim_silence(load(k('impact-sounds', f'impactPunch_heavy_00{i}.ogg'))), 0, 0), (trim_silence(load(k('impact-sounds', f'impactMining_00{i}.ogg'))), 0, -4))
        write(f'battle/fist_{i + 1}', norm(fade(lowpass(x, 3000), 0.001, 0.1), T_SFX + 1))


@recipe('battle/grunt')
def _grunt():
    lib = '344 Audio - Medieval Battle'
    m = trim_silence(load(son('2020', lib, 'Male Warrior 2 Scream, Battle, War, Cry, Fight, Shout 3.flac')), -40)
    f = trim_silence(load(son('2020', lib, 'Female Warrior 3 Scream, Battle, War, Cry, Fight, Shout 3.flac')), -40)
    write('battle/grunt_1', norm(fade(m, 0.005, 0.1), T_SFX - 2))
    write('battle/grunt_2', norm(fade(resample_rate(m, 0.92), 0.005, 0.1), T_SFX - 2))
    write('battle/grunt_3', norm(fade(f, 0.005, 0.1), T_SFX - 2))


@recipe('battle/death')
def _death():
    """A soldier falls: armour body-drop (chain & leather) variants."""
    drop = trim_silence(load(son('2020', 'SmartSoundFX - Medieval', 'ARMOR Body Drop Chain Leather Short 02.flac')), -45)
    for i, r in enumerate([1.0, 0.9, 1.08]):
        x = mix((resample_rate(drop, r), 0, 0), (trim_silence(load(k('impact-sounds', f'impactSoft_medium_00{i}.ogg'))), 0.0, -6))
        write(f'battle/death_{i + 1}', norm(fade(x, 0.001, 0.2), T_SFX - 2))


@recipe('battle/wipe')
def _wipe():
    """A whole squad wiped out: a low cinematic hit + a group agony cry, distant."""
    imp = load(son('2023', '344 Audio - Epic Impacts Vol. 1', 'Impact 045.flac'))
    cry = load(son('2015', 'Coll Anderson - Battle Crowd', 'EFX EXT GROUP Agony Scream 02 A.flac'))
    x = mix((fade(cut(imp, 0, 2.5), 0.001, 1.0), 0, 0), (fade(lowpass(cut(cry, 1.0, 2.2), 3500), 0.05, 1.0), 0.05, -8))
    write('battle/wipe', norm(fade(x, 0.001, 0.8), T_SFX + 1), stereo=True, kbps=56)


# ---- battle: ranged & siege ---------------------------------------------------


@recipe('battle/volley')
def _volley():
    """One whoosh per volley: several bow releases + arrow flights, layered offline."""
    noc = 'Eiravaein Works - Nocked'
    bows = [trim_silence(load(son('2019', noc, f)), -45) for f in [
        'Nocked,archery,firing,loose,Pinakabow,mythic,midflight,wide,hum,sizzle,energy,alt8.flac',
        'Nocked,archery,firing,loose,Vaeyanbow,midflight,wide,mythic,sleek,swirl,rattle,alt14.flac',
    ]]
    bows = [norm(b, -16) for b in bows]
    sw = [norm(trim_silence(load(f'{OG}/swishes/swishes/swish-{i}.wav')), -18) for i in (1, 2, 3, 4)]
    for size, n, spread in [('small', 3, 0.12), ('large', 9, 0.3)]:
        for v in range(3):
            layers = []
            for j in range(n):
                t = float(RNG.uniform(0, spread))
                b = resample_rate(bows[RNG.integers(2)], float(RNG.uniform(0.9, 1.12)))
                s = resample_rate(sw[RNG.integers(4)], float(RNG.uniform(0.85, 1.2)))
                p = float(RNG.uniform(-0.6, 0.6))
                layers += [(b, t, -2 - j * 0.4, p), (s, t + 0.06, -4, p)]
            x = mix(*layers)
            write(f'battle/volley_{size}_{v + 1}', norm(fade(x, 0.002, 0.2), T_SFX + (1 if size == 'large' else -1)), stereo=True, kbps=56)


@recipe('battle/arrowhit')
def _arrowhit():
    """Arrows landing, aggregated: a scatter of thuds in wood / earth / shields."""
    a = trim_silence(load(son('2020', 'SmartSoundFX - Medieval', 'BOW Arrow Hit 05.flac')), -45)
    woods = [trim_silence(load(k('impact-sounds', f'impactWood_light_00{i}.ogg'))) for i in range(5)]
    soft = [trim_silence(load(k('impact-sounds', f'impactSoft_medium_00{i}.ogg'))) for i in range(5)]
    for v in range(4):
        layers = [(a, 0, 0, float(RNG.uniform(-0.3, 0.3)))]
        for j in range(5 + v):
            src = woods[RNG.integers(5)] if RNG.random() < 0.5 else soft[RNG.integers(5)]
            layers.append((resample_rate(src, float(RNG.uniform(0.85, 1.15))), float(RNG.uniform(0.02, 0.35)), float(RNG.uniform(-14, -6)), float(RNG.uniform(-0.7, 0.7))))
        write(f'battle/arrowhit_{v + 1}', norm(fade(mix(*layers), 0.001, 0.15), T_SFX - 2), stereo=True, kbps=48)


@recipe('battle/ballista')
def _ballista():
    noc = 'Eiravaein Works - Nocked'
    snap = trim_silence(load(son('2019', noc, 'Nocked,archery,firing,loose,crossbow1,carbonbolt,atbow,snap,buzz,airy,bright,alt.flac')), -45)
    wood = trim_silence(load(k('impact-sounds', 'impactWood_heavy_001.ogg')))
    for i, r in enumerate([0.7, 0.62, 0.76]):
        x = mix((resample_rate(snap, r), 0, 0), (wood, 0.0, -6), (resample_rate(trim_silence(load(f'{OG}/swishes/swishes/swish-{7 + i}.wav')), 0.8), 0.04, -6))
        write(f'battle/ballista_{i + 1}', norm(fade(x, 0.001, 0.2), T_SFX + 1))


@recipe('battle/treb')
def _treb():
    """Trebuchet throw: a wooden arm thump + creak + a heavy swish."""
    for i in range(3):
        x = mix(
            (trim_silence(load(k('impact-sounds', f'impactWood_heavy_00{i + 2}.ogg'))), 0, 0),
            (trim_silence(load(k('rpg-audio', f'creak{i + 1}.ogg'))), 0.0, -6),
            (resample_rate(trim_silence(load(f'{OG}/swishes/swishes/swish-{10 + i}.wav')), 0.65), 0.05, -2),
        )
        write(f'battle/treb_{i + 1}', norm(fade(lowpass(x, 6000), 0.001, 0.25), T_SFX + 1))


@recipe('battle/stone')
def _stone():
    """Siege stone impact: a rock smash + debris + a low thump."""
    bz = 'BluezoneCorp - Stone Impact'
    rocks = [load(son('2024', bz, f)) for f in ['Bluezone_BC0297_stone_impact_015.flac', 'Bluezone_BC0297_stone_impact_041.flac']]
    far = load(son('2017', 'Gamemaster Audio -  Explosion Sound Pack', 'explosion_far_distant_02.flac')) if os.path.exists(os.path.join(SRC, SN, '2017')) else None
    deb = load(son('2023', 'BluezoneCorp - Building Collapse', 'Bluezone_BC0275_building_collapse_debris_falling_rock_rubble_glass_010.flac'))
    for i in range(3):
        layers = [(rocks[i % 2], 0, 0), (lowpass(cut(deb, 0, 1.6), 5000), 0.05, -8)]
        if far is not None:
            layers.append((lowpass(cut(far, 0, 2.5), 900), 0, -4))
        write(f'battle/stone_{i + 1}', norm(fade(mix(*layers), 0.001, 0.6), T_SFX + 3), stereo=True, kbps=56)


# ---- battle: magic & monsters --------------------------------------------------


@recipe('battle/fireball')
def _fireball():
    ss = 'Sound Spark LLC - Magic Spells, Buffs and Attacks'
    a = trim_silence(load(son('2019', ss, 'Fire_Spell_Dragon_Trap_03.flac')), -45)
    b = trim_silence(load(son('2020', 'SmartSoundFX - Medieval', 'WHOOSH Ball Crackle Small 02.flac')), -45)
    write('battle/fireball_1', norm(fade(cut(a, 0, 1.6), 0.003, 0.5), T_SFX))
    write('battle/fireball_2', norm(fade(cut(b, 0, 1.6), 0.003, 0.5), T_SFX))
    write('battle/fireball_3', norm(fade(resample_rate(cut(b, 0, 1.6), 0.88), 0.003, 0.5), T_SFX))


@recipe('battle/boom')
def _boom():
    """Fireball / spell explosion (medium) and a big one (meteor, earthshaker)."""
    gm = 'Gamemaster Audio -  Explosion Sound Pack'
    dd = 'David Dumais Audio - Magic Sound FX Pack 1'
    mex = load(son('2020', dd, 'Magic_Explosion_Short19.flac'))
    ign = load(son('2018', 'Gregor Quendel - Designed Fire', 'Designed Fire - Impacts - Large, ignition 03.flac'))
    med = load(son('2017', gm, 'explosion_med_long_tail_01.flac'))
    lg = load(son('2017', gm, 'explosion_large_08.flac'))
    write('battle/boom_1', norm(fade(mix((mex, 0, 0), (lowpass(med, 3000), 0, -6)), 0.001, 0.8), T_SFX + 2), stereo=True, kbps=56)
    write('battle/boom_2', norm(fade(mix((cut(ign, 0, 2.5), 0, 0), (lowpass(med, 2500), 0, -8)), 0.001, 0.9), T_SFX + 2), stereo=True, kbps=56)
    write('battle/boom_3', norm(fade(mix((resample_rate(mex, 0.85), 0, 0), (lowpass(cut(lg, 0, 2.5), 2000), 0, -8)), 0.001, 0.9), T_SFX + 2), stereo=True, kbps=56)
    boom = load(son('2019', 'Federico Soler Fernández - Effective Trailer Booms', 'Boom 005.flac'))
    write('battle/boom_big', norm(fade(mix((lg, 0, 0), (boom, 0, -3), (cut(ign, 0, 3.0), 0.05, -8)), 0.001, 1.2), T_BIG), stereo=True, kbps=64)


@recipe('battle/zap')
def _zap():
    gm = son('2018', 'Gamemaster Audio - Magic and Spell Sounds', 'electric_surge_blast_04.flac')
    dd = son('2023', 'David Dumais Audio - Magic Sound FX Pack 2', 'MagicPack2_ElectricitySpells_Spell2-002.flac')
    write('battle/zap_1', norm(fade(cut(load(gm), 0, 1.4), 0.001, 0.4), T_SFX + 1))
    write('battle/zap_2', norm(fade(cut(load(dd), 0, 1.6), 0.001, 0.5), T_SFX + 1))
    write('battle/zap_3', norm(fade(resample_rate(cut(load(gm), 0, 1.4), 1.12), 0.001, 0.4), T_SFX + 1))


@recipe('battle/heal')
def _heal():
    e = trim_silence(load(son('2026', 'Epic Stock Media - Fantasy Game 2 - Sound Kit for Enchanted Realms', 'MAGAngl_Magic Light Spell Enchantment Potion Effect Tonal Bright 03_ESM_FG2.flac')), -45)
    ice = trim_silence(load(son('2019', 'Sound Spark LLC - Magic Spells, Buffs and Attacks', 'Ice_Spell_Ice_Spell_Buff_Positive_02.flac')), -45)
    write('battle/heal_1', norm(fade(cut(e, 0, 1.6), 0.01, 0.7), T_SFX - 3), stereo=True, kbps=48)
    write('battle/heal_2', norm(fade(cut(ice, 0, 1.4), 0.01, 0.6), T_SFX - 3), stereo=True, kbps=48)


@recipe('battle/breath')
def _breath():
    """Dragon / wyvern fire breath: a roaring fire burst; the roar layer plays on its own cooldown."""
    f = load(son('2018', 'Gregor Quendel - Designed Fire', 'Designed Fire - Swooshes - Burst, evolving 34.flac'))
    write('battle/breath_1', norm(fade(cut(trim_silence(f, -40), 0, 2.4), 0.05, 0.8), T_SFX + 2), stereo=True, kbps=56)
    write('battle/breath_2', norm(fade(cut(trim_silence(f, -40), 2.4, 2.2), 0.05, 0.8), T_SFX + 2), stereo=True, kbps=56)


@recipe('battle/roar')
def _roar():
    hd = 'Varazuvi - Hollywood Dragons'
    write('battle/roar_1', norm(fade(trim_silence(load(son('2015', hd, 'Dragon Roaring 4.flac')), -40), 0.01, 0.6), T_BIG - 1), stereo=True, kbps=56)
    write('battle/roar_2', norm(fade(trim_silence(load(son('2015', hd, 'Dragon Long Huff 2.flac')), -40), 0.01, 0.6), T_SFX + 1), stereo=True, kbps=56)
    fox = 'Fox Audio Post-Production - Dino - Roars & Growls'
    write('battle/roar_3', norm(fade(mix((resample_rate(load(son('2018', fox, 'DRY_T-Rex_roar_03.flac')), 0.8), 0, 0), (load(son('2015', hd, 'Dragon Short Huff.flac')), 0.1, -6)), 0.01, 0.4), T_BIG - 1), stereo=True, kbps=56)
    write('battle/screech', norm(fade(trim_silence(load(son('2018', fox, 'DRY_Pterodactyl_roar_07.flac')), -40), 0.005, 0.3), T_SFX))


@recipe('battle/stomp')
def _stomp():
    """Golem stomp / earthshaker: a ground impact + rock debris."""
    imp = load(son('2023', '344 Audio - Epic Impacts Vol. 1', 'Impact 021.flac'))
    rock = load(son('2024', 'BluezoneCorp - Stone Impact', 'Bluezone_BC0297_stone_impact_hammer_015.flac'))
    write('battle/stomp_1', norm(fade(mix((lowpass(cut(imp, 0, 2.0), 2500), 0, 0), (rock, 0, -6)), 0.001, 0.7), T_SFX + 2), stereo=True, kbps=56)
    write('battle/stomp_2', norm(fade(mix((lowpass(resample_rate(cut(imp, 0, 2.0), 0.85), 2000), 0, 0), (rock, 0.01, -8)), 0.001, 0.7), T_SFX + 2), stereo=True, kbps=56)


@recipe('battle/summon')
def _summon():
    x = load(son('2019', 'Rock The Speakerbox - Sorcery', 'SORCERY - DESIGNED - MAGIC BLACK Summon Necromancer.flac'))
    write('battle/summon', norm(fade(cut(trim_silence(x, -40), 0, 2.6), 0.01, 1.0), T_SFX), stereo=True, kbps=56)


# ---- battle: keeps & lord abilities ----------------------------------------------


@recipe('battle/keep')
def _keep():
    """Keep hit (stone wall struck) and the stage collapse (masonry falling)."""
    imps = [load(son('2023', '344 Audio - Epic Impacts Vol. 1', f'Impact {n}.flac')) for n in ('038', '059')]
    rock = load(son('2024', 'BluezoneCorp - Stone Impact', 'Bluezone_BC0297_stone_impact_041.flac'))
    wall = load(f'{OG}/cannon_hit_wall.ogg')
    for i in range(3):
        x = mix((imps[i % 2], 0, -2), (rock, 0, -4), (wall, 0.01, -6 - i * 2))
        write(f'battle/keephit_{i + 1}', norm(fade(cut(x, 0, 3.0), 0.001, 1.0), T_SFX + 3), stereo=True, kbps=56)
    bc = 'BluezoneCorp - Building Collapse'
    col = load(son('2023', bc, 'Bluezone_BC0275_building_collapse_debris_falling_rock_rubble_008.flac'))
    col2 = load(son('2023', bc, 'Bluezone_BC0275_building_collapse_debris_falling_rock_008.flac'))
    boom = load(son('2019', 'Federico Soler Fernández - Effective Trailer Booms', 'Boom 036.flac'))
    write('battle/collapse_1', norm(fade(mix((col, 0, 0), (boom, 0, -4)), 0.001, 1.5), T_BIG), stereo=True, kbps=64)
    write('battle/collapse_2', norm(fade(mix((col2, 0, 0), (boom, 0, -6), (imps[0], 0, -6)), 0.001, 1.5), T_BIG), stereo=True, kbps=64)


@recipe('battle/horn')
def _horn():
    """Battle start: cow-horn calls (Klausjagen recording, PD) + the army's battle cry."""
    h = load('commons/hornblaeser.ogg')
    write('battle/horn', norm(fade(reverb_tail(cut(h, 0.05, 4.2), 2.0, -14), 0.02, 1.2), T_BIG - 2), stereo=True, kbps=64)
    cry = load(son('2020', '344 Audio - Medieval Battle', 'Battle Cry, Charge, Screams, Army Attacking, Running 1.flac'))
    write('battle/charge', norm(fade(cut(cry, 0, 4.9), 0.05, 1.2), T_SFX + 1), stereo=True, kbps=56)
    cry2 = load(son('2015', 'Coll Anderson - Battle Crowd', 'EFX EXT GROUP Battle Cry 03 A.flac'))
    write('battle/warcry', norm(fade(cut(cry2, 0.0, 5.0), 0.05, 1.5), T_SFX + 1), stereo=True, kbps=56)


@recipe('battle/lord')
def _lord():
    """Lord abilities: meteor (incoming roar + huge impact), rally (horn + cheering), bulwark (a
    ringing holy ward), skyfall (thunder crack + electric strike)."""
    sw = trim_silence(load(son('2015', 'Coll Anderson - Sliding Whoosh By', 'EFX SD Sliding Whoosh By 34.flac')), -40)
    lg = load(son('2017', 'Gamemaster Audio -  Explosion Sound Pack', 'explosion_large_08.flac'))
    boom = load(son('2019', 'Federico Soler Fernández - Effective Trailer Booms', 'Boom 040.flac'))
    ign = load(son('2018', 'Gregor Quendel - Designed Fire', 'Designed Fire - Impacts - Large, ignition 03.flac'))
    write('battle/meteor', norm(fade(mix((fade(cut(sw, 0, 1.2), 0.6, 0.05), 0, -2), (lg, 1.15, 0), (boom, 1.15, -2), (cut(ign, 0, 3.5), 1.2, -8)), 0.01, 1.5), T_BIG), stereo=True, kbps=64)
    cel = load(son('2015', 'Coll Anderson - Battle Crowd', 'EFX EXT GROUP Battle Celebration 02 A.flac'))
    h = load('commons/hornblaeser.ogg')
    write('battle/rally', norm(fade(mix((cut(h, 0.05, 2.6), 0, 0), (fade(cut(cel, 1.0, 3.5), 0.3, 1.5), 0.6, -6)), 0.02, 1.2), T_BIG - 1), stereo=True, kbps=64)
    ice = load(son('2019', 'Sound Spark LLC - Magic Spells, Buffs and Attacks', 'Ice_Spell_Ice_Spell_Buff_Positive_02.flac'))
    plate = load(son('2017', 'Double Trouble Audio - Medieval Armor and Impacts', 'Plate_Impact_Hard_02.flac'))
    tr = load(son('2020', 'David Dumais Audio - Magic Sound FX Pack 1', 'Magic_Transformation03.flac'))
    write('battle/bulwark', norm(fade(reverb_tail(mix((plate, 0, -2), (ice, 0.02, 0), (tr, 0.05, -6)), 1.8, -12), 0.001, 1.2), T_BIG - 1), stereo=True, kbps=64)
    th = load(son('2015', 'Soundopolis - Natures Fury_Thunder', 'Thunder_Crack_Fienup_016.flac'))
    zap = load(son('2018', 'Gamemaster Audio - Magic and Spell Sounds', 'electric_surge_blast_04.flac'))
    th = trim_silence(th, -30)
    write('battle/skyfall', norm(fade(mix((cut(th, 0, 4.0), 0, 0), (zap, 0.0, -4)), 0.001, 1.6), T_BIG), stereo=True, kbps=64)
    cast = load(son('2020', 'David Dumais Audio - Spells Magic 1', 'Magic_Spells_CastShort_Push14.flac'))
    write('battle/cast', norm(fade(cast, 0.001, 0.4), T_SFX))


# ---- stings -------------------------------------------------------------------


@recipe('sting')
def _sting():
    cel = load(son('2015', 'Coll Anderson - Battle Crowd', 'EFX EXT GROUP Battle Celebration 02 A.flac'))
    write('sting/round_won', norm(fade(cut(cel, 0.6, 4.5), 0.2, 2.0), T_SFX), stereo=True, kbps=56)
    fail = load(son('2023', 'InspectorJ - RPG Orchestral Essentials (Music FX)', 'Failure_01-10_Ensemble-Small_DRY.flac'))
    write('sting/round_lost', norm(fade(reverb_tail(fail, 1.5, -14), 0.002, 0.8), T_SFX - 1), stereo=True, kbps=64)
    v = load(f'{OG}/livelymeadow/Lively Meadow Collection/Lively Meadow Victory Fanfare.wav')
    write('sting/victory', norm(fade(trim_silence(v, -50), 0.002, 1.0), -14, 'short'), stereo=True, kbps=96)
    d = load(f'{OG}/rm_defeat.wav')
    write('sting/defeat', norm(fade(cut(d, 0, 11.0), 0.01, 3.5), -15, 'short'), stereo=True, kbps=96)
    write('sting/reveal', norm(fade(mix((cut(load('commons/hornblaeser.ogg'), 0.05, 3.0), 0, 0), (load(son('2019', 'Federico Soler Fernández - Effective Trailer Booms', 'Boom 091.flac')), 0, -4)), 0.01, 1.0), T_BIG - 1), stereo=True, kbps=64)


# ---- ambience -------------------------------------------------------------------


@recipe('amb')
def _amb():
    forest = load(son('2024', 'Justsoundeffects - Forest Ambiences', 'AMBForst_Spring Noon Deciduous Forest Gentle Wind Leaves Rustling Blackbird Raven in Background_JSE_FA.flac'))
    write('amb/forest', norm(loopify(cut(forest, 20.0, 31.0), 1.5), T_BED, 'int'), stereo=True, kbps=56)
    river = load(son('2023', 'Justsoundeffects - Streams and Rivers', 'WATRFlow_River Small Gurgling between Stones_01_JSE_SR.flac'))
    write('amb/river', norm(loopify(cut(river, 5.0, 21.0), 1.5), T_BED, 'int'), stereo=True, kbps=48)
    wind = load(son('2017', 'Hzandbits - Wind In Trees', 'Wind,Ext,Breeze,Treeline,Whoosh,Noise,Constant.flac'))
    write('amb/wind', norm(loopify(cut(wind, 30.0, 26.0), 2.0), T_BED, 'int'), stereo=True, kbps=48)
    crowd = load(son('2015', 'Coll Anderson - Battle Crowd', 'EFX EXT GROUP Battle Steady Fighting 03 A.flac'))
    write('amb/battle', norm(loopify(lowpass(cut(crowd, 20.0, 21.0), 4000), 1.5), T_BED, 'int'), stereo=True, kbps=48)


# ---- music ---------------------------------------------------------------------


def music(name: str, rel: str, start: float, dur: float | None, xf: float = 3.0, kbps: int = 80, target: float = -17) -> None:
    x = cut(load(rel), start, dur)
    x = loopify(x, xf)
    write(f'music/{name}', norm(x, target, 'int'), stereo=True, kbps=kbps)


@recipe('music')
def _music():
    music('menu', f'{OG}/fortheking.ogg', 0.0, 150.0, 4.0)
    music('planning', f'{OG}/woodland.mp3', 0.0, 147.0, 3.0)
    music('battle_a', f'{OG}/battleThemeA.mp3', 0.0, 95.0, 2.0)
    music('battle_b', f'{OG}/treadofwar/The Tread of War - MP3.mp3', 0.0, 150.0, 3.0)


def main(prefixes: list) -> None:
    os.makedirs(OUT, exist_ok=True)
    for name, fn in RECIPES.items():
        if prefixes and not any(name.startswith(p) or p.startswith(name) for p in prefixes):
            continue
        print('==', name, flush=True)
        fn()
    tot = 0
    for n, b, d in BUILT:
        tot += b
        print(f'{n:32s} {d:6.2f}s {b / 1024:7.1f} KB')
    print(f'built {len(BUILT)} files, {tot / 1e6:.2f} MB')


if __name__ == '__main__':
    main(sys.argv[1:])
