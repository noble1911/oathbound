"""Authored trappings ("candidate B" of the War Elephant A/B test): designed / hard-surface parts built as real
geometry in Blender with clean UVs and flat Codex art at native resolution. docs/ART.md section 10.

=== CONTRACT (cleanup.py's `parts` hook codes against this; keep it stable) ===================================

    import trappings
    ob = trappings.build(name, args, ctx)

  name : str   builder name, one of trappings.BUILDERS (caparison, barding, band, saddle, chamfron, howdah, shield,
               banner, pennant, quiver, lance). Unknown name -> KeyError.
  args : dict  the part's `args` from assets.json (builder-specific, all optional; see each builder's docstring).
  ctx  : dict  { 'id' / 'unit': unit id (str),
                 'asset': the unit's assets.json entry (dict),
                 'body': bpy mesh object of the organic body in UNIT space, or None (drape builders -- caparison,
                         barding, band, saddle, chamfron, howdah -- shrink onto it; without it they use a
                         parametric barrel from args['barrel']),
                 'faction': 'kingdom' | 'ashen' | 'caliphate' (optional; else args['faction'], else derived from
                         the asset's hue_map) }

  Returns ONE new mesh object, linked to the scene collection, in UNIT space (Blender: metres, +Z up, the model
  faces -Y, ground z = 0), transform applied (matrix_world = identity). The caller applies the part's own
  `pos` / `yaw` / `scale` afterwards (builders that drape on ctx['body'] are already in place: use pos 0).
  Hand-held builders (shield, banner, pennant, quiver, lance) are in the WEAPON frame instead: long axis +Z, head
  up, the grip at the origin, the camera-facing side towards -Y (rig.py: HOLDS).
    * one UV map 'UVMap', all islands inside 0..1. Islands never overlap, EXCEPT exact instances of one piece
      (mirrored flanks, repeated tassels / panels, the flipped back faces of thin cloth): those share texels.
    * ONE material (custom props `authored` = 1, `team_image`): Principled BSDF with an Image Texture on Base
      Color (sRGB, team cloth already neutralised to light grey), a tangent normal map, and one metal/rough image
      (G = roughness, B = metal) through a Separate Color node -- the same node layout as art_lib.build_material.
    * ob['team_image'] : name of a bpy.data.images greyscale (non-colour) image in the SAME UVs, 1 = team cloth
      (OR this into the unit team mask). '' = no team cloth. A vertex attribute `_TEAM` holds the same mask.
    * ob['texel'] : texels per metre of the authored basecolour (float; a hint for uv_boost / atlas packing)
    * ob['double_sided'] : always 0 -- thin cloth gets flipped back faces instead (works with single-sided
      materials, costs triangles only on the cloth).
    * mesh attribute '_RIGID' is NOT set here: `bone` in the part config decides skinning.
    * args['tris'] is a soft budget where a builder supports it (grid resolution); args['tex'] caps the part's own
      atlas (default 1024, shields 512), args['texel'] the wanted texels per metre, args['metal_max'] the
      metalness cap (default 0.3: the engine has no environment map, full metal renders black).
  The object is both the bake source and the low mesh (bake with an emit pass from itself, or copy texels).

  trappings.BUILDERS : dict name -> function(args, ctx) -> trappings_lib.Kit (build() finishes it)
  trappings_lib.flat(name) -> source from art-work/flat/<name>.png (a placeholder when the file is missing, so
                              builds never fail on missing art; node tools/art/flat.mjs <name> generates it)

Test harness (EEVEE previews, team cloth shown in blue):
  blender -b --factory-startup --python tools/art/blender/trappings.py -- test <builder> '<args json>' out.png ['<body json>']
  blender -b --factory-startup --python tools/art/blender/trappings.py -- sheet out_dir          (every builder)
  body json: {"glb": path, "height": m, "yaw": deg, "feet_span": m, "fore_y": m}  (as cleanup places a mount) or
             {"blend": path, "object": name}
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Matrix, Vector

import trappings_lib as T

LOOK = {
    'kingdom': dict(metal='steel', trim='gold', wood='oak', leather='leather', cap='caparison_kingdom', band='band_kingdom',
                    banner='banner_kingdom', chamfron='chamfron_kingdom', panel=None, scales=(0.72, 0.76, 0.86), tassel=(0.85, 0.62, 0.18),
                    shield='kite'),
    'ashen': dict(metal='bronze', trim='bronze', wood='wood_dark', leather='leather_dark', cap='caparison_ashen', band='band_ashen',
                  banner='banner_ashen', chamfron='chamfron_ashen', panel=None, scales=(0.62, 0.56, 0.42), tassel=(0.36, 0.3, 0.24),
                  shield='grave'),
    'caliphate': dict(metal='gold', trim='gold', wood='wood_dark', leather='leather_red', cap='caparison_sun', band='band_sun',
                      banner='banner_sun', chamfron='chamfron_sun', panel='howdah_panel_sun', scales=(1, 1, 1), tassel=(0.06, 0.62, 0.56),
                      shield='sun'),
}


def faction_of(args, ctx):
    f = args.get('faction') or ctx.get('faction')
    if f:
        return f
    hm = (ctx.get('asset') or {}).get('hue_map')
    if hm:
        return 'ashen' if abs(hm[0][2] - 0.37) < 0.06 else 'caliphate'
    return 'kingdom'


def band_src(name, width):
    """One strip of a 3-strip band image as a tiling source `width` metres wide."""
    s = T.flat(name, crop=(0, 0, 1, 1 / 3), rough=0.8, metal_gold=0.3, bump=0.006)
    h, w = s.col.shape[:2]
    v = s.variant(); v.tile = (width * w / h, width); v.team = s.team; v.h = s.h; v.bump = s.bump
    return v


def tassels(kit, pos, look, length=0.2, mirror=True, w=0.9):
    """A tassel master at pos[0] + copies at the other positions."""
    if not len(pos):
        return
    p0 = Vector(pos[0]); L_ = length; k = L_ / 0.24
    cap = T.lathe('tassel_cap', [(0.0, -0.085 * k), (0.034 * k, -0.075 * k), (0.042 * k, -0.045 * k), (0.03 * k, -0.012 * k), (0.008 * k, 0.0), (0.006 * k, 0.05 * k)], nseg=6, centre=p0)
    sk = T.lathe('tassel', [(0.0, -L_), (0.05 * k, -L_ + 0.005), (0.043 * k, -0.16 * k), (0.027 * k, -0.07 * k)], nseg=7, centre=p0)
    copies = [Matrix.Translation(Vector(p) - p0) for p in pos[1:]]
    kit.add(cap, look['trim'], w=w, copies=copies, mirror=mirror, jitter=0)
    src = T.tile('tassel').variant(tint=look['tassel']); src.tile = (0.25, 1.0)
    kit.add(sk, src, w=w, copies=copies, mirror=mirror, jitter=0)


def _drape(args, ctx):
    # `barrel` given: drape on that parametric barrel even when a body exists (a skeleton or a feathered body
    # has no clean back surface to cast onto: ribs, wing roots and feathers catch the rays)
    if args.get('barrel'):
        return T.Drape(None, args['barrel'])
    return T.Drape(ctx.get('body'), args.get('barrel'))


def _span(D, args, f0, f1):
    L_ = D.hi[1] - D.lo[1]
    return args.get('y0', D.lo[1] + f0 * L_), args.get('y1', D.lo[1] + f1 * L_)


def _hem_shape(P, kind, amp, seed=3):
    """Shape the last row (the hem) of a sheet P (ncol, nrow, 3)."""
    n = P.shape[0]
    if kind == 'scallop':
        P[:, -1, 2] += amp * np.abs(np.sin(np.linspace(0, math.pi * (n - 1) / 2, n)))
    elif kind == 'tatter':
        rng = np.random.default_rng(seed)
        P[:, -1, 2] += amp * rng.random(n) ** 2 * 2.0
        P[:, -2, 2] = np.maximum(P[:, -2, 2], P[:, -1, 2] + 0.01)
    elif kind == 'dags':
        P[1::2, -1, 2] += amp


# ----------------------------------------------------------------------------------------------- body cloth
def caparison(args, ctx):
    """Draped cloth over the back and flanks, one flank authored and mirrored; the image panel (3:2 flat art, team
    field) hangs from the hem up, plain team cloth above it to the spine.
    args: y0, y1 (m along the body; default 30 %..78 % of its length), hem (absolute z of the hem; default just
    under the belly), drop (panel height, default (y1-y0)/1.5), off (0.03 m above the skin), cols 25, rows_top 4,
    rows_low 12, art (flat name), hem_shape straight|scallop|tatter|dags, hem_amp, wave (0.03 fold amplitude),
    flare (0.05), tassels (bool), tassel_len, top ('cloth_team' tile above the panel)."""
    look = LOOK[faction_of(args, ctx)]
    D = _drape(args, ctx)
    y0, y1 = _span(D, args, 0.30, 0.78)
    top, belly = D.spine(0.5 * (y0 + y1)) or (D.hi[2], D.lo[2])
    hem = args.get('hem', belly - 0.12 * (top - belly))
    drop = args.get('drop', (y1 - y0) / 1.5)
    cols, rt, rl = args.get('cols', 25), args.get('rows_top', 4), args.get('rows_low', 12)
    ys = np.linspace(y0, y1, cols)
    P, A = D.sheet(ys, args.get('off', 0.03), lambda y: hem, rt, rl, drop=drop, axis_z=args.get('axis_z'))
    S = A[:, -1]
    frac = np.clip((A - (S[:, None] - drop)) / drop, None, 1)                 # 0 at the panel top, 1 at the hem
    hang = np.clip((frac - 0.45) / 0.55, 0, 1)
    P[:, :, 0] += args.get('wave', 0.03) * hang ** 1.5 * np.sin(2 * math.pi * ys[:, None] / 0.46 + 0.6) + args.get('flare', 0.05) * hang ** 2
    _hem_shape(P, args.get('hem_shape', 'straight'), args.get('hem_amp', 0.08))
    kit = T.Kit(args.get('name', 'caparison'))
    mid = 0.5 * (top + belly)
    ref = lambda c: (0, c.y, mid)
    UV = np.zeros(P.shape[:2] + (2,))
    UV[:, :, 0] = ((ys - y0) / (y1 - y0))[:, None]; UV[:, :, 1] = np.clip(1 - frac, 0, 1)
    low = T.orient_out(T.grid_mesh('cap_panel', P[:, rt:], UV[:, rt:]), ref)
    kit.add(low, T.flat(args.get('art', look['cap']), rough=0.85, metal_gold=0.3, bump=0.006), w=1.0, mirror=True, double=True)
    if rt > 0:
        UVt = np.zeros((cols, rt + 1, 2)); UVt[:, :, 0] = ys[:, None]; UVt[:, :, 1] = -A[:, :rt + 1]
        kit.add(T.orient_out(T.grid_mesh('cap_top', P[:, :rt + 1], UVt), ref), args.get('top', 'cloth_team'), w=0.7, mirror=True, jitter=0)
    if args.get('tassels', True):
        tassels(kit, [P[i, -1] + np.array([0.0, 0, -0.01]) for i in range(1, cols, 2)], look, args.get('tassel_len', 0.2))
    return kit


def barding(args, ctx):
    """Scale / plate armour sheets draped over shoulders and haunches (or the whole flank).
    args: ranges [[ya, yb], ...] (m along the body; default the fore and hind quarters), hem (z), hem_shape
    (scallop), off 0.035, cols 9, rows 16, tile ('scales'), tint."""
    look = LOOK[faction_of(args, ctx)]
    D = _drape(args, ctx)
    L_ = D.hi[1] - D.lo[1]
    rng = args.get('ranges') or [[D.lo[1] + 0.2 * L_, D.lo[1] + 0.34 * L_], [D.lo[1] + 0.72 * L_, D.lo[1] + 0.86 * L_]]
    kit = T.Kit(args.get('name', 'barding'))
    src = T.tile(args.get('tile', 'scales')).variant(tint=args.get('tint', look['scales']))
    for k, (a, b) in enumerate(rng):
        top, belly = D.spine(0.5 * (a + b)) or (D.hi[2], D.lo[2])
        hem = args.get('hem', belly + 0.3 * (top - belly))
        n = args.get('cols', 9)
        yb = np.linspace(a, b, n)
        P, A = D.sheet(yb, args.get('off', 0.035), lambda y: hem, args.get('rows', 16) * 2 // 3, args.get('rows', 16) // 3, smooth_n=1, axis_z=args.get('axis_z'))
        _hem_shape(P, args.get('hem_shape', 'scallop'), args.get('hem_amp', 0.05))
        UV = np.zeros(P.shape[:2] + (2,)); UV[:, :, 0] = yb[:, None]; UV[:, :, 1] = -A
        mid = 0.5 * (top + belly)
        kit.add(T.orient_out(T.grid_mesh(f'barding{k}', P, UV), lambda c: (0, c.y, mid)), src, mirror=True, jitter=0)
    return kit


def band(args, ctx):
    """Ornamental / leather bands wrapped around the neck, the barrel or the legs.
    args: rings [{ "c0": [x,y,z], "c1": [x,y,z] (the two ends of the band's axis), "nseg": 20, "mirror": false,
    "off": 0.03, "start_r": 2.0 }], art (3-strip band image; default the faction's), tile (a tile name instead:
    'leather'), tassels [[x,y,z], ...]."""
    look = LOOK[faction_of(args, ctx)]
    D = _drape(args, ctx)
    kit = T.Kit(args.get('name', 'band'))
    for k, r in enumerate(args.get('rings', [])):
        c0, c1 = Vector(r['c0']), Vector(r['c1'])
        wid = (c1 - c0).length
        nseg = r.get('nseg', 20)
        P = D.ring(lambda t: c0.lerp(c1, t), c1 - c0, r.get('off', 0.03), nseg, 3, r.get('start_r'))
        rad = float(np.mean(np.linalg.norm(P[:, 1] - np.array(c0.lerp(c1, 0.5)), axis=1)))
        UV = np.zeros((nseg + 1, 3, 2)); UV[:, :, 0] = (np.arange(nseg + 1) / nseg * 2 * math.pi * rad)[:, None]; UV[:, :, 1] = np.linspace(0, wid, 3)[None, :]
        src = T.tile(args['tile']) if args.get('tile') else band_src(args.get('art', look['band']), wid)
        if not args.get('tile'):                              # a whole number of motif repeats around the ring
            rep = max(1, round(2 * math.pi * rad / src.tile[0])); UV[:, :, 0] *= rep * src.tile[0] / (2 * math.pi * rad)
        ob = T.grid_mesh(f'band{k}', P, UV, wrap_u=True)
        mid = c0.lerp(c1, 0.5)
        T.orient_out(ob, tuple(mid))
        kit.add(ob, src, w=r.get('w', 1.2), mirror=bool(r.get('mirror')), jitter=0)
    if args.get('tassels'):
        tassels(kit, args['tassels'], look, args.get('tassel_len', 0.2), mirror=args.get('tassel_mirror', True))
    return kit


def saddle(args, ctx):
    """Saddle + saddle cloth + girth for any mount (horse, camel, pegasus, wyvern, drake, roc).
    args: y (seat centre along the body; default 47 % of its length), length 0.52, width 0.24 (seat half width),
    cloth_drop 0.42 (cloth length down the flank, 0 = none), cloth ('cloth_team' tile | flat name), trim (band art),
    trim_w 0.06, girth true, stirrups true, pommel 0.09, cantle 0.13, off 0.015."""
    look = LOOK[faction_of(args, ctx)]
    D = _drape(args, ctx)
    L_ = D.hi[1] - D.lo[1]
    yc = args.get('y', D.lo[1] + 0.47 * L_); ln = args.get('length', 0.52); hw = args.get('width', 0.24)
    off = args.get('off', 0.015)
    kit = T.Kit(args.get('name', 'saddle'))
    top, belly = D.spine(yc) or (D.hi[2], D.lo[2])
    mid = 0.5 * (top + belly)
    ref = lambda c: (0, c.y, mid)
    # saddle cloth
    cd = args.get('cloth_drop', 0.42)
    if cd > 0:
        tw = args.get('trim_w', 0.06)
        ys = np.linspace(yc - ln / 2 - 0.1, yc + ln / 2 + 0.14, 9)
        hems = {}
        def hem(y):
            sp = D.spine(y) or (top, belly)
            return sp[0] - 10.0                                # arc-limited below: `drop` trims it
        P, A = D.sheet(ys, off, hem, 7, 2, drop=None, axis_z=mid)
        # cut every column at arc length cd (rows 0..6 down to cd - tw, rows 7..8 the trim)
        cols = []
        for i, y in enumerate(ys):
            h = D.profile(y, off, mid)
            if h is None:
                h = np.array([(0.0, top), (hw, mid)])
            line = np.vstack([h, [h[-1][0], h[-1][1] - 2.0]])
            cum = np.concatenate([[0], np.cumsum(np.linalg.norm(line[1:] - line[:-1], axis=1))])
            samp = np.concatenate([np.linspace(0, cd - tw, 7), [cd - tw, cd]])
            cols.append(np.stack([np.interp(samp, cum, line[:, 0]), np.full(9, y), np.interp(samp, cum, line[:, 1])], 1))
        P = np.array(cols)
        for _ in range(2):
            Q = P.copy(); Q[1:-1, :, 0] = 0.25 * P[:-2, :, 0] + 0.5 * P[1:-1, :, 0] + 0.25 * P[2:, :, 0]; Q[1:-1, :, 2] = 0.25 * P[:-2, :, 2] + 0.5 * P[1:-1, :, 2] + 0.25 * P[2:, :, 2]; P = Q
        arcs = np.concatenate([np.linspace(0, cd - tw, 7), [cd - tw, cd]])
        UV = np.zeros((9, 7, 2)); UV[:, :, 0] = ys[:, None]; UV[:, :, 1] = -arcs[None, :7]
        cl = args.get('cloth', 'cloth_team')
        csrc = T.tile(cl) if cl.startswith('cloth') or cl in ('leather', 'leather_dark', 'leather_red') else T.flat(cl)
        if not csrc.tile:
            UV[:, :, 0] = ((ys - ys[0]) / (ys[-1] - ys[0]))[:, None]; UV[:, :, 1] = 1 - arcs[None, :7] / (cd - tw)
        kit.add(T.orient_out(T.grid_mesh('saddle_cloth', P[:, :7], UV), ref), csrc, mirror=True, double=True, jitter=0)
        bs = band_src(args.get('trim', look['band']), tw)
        UVb = np.zeros((9, 2, 2)); UVb[:, :, 0] = (ys - ys[0])[:, None]; UVb[:, 0, 1] = tw; UVb[:, 1, 1] = 0
        kit.add(T.orient_out(T.grid_mesh('saddle_trim', P[:, 7:], UVb), ref), bs, mirror=True, double=True, jitter=0)
    # seat: a leather pad over the spine with pommel and cantle
    nj, ni = 9, 9
    Ps = np.zeros((ni, nj, 3)); UVs = np.zeros((ni, nj, 2))
    for j in range(nj):
        r = -1 + 2 * j / (nj - 1)                              # -1 front .. 1 back
        y = yc + r * ln / 2
        w_ = hw * (1 - 0.35 * abs(r) ** 2)
        h = D.profile(y, off + 0.012, mid)
        if h is None:
            h = np.array([(0.0, top), (hw, mid)])
        cum = np.concatenate([[0], np.cumsum(np.linalg.norm(h[1:] - h[:-1], axis=1))])
        rise = 0.035 + args.get('pommel', 0.09) * math.exp(-((r + 0.92) / 0.22) ** 2) + args.get('cantle', 0.13) * math.exp(-((r - 0.95) / 0.25) ** 2)
        for i in range(ni):
            s = -1 + 2 * i / (ni - 1)
            a = abs(s) * w_
            x = float(np.interp(a, cum, h[:, 0])) * (1 if s >= 0 else -1); z = float(np.interp(a, cum, h[:, 1]))
            Ps[i, j] = (x, y, z + rise * (1 - 0.75 * abs(s) ** 2.5))
            UVs[i, j] = (y, s * w_)
    seat = T.grid_mesh('saddle_seat', Ps, UVs)
    T.orient_out(seat, (0, yc, mid))
    kit.add(seat, look['leather'], w=1.2, jitter=0)
    if args.get('girth', True):
        P = D.ring(lambda t: (0, yc - 0.035 + 0.07 * t, mid), (0, 1, 0), 0.012, 20, 2)
        rad = float(np.mean(np.linalg.norm(P[:, 0, [0, 2]] - np.array([0, mid]), axis=1)))
        UV = np.zeros((21, 2, 2)); UV[:, :, 0] = (np.arange(21) / 20 * 2 * math.pi * rad)[:, None]; UV[:, 1, 1] = 0.07
        g = T.grid_mesh('girth', P, UV, wrap_u=True)
        T.orient_out(g, (0, yc, mid))
        kit.add(g, look['leather'], w=0.8, jitter=0)
    if args.get('stirrups', True):
        x = float(Ps[-1, nj // 2, 0]) + 0.02; z = float(Ps[-1, nj // 2, 2])
        sl = args.get('stirrup_len', 0.55)
        strap = T.beam('strap', (x + 0.03, yc - 0.05, z), (x + 0.07, yc - 0.08, z - sl), 0.035, 0.008, up=(1, 0, 0))
        kit.add(strap, look['leather'], w=0.7, mirror=True, jitter=0)
        ring = T.tube('stirrup', [(x + 0.07, yc - 0.08 + 0.06 * math.sin(t), z - sl - 0.06 + 0.06 * math.cos(t)) for t in np.linspace(0, 2 * math.pi, 9)], 0.008, nseg=4, cap=False)
        kit.add(ring, look['metal'], w=0.7, mirror=True, jitter=0)
    return kit


def chamfron(args, ctx):
    """Head plate from flat art (isolated on black), projected on the forehead / nose.
    args: origin [x,y,z] (a point in front of the top centre of the plate), down [x,y,z] (direction along the face,
    top to bottom), ray [x,y,z] (projection direction, into the head), height (plate length, m), width (scale of
    the art's width, 1.0), off 0.03, art, nu 11, nv 18, tassels [[x,y,z], ...]."""
    look = LOOK[faction_of(args, ctx)]
    src = T.flat(args.get('art', look['chamfron']), rough=0.42, metal=0.3, bump=0.012)
    D = _drape(args, ctx) if ctx.get('body') is not None else None
    hgt = args.get('height', 0.5)
    nu, nv = args.get('nu', 11), args.get('nv', 18)
    XY, UV = T.plate_grid(src, hgt, nu, nv)
    Tn = Vector(args.get('down', (0, -0.3, -0.954))).normalized()
    Dr = Vector(args.get('ray', (0, 0.954, -0.3))).normalized()
    if D is not None and 'origin' not in args:
        O = Vector((0, D.lo[1] - 0.2, D.hi[2] + 0.1))
    else:
        O = Vector(args.get('origin', (0, 0, hgt)))
    P = np.zeros((nu, nv, 3))
    off = args.get('off', 0.03)
    for j in range(nv):
        for i in range(nu):
            o = O + Tn * (-XY[i, j, 1]) + Vector((1, 0, 0)) * (XY[i, j, 0] * args.get('width', 1.0))
            p = D.project(o, Dr, off, miss=None) if D is not None else None
            P[i, j] = p if p is not None else o + Dr * args.get('miss', 0.25)
    for _ in range(2):                                         # relax so brow ridges do not dent the plate
        Q = P.copy()
        Q[1:-1, 1:-1] = 0.5 * P[1:-1, 1:-1] + 0.125 * (P[:-2, 1:-1] + P[2:, 1:-1] + P[1:-1, :-2] + P[1:-1, 2:])
        # only ever move the plate outwards (against the ray)
        d = ((Q - P) * np.array(Dr)).sum(2)
        P = P + np.minimum(d, 0)[..., None] * np.array(Dr)
    kit = T.Kit(args.get('name', 'chamfron'))
    ob = T.grid_mesh('chamfron', P, UV)
    T.orient_out(ob, tuple(O + Dr * 3.0))
    kit.add(ob, src, w=1.5, double=bool(args.get('double', False)))
    if args.get('tassels'):
        tassels(kit, args['tassels'], look, args.get('tassel_len', 0.2))
    return kit


def howdah(args, ctx):
    """A crew platform on a large mount: floor, panelled walls, rails, posts with finials, team-cloth swags, a flared
    skirt band, corner tassels, optional canopy.
    args: half_w 0.78, y0 -0.28, y1 1.62, z (floor underside; default the body top between y0..y1 + 0.04),
    wall 0.72, panel (flat art for the wall panels; default per faction, None = planks), swags true, skirt true,
    canopy false, canopy_h 1.25."""
    look = LOOK[faction_of(args, ctx)]
    x1 = args.get('half_w', 0.78); ya, yb = args.get('y0', -0.28), args.get('y1', 1.62)
    if 'z' in args:
        z0 = args['z']
    elif ctx.get('body') is not None:
        D = _drape(args, ctx)
        z0 = max((D.spine(y) or (0, 0))[0] for y in np.linspace(ya, yb, 9)) + 0.04
    else:
        z0 = 0.0
    zf = z0 + 0.1; zt = zf + args.get('wall', 0.72)
    kit = T.Kit(args.get('name', 'howdah'))
    wood, gold = look['wood'], look['trim']
    th = 0.05
    ym = 0.5 * (ya + yb)
    kit.add(T.box('floor', (-x1, ya, z0), (x1, yb, zf)), wood, w=0.4)
    zb = zf - 0.06
    panel = args.get('panel', look['panel'])
    # wall panels: one master quad (local: x = width, z = height, facing -y) instanced on every side
    def M(o, right, up):
        o = Vector(o); right = Vector(right); up = Vector(up)
        n = up.cross(right).normalized()
        return Matrix(((right.x, n.x, up.x, o.x), (right.y, n.y, up.y, o.y), (right.z, n.z, up.z, o.z), (0, 0, 0, 1)))
    Ms = []
    hpan = zt - zb
    for sx in (1, -1):
        for (a, b) in ((ya, ym), (ym, yb)):
            Ms.append(M((sx * x1, a if sx > 0 else b, zb), (0, (b - a) * sx, 0), (0, 0, hpan)))
    for sy, yy in ((-1, ya), (1, yb)):
        for (a, b) in ((-x1, 0), (0, x1)):
            Ms.append(M((a if sy < 0 else b, yy, zb), ((b - a) * -sy, 0, 0), (0, 0, hpan)))
    master = T.quad('panel', (0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1))
    master.data.transform(Ms[0])
    inv = Ms[0].inverted()
    if panel:
        psrc = T.flat(panel, rough=0.55, metal_gold=0.3, bump=0.012)
    else:
        psrc = T.tile(wood); T.set_uv(master, T.get_uv(master) * ((yb - ya) / 2, hpan))
    kit.add(master, psrc, w=1.6, copies=[m @ inv for m in Ms[1:]], jitter=0)
    for sx in (1, -1):
        kit.add(T.box('wall', (sx * x1 - (th if sx > 0 else 0) - 0.004 * sx, ya, zf), (sx * x1 + (0 if sx > 0 else th) - 0.004 * sx, yb, zt - 0.002)), wood, w=0.4)
    for sy, yy in ((-1, ya), (1, yb)):
        kit.add(T.box('wall', (-x1, yy - (0 if sy < 0 else th) - 0.004 * sy, zf), (x1, yy + (th if sy < 0 else 0) - 0.004 * sy, zt - 0.002)), wood, w=0.4)
    r = 0.045
    for z in (zt, zb):
        hh = 0.035 if z == zt else 0.03
        for lo, hi in (((-x1 - r, ya - r, z - hh), (-x1 + r + th, yb + r, z + hh)), ((x1 - r - th, ya - r, z - hh), (x1 + r, yb + r, z + hh)),
                       ((-x1, ya - r, z - hh), (x1, ya + r + th, z + hh)), ((-x1, yb - r - th, z - hh), (x1, yb + r, z + hh))):
            kit.add(T.box('rail', lo, hi), gold, w=0.7)
    can = args.get('canopy', False)
    ch = args.get('canopy_h', 1.25)
    posts = [(sx * x1, yy) for sx in (1, -1) for yy in (ya, ym, yb)]
    for (px, py) in posts:
        corner = py != ym
        tall = zt + ((ch if can else 0.2) if corner else 0.1)
        kit.add(T.box('post', (px - 0.065, py - 0.065, zb - 0.1), (px + 0.065, py + 0.065, tall), long_axis=2), wood, w=0.5)
        s = 1.0 if corner else 0.75
        prof = [(0.085 * s, 0.0), (0.095 * s, 0.03), (0.05 * s, 0.06), (0.075 * s, 0.11), (0.085 * s, 0.16), (0.055 * s, 0.22), (0.02 * s, 0.27), (0.012 * s, 0.34), (0.0, 0.36)]
        if not (can and corner):
            kit.add(T.lathe('finial', prof, nseg=8, centre=(px, py, tall)), gold, w=0.8, jitter=0)
        kit.add(T.box('collar', (px - 0.08, py - 0.08, zt - 0.05), (px + 0.08, py + 0.08, zt + 0.05)), gold, w=0.7)
    if args.get('swags', True):
        def swag(p_a, p_b, out, drop=0.3, n=11, rows=5):
            a = np.array(p_a); b = np.array(p_b); o = np.array(out)
            P = np.zeros((n, rows, 3)); UV = np.zeros((n, rows, 2))
            ln = np.linalg.norm(b - a)
            for i in range(n):
                u = i / (n - 1); sag = math.sin(math.pi * u)
                for j in range(rows):
                    v = j / (rows - 1)
                    d = (0.1 + drop * sag) * v
                    pleat = 0.022 * math.sin(u * math.pi * 7) * v
                    P[i, j] = a + (b - a) * u + o * (0.07 + 0.05 * math.sin(math.pi * v) + pleat) + np.array([0, 0, 0.03 - d])
                    UV[i, j] = (u * ln, -d)
            return T.grid_mesh('swag', P, UV)
        sw = []
        for sx in (1, -1):
            for (a, b) in ((ya, ym), (ym, yb)):
                sw.append(swag((sx * x1, a + 0.07, zt), (sx * x1, b - 0.07, zt), (sx, 0, 0)))
        for sy, yy in ((-1, ya), (1, yb)):
            for (a, b) in ((-x1, 0), (0, x1)):
                sw.append(swag((a + 0.07, yy, zt), (b - 0.07, yy, zt), (0, sy, 0), drop=0.26))
        for o in sw:
            T.orient_out(o, lambda c: (0, ym, c.z))
            kit.add(o, 'cloth_team', w=0.8, double=True, jitter=0)
    if args.get('skirt', True):
        nseg = 28
        ring = []
        for i in range(nseg):
            t = 2 * math.pi * i / nseg
            cx, sy_ = math.cos(t), math.sin(t)
            rr = (abs(cx) ** 4 + abs(sy_) ** 4) ** (-0.25)
            ring.append((rr * cx, rr * sy_))
        ring = np.array(ring)
        Ps = np.zeros((nseg, 3, 3))
        for j, (grow, zz) in enumerate(((0.0, zb - 0.02), (0.1, zb - 0.2), (0.17, zb - 0.42))):
            Ps[:, j, 0] = ring[:, 0] * (x1 + 0.03 + grow); Ps[:, j, 1] = ym + ring[:, 1] * ((yb - ya) / 2 + 0.03 + grow); Ps[:, j, 2] = zz
        Ps[:, 2, 2] -= 0.06 * np.abs(ring[:, 0])
        bs = band_src(args.get('band', look['band']), 0.42)
        per = float(np.linalg.norm(np.roll(Ps[:, 1], -1, 0) - Ps[:, 1], axis=1).sum())
        rep = max(1, round(per / bs.tile[0]))
        UVs = np.zeros((nseg + 1, 3, 2)); UVs[:, :, 0] = (np.arange(nseg + 1) / nseg * rep * bs.tile[0])[:, None]; UVs[:, :, 1] = np.array([0.42, 0.21, 0])[None, :]
        sk = T.grid_mesh('skirt', Ps, UVs, wrap_u=True)
        T.orient_out(sk, lambda c: (0, ym, c.z))
        kit.add(sk, bs, w=1.0, double=True, jitter=0)
    if can:                                                    # tented canopy in team cloth with a trim band and a finial
        zc = zt + ch
        n = 9
        P = np.zeros((4 * (n - 1), 4, 3)); k = 0
        cornersq = [(-x1, ya), (x1, ya), (x1, yb), (-x1, yb)]
        edge = []
        for c in range(4):
            a = np.array(cornersq[c]); b = np.array(cornersq[(c + 1) % 4])
            for i in range(n - 1):
                edge.append(a + (b - a) * i / (n - 1))
        edge = np.array(edge); cen = np.array([0, ym])
        for j, (f, dz) in enumerate(((1.08, -0.16), (1.06, 0.0), (0.5, 0.3), (0.0, 0.52))):
            P[:, j, 0] = cen[0] + (edge[:, 0] - cen[0]) * f; P[:, j, 1] = cen[1] + (edge[:, 1] - cen[1]) * f; P[:, j, 2] = zc + dz
        per = float(np.linalg.norm(np.roll(edge, -1, 0) - edge, axis=1).sum())
        UV = np.zeros((4 * (n - 1) + 1, 4, 2)); UV[:, :, 0] = (np.arange(4 * (n - 1) + 1) / (4 * (n - 1)) * per)[:, None]; UV[:, :, 1] = np.array([0, 0.16, 0.9, 1.6])[None, :]
        roof = T.grid_mesh('canopy', P[:, 1:], UV[:, 1:], wrap_u=True)
        T.orient_out(roof, (0, ym, zc - 1))
        kit.add(roof, 'cloth_team', w=0.8, double=True, jitter=0)
        bs = band_src(args.get('band', look['band']), 0.16)
        rep = max(1, round(per / bs.tile[0])); UVv = UV[:, :2].copy(); UVv[:, :, 0] *= rep * bs.tile[0] / per
        val = T.grid_mesh('valance', P[:, :2], UVv, wrap_u=True)
        T.orient_out(val, (0, ym, zc - 1))
        kit.add(val, bs, w=1.0, double=True, jitter=0)
        kit.add(T.lathe('finial', [(0.06, 0.0), (0.1, 0.05), (0.05, 0.1), (0.08, 0.17), (0.02, 0.26), (0.0, 0.36)], nseg=8, centre=(0, ym, zc + 0.5)), gold, w=0.8, jitter=0)
    if args.get('tassels', True):
        tassels(kit, [(x1 + 0.09, ya - 0.09, zt - 0.06), (x1 + 0.09, yb + 0.09, zt - 0.06)], look, 0.22)
    return kit


# ----------------------------------------------------------------------------------------------- hand-held
SHIELDS = dict(kite=('shield_kingdom_kite', 0.95, 'x', 0.07), round=('shield_kingdom_round', 0.70, 'r', 0.06), grave=('shield_grave', 0.95, 'x', 0.07),
               sun=('shield_sun', 0.75, 'r', 0.09), tower=('shield_tower_ossuary', 1.7, 'x', 0.12))


def shield(args, ctx):
    """A shield whose face is flat heraldic art (isolated on black; its silhouette is the outline).
    args: kind kite|round|grave|sun|tower (default per faction), art, height (m; `length` of the weapon asset),
    bulge (m), thick 0.025, back (tile: the faction's wood), nu 9, nv 13, strap true. Weapon frame: face -Y, centre
    at the origin."""
    look = LOOK[faction_of(args, ctx)]
    kind = args.get('kind', look['shield'])
    art, hgt, curve, bulge = SHIELDS[kind]
    hgt = args.get('height', hgt); bulge = args.get('bulge', bulge * hgt / SHIELDS[kind][1])
    src = T.flat(args.get('art', art), rough=0.6, metal_gold=0.3, bump=0.01)
    nu, nv = args.get('nu', 9), args.get('nv', 13)
    XY, UV = T.plate_grid(src, hgt, nu, nv, inset=2, cos=curve == 'r')
    hw = float(np.abs(XY[:, :, 0]).max())
    P = np.zeros((nu, nv, 3))
    for i in range(nu):
        for j in range(nv):
            x, y = XY[i, j]; z = y + hgt / 2
            d = 1 - (x / hw) ** 2 if curve == 'x' else 1 - min(1.0, (x * x + z * z) / (hgt / 2) ** 2)
            P[i, j] = (x, -bulge * d, z)
    kit = T.Kit(args.get('name', 'shield'))
    front = T.grid_mesh('shield_face', P, UV)
    T.orient_out(front, (0, 5, 0))
    kit.add(front, src, w=1.0)
    th = args.get('thick', 0.025)
    Pb = P.copy(); Pb[:, :, 1] += th
    UVb = np.zeros((nu, nv, 2)); UVb[:, :, 0] = Pb[:, :, 2]; UVb[:, :, 1] = Pb[:, :, 0]
    back = T.grid_mesh('shield_back', Pb, UVb)
    T.orient_out(back, (0, -5, 0))
    kit.add(back, args.get('back', look['wood']), w=0.45, jitter=0)
    # rim: the boundary loop joins face and back
    idx = [(0, j) for j in range(nv)] + [(i, nv - 1) for i in range(1, nu)] + [(nu - 1, j) for j in range(nv - 2, -1, -1)] + [(i, 0) for i in range(nu - 2, 0, -1)]
    loop = np.array([P[i, j] for i, j in idx])
    arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.roll(loop, -1, 0) - loop, axis=1))])
    n = len(loop)
    Pr = np.zeros((n, 2, 3)); Pr[:, 0] = loop; Pr[:, 1] = loop + (0, th, 0)
    UVr = np.zeros((n + 1, 2, 2)); UVr[:, 0, 0] = arc; UVr[:, 1, 0] = arc; UVr[:, 1, 1] = th
    rim = T.grid_mesh('shield_rim', Pr, UVr, wrap_u=True)
    T.orient_out(rim, (0, th / 2, 0))
    kit.add(rim, look['metal'], w=0.6, jitter=0)
    if args.get('strap', True):
        kit.add(T.tube('strap', [(-0.12 * hgt, th + 0.005, 0.02), (0, th + 0.05, 0.02), (0.12 * hgt, th + 0.005, 0.02)], 0.014, nseg=4, cap=False, squash=(1, 2.2)), look['leather'], w=0.5, jitter=0)
    return kit


