"""Creature + mounted builder: a quadruped / winged skeleton laid out per mount in tools/art/creatures.json,
bone-heat skin, hand-authored clips; for mounted units the rider (rigged humanoid part) is merged into the same
armature and seated on the saddle, so the unit is ONE skeleton, ONE set of clips and (for squads) one crowd
mesh + VAT.

blender -b --factory-startup --python tools/art/blender/creature.py -- <unit id>
  dragon                  : standalone creature (art-work/blend/dragon_clean.blend)
  cavalier/pegasus/wyvern : mount = assets[id].mount, rider = assets[id].rider (needs <rider>_rig.blend)

Skeleton (mount bones are prefixed `m_`): m_root, m_body (pelvis -> mid back), m_chest (mid back -> withers),
m_neck, m_neck2.., m_head, m_tail1..n, m_leg_{fl,fr,bl,br}_{1..k} (front: scapula, humerus, forearm, cannon,
pastern; hind: femur, tibia, cannon, pastern), m_wing_{l,r}_{1..k}. Rider bones keep the humanoid names; the
rider's `root` is parented to `m_body`.

Motion (24 fps source, same 11 clip names as the humanoids):
  * ground gaits (horse): each hoof follows a stance / swing path timed by a real footfall pattern -- 4-beat
    lateral-sequence walk (LH, LF, RH, RF, duty 0.6) and a transverse gallop (LH, RH, LF, RF close together, duty
    0.27, then a suspension phase with all four legs gathered). The stance sweep equals speed x stance time for
    the renderer's walkSpeed / runSpeed, so planted hooves do not slide. Legs are solved per frame with a planar
    damped-least-squares IK that also pulls toward a joint "style" (knee / hock fold in swing, fetlock breakover).
  * body: bob, pitch rocking about the mid back, spine flex (m_chest against m_body), neck / head counter-motion,
    tail follow-through with a phase lag per segment, rider bounce and lean synced to the gait.
  * wings: asymmetric flap (downstroke 58 % of the cycle with the wing extended, a faster upstroke with the outer
    wing folded and lagging so the segments overlap), forward sweep on the downstroke, body heave in counter-phase.
    Fliers flap in every clip; the renderer supplies the flight height.
Checks (fail the build): every limb bone must own vertices on both LODs, hooves must travel in walk / run and
wing tips in every flier loop -- a mount can no longer ship as a rigid block that only rocks.
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

import art_lib as L
import retarget as R
import rig as RG

FPS = 24
LOOPS = {'idle', 'walk', 'run', 'victory'}
CLIP_ORDER = ['idle', 'walk', 'run', 'attack_melee_a', 'attack_melee_b', 'attack_bow', 'cast', 'hit', 'death_a',
              'death_b', 'victory']
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
# ground gaits: T frames per stride, touchdown phase per leg, duty factor, the renderer's speed for the clip (m/s)
GAITS = {
    'walk': dict(T=16, phase=dict(bl=0.0, fl=0.25, br=0.5, fr=0.75), duty=0.60, speed=2.2, lift=(0.11, 0.09),
                 flex=0.9, centre=(-0.02, -0.06)),
    'run': dict(T=12, phase=dict(bl=0.0, br=0.11, fl=0.30, fr=0.41), duty=0.27, speed=7.0, lift=(0.26, 0.22),
                flex=1.5, centre=(-0.16, -0.14)),
}
# frames per clip for a mount without a rider (with one, non-loop clips take the rider clip's length)
FRAMES = dict(idle=48, walk=16, run=12, attack_melee_a=30, attack_melee_b=30, attack_bow=30, cast=30, hit=10,
              death_a=40, death_b=40, victory=48)
# fliers: frames per wing beat while cruising (walk), sprinting (run) and hovering / fighting (other clips)
FLAP = {'pegasus_mount': dict(walk=16, run=12, other=18), 'wyvern_mount': dict(walk=20, run=16, other=22),
        'dragon': dict(walk=26, run=20, other=28)}


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def pulse(u, a, b, c, d):
    """0 before a, ramps to 1 by b, holds to c, back to 0 by d."""
    if u <= a or u >= d:
        return 0.0
    if u < b:
        return smooth((u - a) / (b - a))
    if u <= c:
        return 1.0
    return 1 - smooth((u - c) / (d - c))


def flap_wave(p, D=0.58):
    """+1 at the top of the stroke, -1 at the bottom. Downstroke takes D of the cycle, the upstroke the rest."""
    p %= 1.0
    if p < D:
        return math.cos(math.pi * p / D)
    return -math.cos(math.pi * (p - D) / (1 - D))


def flap_up(p, D=0.58):
    """Upstroke envelope (0 during the downstroke): drives the fold of the outer wing."""
    p %= 1.0
    return math.sin(math.pi * (p - D) / (1 - D)) if p > D else 0.0


# ----------------------------------------------------------------------------------------------- skeleton
def chains_of(cfg):
    """{bone name: (head, tail, parent)} in creation order + the chain lists."""
    bones = {}
    info = dict(legs={}, wings={}, tail=[], neck=[])
    s = [Vector(p) for p in cfg['spine']]
    bones['m_root'] = (Vector((0, 0, 0)), Vector((0, -0.3 * s[0].z, 0)), None)
    bones['m_body'] = (s[0], s[1], 'm_root')
    bones['m_chest'] = (s[1], s[2], 'm_body')
    n = [Vector(p) for p in cfg['neck']]
    par = 'm_chest'
    for i in range(len(n) - 1):
        nm = 'm_neck' if i == 0 else f'm_neck{i + 1}'
        bones[nm] = (n[i], n[i + 1], par); par = nm; info['neck'].append(nm)
    bones['m_head'] = (n[-1], Vector(cfg['head']), par)
    t = [Vector(p) for p in cfg['tail']]
    par = 'm_body'
    for i in range(len(t) - 1):
        nm = f'm_tail{i + 1}'
        bones[nm] = (t[i], t[i + 1], par); par = nm; info['tail'].append(nm)
    for grp, prefix in (('legs', 'm_leg'), ('wings', 'm_wing')):
        g = dict(cfg.get(grp, {}))
        for k in list(g):
            if k.endswith('l') and k[:-1] + 'r' not in g:
                g[k[:-1] + 'r'] = [[-p[0], p[1], p[2]] for p in g[k]]
        for k in sorted(g):
            pts = [Vector(p) for p in g[k]]
            par = 'm_chest' if (grp == 'wings' or k[0] == 'f') else 'm_body'
            names = []
            for i in range(len(pts) - 1):
                nm = f'{prefix}_{k}_{i + 1}'
                bones[nm] = (pts[i], pts[i + 1], par); par = nm; names.append(nm)
            info[grp][k] = names
    return bones, info


def refine_hooves(cfg, co):
    """Move each leg chain onto its own hoof: TRELLIS horses stand slightly staggered, the layout is symmetric."""
    g = cfg['legs']
    for k in list(g):
        if k.endswith('l') and k[:-1] + 'r' not in g:
            g[k[:-1] + 'r'] = [[-p[0], p[1], p[2]] for p in g[k]]
    for k, pts in g.items():
        toe = np.array(pts[-1]); top = pts[0][2]
        m = (co[:, 2] < 0.07) & (np.hypot(co[:, 0] - toe[0], co[:, 1] - toe[1]) < 0.2)
        if m.sum() < 30:
            continue
        c = co[m].mean(0)
        d = c[:2] - toe[:2]
        for i, p in enumerate(pts):
            w = 1.0 - p[2] / top
            p[0] += d[0] * (0.5 if i == 0 else 1.0)
            p[1] += d[1] * w
        print(f'[creature] hoof {k}: shifted {d[0]:+.3f} {d[1]:+.3f}')


def build_skeleton(name, cfg):
    bones, info = chains_of(cfg)
    data = bpy.data.armatures.new(name); rig = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(rig)
    L.select_only(rig); bpy.ops.object.mode_set(mode='EDIT')
    for n, (h, t, p) in bones.items():
        b = data.edit_bones.new(n); b.head = h; b.tail = t
        if p:
            b.parent = data.edit_bones[p]
    for b in data.edit_bones:
        b.roll = 0
    bpy.ops.object.mode_set(mode='OBJECT')
    data.bones['m_root'].use_deform = False
    return rig, info


# ----------------------------------------------------------------------------------------------- pose + solve
class Pose:
    """One frame of mount motion: whole-body transform, per-bone rotations about rest-frame (armature) axes,
    leg IK goals and the rider's seat offsets."""

    def __init__(self):
        self.off = Vector((0, 0, 0)); self.pitch = 0.0; self.roll = 0.0; self.yaw = 0.0
        self.rot = {}
        self.ik = {}
        self.fk = {}
        self.lean = 0.0; self.seat = Vector((0, 0, 0)); self.follow = 0.35

    def add(self, bone, axis, ang):
        self.rot.setdefault(bone, []).append((Vector(axis), ang))


