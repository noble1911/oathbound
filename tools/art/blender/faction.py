"""Builder for the faction units that the stock rig.py / creature.py cannot express (assets.json `builder`).
It wraps those scripts instead of changing them: module-level tables and hooks are replaced before their
main() runs, so every other unit keeps building exactly as before.

blender -b --factory-startup --python tools/art/blender/faction.py -- <id>

  float units (assets.json `float`: the Bound Djinn) -> rig.py with the legs turned into a smoke tail:
      the leg chain follows the pelvis rigidly with a travelling wave, walk / run are the idle upper body leaned
      into the flight direction, the body bobs. No stepping.
  creatures / mounts with extras in creatures.json -> creature.py with
      `gaits`      per-mount overrides of creature.GAITS (camel pace, elephant amble); T also sets the clip length
      `amble`      run = a faster walk (no gallop rocking, no suspension): elephants
      `pace_roll`  side-to-side body roll in the walk (camel)
      `body_scale` scales the gait's body bob (the stock numbers are horse-sized)
      `flap`       creature.FLAP entry for a flier {walk, run, other}
      `dragon_like` head-strike attacks of the dragon (bone drake)
      `chains`     extra FK chains {name: {parent, pts}} -> bones m_<name>1..n (the elephant's trunk), driven here
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
from mathutils import Matrix, Vector

import art_lib as L
import retarget as R
import rig as RG
import creature as C

X = Vector((1, 0, 0)); Y = Vector((0, 1, 0)); Z = Vector((0, 0, 1))
LEGS = [f'{b}.{s}' for b in ('thigh', 'shin', 'foot', 'toe') for s in 'LR']
LOOPS = {'idle', 'walk', 'run', 'victory'}


# ----------------------------------------------------------------------------------------------- floaters
def patch_float(a):
    st = dict(clip='idle', nf=2)
    bake0, solve0 = R.bake, R.solve_and_key
    lean = dict(walk=0.2, run=0.38)
    trail = dict(walk=0.16, run=0.3)

    def bake(tgt, act_name, segments, **kw):
        st['clip'] = act_name
        st['nf'] = max(2, int(segments[0]['end'] - segments[0]['start'] + 1))
        return bake0(tgt, act_name, segments, **kw)

    def solve(tgt, frame, rot, hips_pos, hips_name='hips', prev=None):
        clip = st['clip']; ph = frame / (st['nf'] - 1)
        B = tgt.data.bones
        H = a['height']
        if clip in lean:                                    # flying: the idle pose tipped forward
            Ln = Matrix.Rotation(lean[clip], 3, 'X')
            for n in list(rot):
                rot[n] = Ln @ rot[n]
        if 'hips' in rot:
            Hd = rot['hips'] @ B['hips'].matrix_local.to_3x3().inverted()
            dead = clip.startswith('death')
            cyc = 2 if clip in ('walk', 'run') else 1
            amp = 0.0 if dead else (0.10 if clip in LOOPS else 0.05)
            for i, seg in enumerate(('thigh', 'shin', 'foot', 'toe')):
                w = 2 * math.pi * (ph * cyc - 0.16 * i)
                ax = trail.get(clip, 0.0) * (i + 1) * 0.6 + amp * (0.5 + 0.5 * i) * math.sin(w)
                ay = amp * 0.6 * (0.5 + 0.5 * i) * math.sin(w + 1.3)
                Rw = Hd @ Matrix.Rotation(ax, 3, 'X') @ Matrix.Rotation(ay, 3, 'Y')
                for s in 'LR':
                    rot[f'{seg}.{s}'] = Rw @ B[f'{seg}.{s}'].matrix_local.to_3x3()
        if hips_pos is not None and clip in LOOPS:
            hips_pos = hips_pos + Vector((0, 0, 0.022 * H * math.sin(2 * math.pi * ph * (2 if clip in ('walk', 'run') else 1))))
        return solve0(tgt, frame, rot, hips_pos, hips_name=hips_name, prev=prev)

    R.bake = bake
    R.solve_and_key = solve


# ----------------------------------------------------------------------------------------------- creatures
def patch_creature(cfg, mount_id):
    for k, v in cfg.get('gaits', {}).items():
        C.GAITS[k] = dict(C.GAITS[k], **v)
        for kk in ('lift', 'centre'):
            C.GAITS[k][kk] = tuple(C.GAITS[k][kk])
        C.FRAMES[k] = C.GAITS[k]['T']
    if cfg.get('flap'):
        C.FLAP[mount_id] = dict(cfg['flap'])
        if cfg.get('dragon_like'):
            C.FLAP['dragon'] = dict(cfg['flap'])
    chains0 = C.chains_of

    def chains_of(c):
        bones, info = chains0(c)
        for name, ch in c.get('chains', {}).items():
            pts = [Vector(p) for p in ch['pts']]
            par = ch['parent']
            for i in range(len(pts) - 1):
                nm = f'm_{name}{i + 1}'
                bones[nm] = (pts[i], pts[i + 1], par); par = nm
        return bones, info
    C.chains_of = chains_of

    class FCreature(C.Creature):
        def pose_at(self, clip, f, n, impact=10):
            c = self.cfg
            ph = f / n; u = f / max(1, n - 1)
            if c.get('dragon_like'):
                mid = self.mid; self.mid = 'dragon'
                try:
                    pose = super().pose_at(clip, f, n, impact)
                finally:
                    self.mid = mid
                return pose
            if c.get('amble') and clip == 'run':
                keep = C.GAITS['walk']; C.GAITS['walk'] = C.GAITS['run']
                try:
                    pose = super().pose_at('walk', f, n, impact)
                finally:
                    C.GAITS['walk'] = keep
            else:
                pose = super().pose_at(clip, f, n, impact)
            if clip in ('walk', 'run'):
                s = c.get('body_scale', 1.0)
                pose.off.z *= s
                pose.seat.z *= s
                if c.get('pace_roll') and (clip == 'walk' or c.get('amble')):
                    pose.roll += c['pace_roll'] * math.sin(2 * math.pi * (ph - 0.12))
            trunk = [b for b in self.mbones if b.startswith('m_trunk')]
            if trunk:
                atk = clip.startswith('attack') or clip == 'cast'
                hit = C.pulse(f, impact - 9, impact - 1, impact + 2, impact + 14) if atk else 0.0
                wind = C.pulse(f, 0, max(1, impact - 7), max(2, impact - 3), impact) if atk else 0.0
                for i, b in enumerate(trunk):
                    w = (i + 1) / len(trunk)
                    ax, az = 0.0, 0.0
                    if clip == 'idle':
                        ax = 0.06 * w * math.sin(2 * math.pi * (ph - 0.12 * i)) - 0.25 * w * C.pulse(ph, 0.5, 0.62, 0.7, 0.85)
                        az = 0.10 * w * math.sin(2 * math.pi * (ph * 2 - 0.1 * i))
                    elif clip in ('walk', 'run'):
                        ax = 0.10 * w * math.sin(2 * math.pi * (ph * 2 - 0.15 * i))
                        az = 0.07 * w * math.sin(2 * math.pi * (ph - 0.1 * i))
                    elif atk:
                        ax = 0.35 * wind - 0.75 * hit * (0.6 + 0.4 * w)
                    elif clip == 'hit':
                        ax = -0.3 * math.sin(math.pi * u) * w
                    elif clip == 'victory':
                        ax = -(0.75 + 0.1 * math.sin(4 * math.pi * ph)) * (0.5 - 0.5 * math.cos(2 * math.pi * ph)) ** 0.8
                    elif clip.startswith('death'):
                        ax = 0.2 * C.smooth(u / 0.4) * w
                    if ax:
                        pose.add(b, X, ax)
                    if az:
                        pose.add(b, Z, az)
            return pose
    C.Creature = FCreature


def main():
    aid = L.argv()[0]
    a = L.assets()[aid]
    if a.get('float'):
        patch_float(a)
        RG.main()
        return
    mount_id = a.get('mount', aid)
    cfg = json.loads((L.ART / 'creatures.json').read_text())[mount_id]
    patch_creature(cfg, mount_id)
    C.main()


if __name__ == '__main__':
    main()