def _cloth_grid(w, h, nu, nv, wave, tail, tatter, seed=5):
    """A hanging cloth in the XZ plane (top edge z = 0, centred in x), waving in y. tail: 'point' | 'swallow' | None."""
    P = np.zeros((nu, nv, 3)); UV = np.zeros((nu, nv, 2))
    rng = np.random.default_rng(seed)
    for i in range(nu):
        u = i / (nu - 1)
        for j in range(nv):
            v = j / (nv - 1)
            z = -h * v
            if j == nv - 1:
                if tail == 'point':
                    z = -h * (0.82 + 0.18 * (1 - abs(2 * u - 1)))
                elif tail == 'swallow':
                    z = -h * (0.80 + 0.2 * abs(2 * u - 1))
                if tatter:
                    z += h * tatter * rng.random() ** 1.5
            P[i, j] = ((u - 0.5) * w, wave * v * math.sin(u * math.pi * 2.3 + v * 3.0) + 0.5 * wave * v * v, z)
            UV[i, j] = (u, 1 - v)
    return P, UV


def banner(args, ctx):
    """A standard: pole + finial + crossbar + a hanging cloth of flat art (both sides).
    args: length 2.9 (pole), grip_at 0.3 (fraction of the pole below the grip... the origin sits there), cloth
    [0.72, 1.08] (w, h), art (default the faction banner), tail point|swallow|none, tatter 0..0.3, wave 0.05,
    tassels true. Weapon frame: pole +Z, cloth faces -Y / +Y."""
    look = LOOK[faction_of(args, ctx)]
    L_ = args.get('length', 2.9); g = args.get('grip_at', 0.3) * L_
    cw, chh = args.get('cloth', (0.72, 1.08))
    kit = T.Kit(args.get('name', 'banner'))
    kit.add(T.tube('pole', [(0, 0, -g), (0, 0, L_ - g - 0.12)], 0.02, nseg=6), look['wood'], w=0.6, jitter=0)
    zt = L_ - g - 0.2
    kit.add(T.lathe('finial', [(0.022, 0.0), (0.045, 0.03), (0.02, 0.06), (0.05, 0.12), (0.03, 0.19), (0.0, 0.3)], nseg=7, centre=(0, 0, L_ - g - 0.14)), look['trim'], w=0.9, jitter=0)
    kit.add(T.tube('crossbar', [(-cw / 2 - 0.05, -0.03, zt), (cw / 2 + 0.05, -0.03, zt)], 0.014, nseg=5), look['wood'], w=0.6, jitter=0)
    for sx in (-1, 1):
        kit.add(T.sphere('knob', (sx * (cw / 2 + 0.06), -0.03, zt), 0.028, seg=6, rings=4), look['trim'], w=0.8, jitter=0)
    tat = args.get('tatter', 0.22 if faction_of(args, ctx) == 'ashen' else 0.0)
    P, UV = _cloth_grid(cw, chh, 9, 13, args.get('wave', 0.05), args.get('tail', 'point'), tat)
    P[:, :, 1] += -0.03 - 0.016; P[:, :, 2] += zt - 0.005
    cl = T.grid_mesh('banner_cloth', P, UV)
    T.orient_out(cl, (0, 5, zt))
    kit.add(cl, T.flat(args.get('art', look['banner']), rough=0.85, metal_gold=0.25, bump=0.004), w=1.0, double=True)
    if args.get('tassels', True) and not tat:
        tassels(kit, [P[0, -1] + (0, 0, -0.01), P[-1, -1] + (0, 0, -0.01)], look, 0.12, mirror=False)
    return kit