class Creature:
    def __init__(self, rig, info, cfg, mount_id, flier):
        self.rig, self.info, self.cfg, self.mid, self.flier = rig, info, cfg, mount_id, flier
        B = rig.data.bones
        self.mbones = [n for n in R.order(rig) if n.startswith('m_')]
        self.rest = {n: B[n].matrix_local.copy() for n in self.mbones}
        self.rel = {n: (B[n].parent.matrix_local.inverted() @ B[n].matrix_local) if B[n].parent else B[n].matrix_local.copy()
                    for n in self.mbones}
        self.len = {n: B[n].length for n in self.mbones}
        s = [Vector(p) for p in cfg['spine']]
        self.pivot = s[1].copy()
        self.axis = (s[2] - s[0]).normalized()                    # body long axis (toward the head)
        self.toe0, self.ang0, self.reach = {}, {}, {}
        for k, names in info['legs'].items():
            last = B[names[-1]]
            self.toe0[k] = last.tail_local.copy()
            d = last.tail_local - last.head_local
            self.ang0[k] = math.atan2(d.y, -d.z)
        self.tail_bend = []
        tl = info['tail']
        for i, n in enumerate(tl):
            if i == 0:
                self.tail_bend.append(0.0); continue
            a = B[tl[i - 1]].tail_local - B[tl[i - 1]].head_local; b = B[n].tail_local - B[n].head_local
            self.tail_bend.append(math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y))
        self.prev_th = {}
        self.ik_err = 0.0

    # -- helpers
    def q_local(self, bone, axis, ang):
        a = (self.rest[bone].to_3x3().inverted() @ Vector(axis)).normalized()
        return Quaternion(a, ang)

    def local(self, bone, pose):
        q = Quaternion()
        for axis, ang in pose.rot.get(bone, []):
            q = self.q_local(bone, axis, ang) @ q
        return q

    def root_matrix(self, pose):
        A = (Matrix.Translation(pose.off) @ Matrix.Rotation(pose.roll, 4, 'Y') @ Matrix.Translation(self.pivot) @
             Matrix.Rotation(pose.yaw, 4, 'Z') @ Matrix.Rotation(pose.pitch, 4, 'X') @ Matrix.Translation(-self.pivot))
        return A

    def leg_limits(self, k):
        n = len(self.info['legs'][k])
        if k[0] == 'f' and n == 5:      # scapula, humerus, forearm, cannon (knee), pastern
            return [(-0.4, 0.4), (-0.7, 0.7), (-1.3, 1.3), (-0.04, 2.3), (-0.6, 1.5)]
        if n == 4:                      # femur, tibia (stifle), cannon (hock), pastern
            return [(-1.1, 1.1), (-0.5, 1.2), (-1.9, 0.3), (-0.6, 1.5)]
        return [(-1.5, 1.5)] * n

    def solve_leg(self, k, M, goal):
        names = self.info['legs'][k]; n = len(names)
        parentM = M[self.rig.data.bones[names[0]].parent.name]
        axes = [(self.rest[b].to_3x3().inverted() @ X).normalized() for b in names]
        rels = [self.rel[b] for b in names]
        tipv = Vector((0, self.len[names[-1]], 0))
        ty, tz = goal['target']
        want = self.ang0[k] + goal.get('pitch', 0.0)
        pref = np.array(goal.get('pref', [0.0] * n), float)
        sig = np.array(goal.get('sig', [0.6] * n), float)
        lim = self.leg_limits(k)
        lo = np.array([a for a, _ in lim]); hi = np.array([b for _, b in lim])

        def fk(th):
            Mp = parentM
            for i in range(n):
                Mp = Mp @ rels[i] @ Quaternion(axes[i], th[i]).to_matrix().to_4x4()
            tip = Mp @ tipv
            d = tip - Mp.translation
            return tip, math.atan2(d.y, -d.z)

        def res(th):
            tip, ang = fk(th)
            da = (ang - want + math.pi) % (2 * math.pi) - math.pi
            return np.concatenate([[(tip.y - ty) / 0.004, (tip.z - tz) / 0.004, da / 0.2], (th - pref) / sig])

        th = np.clip(np.array(self.prev_th.get(k, pref), float), lo, hi)
        lam = 1e-2
        r = res(th); cost = float(r @ r)
        for _ in range(30):
            J = np.empty((len(r), n))
            for i in range(n):
                t2 = th.copy(); t2[i] += 1e-3
                J[:, i] = (res(t2) - r) / 1e-3
            step = np.linalg.solve(J.T @ J + lam * np.eye(n) * (1 + np.diag(J.T @ J)), -J.T @ r)
            t2 = np.clip(th + step, lo, hi)
            r2 = res(t2); c2 = float(r2 @ r2)
            if c2 < cost:
                done = cost - c2 < 1e-6
                th, r, cost = t2, r2, c2; lam = max(lam * 0.4, 1e-5)
                if done:
                    break
            else:
                lam *= 6
                if lam > 1e4:
                    break
        self.prev_th[k] = th
        tip, _ = fk(th)
        if goal.get('planted'):
            self.ik_err = max(self.ik_err, math.hypot(tip.y - ty, tip.z - tz))
        return th

    def mount_matrices(self, pose):
        """Armature-space matrices + local quaternions for every mount bone."""
        M, Q = {}, {}
        leg_of = {b: (k, i) for k, names in self.info['legs'].items() for i, b in enumerate(names)}
        solved = {}
        for n in self.mbones:
            if n == 'm_root':
                A = self.root_matrix(pose)
                Lb = self.rest[n].inverted() @ A @ self.rest[n]
                M[n] = A @ self.rest[n]; Q[n] = (Lb.to_quaternion(), Lb.translation.copy())
                continue
            parentM = M[self.rig.data.bones[n].parent.name]
            if n in leg_of:
                k, i = leg_of[n]
                if k not in solved:
                    if k in pose.ik:
                        solved[k] = self.solve_leg(k, M, pose.ik[k])
                    else:
                        solved[k] = pose.fk.get(k, [0.0] * len(self.info['legs'][k]))
                        self.prev_th[k] = np.array(solved[k], float)
                q = self.q_local(n, X, float(solved[k][i])) @ self.local(n, pose) if n in pose.rot else self.q_local(n, X, float(solved[k][i]))
            else:
                q = self.local(n, pose)
            M[n] = parentM @ self.rel[n] @ q.to_matrix().to_4x4()
            Q[n] = (q, None)
        return M, Q

    # -- shared motion layers
    def gait_goal(self, k, clip, ph, g, air=0.0):
        """IK goal for leg k at stride phase ph (0..1) of gait g. `air` lifts the whole path (fliers)."""
        front = k[0] == 'f'
        n = len(self.info['legs'][k])
        d = g['duty']; T = g['T'] / FPS
        S = g['speed'] * d * T * g.get('stride', 1.0)
        toe = self.toe0[k]
        y0 = toe.y + g['centre'][0 if front else 1]
        u = (ph - g['phase'][k]) % 1.0
        flex = g['flex']
        pref = [0.0] * n; sig = [0.7] * n
        if u < d:                                   # stance: the hoof rides the ground backward at ground speed
            s = u / d
            y = y0 - S / 2 + S * s
            z = toe.z
            pitch = 0.75 * smooth((s - 0.72) / 0.28)            # breakover: heel lifts, toe stays
            planted = True
            pref[-1] = -0.18 * math.sin(math.pi * min(1, s / 0.7))    # fetlock sinks under load
        else:                                       # swing: fold, carry forward, reach, set down
            s = (u - d) / (1 - d)
            e = smooth(s) * 0.7 + s * 0.3
            y = y0 + S / 2 - S * e
            lift = g['lift'][0 if front else 1]
            z = toe.z + lift * math.sin(math.pi * s ** 0.85) ** 1.2
            b = math.sin(math.pi * min(1.0, s / 0.75)) if s < 0.75 else 0.0
            pitch = 0.75 * (1 - smooth(s / 0.25)) + 0.9 * b - 0.22 * smooth((s - 0.75) / 0.25) * (1 - smooth((s - 0.93) / 0.07))
            planted = False
            if front and n == 5:
                pref[3] = flex * b; sig[3] = 0.25                 # knee folds, cannon tucks under the forearm
            elif n == 4:
                pref[1] = 0.45 * flex * b; pref[2] = -0.8 * flex * b; sig[1] = sig[2] = 0.3   # stifle + hock fold
        if front and n == 5:
            pref[0] = 0.3 * (y - toe.y); sig[0] = 0.15           # scapula swings with the stride
        return dict(target=(y, z + air), pitch=pitch, pref=pref, sig=sig, planted=planted and air == 0.0)

    def stand(self, pose, shift=None):
        for k in self.info['legs']:
            t = self.toe0[k]
            pose.ik[k] = dict(target=(t.y, t.z), pitch=0.0, planted=True)

    def tail(self, pose, ph, lift=0.0, sway=0.12, wave=0.0, lag=0.11):
        tl = self.info['tail']
        for i, n in enumerate(tl):
            w = (i + 1) / len(tl)
            if lift:
                pose.add(n, X, lift * (1.0 if i == 0 else 0.35 if i == 1 else 0.1))
            if sway:
                pose.add(n, Z, sway * (0.5 + w) * math.sin(2 * math.pi * (ph - lag * i)))
            if wave:
                pose.add(n, X, wave * (0.4 + w) * math.sin(2 * math.pi * (ph - lag * i)))

    def neck(self, pose, a, head=None):
        nk = self.info['neck']
        for n in nk:
            pose.add(n, X, a / len(nk))
        pose.add('m_head', X, -0.6 * a if head is None else head)

    def flex_spine(self, pose, f):
        """Bend the back in the middle: +f rounds it (croup and withers drop around the mid back)."""
        pose.add('m_chest', X, f)
        pose.pitch -= f / 2

    def wings(self, pose, p, amp, mid, fold=0.35, sweep=0.12, outer=0.3, lag=0.1, spread=1.0):
        fl = self.cfg.get('flight', {})
        pron = fl.get('wing_pron', 0.0) * spread
        stat = fl.get('wing_pose', {})
        for k, names in self.info['wings'].items():
            sg = 1.0 if k == 'l' else -1.0
            w = flap_wave(p)
            for i, n in enumerate(names):
                st = stat.get(str(i + 1))
                if st:
                    for ax, ang, mirror in st:
                        pose.add(n, {'X': X, 'Y': Y, 'Z': Z, 'A': self.axis}[ax], ang * spread * (sg if mirror else 1.0))
                if i == 0:
                    pose.add(n, X, pron)
                    pose.add(n, Z, -sg * sweep * math.sin(2 * math.pi * (p - 0.08)))   # forward on the downstroke
                    pose.add(n, self.axis, sg * (mid + amp * w))
                else:
                    wl = flap_wave(p - lag * i)
                    pose.add(n, self.axis, sg * (outer * amp * wl - fold * flap_up(p - 0.04 * i)))

    def tuck(self, pose, amount=1.0, sway=0.0, ph=0.0):
        t = self.cfg.get('flight', {}).get('tuck', {})
        for k, names in self.info['legs'].items():
            a = t.get(k[0] + 'l', t.get(k, [0.0] * len(names)))
            s = sway * math.sin(2 * math.pi * ph + (0 if k[1] == 'l' else math.pi) + (0 if k[0] == 'f' else 1.3))
            pose.fk[k] = [amount * a[i] + s * (0.6 if i == 0 else 0.3) for i in range(len(names))]

    def flight_base(self, pose, clip, f, n):
        """Flying posture + wing beat for fliers; returns the wing phase."""
        fl = self.cfg.get('flight', {})
        beats = FLAP[self.mid]
        mode = clip if clip in ('walk', 'run') else 'other'
        if clip in LOOPS:
            cycles = max(1, round(n / beats[mode]))
            p = cycles * f / n
        else:
            p = f / beats['other']
        hover = fl.get('hover', {}); cruise = fl.get('cruise', {})
        k = {'walk': 0.75, 'run': 1.0}.get(clip, 0.0)          # 0 = hover posture, 1 = fast cruise
        mix = lambda key, d=0.0: hover.get(key, d) * (1 - k) + cruise.get(key, d) * k
        pose.pitch += mix('pitch')
        for i, nm in enumerate(self.info['neck']):
            a = hover.get('neck', [0] * 8)[i] * (1 - k) + cruise.get('neck', [0] * 8)[i] * k
            pose.add(nm, X, a)
        pose.add('m_head', X, mix('head'))
        tl = self.info['tail']
        ht = hover.get('tail', [0] * 12); ct = cruise.get('tail', [0] * 12)
        un = fl.get('tail_uncurl', 0.0)
        for i, nm in enumerate(tl):
            a = (ht[i] if i < len(ht) else 0) * (1 - k) + (ct[i] if i < len(ct) else 0) * k
            if a:
                pose.add(nm, X, a)
            if un and self.tail_bend[i]:
                pose.add(nm, Z, -un * self.tail_bend[i])
        amp = mix('amp', 0.5); mid = mix('mid', 0.0)
        heave = fl.get('heave', 0.08)
        pose.off.z += heave * (0.6 + 0.4 * (1 - k)) * math.sin(2 * math.pi * (p - 0.33))    # rises through the downstroke
        pose.pitch += 0.03 * math.sin(2 * math.pi * (p - 0.2))
        self.tail(pose, p, sway=0.05, wave=fl.get('tail_wave', 0.12), lag=0.13)
        self.neck(pose, 0.05 * math.sin(2 * math.pi * (p - 0.45)))
        pose.seat.z += 0.02 * math.sin(2 * math.pi * (p - 0.5))
        return p, amp, mid

    # -- clips
    def pose_at(self, clip, f, n, impact=10):
        pose = Pose()
        ph = f / n
        u = f / max(1, n - 1)
        flier = self.flier
        quad = 'fl' in self.info['legs'] and 'bl' in self.info['legs']
        horse = self.cfg.get('refine_hooves', False)
        hit = pulse(f, impact - 9, impact - 1, impact + 2, impact + 14) if clip.startswith('attack') or clip == 'cast' else 0.0
        wind = pulse(f, 0, max(1, impact - 7), max(2, impact - 3), impact) if clip.startswith('attack') or clip == 'cast' else 0.0
        death = clip.startswith('death')
        side = -1.0 if clip == 'death_b' else 1.0
        if flier:
            p, amp, mid = self.flight_base(pose, clip, f, n)
            fold, spread = 0.35, 1.0
            if horse:       # pegasus: gallops on the air
                if clip in ('walk', 'run'):
                    g = dict(GAITS[clip], stride=0.55 if clip == 'walk' else 0.6, T=n,
                             lift=(0.2, 0.16) if clip == 'walk' else (0.3, 0.24))
                    for k in self.info['legs']:
                        pose.ik[k] = self.gait_goal(k, clip, ph, g, air=0.1)
                    pose.pitch += 0.05 * math.cos(2 * math.pi * (ph - 0.1)) if clip == 'run' else 0.0
                    pose.lean = 0.12 if clip == 'run' else 0.04
                else:
                    self.tuck(pose, 1.0, sway=0.12, ph=ph * (2 if clip in LOOPS else 1) if clip in LOOPS else p)
            else:
                self.tuck(pose, 1.0, sway=0.06, ph=p)
            if clip == 'victory':
                amp *= 1.25
                self.neck(pose, -0.35 - 0.1 * math.sin(4 * math.pi * ph), head=-0.25)
                pose.pitch -= 0.12
            if hit or wind:
                if self.mid == 'dragon':        # rear the head back, then drive it forward and down (breath / bite)
                    b = clip in ('attack_melee_b', 'attack_bow')
                    self.neck(pose, -0.45 * wind + (0.75 if not b else 0.95) * hit, head=0.3 * wind - (0.1 if not b else -0.25) * hit)
                    pose.pitch += -0.14 * wind + 0.1 * hit
                    pose.off.y += 0.25 * wind - (0.5 if b else 0.2) * hit
                    amp *= 1 + 0.3 * hit
                else:                           # mount lunges under the rider's blow
                    self.neck(pose, -0.25 * wind + 0.5 * hit, head=0.15 * wind - 0.2 * hit)
                    pose.pitch += -0.08 * wind + 0.1 * hit
                    pose.off.y += 0.1 * wind - 0.22 * hit
                    pose.lean += 0.12 * hit
            if clip == 'hit':
                k = math.sin(math.pi * u)
                pose.pitch -= 0.14 * k; pose.off.y += 0.18 * k; pose.roll += 0.1 * k
                self.neck(pose, -0.25 * k, head=0.3 * k)
                amp *= 1 + 0.4 * k
            if death:
                e = smooth(u / 0.42)                   # the renderer drops the corpse to the ground in ~1.1 s
                land = smooth((u - 0.38) / 0.12)
                pose.roll += side * (1.45 * e + 0.08 * math.sin(math.pi * land) * (1 - smooth((u - 0.5) / 0.3)))
                pose.pitch += 0.25 * math.sin(math.pi * e) - fl_get(self.cfg, 'pitch_rest', 0.0) * e
                pose.off.z += self.cfg.get('lie_lift', 0.2) * e - 0.12 * math.sin(math.pi * land) * 0.0
                amp *= (1 - e); mid = mid * (1 - e) + 0.75 * math.sin(math.pi * min(1, u / 0.5)) * (1 - land) + self.cfg.get('flight', {}).get('dead_mid', -0.2) * land
                fold = 0.35 + 0.5 * e; spread = 1 - 0.75 * land
                self.neck(pose, 0.45 * land, head=0.2 * land)
                self.tail(pose, 0, sway=0, wave=0, lift=-0.2 * land)
                pose.off.z *= 1.0
            self.wings(pose, p, amp, mid, fold=fold, spread=spread)
            return pose
        # ---------------- ground quadruped (horse)
        self.tail(pose, ph if clip in LOOPS else u * 1.5, sway=0.1)
        if clip in GAITS:
            g = GAITS[clip]
            for k in self.info['legs']:
                pose.ik[k] = self.gait_goal(k, clip, ph, g)
            if clip == 'walk':
                pose.off.z = -0.035 + 0.012 * math.cos(4 * math.pi * (ph - 0.06))
                pose.pitch = 0.012 * math.sin(4 * math.pi * ph)
                pose.add('m_body', Y, 0.035 * math.sin(2 * math.pi * (ph - 0.05)))       # croup rolls over the stance hind
                pose.add('m_chest', Y, -0.05 * math.sin(2 * math.pi * (ph - 0.05)) - 0.02 * math.sin(2 * math.pi * (ph - 0.3)))
                pose.add('m_chest', Z, 0.03 * math.sin(2 * math.pi * (ph - 0.25)))
                self.neck(pose, 0.07 * math.cos(4 * math.pi * (ph - 0.3)))               # nods down as each fore lands
                self.tail(pose, ph, sway=0.1, wave=0.04)
                pose.seat.z = 0.012 * math.cos(4 * math.pi * (ph - 0.16))
                pose.lean = 0.03 + 0.02 * math.cos(4 * math.pi * (ph - 0.2))
            else:
                # hinds strike 0-0.4, fores 0.3-0.7, suspension 0.7-1.0
                rock = math.cos(2 * math.pi * (ph - 0.12))                 # +1: forehand up over the driving hinds
                pose.pitch = -0.085 * rock
                pose.off.z = -0.06 + 0.055 * math.cos(2 * math.pi * (ph - 0.86))
                self.flex_spine(pose, 0.11 * math.cos(2 * math.pi * (ph - 0.88)) - 0.02)   # rounds in the air, stretches on the hinds
                self.neck(pose, 0.05 - 0.16 * rock)                        # neck reaches out and down as the fores land
                self.tail(pose, ph, sway=0.05, wave=0.16, lift=0.8)
                pose.seat.z = 0.035 * math.cos(2 * math.pi * (ph - 0.98))
                pose.seat.y = 0.02 * math.sin(2 * math.pi * (ph - 0.3))
                pose.lean = 0.26 + 0.07 * math.cos(2 * math.pi * (ph - 0.55))
                pose.follow = 0.6
            return pose
        self.stand(pose)
        rear = 0.0
        if clip == 'idle':
            b = math.sin(2 * math.pi * ph)
            pose.off.z = 0.004 * b
            self.neck(pose, 0.05 * math.sin(2 * math.pi * ph) + 0.1 * pulse(ph, 0.55, 0.65, 0.72, 0.85))   # breath + a head toss
            self.tail(pose, ph * 2, sway=0.14)
            pose.add('m_body', Y, 0.012 * math.sin(2 * math.pi * (ph + 0.2)))
            pose.seat.z = 0.003 * b
        elif clip == 'attack_melee_a' or clip in ('attack_bow', 'cast'):
            # surge into the blow: weight rocks back, then the horse drives forward and strikes with a foreleg
            k = 1.0 if clip == 'attack_melee_a' else 0.5
            pose.off.y = k * (0.07 * wind - 0.2 * hit)
            pose.off.z = -0.03 * k * hit
            pose.pitch = k * (-0.05 * wind + 0.06 * hit)
            self.neck(pose, k * (-0.22 * wind + 0.3 * hit), head=k * (0.15 * wind - 0.1 * hit))
            paw = pulse(f, impact - 9, impact - 4, impact - 3, impact + 3)
            t = self.toe0['fr']
            pose.ik['fr'] = dict(target=(t.y - 0.3 * k * paw + pose.off.y, t.z + 0.3 * k * paw), pitch=0.9 * paw,
                                 pref=[0, 0, 0, 1.2 * paw, 0], sig=[0.3, 0.6, 0.6, 0.3, 0.6])
            pose.lean = 0.1 * hit * k
        elif clip == 'attack_melee_b':
            rear = 0.32 * pulse(f, impact - 10, impact - 4, impact - 2, impact + 6)       # half-rear, drop onto the target
            self.neck(pose, -0.2 * rear / 0.32 + 0.25 * hit, head=0.2 * rear)
        elif clip == 'hit':
            k = math.sin(math.pi * u)
            pose.off.y = 0.12 * k; pose.pitch = -0.07 * k; pose.off.z = -0.03 * k
            self.neck(pose, -0.3 * k, head=0.25 * k)
            pose.add('m_chest', Z, 0.08 * k)
            pose.lean = -0.12 * k
        elif clip == 'victory':
            rear = 0.55 * (0.5 - 0.5 * math.cos(2 * math.pi * ph)) ** 0.8
            self.neck(pose, -0.25 * rear / 0.55, head=0.15)
        if rear:
            # rear up on the hinds: pivot about the hips, fore legs paw the air
            hip = self.cfg['legs']['bl'][0]
            a = -rear
            py, pz = hip[1] - self.pivot.y, hip[2] - self.pivot.z
            pose.pitch += a
            pose.off.y += py - (py * math.cos(a) - pz * math.sin(a))
            pose.off.z += pz - (py * math.sin(a) + pz * math.cos(a)) - 0.04 * rear
            for i, k in enumerate(('fl', 'fr')):
                pw = math.sin(2 * math.pi * (ph * 3 if clip == 'victory' else u * 2) + i * 2.2)
                pose.fk[k] = [0.0, -0.5 * rear / 0.5 - 0.15 * pw * rear, -0.7 * rear / 0.5, (1.4 + 0.5 * pw) * rear / 0.5, 0.6 * rear / 0.5]
                pose.ik.pop(k, None)
            pose.lean = 0.5 * rear
            pose.follow = 0.25
        if death:
            buckle = smooth(u / 0.3)
            e = smooth((u - 0.16) / 0.42)
            land = smooth((u - 0.5) / 0.1)
            pose.ik.clear()
            for k in self.info['legs']:
                front = k[0] == 'f'
                limp = 0.35 * e
                if front:
                    pose.fk[k] = [0.0, -0.3 * buckle + limp, 0.2 * buckle, 1.5 * buckle * (1 - 0.6 * e), 0.5 * buckle]
                else:
                    pose.fk[k] = [0.5 * buckle * (1 - e) - 0.2 * e, 0.6 * buckle * (1 - 0.5 * e), -0.9 * buckle * (1 - 0.5 * e), 0.4 * buckle]
            pose.pitch = 0.22 * buckle * (1 - e)
            pose.off.z = -0.38 * buckle * (1 - e) + self.cfg.get('lie_lift', 0.2) * e - 0.0 * land
            pose.roll = side * (1.47 * e + 0.05 * math.sin(math.pi * land) * (1 - smooth((u - 0.6) / 0.3)))
            self.neck(pose, 0.25 * buckle + 0.35 * e, head=0.2 * e)
            pose.add('m_neck', Z, -side * 0.25 * e)
            self.tail(pose, 0, sway=0, lift=0.3 * e)
            pose.lean = 0.1 * buckle
        return pose


