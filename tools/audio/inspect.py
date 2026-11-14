"""Inspect source audio: duration, channels, peak/RMS and onset segments (for slicing multi-take files).
Usage: python -I tools/audio/inspect.py <file>... [--seg]"""
import sys
import numpy as np
import soundfile as sf


def load(path):
    if path.lower().endswith(('.mp3', '.webm', '.m4a')):
        import subprocess, imageio_ffmpeg, io
        raw = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'quiet', '-i', path, '-f', 'wav', '-'], capture_output=True).stdout
        return sf.read(io.BytesIO(raw), always_2d=True)
    return sf.read(path, always_2d=True)


def segments(mono, sr, thresh_db=-30, min_gap=0.08, min_len=0.05):
    """Regions where the 10 ms envelope is within thresh_db of the file peak."""
    hop = int(sr * 0.01)
    n = len(mono) // hop
    env = np.sqrt(np.mean(mono[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(env / (env.max() + 1e-12))
    on = db > thresh_db
    segs, start, last = [], None, -1e9
    for i, v in enumerate(on):
        if v:
            if start is None:
                start = i
            last = i
        elif start is not None and (i - last) * 0.01 > min_gap:
            if (last - start) * 0.01 >= min_len:
                segs.append((start * 0.01, (last + 1) * 0.01, float(db[start:last + 1].max())))
            start = None
    if start is not None:
        segs.append((start * 0.01, (last + 1) * 0.01, float(db[start:last + 1].max())))
    return segs


if __name__ == '__main__':
    seg = '--seg' in sys.argv
    for p in [a for a in sys.argv[1:] if not a.startswith('--')]:
        x, sr = load(p)
        m = x.mean(axis=1)
        pk = 20 * np.log10(np.abs(x).max() + 1e-12)
        rms = 20 * np.log10(np.sqrt(np.mean(m ** 2)) + 1e-12)
        print(f'{p.split("/")[-1][:70]:70s} {len(x)/sr:7.2f}s ch{x.shape[1]} {sr}Hz pk{pk:6.1f} rms{rms:6.1f}')
        if seg:
            for a, b, d in segments(m, sr):
                print(f'    {a:7.2f}-{b:7.2f} ({b-a:5.2f}s) {d:6.1f}dB')