def pennant(args, ctx):
    """A flying team-cloth pennant on a short pole (siege engines, lances).
    args: pole 1.0, size [0.7, 0.3] (length, height at the hoist), tail swallow|point, wave 0.06, dir [x,y,z] the
    cloth flies towards (default +Y: backwards), cloth 'cloth_team'. Origin at the pole foot, pole +Z."""
    look = LOOK[faction_of(args, ctx)]
    pl = args.get('pole', 1.0); ln, hh = args.get('size', (0.7, 0.3))
    kit = T.Kit(args.get('name', 'pennant'))
    if pl > 0:
        kit.add(T.tube('pole', [(0, 0, 0), (0, 0, pl)], 0.014, nseg=5), look['wood'], w=0.6, jitter=0)
        kit.add(T.lathe('tip', [(0.016, 0.0), (0.03, 0.02), (0.014, 0.05), (0.022, 0.08), (0.0, 0.16)], nseg=6, centre=(0, 0, pl)), look['trim'], w=0.9, jitter=0)
    d = Vector(args.get('dir', (0, 1, 0))).normalized()
    side = d.cross(Vector((0, 0, 1))).normalized()
    nu, nv = 9, 4
    P = np.zeros((nu, nv, 3)); UV = np.zeros((nu, nv, 2))
    tail = args.get('tail', 'swallow')
    for i in range(nu):
        u = i / (nu - 1)
        for j in range(nv):
            v = j / (nv - 1)
            h_ = hh * (1 - 0.45 * u)
            z = pl - 0.04 - hh / 2 + (0.5 - v) * h_ - 0.08 * ln * u * u
            x = u * ln
            if i == nu - 1:
                x = ln * ((0.8 + 0.2 * abs(2 * v - 1)) if tail == 'swallow' else (0.8 + 0.2 * (1 - abs(2 * v - 1))))
            wv = args.get('wave', 0.06) * math.sin(u * math.pi * 2.5 + v) * u
            P[i, j] = np.array(d * x + side * wv) + (0, 0, z)
            UV[i, j] = (x, z)
    cl = T.grid_mesh('pennant_cloth', P, UV)
    kit.add(cl, args.get('cloth', 'cloth_team'), w=0.8, double=True, jitter=0)
    return kit