def fl_get(cfg, key, d):
    return cfg.get('flight', {}).get(key, d)


# ----------------------------------------------------------------------------------------------- rider
RIDER_LEGS = {  # straddle: direction of each leg bone in the rider's seat frame, left side (x mirrored for right)
    'thigh': (0.55, -0.72, -0.43), 'shin': (0.02, 0.22, -0.97), 'foot': (0.12, -0.9, -0.42), 'toe': (0.1, -1.0, -0.05),
}


def aim(rest3, d):
    y = rest3.col[1].normalized()
    return y.rotation_difference(Vector(d).normalized()).to_matrix() @ rest3


def solve_rider(rig, cr, pose, M, lib_pose, rbones, hips_rest, prev, frame):
    """Key the rider: hips ride the saddle (m_body) with the gait's bounce, the seat frame follows only part of
    the mount's pitch (a rider stays upright), legs straddle, upper body comes from the humanoid clip."""
    D = M['m_body'] @ cr.rest['m_body'].inverted()
    A = cr.root_matrix(pose).to_3x3()
    Dq = D.to_3x3().to_quaternion()
    Aq = (Matrix.Rotation(pose.roll, 3, 'Y') @ Matrix.Rotation(pose.yaw, 3, 'Z')).to_quaternion()
    F = Aq.slerp(Dq, pose.follow).to_matrix() @ Matrix.Rotation(pose.lean, 3, 'X')
    Mr = {}
    for n in R.order(rig):
        if n.startswith('m_'):
            continue
        b = rig.data.bones[n]; pb = rig.pose.bones[n]
        rest = b.matrix_local
        parentM = Mr[b.parent.name] if b.parent.name in Mr else M[b.parent.name]
        rel = b.parent.matrix_local.inverted() @ rest
        if n == 'root':
            Mb = D @ rest
        else:
            base = n.split('.')[0]
            if base in RIDER_LEGS:
                d = Vector(RIDER_LEGS[base])
                if n.endswith('.R'):
                    d.x = -d.x
                Rw = F @ aim(rest.to_3x3(), d)
            elif n == 'hips':
                Rw = F @ rest.to_3x3()
            else:
                Rw = F @ lib_pose[n].to_3x3().normalized()
            Mb = Rw.to_4x4(); Mb.translation = (parentM @ rel).translation
            if n == 'hips':
                Mb.translation = D @ hips_rest + F @ pose.seat
        Lb = rel.inverted() @ parentM.inverted() @ Mb
        q = Lb.to_quaternion()
        if n in prev and prev[n].dot(q) < 0:
            q.negate()
        prev[n] = q
        pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = q
        pb.keyframe_insert('rotation_quaternion', frame=frame, group=n)
        if n == 'hips':
            pb.location = Lb.translation; pb.keyframe_insert('location', frame=frame, group=n)
        Mr[n] = parentM @ rel @ Lb