def quiver(args, ctx):
    """A leather quiver with a metal rim and three arrows. args: length 0.55, radius 0.06. Frame: axis +Z, mouth up,
    origin at the middle."""
    look = LOOK[faction_of(args, ctx)]
    L_ = args.get('length', 0.55); r = args.get('radius', 0.06)
    kit = T.Kit(args.get('name', 'quiver'))
    kit.add(T.tube('quiver', [(0, 0, -L_ / 2), (0, 0, 0), (0, 0, L_ / 2)], [r * 0.72, r * 0.93, r], nseg=7), look['leather'], jitter=0)
    kit.add(T.tube('rim', [(0, 0, L_ / 2 - 0.02), (0, 0, L_ / 2 + 0.012)], r * 1.1, nseg=7, cap=False), look['trim'], jitter=0)
    for k, (ox, oy) in enumerate(((0.02, 0.0), (-0.025, 0.012), (0.0, -0.025))):
        tip = (ox, oy, L_ / 2 + 0.16 + 0.02 * k)
        kit.add(T.tube('shaft', [(ox, oy, L_ / 2), tip], 0.006, nseg=3, cap=False), look['wood'], w=0.5, jitter=0)
        kit.add(T.tube('fletch', [(ox, oy, tip[2] - 0.1), (ox, oy, tip[2] - 0.05), tip], [0.006, 0.022, 0.012], nseg=4), 'fletch', w=0.5, jitter=0)
    return kit


def lance(args, ctx):
    """A lance / spear / pike: tapered wooden shaft, steel head, optional vamplate and team pennon.
    args: length 3.0, grip_at 0.3 (fraction from the butt), head 0.3 (m), radius 0.02, vamplate false, pennon false.
    Weapon frame: +Z = tip, the grip at the origin."""
    look = LOOK[faction_of(args, ctx)]
    L_ = args.get('length', 3.0); g = args.get('grip_at', 0.3) * L_; hd = args.get('head', 0.3); r = args.get('radius', 0.02)
    kit = T.Kit(args.get('name', 'lance'))
    sh = L_ - hd
    kit.add(T.tube('shaft', [(0, 0, -g), (0, 0, -g + sh * 0.5), (0, 0, -g + sh)], [r * 1.1, r, r * 0.8], nseg=6), look['wood'], w=0.7, jitter=0)
    z = -g + sh
    hdm = T.lathe('head', [(r * 0.95, 0.0), (r * 1.2, 0.03), (r * 0.9, 0.06), (r * 2.6, hd * 0.38), (r * 1.6, hd * 0.7), (0.0, hd)], nseg=6, centre=(0, 0, z))
    hdm.data.transform(Matrix.Translation((0, 0, z)) @ Matrix.Diagonal((1, 0.35, 1, 1)) @ Matrix.Translation((0, 0, -z)))
    kit.add(hdm, look['metal'], w=1.0, jitter=0)
    kit.add(T.tube('butt', [(0, 0, -g - 0.01), (0, 0, -g + 0.05)], r * 1.25, nseg=6), look['metal'], w=0.6, jitter=0)
    if args.get('vamplate'):
        kit.add(T.lathe('vamplate', [(r * 1.1, 0.0), (r * 5.5, 0.03), (r * 1.2, 0.2)], nseg=8, centre=(0, 0, 0.14)), look['metal'], jitter=0)
    if args.get('pennon'):
        pk = pennant(dict(pole=0, size=args.get('pennon_size', (0.55, 0.22)), faction=faction_of(args, ctx)), ctx)
        for it in pk.items:
            it['ob'].data.transform(Matrix.Translation((0, 0.02, z - 0.02)))
            kit.items.append(it)
    return kit