def key_mount(rig, Q, prev, frame):
    for n, (q, loc) in Q.items():
        pb = rig.pose.bones[n]
        q = q.copy()
        if n in prev and prev[n].dot(q) < 0:
            q.negate()
        prev[n] = q
        pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = q
        pb.keyframe_insert('rotation_quaternion', frame=frame, group=n)
        if loc is not None:
            pb.location = loc; pb.keyframe_insert('location', frame=frame, group=n)


# ----------------------------------------------------------------------------------------------- checks
def owned(ob, rig, thr=0.25):
    """{bone: number of vertices it influences with weight >= thr}."""
    names = {g.index: g.name for g in ob.vertex_groups}
    cnt = {}
    for v in ob.data.vertices:
        for g in v.groups:
            if g.weight >= thr:
                cnt[names[g.group]] = cnt.get(names[g.group], 0) + 1
    return cnt


def dominant(ob, bones):
    names = {g.index: g.name for g in ob.vertex_groups}
    out = []
    for v in ob.data.vertices:
        if v.groups:
            g = max(v.groups, key=lambda g: g.weight)
            if names[g.group] in bones:
                out.append(v.index)
    return np.array(out, int)


def deformed(ob):
    oe = ob.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = oe.to_mesh()
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co)
    oe.to_mesh_clear()
    return co.reshape(-1, 3)