BUILDERS = dict(caparison=caparison, barding=barding, band=band, saddle=saddle, chamfron=chamfron, howdah=howdah,
                shield=shield, banner=banner, pennant=pennant, quiver=quiver, lance=lance)
TEX = dict(shield=512, pennant=256, quiver=256, lance=256, band=512, chamfron=512)


def build(name, args, ctx):
    """See the module docstring. -> one mesh object."""
    fn = BUILDERS[name]
    args = dict(args or {}); ctx = dict(ctx or {})
    kit = fn(args, ctx)
    kit.name = args.get('name', name)
    ob = kit.finish(tex=args.get('tex', TEX.get(name, 1024)), texel=args.get('texel', 700.0), metal_max=args.get('metal_max', 0.3))
    return ob


# =============================================================================================== test harness
def load_body(spec):
    import art_lib as L
    if 'blend' in spec:
        with bpy.data.libraries.load(spec['blend']) as (src, dst):
            dst.objects = [spec['object']]
        ob = dst.objects[0]; bpy.context.scene.collection.objects.link(ob)
        return ob
    objs = L.import_glb(Path(spec['glb']))
    ob = L.join_meshes(objs, 'body')
    co = L.verts_np(ob)
    yaw = L.best_yaw(co[:, :2], prefer_wide_x=False) if spec.get('align', True) else 0.0
    L.rotate_z(ob, yaw + math.radians(spec.get('yaw', 0)))
    L.ground_and_scale(ob, spec['height'])
    if spec.get('feet_span'):
        H = spec['height']
        co = L.verts_np(ob); low = co[co[:, 2] < 0.04 * H]
        ym = 0.5 * (low[:, 1].min() + low[:, 1].max())
        f, h = low[low[:, 1] < ym][:, 1].mean(), low[low[:, 1] >= ym][:, 1].mean()
        s = spec['feet_span'] / (h - f)
        ob.data.transform(Matrix.Diagonal((s, s, s, 1)))
        co = L.verts_np(ob); low = co[co[:, 2] < 0.04 * H * s]
        f = low[low[:, 1] < 0.5 * (low[:, 1].min() + low[:, 1].max())][:, 1].mean()
        xm = 0.5 * (low[:, 0].min() + low[:, 0].max())
        ob.data.transform(Matrix.Translation((-xm, spec.get('fore_y', -0.45) - f, 0)))
    ob.data.update()
    return ob


def tint_preview(ob, rgb=(0.10, 0.22, 0.85)):
    """Show the team mask in the preview: basecolour * mix(1, team colour, mask)."""
    if not ob.get('team_image'):
        return
    m = ob.data.materials[0]; nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    link = p.inputs['Base Color'].links[0]; base = link.from_socket
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = bpy.data.images[ob['team_image']]
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
    ins = [i for i in mix.inputs if i.type == 'RGBA']
    nt.links.new(t.outputs['Color'], mix.inputs[0]); nt.links.new(base, ins[0]); ins[1].default_value = (*rgb, 1)
    nt.links.new([o for o in mix.outputs if o.type == 'RGBA'][0], p.inputs['Base Color'])


def render_views(out, objs, views=None, res=(900, 900), bg=(0.55, 0.57, 0.62)):
    """EEVEE previews of objs from several views, montaged side by side -> out (png)."""
    sc = bpy.context.scene
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    w = bpy.data.worlds.get('pv') or bpy.data.worlds.new('pv')
    sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (*bg, 1); w.node_tree.nodes['Background'].inputs[1].default_value = 0.55
    for o in [o for o in bpy.data.objects if o.name.startswith('_pv')]:
        bpy.data.objects.remove(o, do_unlink=True)
    sun = bpy.data.objects.new('_pv_sun', bpy.data.lights.new('_pv_sun', 'SUN'))
    sun.data.energy = 3.4; sun.data.angle = 0.05; sun.rotation_euler = (math.radians(50), 0, math.radians(-40))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('_pv_cam', bpy.data.cameras.new('_pv_cam'))
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = 'PNG'
    sc.view_settings.view_transform = 'Standard'
    co = np.concatenate([T.verts(o) for o in objs])
    lo, hi = co.min(0), co.max(0); c = (lo + hi) / 2; size = float(np.linalg.norm(hi - lo)) * 1.02
    views = views or [(-35, 12), (-90, 5), (35, 12), (160, 15)]
    tiles = []
    out = str(out)
    for i, v in enumerate(views):
        az, el = v[0], v[1]
        tgt = Vector(v[2]) if len(v) > 2 else Vector(c)
        a = math.radians(az); e = math.radians(el)
        d = Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
        cam.location = tgt + d * 50
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        cam.data.type = 'ORTHO'; cam.data.ortho_scale = v[3] if len(v) > 3 else size; cam.data.clip_end = 200
        p = out.replace('.png', f'_{i}.png')
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        tiles.append(T.load_px(p))
        Path(p).unlink()
    sheet = np.concatenate(tiles, 1)
    img = bpy.data.images.new('_sheet', sheet.shape[1], sheet.shape[0], alpha=False)
    img.pixels.foreach_set(sheet.ravel()); img.filepath_raw = out; img.file_format = 'PNG'; img.save()
    return out