def check(rig, cr, lod0, lod1, flier, horse):
    """Fail loudly if the mount would play as a rigid block (the first v2 horses shipped that way)."""
    errs = []
    limb = [b for names in list(cr.info['legs'].values()) + list(cr.info['wings'].values()) for b in names]
    limb += cr.info['tail'] + cr.info['neck'] + ['m_head']
    for ob, need in ((lod0, 12), (lod1, 2)):
        cnt = owned(ob, rig)
        for b in limb:
            # short end bones (pasterns, tail tips) may own few vertices on the 750-tri LOD
            if cnt.get(b, 0) < need:
                errs.append(f'{ob.name}: bone {b} influences {cnt.get(b, 0)} vertices (< {need})')
    sc = bpy.context.scene
    body = dominant(lod1, {'m_body', 'm_chest'})
    def travel(clip, bones):
        act = bpy.data.actions[clip]
        R.set_action(rig, act)
        idx = dominant(lod1, set(bones))
        if not len(idx):
            return 0.0
        rel = []
        f0, f1 = act.frame_range
        for f in range(int(f0), int(f1) + 1):
            sc.frame_set(f)
            co = deformed(lod1)
            rel.append(co[idx].mean(0) - co[body].mean(0))
        rel = np.array(rel)
        return float(np.linalg.norm(rel.max(0) - rel.min(0)))
    if not flier:
        for clip, need in (('walk', 0.35), ('run', 0.45)):
            for k, names in cr.info['legs'].items():
                t = travel(clip, names[-2:])
                print(f'[creature] check {clip} hoof {k} travels {t:.2f} m relative to the body')
                if t < need:
                    errs.append(f'{clip}: hoof {k} moves only {t:.2f} m relative to the body (< {need})')
    else:
        for clip in ('idle', 'walk', 'run'):
            for k, names in cr.info['wings'].items():
                span = sum(cr.len[b] for b in names)
                t = travel(clip, names[-1:])
                print(f'[creature] check {clip} wing {k} tip travels {t:.2f} m (span {span:.2f})')
                if t < 0.3 * span:
                    errs.append(f'{clip}: wing {k} tip moves only {t:.2f} m (< 30 % of its {span:.2f} m span)')
    R.set_action(rig, None)
    if errs:
        raise RuntimeError('creature animation checks FAILED:\n  ' + '\n  '.join(errs))
    print('[creature] checks passed')