def save_atlas(ob, out):
    img = bpy.data.images.get(f'{ob.name}_base')
    if img:
        img.filepath_raw = str(out); img.file_format = 'PNG'; img.save()


SHEET = [
    ('shield_kite', 'shield', dict(kind='kite', faction='kingdom')), ('shield_round', 'shield', dict(kind='round', faction='kingdom')),
    ('shield_grave', 'shield', dict(kind='grave', faction='ashen')), ('shield_sun', 'shield', dict(kind='sun', faction='caliphate')),
    ('shield_tower', 'shield', dict(kind='tower', faction='ashen')),
    ('banner_sun', 'banner', dict(faction='caliphate')), ('banner_kingdom', 'banner', dict(faction='kingdom', tail='swallow')),
    ('banner_ashen', 'banner', dict(faction='ashen')),
    ('pennant', 'pennant', dict(faction='kingdom')), ('quiver', 'quiver', dict(faction='caliphate')),
    ('lance', 'lance', dict(faction='kingdom', vamplate=True, pennon=True)),
    ('howdah', 'howdah', dict(faction='caliphate')), ('howdah_canopy', 'howdah', dict(faction='caliphate', canopy=True)),
    ('caparison_barrel', 'caparison', dict(faction='kingdom', barrel=dict(y0=-0.7, y1=0.7, z=1.25, rx=0.33, rz=0.4), y0=-0.75, y1=0.75, hem=0.55, hem_shape='dags')),
    ('saddle_barrel', 'saddle', dict(faction='kingdom', barrel=dict(y0=-0.7, y1=0.7, z=1.25, rx=0.33, rz=0.4), y=0.0)),
]


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not argv:
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if argv[0] == 'test':
        name = argv[1]
        args = json.loads(argv[2]) if len(argv) > 2 and argv[2].lstrip().startswith('{') else {}
        out = next(a for a in argv[2:] if a.endswith('.png'))
        rest = [a for a in argv[3:] if a.lstrip().startswith('{')]
        body = load_body(json.loads(rest[0])) if rest else None
        ob = build(name, args, dict(id='test', asset={}, body=body))
        print(f'[trappings] {name}: {T.tris(ob)} tris, atlas {ob["atlas"]} px ({ob["fill"] * 100:.0f} % used), {ob["texel"]:.0f} px/m, team {bool(ob["team_image"])}')
        save_atlas(ob, out.replace('.png', '_atlas.png'))
        tint_preview(ob)
        views = json.loads(args['views']) if isinstance(args.get('views'), str) else args.get('views')
        render_views(out, [ob] + ([body] if body is not None and not args.get('hide_body') else []), views=views)
    elif argv[0] == 'unit':                                  # unit <parts json file | json> out.png '<body json>' ['<views json>']
        spec = json.loads(Path(argv[1]).read_text() if not argv[1].lstrip().startswith('[') else argv[1])
        out = argv[2]
        body = load_body(json.loads(argv[3])) if len(argv) > 3 and argv[3] != '-' else None
        views = json.loads(argv[4]) if len(argv) > 4 else None
        obs = []
        for p in spec:
            ob = build(p['builder'], dict(p.get('args', {}), name=p.get('name', p['builder'])), dict(id='test', asset={}, body=body, faction=p.get('faction')))
            print(f'[trappings] {ob.name}: {T.tris(ob)} tris, atlas {ob["atlas"]} px ({ob["fill"] * 100:.0f} % used), {ob["texel"]:.0f} px/m')
            tint_preview(ob, tuple(p.get('team', (0.10, 0.22, 0.85))))
            obs.append(ob)
        print('[trappings] total tris', sum(T.tris(o) for o in obs))
        render_views(out, obs + ([body] if body is not None else []), views=views)
    elif argv[0] == 'sheet':
        outd = Path(argv[1]); outd.mkdir(parents=True, exist_ok=True)
        only = argv[2].split(',') if len(argv) > 2 else None
        for label, name, args in SHEET:
            if only and label not in only:
                continue
            for o in list(bpy.data.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            ob = build(name, args, dict(id='test', asset={}, body=None))
            print(f'[trappings] {label}: {T.tris(ob)} tris, atlas {ob["atlas"]} px ({ob["fill"] * 100:.0f} % used), {ob["texel"]:.0f} px/m')
            save_atlas(ob, outd / f'{label}_atlas.png')
            tint_preview(ob)
            render_views(outd / f'{label}.png', [ob], res=(700, 700))


if __name__ == '__main__':
    main()