# ----------------------------------------------------------------------------------------------- team colour
def mat_images(ob):
    """(basecolour, normal, metal-rough) images of an object's first material."""
    nt = ob.material_slots[0].material.node_tree
    p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    def up(sock):
        return L._upstream_image(sock.links[0].from_node) if sock.is_linked else None
    return up(p.inputs['Base Color']), up(p.inputs['Normal']), up(p.inputs['Roughness'])


def wing_team(m0, info, strength):
    """Team-coloured wing membranes: the creature's own cloth (a chest bib, a saddle blanket) is invisible from
    the RTS camera, the wings are most of what it shows. Texels skinned to the wing bones are neutralised to a
    light grey that keeps the membrane's shading, and enter the team mask at `strength`."""
    names = {g.index: g.name for g in m0.vertex_groups}
    wing = {b for ns in info['wings'].values() for b in ns}
    wv = np.zeros(len(m0.data.vertices), np.float32)
    for v in m0.data.vertices:
        wv[v.index] = sum(g.weight for g in v.groups if names[g.group] in wing)
    base = mat_images(m0)[0]
    px = L.img_np(base); h, w = px.shape[:2]
    k = np.clip((L.raster_attr(m0, wv, w, h) - 0.45) / 0.3, 0, 1)
    k = k * k * (3 - 2 * k)
    rgb = px[..., :3]; lum = rgb.mean(2)
    ref = float(np.percentile(lum[k > 0.5], 85)) if (k > 0.5).any() else 1.0
    grey = np.clip(0.30 + 0.60 * lum / max(ref, 1e-3), 0, 0.95)
    px[..., :3] = rgb * (1 - k[..., None]) + grey[..., None] * k[..., None]
    L.np_img(base, px); base.pack()
    print(f'[creature] team wings: {float((k > 0.5).mean()) * 100:.1f}% of the atlas')
    return strength * k


def unit_atlas(uid, parts, extra):
    """One material + one team mask for the whole unit. parts = [(LOD0 object, asset id)]; rider and mount were
    baked to separate atlases, and the renderer has a single `tintMask` per unit sampled at UV0 -- so mounted
    heroes shipped with no team colour at all. The atlases are packed side by side, UVs remapped, and the masks
    (cleanup's cloth mask + `extra`[id], e.g. the wings) written to art-work/clean/<uid>_unit_team.png."""
    imgs = [mat_images(o) for o, _ in parts]
    sizes = [tuple(i[0].size) for i in imgs]
    masks = []
    for (o, pid), (w, h) in zip(parts, sizes):
        mp = L.WORK / 'clean' / f'{pid}_team.png'
        m = L.load_gray(mp, w, h) if mp.exists() else np.zeros((h, w), np.float32)
        if extra.get(pid) is not None:
            m = np.maximum(m, extra[pid])
        masks.append(m)
    out = L.WORK / 'clean' / f'{uid}_unit_team.png'
    if len(parts) == 1:
        L.save_gray(masks[0], out, 256, 256)
        parts[0][0]['team_frac'] = L.set_team_attr(parts[0][0], masks[0])
        return
    W = sum(w for w, _ in sizes); H = max(h for _, h in sizes)
    def canvas(k, name, div, non_color):
        img = bpy.data.images.new(name, W // div, H // div)
        if non_color:
            img.colorspace_settings.name = 'Non-Color'
        a = np.zeros((H // div, W // div, 4), np.float32); a[..., 3] = 1
        if k == 1:
            a[..., :3] = (0.5, 0.5, 1.0)                       # flat tangent normal in the unused corner
        x = 0
        for im, (w, h) in zip(imgs, sizes):
            src = L.img_np(im[k])
            sh, sw = src.shape[:2]
            a[:sh, x:x + sw] = src
            x += w // div
        L.np_img(img, a); img.pack()
        return img
    mdiv = sizes[0][0] // imgs[0][2].size[0]
    base = canvas(0, f'{uid}_base', 1, False); nrm = canvas(1, f'{uid}_normal', 1, True); mr = canvas(2, f'{uid}_mr', mdiv, True)
    mat = L.build_material(f'{uid}_mat', base, nrm, mr)
    mask = np.zeros((H, W), np.float32)
    x = 0
    for (o, pid), (w, h), m in zip(parts, sizes, masks):
        me = o.data
        uv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        uv[:, 0] = (uv[:, 0] * w + x) / W; uv[:, 1] = uv[:, 1] * h / H
        me.uv_layers.active.data.foreach_set('uv', uv.ravel())
        me.materials.clear(); me.materials.append(mat)
        mask[:h, x:x + w] = m
        x += w
    L.save_gray(mask, out, W // 4, H // 4)
    for o, _ in parts:
        o['team_frac'] = L.set_team_attr(o, mask)
    print(f'[creature] unit atlas {W}x{H}, team mask {out.name}')


# ----------------------------------------------------------------------------------------------- build
def append(path, names):
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = [n for n in names if n in src.objects]
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
    return {o.name: o for o in dst.objects}


def main():
    uid = L.argv()[0]
    a = L.assets()[uid]
    flier = a['kind'] == 'flier'
    mount_id = a.get('mount', uid)
    rider_id = a.get('rider')
    cfg = json.loads((L.ART / 'creatures.json').read_text())[mount_id]
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{mount_id}_clean.blend'))
    sc = bpy.context.scene; sc.render.fps = FPS
    m0 = bpy.data.objects[mount_id]; m1 = bpy.data.objects[f'{mount_id}_lod1']
    Hm = L.assets()[mount_id]['height'] if rider_id else a['height']
    # rig frame: face -Y, centred on x = 0
    fix = Matrix.Translation((-cfg.get('dx', 0.0), 0, 0)) @ Matrix.Rotation(math.radians(cfg.get('yaw', 0.0)), 4, 'Z')
    for o in (m0, m1):
        o.data.transform(fix); o.data.update()
    co = RG.surface_points(m0)
    if cfg.get('refine_hooves'):
        refine_hooves(cfg, co)
    rig, info = build_skeleton('rig', cfg)
    RG.skin(mount_id, rig, [m0, m1], Hm)
    meshes0, meshes1, weapons = [m0], [m1], []
    lib = None
    if rider_id:
        rpath = L.WORK / 'blend' / f'{rider_id}_rig.blend'
        objs = append(rpath, ['rig', rider_id, f'{rider_id}_lod1'] + [f'{w}_{s}' for w, s in a.get('weapons', [])] +
                      [f'{w}_{s}_lod1' for w, s in a.get('weapons', [])])
        rrig = next(o for o in objs.values() if o.type == 'ARMATURE')
        rrig.name = 'rider_rig'
        lib = RG.load_lib()
        hips = rrig.data.bones['hips'].head_local
        crotch = 0.5 * (rrig.data.bones['thigh.L'].head_local + rrig.data.bones['thigh.R'].head_local)
        rrig.location = Vector(cfg['seat']) + Vector((0, 0, -0.04)) - crotch
        bpy.context.view_layer.update()
        for o in objs.values():
            if o.type == 'MESH':
                (meshes1 if o.name.endswith('_lod1') else meshes0).append(o) if not o.name.startswith('weapon_') else weapons.append(o)
        wkeep = {o.name: (o.parent_bone, o.matrix_world.copy()) for o in weapons}
        mkeep = {o.name: o.matrix_world.copy() for o in list(meshes0[1:]) + list(meshes1[1:])}
        L.select_only(rig, rrig); rig.select_set(True); rrig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.join()
        L.select_only(rig); bpy.ops.object.mode_set(mode='EDIT')
        rig.data.edit_bones['root'].parent = rig.data.edit_bones['m_body']
        bpy.ops.object.mode_set(mode='OBJECT')
        for o in list(meshes0[1:]) + list(meshes1[1:]):
            for m in o.modifiers:
                if m.type == 'ARMATURE':
                    m.object = rig
            o.parent = rig
            bpy.context.view_layer.update(); o.matrix_world = mkeep[o.name]
        for o in weapons:
            pbn, mw = wkeep[o.name]
            o.parent = rig; o.parent_type = 'BONE'; o.parent_bone = pbn
            bpy.context.view_layer.update(); o.matrix_world = mw
        rig.data.bones['root'].use_deform = False
    # the appended rider rig drags its own active action (`idle`) along; left in place it took the name, so the
    # unit shipped a rider-only `idle` (mount frozen) and the real clip as `idle.001`
    for act in list(bpy.data.actions):
        if not act.name.startswith('lib_'):
            bpy.data.actions.remove(act)
    wings = wing_team(m0, info, cfg['team_wings']) if cfg.get('team_wings') and info['wings'] else None
    unit_atlas(uid, [(m0, mount_id)] + [(o, rider_id) for o in meshes0[1:]], {mount_id: wings})
    cr = Creature(rig, info, cfg, mount_id, flier)
    # ---- clips
    impact = int(round(a.get('impact', 0.42) * FPS))
    if rider_id:
        rbones = [b.name for b in lib.data.bones]
        hips_rest = rig.data.bones['hips'].head_local.copy()
        mapping = dict(RG.COMMON, **RG.CLIPSETS[a.get('clipset', 'sword')])
        ride = mapping['idle']
    facts_clips = {}
    for clip in CLIP_ORDER:
        n = FRAMES[clip]
        if flier and clip in ('idle', 'walk', 'run'):
            beats = FLAP[mount_id]
            n = beats[clip] if clip != 'idle' else beats['other'] * 2
        smp = None
        if rider_id:
            moving = clip in ('walk', 'run')
            src = bpy.data.actions[f'lib_{ride if moving else mapping[clip]}']
            nf = int(src.get('frames', src.frame_range[1] + 1))
            if not moving:
                n = nf - 1 if clip in LOOPS else nf           # loops: the source's last frame repeats its first
            smp = R.sample(lib, src, [0] if moving else list(range(nf)), rbones)
        act = bpy.data.actions.new(clip); act.use_fake_user = True
        R.set_action(rig, act)
        cr.prev_th = {}; cr.ik_err = 0.0
        prev, prev_r = {}, {}
        loop = clip in LOOPS
        total = n + 1 if loop else n                          # loops get a closing key identical to frame 0
        if loop and clip in GAITS and not flier:              # warm up the IK so frame 0 == frame n
            for f in range(n):
                cr.mount_matrices(cr.pose_at(clip, f, n, impact))
        for f in range(total):
            pose = cr.pose_at(clip, f % n if loop else f, n, impact)
            M, Q = cr.mount_matrices(pose)
            key_mount(rig, Q, prev, f)
            if rider_id:
                lp = smp[0] if clip in ('walk', 'run') else smp[(f % n) if loop else min(f, len(smp) - 1)]
                solve_rider(rig, cr, pose, M, lp, rbones, hips_rest, prev_r, f)
        R.set_action(rig, None)
        facts_clips[clip] = dict(frames=total, duration=round((total - 1) / FPS, 4), loop=loop)
        print(f'[creature] {clip}: {total} frames' + (f', worst planted-hoof error {cr.ik_err * 100:.1f} cm' if cr.ik_err else ''))
    if lib:
        bpy.data.objects.remove(lib, do_unlink=True)
    for act in list(bpy.data.actions):
        if act.name.startswith('lib_'):
            bpy.data.actions.remove(act)
    check(rig, cr, m0, m1, flier, cfg.get('refine_hooves', False))
    R.set_action(rig, bpy.data.actions['idle'])
    # merge LOD meshes (rider + mount) per LOD so a unit is one skinned mesh per LOD (+ rigid weapons)
    def merge(objs, name):
        for o in objs:
            if o.parent != rig:
                mw = o.matrix_world.copy(); o.parent = rig; o.matrix_world = mw
        L.select_only(*objs); bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active; ob.name = name; ob.data.name = name
        return ob
    lod0 = merge(meshes0, uid); lod1 = merge(meshes1, f'{uid}_lod1')
    for o in (lod0, lod1):
        if not any(m.type == 'ARMATURE' for m in o.modifiers):
            o.modifiers.new('Armature', 'ARMATURE').object = rig
    w0 = [o for o in weapons if not o.name.endswith('_lod1')]; w1 = [o for o in weapons if o.name.endswith('_lod1')]
    dst = L.OUT
    L.export_glb(dst / f'{uid}.glb', [rig, lod0] + w0, anims=True)
    if not a.get('squad'):
        L.export_glb(dst / f'{uid}_lod1.glb', [rig, lod1] + w1, anims=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / f'{uid}_rig.blend'), compress=True)
    facts = dict(id=uid, height=a['height'], tris_lod0=L.tris(lod0) + sum(L.tris(w) for w in w0),
                 tris_lod1=L.tris(lod1) + sum(L.tris(w) for w in w1), clips=facts_clips,
                 weapons=[dict(id=w.name.rsplit('_', 1)[0], node=w.name, bone=w.parent_bone) for w in w0],
                 team_frac=max(m0.get('team_frac', 0), 0.01), bones=[b.name for b in rig.data.bones],
                 mount=mount_id, rider=rider_id)
    (L.WORK / 'clean' / f'{uid}.json').write_text(json.dumps(facts, indent=1))
    print('[creature] done', uid, facts['tris_lod0'], facts['tris_lod1'])


if __name__ == '__main__':
    main()
