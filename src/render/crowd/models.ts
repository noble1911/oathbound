// Procedural stand-in models for every unit (used until the art pipeline's GLBs land): rigged
// humanoids (variants by unit), horses + riders, pegasi, a golem, a dragon/wyvern and siege
// engines, each with a clip set: idle, move, run, attack, cast, hit, death (death holds).
import * as THREE from 'three';
import { RigBuilder, Pose, box, ball, limb, cone, disc, fan, clipFromPose, smooth, bump, type V3, type ClipSpec } from './rig.ts';

export type WeaponStyle = 'sword' | 'pike' | 'axe2h' | 'bow' | 'staff' | 'lance' | 'fists';

export interface HumanLook {
  skin: string;
  cloth: string;
  trim: string;
  metal: string;
  leather: string;
  body: 'tunic' | 'plate' | 'robe' | 'bare' | 'bones';
  helmet: 'cap' | 'hood' | 'greathelm' | 'hat' | 'none' | 'skull' | 'crown' | 'horned';
  weapon: WeaponStyle;
  shield?: 'round' | 'kite' | null;
  bulk?: number;
  cape?: boolean;
  quiver?: boolean;
  /** Emissive colour of a staff orb / glowing weapon. */
  glow?: string;
  glowStrength?: number;
}

export interface ModelBuild {
  rig: RigBuilder;
  clips: ClipSpec[];
  prefix: string;
}

const L = 1; // left = +X (the figure faces +Z)
const R = -1;

// ------------------------------------------------------------------ humanoid

function humanBones(rb: RigBuilder, s = 1): void {
  const v = (x: number, y: number, z = 0): V3 => [x * s, y * s, z * s];
  rb.bone('root', null, [0, 0, 0])
    .bone('hips', 'root', v(0, 0.98))
    .bone('spine', 'hips', v(0, 1.1))
    .bone('chest', 'spine', v(0, 1.3))
    .bone('head', 'chest', v(0, 1.55))
    .bone('uarm_l', 'chest', v(0.21, 1.46))
    .bone('farm_l', 'uarm_l', v(0.23, 1.19))
    .bone('uarm_r', 'chest', v(-0.21, 1.46))
    .bone('farm_r', 'uarm_r', v(-0.23, 1.19))
    .bone('weapon', 'farm_r', v(-0.24, 0.93))
    .bone('offhand', 'farm_l', v(0.24, 0.93))
    .bone('thigh_l', 'hips', v(0.1, 0.94))
    .bone('shin_l', 'thigh_l', v(0.1, 0.52))
    .bone('thigh_r', 'hips', v(-0.1, 0.94))
    .bone('shin_r', 'thigh_r', v(-0.1, 0.52));
}


export function buildHumanoid(prefix: string, look: HumanLook, scale = 1): ModelBuild {
  const rb = new RigBuilder(prefix);
  humanBones(rb, scale);
  const s = scale;
  const k = look.bulk ?? 1;
  const P = (x: number, y: number, z = 0): V3 => [x * s, y * s, z * s];
  const metal = { rough: 0.32, metal: 0.85 };
  const cloth = { rough: 0.85 };
  const leather = { rough: 0.6 };
  const skinC = look.body === 'bones' ? '#d9d2bd' : look.skin;
  const torsoC = look.body === 'plate' ? look.metal : look.body === 'bones' ? '#cfc8b0' : look.cloth;
  const torsoO = look.body === 'plate' ? metal : cloth;

  // legs
  for (const side of [L, R]) {
    const t = side === L ? 'thigh_l' : 'thigh_r';
    const sh = side === L ? 'shin_l' : 'shin_r';
    const x = 0.1 * side;
    const legC = look.body === 'plate' ? look.metal : look.body === 'bones' ? skinC : look.leather;
    rb.part(t, limb(P(x, 0.93), P(x, 0.55), 0.075 * k * s), legC, look.body === 'plate' ? metal : leather);
    rb.part(sh, limb(P(x, 0.52), P(x, 0.14), 0.062 * k * s), legC, look.body === 'plate' ? metal : leather);
    rb.part(sh, box(0.11 * k * s, 0.1 * s, 0.25 * s, P(x, 0.05, 0.045)), look.body === 'bones' ? skinC : '#3a2a1e', leather);
    if (look.body === 'plate') rb.part(sh, ball(0.07 * k * s, P(x, 0.53, 0.03)), look.metal, metal);
  }
  // pelvis + belt
  rb.part('hips', ball(0.17 * k * s, P(0, 0.97), [1.05, 0.7, 0.78]), torsoC, torsoO);
  rb.part('hips', limb(P(0, 0.99), P(0, 1.05), 0.165 * k * s, 0.165 * k * s, 'cyl', 12), look.leather, leather);
  // torso
  if (look.body === 'bones') {
    rb.part('chest', limb(P(0, 1.02), P(0, 1.42), 0.03 * s), skinC, cloth);
    for (let i = 0; i < 4; i++) rb.part('chest', limb(P(-0.12, 1.18 + i * 0.07, 0.02), P(0.12, 1.18 + i * 0.07, 0.02), 0.018 * s), skinC, cloth);
  } else {
    const g = limb(P(0, 1.1), P(0, 1.38), 0.17 * k * s, 0.17 * k * s, 'capsule', 12);
    g.translate(0, -1.24 * s, 0).scale(1.12, 1, 0.78).translate(0, 1.24 * s, 0);
    rb.part('chest', g, torsoC, torsoO);
  }
  // tabard / robe (team colour)
  if (look.body === 'robe') {
    rb.part('hips', cone(0.3 * k * s, 1.0 * s, P(0, 0.55), [0, 0, 0], 14), look.cloth, { ...cloth, tint: 0.85 });
    rb.part('hips', limb(P(0, 0.07), P(0, 0.14), 0.305 * k * s, 0.3 * k * s, 'cyl', 14), look.trim, cloth);
    rb.part('chest', limb(P(0, 1.08), P(0, 1.42), 0.18 * k * s, 0.15 * k * s, 'cyl', 12), look.cloth, { ...cloth, tint: 0.85 });
  } else if (look.body !== 'bones' && look.body !== 'bare') {
    rb.part('chest', box(0.3 * k * s, 0.42 * s, 0.03 * s, P(0, 1.18, 0.14 * k)), look.cloth, { ...cloth, tint: 1 });
    rb.part('hips', box(0.28 * k * s, 0.34 * s, 0.03 * s, P(0, 0.8, 0.13 * k), [-0.08, 0, 0]), look.cloth, { ...cloth, tint: 1 });
    rb.part('hips', box(0.28 * k * s, 0.32 * s, 0.03 * s, P(0, 0.82, -0.13 * k), [0.08, 0, 0]), look.cloth, { ...cloth, tint: 0.8 });
    rb.part('chest', box(0.31 * k * s, 0.04 * s, 0.035 * s, P(0, 1.39, 0.135 * k)), look.trim, { rough: 0.4, metal: 0.7 });
  } else if (look.body === 'bare') {
    rb.part('chest', box(0.34 * k * s, 0.1 * s, 0.3 * s, P(0, 1.42), [0, 0, 0]), '#5b4636', { rough: 0.95, tint: 0.35 }); // fur mantle
  }
  if (look.cape) {
    rb.part('chest', box(0.42 * k * s, 0.95 * s, 0.025 * s, P(0, 1.0, -0.19 * k), [0.12, 0, 0]), look.cloth, { ...cloth, tint: 1 });
  }
  if (look.quiver) rb.part('chest', limb(P(0.08, 1.05, -0.18), P(-0.12, 1.52, -0.2), 0.05 * s, 0.05 * s, 'cyl'), look.leather, leather);
  // arms
  for (const side of [L, R]) {
    const u = side === L ? 'uarm_l' : 'uarm_r';
    const f = side === L ? 'farm_l' : 'farm_r';
    const x = side;
    const armC = look.body === 'plate' ? look.metal : look.body === 'bare' || look.body === 'bones' ? skinC : look.cloth;
    const armO = look.body === 'plate' ? metal : cloth;
    rb.part(u, ball(0.085 * k * s, P(0.2 * x, 1.45)), look.body === 'plate' || look.body === 'tunic' ? look.metal : armC, look.body === 'robe' ? cloth : metal);
    rb.part(u, limb(P(0.21 * x, 1.44), P(0.23 * x, 1.2), 0.055 * k * s), armC, armO);
    rb.part(f, limb(P(0.23 * x, 1.18), P(0.24 * x, 0.98), 0.05 * k * s), look.body === 'robe' ? look.cloth : look.body === 'bare' || look.body === 'bones' ? skinC : look.leather, armO);
    rb.part(f, ball(0.048 * s, P(0.24 * x, 0.93)), look.body === 'plate' ? look.metal : skinC, look.body === 'plate' ? metal : { rough: 0.6 });
  }
  // neck + head
  rb.part('chest', limb(P(0, 1.45), P(0, 1.57), 0.05 * s), skinC, { rough: 0.6 });
  if (look.body === 'bones') {
    rb.part('head', ball(0.105 * s, P(0, 1.67), [0.9, 1, 1]), skinC, { rough: 0.7 });
    rb.part('head', box(0.035 * s, 0.03 * s, 0.02 * s, P(0.04, 1.68, 0.09)), '#140c0c', { emissive: 0 });
    rb.part('head', box(0.035 * s, 0.03 * s, 0.02 * s, P(-0.04, 1.68, 0.09)), '#140c0c');
    rb.part('head', ball(0.012 * s, P(0.04, 1.68, 0.098)), '#7fffd0', { emissive: 4 });
    rb.part('head', ball(0.012 * s, P(-0.04, 1.68, 0.098)), '#7fffd0', { emissive: 4 });
  } else {
    rb.part('head', ball(0.11 * s, P(0, 1.67), [0.92, 1.05, 1]), skinC, { rough: 0.55 });
  }
  switch (look.helmet) {
    case 'cap':
      rb.part('head', new THREE.SphereGeometry(0.122 * s, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(...P(0, 1.69)), look.metal, metal);
      rb.part('head', limb(P(0, 1.67), P(0, 1.69), 0.128 * s, 0.128 * s, 'cyl', 12), look.metal, metal);
      rb.part('head', box(0.02 * s, 0.1 * s, 0.03 * s, P(0, 1.65, 0.115)), look.metal, metal);
      break;
    case 'hood': {
      const g = ball(0.135 * s, P(0, 1.69, -0.01), [1, 1.06, 1.1], 12);
      rb.part('head', g, look.cloth, { ...cloth, tint: 0.9 });
      rb.part('head', cone(0.07 * s, 0.18 * s, P(0, 1.68, -0.15), [-1.9, 0, 0]), look.cloth, { ...cloth, tint: 0.9 });
      break;
    }
    case 'greathelm':
      rb.part('head', limb(P(0, 1.56), P(0, 1.8), 0.13 * s, 0.125 * s, 'cyl', 12), look.metal, metal);
      rb.part('head', ball(0.125 * s, P(0, 1.8), [1, 0.45, 1]), look.metal, metal);
      rb.part('head', box(0.17 * s, 0.018 * s, 0.03 * s, P(0, 1.7, 0.12)), '#0c0c10', { rough: 0.9 });
      rb.part('head', box(0.02 * s, 0.14 * s, 0.25 * s, P(0, 1.88, -0.02)), look.cloth, { ...cloth, tint: 1 }); // crest
      break;
    case 'horned':
      rb.part('head', new THREE.SphereGeometry(0.125 * s, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(...P(0, 1.69)), look.metal, metal);
      rb.part('head', limb(P(0.1, 1.74), P(0.24, 1.9, 0.05), 0.03 * s, 0.008 * s, 'cyl'), '#e8dcc0', { rough: 0.5 });
      rb.part('head', limb(P(-0.1, 1.74), P(-0.24, 1.9, 0.05), 0.03 * s, 0.008 * s, 'cyl'), '#e8dcc0', { rough: 0.5 });
      break;
    case 'hat':
      rb.part('head', disc(0.24 * s, 0.015 * s, P(0, 1.74), [0, 1, 0.08], 18), look.cloth, { ...cloth, tint: 0.85 });
      rb.part('head', cone(0.14 * s, 0.42 * s, P(0, 1.95, -0.03), [-0.25, 0, 0], 12), look.cloth, { ...cloth, tint: 0.85 });
      break;
    case 'crown':
      rb.part('head', ball(0.118 * s, P(0, 1.7, -0.01), [1, 0.9, 1.05]), '#4a3020', { rough: 0.8 }); // hair
      rb.part('head', limb(P(0, 1.75), P(0, 1.8), 0.12 * s, 0.125 * s, 'cyl', 14), '#e6b84a', { rough: 0.25, metal: 1, emissive: 0.15 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        rb.part('head', cone(0.022 * s, 0.07 * s, P(Math.sin(a) * 0.12, 1.83, Math.cos(a) * 0.12)), '#e6b84a', { rough: 0.25, metal: 1, emissive: 0.15 });
      }
      break;
    case 'none':
      rb.part('head', ball(0.116 * s, P(0, 1.7, -0.015), [1, 0.88, 1.05]), '#3b2a1c', { rough: 0.85 });
      break;
    case 'skull':
      break;
  }

  // weapons (modelled pointing +Z from the hand; the idle pose turns them upright)
  const hand = rb.pos('weapon');
  const hx = hand.x / s;
  const hy = hand.y / s;
  const W = (dx: number, dy: number, dz: number): V3 => P(hx + dx, hy + dy, dz);
  const glowC = look.glow ?? '#ff8a3a';
  switch (look.weapon) {
    case 'sword':
      rb.part('weapon', box(0.05 * s, 0.012 * s, 0.72 * s, W(0, 0, 0.47)), '#d4dae3', { rough: 0.22, metal: 1, emissive: look.glowStrength ? look.glowStrength * 0.3 : 0 });
      rb.part('weapon', box(0.2 * s, 0.035 * s, 0.04 * s, W(0, 0, 0.1)), '#b8913f', metal);
      rb.part('weapon', limb(W(0, 0, -0.06), W(0, 0, 0.09), 0.018 * s), '#3a2416', leather);
      break;
    case 'pike':
      rb.part('weapon', limb(W(0, 0, -1.2), W(0, 0, 2.35), 0.02 * s, 0.02 * s, 'cyl', 6), '#7a5534', leather);
      rb.part('weapon', cone(0.04 * s, 0.26 * s, W(0, 0, 2.48), [Math.PI / 2, 0, 0], 6), '#d4dae3', metal);
      rb.part('weapon', box(0.09 * s, 0.09 * s, 0.03 * s, W(0, 0, 2.3)), look.cloth, { ...cloth, tint: 1 });
      break;
    case 'lance':
      rb.part('weapon', limb(W(0, 0, -0.5), W(0, 0, 2.4), 0.035 * s, 0.012 * s, 'cyl', 8), '#e9e2cf', { rough: 0.5 });
      rb.part('weapon', cone(0.09 * s, 0.25 * s, W(0, 0, 0.05), [-Math.PI / 2, 0, 0], 10), look.metal, metal);
      rb.part('weapon', box(0.012 * s, 0.22 * s, 0.32 * s, W(0, 0.1, 1.9)), look.cloth, { ...cloth, tint: 1 });
      break;
    case 'axe2h':
      rb.part('weapon', limb(W(0, 0, -0.35), W(0, 0, 1.05), 0.022 * s, 0.022 * s, 'cyl', 6), '#6a4a2e', leather);
      rb.part('weapon', box(0.03 * s, 0.34 * s, 0.24 * s, W(0, 0.17, 0.92)), '#c9cfd8', { rough: 0.3, metal: 1 });
      rb.part('weapon', box(0.03 * s, 0.24 * s, 0.18 * s, W(0, -0.12, 0.92)), '#c9cfd8', { rough: 0.3, metal: 1 });
      break;
    case 'staff':
      rb.part('weapon', limb(W(0, 0, -0.7), W(0, 0, 1.15), 0.022 * s, 0.018 * s, 'cyl', 6), '#5a3d26', leather);
      rb.part('weapon', ball(0.075 * s, W(0, 0, 1.25), [1, 1, 1], 10), glowC, { rough: 0.2, emissive: look.glowStrength ?? 5 });
      rb.part('weapon', limb(W(0, 0, 1.12), W(0, 0, 1.18), 0.05 * s, 0.03 * s, 'cyl', 8), '#b8913f', metal);
      break;
    case 'bow': {
      // bow in the offhand: belly bulges toward −Y of the hand frame (forward once raised)
      const segs = 7;
      for (let i = 0; i < segs; i++) {
        const z0 = -0.62 + (1.24 * i) / segs;
        const z1 = -0.62 + (1.24 * (i + 1)) / segs;
        const y0 = -0.16 * (1 - (z0 / 0.62) ** 2);
        const y1 = -0.16 * (1 - (z1 / 0.62) ** 2);
        const ox = rb.pos('offhand').x / s;
        rb.part('offhand', limb(P(ox, hy + y0, z0), P(ox, hy + y1, z1), 0.016 * s, 0.016 * s, 'cyl', 5), '#6e4a2a', leather);
      }
      const ox = rb.pos('offhand').x / s;
      rb.part('offhand', limb(P(ox, hy + 0.0, -0.62), P(ox, hy + 0.0, 0.62), 0.004 * s, 0.004 * s, 'cyl', 3), '#e8e0c8', cloth);
      break;
    }
    case 'fists':
      break;
  }
  if (look.shield) {
    const oh = rb.pos('offhand');
    const at: V3 = [oh.x + 0.02 * s, oh.y - 0.05 * s, oh.z];
    if (look.shield === 'round') {
      rb.part('offhand', disc(0.3 * s, 0.035 * s, at, [0, -1, 0], 18), look.cloth, { rough: 0.7, tint: 1 });
      rb.part('offhand', disc(0.31 * s, 0.02 * s, [at[0], at[1] + 0.005 * s, at[2]], [0, -1, 0], 18), '#5b3e26', leather);
      rb.part('offhand', ball(0.06 * s, [at[0], at[1] - 0.025 * s, at[2]], [1, 0.5, 1]), look.metal, metal);
    } else {
      rb.part('offhand', box(0.42 * s, 0.04 * s, 0.68 * s, [at[0], at[1], at[2] + 0.05 * s]), look.cloth, { rough: 0.6, tint: 1 });
      rb.part('offhand', box(0.08 * s, 0.05 * s, 0.6 * s, [at[0], at[1] - 0.01 * s, at[2] + 0.05 * s]), look.trim, metal);
      rb.part('offhand', box(0.4 * s, 0.05 * s, 0.08 * s, [at[0], at[1] - 0.01 * s, at[2] + 0.18 * s]), look.trim, metal);
    }
  }
  return { rig: rb, clips: humanClips(look.weapon, !!look.shield), prefix };
}

// ------------------------------------------------------------------ humanoid clips

const TAU = Math.PI * 2;
/** Swing a limb forward (positive = toward +Z) and outward (positive = away from the body). */
function sw(p: Pose, bone: string, fwd: number, out = 0, twist = 0): void {
  const side = bone.endsWith('_l') ? 1 : bone.endsWith('_r') ? -1 : 0;
  p.r(bone, -fwd, twist, out * side);
}

function stance(p: Pose, style: WeaponStyle, shield: boolean, a = 1): void {
  switch (style) {
    case 'sword':
      sw(p, 'uarm_r', 0.3 * a, 0.12 * a);
      sw(p, 'farm_r', 1.05 * a);
      sw(p, 'uarm_l', (shield ? 0.45 : 0.1) * a, 0.18 * a);
      sw(p, 'farm_l', (shield ? 1.25 : 0.3) * a);
      break;
    case 'pike':
    case 'lance':
      sw(p, 'uarm_r', 0.25 * a, 0.1 * a);
      sw(p, 'farm_r', 1.4 * a);
      sw(p, 'uarm_l', (shield ? 0.45 : 0.35) * a, 0.15 * a);
      sw(p, 'farm_l', 1.25 * a);
      break;
    case 'axe2h':
      sw(p, 'uarm_r', 0.45 * a, -0.05 * a);
      sw(p, 'farm_r', 1.0 * a);
      sw(p, 'uarm_l', 0.6 * a, -0.35 * a);
      sw(p, 'farm_l', 1.3 * a);
      break;
    case 'bow':
      sw(p, 'uarm_l', 0.35 * a, 0.12 * a);
      sw(p, 'farm_l', 0.55 * a);
      sw(p, 'uarm_r', 0.1 * a, 0.1 * a);
      sw(p, 'farm_r', 0.4 * a);
      break;
    case 'staff':
      sw(p, 'uarm_r', 0.2 * a, 0.12 * a);
      sw(p, 'farm_r', 1.35 * a);
      sw(p, 'uarm_l', 0.15 * a, 0.12 * a);
      sw(p, 'farm_l', 0.45 * a);
      break;
    case 'fists':
      sw(p, 'uarm_r', 0.3 * a, 0.25 * a);
      sw(p, 'farm_r', 0.9 * a);
      sw(p, 'uarm_l', 0.3 * a, 0.25 * a);
      sw(p, 'farm_l', 0.9 * a);
      break;
  }
}

function legs(p: Pose, ph: number, amp: number, knee: number, bob: number, s = 1): void {
  const sL = Math.sin(ph);
  const sR = Math.sin(ph + Math.PI);
  sw(p, 'thigh_l', amp * sL);
  sw(p, 'thigh_r', amp * sR);
  // knee flexes while the leg swings forward (cos > 0)
  sw(p, 'shin_l', -knee * Math.max(0, Math.cos(ph)) - 0.08);
  sw(p, 'shin_r', -knee * Math.max(0, Math.cos(ph + Math.PI)) - 0.08);
  p.p('hips', 0, -bob * s * (0.5 + 0.5 * Math.cos(ph * 2)), 0);
  p.r('hips', 0, 0.06 * amp * sL, 0);
  p.r('chest', 0, -0.1 * amp * sL, 0);
}

function deathPose(p: Pose, t: number, s = 1): void {
  // stagger, knees give, fall backwards and settle; holds the last frame
  const k = smooth(0.12, 0.95, t) ** 1.6;
  const settle = bump(0.95, 1.05, 1.08, 1.25, t) * 0.05;
  p.r('root', 1.5 * k - settle, 0, 0.1 * k);
  p.p('root', 0, 0.14 * s * k, -0.15 * s * k);
  sw(p, 'thigh_l', 0.5 * smooth(0, 0.5, t) - 0.3 * k);
  sw(p, 'thigh_r', 0.35 * smooth(0, 0.5, t) - 0.2 * k);
  sw(p, 'shin_l', -0.9 * smooth(0, 0.5, t) + 0.6 * k);
  sw(p, 'shin_r', -0.6 * smooth(0, 0.5, t) + 0.4 * k);
  sw(p, 'uarm_l', 1.4 * smooth(0.1, 0.6, t) - 0.6 * k, 0.6 * k);
  sw(p, 'uarm_r', 1.2 * smooth(0.1, 0.6, t) - 0.5 * k, 0.7 * k);
  sw(p, 'farm_l', 0.3);
  sw(p, 'farm_r', 0.4);
  p.r('head', -0.3 * smooth(0, 0.3, t) + 0.2 * k, 0.3 * k, 0);
}

export function humanClips(style: WeaponStyle, shield: boolean, s = 1): ClipSpec[] {
  const clips: ClipSpec[] = [];
  clips.push({
    name: 'idle', duration: 2.4, loop: true,
    pose: (t, p) => {
      const b = Math.sin((TAU * t) / 2.4);
      stance(p, style, shield);
      p.r('chest', -0.03 * b, 0, 0);
      p.r('head', 0.03 * b, 0.05 * Math.sin((TAU * t) / 2.4 * 0.5 * 2), 0);
      sw(p, 'thigh_l', 0.05);
      sw(p, 'thigh_r', -0.04);
      sw(p, 'shin_l', -0.08);
      sw(p, 'shin_r', -0.06);
      p.p('hips', 0, -0.012 * s * (0.5 + 0.5 * b), 0);
    },
  });
  clips.push({
    name: 'move', duration: 1.0, loop: true,
    pose: (t, p) => {
      const ph = TAU * t;
      stance(p, style, shield, 0.95);
      legs(p, ph, 0.45, 0.65, 0.04, s);
      if (style === 'bow' || style === 'staff') sw(p, 'uarm_l', 0.25 * Math.sin(ph + Math.PI));
      p.r('spine', -0.05, 0, 0);
      sw(p, 'farm_r', 0.05 * Math.sin(ph * 2));
    },
  });
  clips.push({
    name: 'run', duration: 0.62, loop: true,
    pose: (t, p) => {
      const ph = (TAU * t) / 0.62;
      stance(p, style, shield, 0.9);
      legs(p, ph, 0.8, 1.2, 0.08, s);
      p.r('spine', -0.22, 0, 0);
      p.r('head', 0.15, 0, 0);
      sw(p, 'uarm_l', 0.35 * Math.sin(ph + Math.PI));
    },
  });
  clips.push({ name: 'attack', duration: style === 'bow' ? 1.1 : 0.9, loop: false, pose: (t, p) => attackPose(p, style, shield, t) });
  clips.push({
    name: 'cast', duration: 1.2, loop: false,
    pose: (t, p) => {
      const up = bump(0.0, 0.45, 0.8, 1.15, t);
      const thrust = bump(0.45, 0.6, 0.75, 1.1, t);
      stance(p, style, shield, 1 - up);
      sw(p, 'uarm_r', 2.3 * up - 0.9 * thrust, 0.15);
      sw(p, 'farm_r', 0.5 * up + 0.6 * thrust);
      sw(p, 'uarm_l', 1.7 * up, 0.4 * up);
      sw(p, 'farm_l', 0.6 * up);
      p.r('chest', 0.12 * up - 0.2 * thrust, 0, 0);
      p.r('head', 0.15 * up, 0, 0);
    },
  });
  clips.push({
    name: 'hit', duration: 0.4, loop: false,
    pose: (t, p) => {
      const k = bump(0, 0.08, 0.15, 0.4, t);
      stance(p, style, shield);
      p.r('chest', 0.25 * k, 0.15 * k, 0);
      p.r('head', 0.3 * k, 0, 0);
      p.p('hips', 0, -0.03 * k * s, -0.05 * k * s);
    },
  });
  clips.push({ name: 'death', duration: 1.3, loop: false, pose: (t, p) => deathPose(p, t, s) });
  return clips;
}

function attackPose(p: Pose, style: WeaponStyle, shield: boolean, t: number): void {
  switch (style) {
    case 'sword':
    case 'axe2h': {
      const wind = smooth(0.0, 0.32, t) * (1 - smooth(0.32, 0.46, t));
      const strike = smooth(0.32, 0.46, t) * (1 - smooth(0.55, 0.9, t));
      const two = style === 'axe2h';
      stance(p, style, shield, 1 - Math.max(wind, strike) * 0.8);
      sw(p, 'uarm_r', 2.5 * wind + 0.55 * strike, 0.25 * wind - 0.1 * strike);
      sw(p, 'farm_r', 0.7 * wind + 0.15 * strike);
      if (two) {
        sw(p, 'uarm_l', 2.3 * wind + 0.6 * strike, -0.3);
        sw(p, 'farm_l', 0.8 * wind + 0.2 * strike);
      }
      p.r('chest', 0.15 * wind - 0.3 * strike, 0.35 * wind - 0.45 * strike, 0);
      p.r('spine', -0.1 * strike, 0, 0);
      sw(p, 'thigh_l', 0.35 * strike);
      sw(p, 'shin_l', -0.3 * strike);
      sw(p, 'thigh_r', -0.2 * strike);
      p.p('hips', 0, -0.05 * strike, 0.08 * strike);
      break;
    }
    case 'pike':
    case 'lance': {
      const back = smooth(0, 0.3, t) * (1 - smooth(0.3, 0.42, t));
      const thrust = smooth(0.3, 0.42, t) * (1 - smooth(0.55, 0.88, t));
      stance(p, style, shield, 1 - thrust - back * 0.5);
      // level the shaft and drive it forward
      sw(p, 'uarm_r', 0.6 * back + 1.25 * thrust, 0.25);
      sw(p, 'farm_r', 0.6 * back + 0.2 * thrust + 0.1);
      sw(p, 'uarm_l', 0.9 * back + 1.3 * thrust, -0.1);
      sw(p, 'farm_l', 0.4 + 0.2 * thrust);
      p.r('chest', 0.05 * back - 0.25 * thrust, 0.3 * back - 0.1 * thrust, 0);
      sw(p, 'thigh_l', 0.4 * thrust);
      sw(p, 'shin_l', -0.35 * thrust);
      p.p('hips', 0, -0.06 * thrust, 0.15 * thrust);
      break;
    }
    case 'bow': {
      const raise = smooth(0.0, 0.25, t) * (1 - smooth(0.8, 1.1, t));
      const draw = smooth(0.2, 0.6, t) * (1 - smooth(0.62, 0.66, t));
      const after = bump(0.62, 0.66, 0.75, 1.0, t);
      stance(p, style, shield, 1 - raise);
      sw(p, 'uarm_l', 1.55 * raise, 0.05);
      sw(p, 'farm_l', 0.02 * raise);
      p.r('farm_l', 0, -0.2 * raise, 0);
      sw(p, 'uarm_r', 1.45 * raise, -0.35 * draw + 0.1 * after);
      sw(p, 'farm_r', 0.4 * raise + 1.8 * draw + 0.3 * after);
      p.r('chest', 0, 0.45 * raise, 0);
      p.r('head', 0, -0.4 * raise, 0);
      break;
    }
    case 'staff': {
      const up = bump(0, 0.35, 0.5, 0.85, t);
      const thrust = bump(0.35, 0.48, 0.6, 0.9, t);
      stance(p, style, shield, 1 - up);
      sw(p, 'uarm_r', 1.9 * up + 0.3 * thrust, 0.1);
      sw(p, 'farm_r', 0.3 * up + 0.2 * thrust);
      sw(p, 'uarm_l', 1.2 * thrust, 0.1);
      sw(p, 'farm_l', 0.2);
      p.r('chest', 0.1 * up - 0.25 * thrust, 0, 0);
      break;
    }
    case 'fists': {
      const wind = bump(0, 0.35, 0.4, 0.5, t);
      const slam = bump(0.38, 0.5, 0.6, 0.9, t);
      stance(p, style, shield, 1 - Math.max(wind, slam));
      sw(p, 'uarm_r', 2.6 * wind + 0.8 * slam, 0.15);
      sw(p, 'uarm_l', 2.6 * wind + 0.8 * slam, 0.15);
      sw(p, 'farm_r', 0.4 * wind);
      sw(p, 'farm_l', 0.4 * wind);
      p.r('chest', 0.2 * wind - 0.5 * slam, 0, 0);
      p.r('spine', -0.2 * slam, 0, 0);
      p.p('hips', 0, -0.12 * slam, 0.05 * slam);
      sw(p, 'thigh_l', 0.3 * slam);
      sw(p, 'thigh_r', 0.3 * slam);
      sw(p, 'shin_l', -0.5 * slam);
      sw(p, 'shin_r', -0.5 * slam);
      break;
    }
  }
}

// ------------------------------------------------------------------ horse (+ rider, + wings)

export interface HorseLook {
  coat: string;
  mane: string;
  barding: string;
  rider: HumanLook;
  wings?: boolean;
}

export function buildHorse(prefix: string, look: HorseLook): ModelBuild {
  const rb = new RigBuilder(prefix);
  rb.bone('root', null, [0, 0, 0])
    .bone('body', 'root', [0, 1.2, 0])
    .bone('neck', 'body', [0, 1.42, 0.62])
    .bone('head', 'neck', [0, 1.9, 0.88])
    .bone('tail', 'body', [0, 1.4, -0.78]);
  for (const [n, x, z] of [['fl', 0.17, 0.5], ['fr', -0.17, 0.5], ['hl', 0.17, -0.52], ['hr', -0.17, -0.52]] as const) {
    rb.bone(`${n}_up`, 'body', [x, 1.08, z]).bone(`${n}_lo`, `${n}_up`, [x, 0.6, z + 0.02]);
  }
  if (look.wings) {
    rb.bone('wing_l', 'body', [0.22, 1.5, 0.2]).bone('wtip_l', 'wing_l', [1.25, 1.55, 0.1]);
    rb.bone('wing_r', 'body', [-0.22, 1.5, 0.2]).bone('wtip_r', 'wing_r', [-1.25, 1.55, 0.1]);
  }
  // rider rig, child of the horse body
  rb.bone('r_hips', 'body', [0, 1.62, -0.05])
    .bone('r_chest', 'r_hips', [0, 1.85, -0.05])
    .bone('r_head', 'r_chest', [0, 2.1, -0.05])
    .bone('r_uarm_l', 'r_chest', [0.2, 2.0, -0.05])
    .bone('r_farm_l', 'r_uarm_l', [0.22, 1.74, -0.05])
    .bone('r_uarm_r', 'r_chest', [-0.2, 2.0, -0.05])
    .bone('r_farm_r', 'r_uarm_r', [-0.22, 1.74, -0.05])
    .bone('r_weapon', 'r_farm_r', [-0.23, 1.5, -0.05]);

  const hide = { rough: 0.7 };
  const metal = { rough: 0.32, metal: 0.85 };
  const g = ball(0.38, [0, 1.22, 0], [0.82, 0.88, 1.95], 14);
  rb.part('body', g, look.coat, hide);
  rb.part('body', limb([0, 1.38, 0.5], [0, 1.82, 0.84], 0.15, 0.12, 'cyl', 10), look.coat, hide);
  rb.part('head', limb([0, 1.95, 0.84], [0, 1.72, 1.22], 0.11, 0.075, 'cyl', 10), look.coat, hide);
  rb.part('head', cone(0.03, 0.1, [0.06, 2.06, 0.86]), look.coat, hide);
  rb.part('head', cone(0.03, 0.1, [-0.06, 2.06, 0.86]), look.coat, hide);
  rb.part('neck', box(0.05, 0.42, 0.28, [0, 1.72, 0.62], [0.75, 0, 0]), look.mane, { rough: 0.95 });
  rb.part('tail', limb([0, 1.38, -0.78], [0, 0.85, -0.98], 0.07, 0.03, 'cyl', 6), look.mane, { rough: 0.95 });
  for (const n of ['fl', 'fr', 'hl', 'hr']) {
    const up = rb.pos(`${n}_up`);
    const lo = rb.pos(`${n}_lo`);
    rb.part(`${n}_up`, limb([up.x, up.y + 0.05, up.z], [lo.x, lo.y, lo.z], 0.085, 0.06, 'cyl', 8), look.coat, hide);
    rb.part(`${n}_lo`, limb([lo.x, lo.y, lo.z], [lo.x, 0.1, lo.z], 0.045, 0.04, 'cyl', 6), look.coat, hide);
    rb.part(`${n}_lo`, box(0.09, 0.08, 0.11, [lo.x, 0.04, lo.z + 0.02]), '#2a2420', { rough: 0.6 });
  }
  // caparison + saddle (team)
  rb.part('body', box(0.66, 0.44, 0.9, [0, 1.12, -0.05]), look.barding, { rough: 0.85, tint: 1 });
  rb.part('body', box(0.68, 0.06, 0.92, [0, 0.9, -0.05]), '#c9a54a', { rough: 0.4, metal: 0.8 });
  rb.part('body', box(0.36, 0.1, 0.42, [0, 1.56, -0.05]), '#4a3020', { rough: 0.6 });
  rb.part('head', box(0.16, 0.14, 0.32, [0, 1.86, 1.0], [0.6, 0, 0]), look.rider.metal, metal); // chanfron
  if (look.wings) {
    for (const side of [1, -1]) {
      const w = side > 0 ? 'wing_l' : 'wing_r';
      const wt = side > 0 ? 'wtip_l' : 'wtip_r';
      const X = (x: number, y: number, z: number): V3 => [x * side, y, z];
      rb.part(w, fan([X(0.18, 1.5, 0.32), X(0.7, 1.56, 0.36), X(1.27, 1.57, 0.26), X(1.27, 1.55, -0.32), X(0.95, 1.52, -0.5), X(0.55, 1.5, -0.46), X(0.18, 1.48, -0.2)], 0.04), '#f4f2ec', { rough: 0.85 });
      rb.part(w, limb(X(0.2, 1.53, 0.3), X(1.27, 1.58, 0.24), 0.045, 0.03, 'cyl', 6), '#e6e2d8', { rough: 0.8 });
      rb.part(wt, fan([X(1.25, 1.57, 0.26), X(1.8, 1.6, 0.18), X(2.35, 1.6, -0.02), X(2.25, 1.59, -0.22), X(2.0, 1.58, -0.3), X(1.75, 1.57, -0.42), X(1.5, 1.56, -0.38), X(1.25, 1.55, -0.32)], 0.03), '#ffffff', { rough: 0.85 });
      // primary feather tips (sawtooth trailing edge)
      for (let f = 0; f < 5; f++) {
        const x0 = 1.35 + f * 0.2;
        rb.part(wt, fan([X(x0, 1.57, -0.3 + f * 0.04), X(x0 + 0.2, 1.575, -0.26 + f * 0.05), X(x0 + 0.06, 1.565, -0.6 + f * 0.07)], 0.02), '#f7f6f2', { rough: 0.85 });
      }
    }
  }
  // rider (rigid legs on the rider hips)
  const r = look.rider;
  const cloth = { rough: 0.85 };
  for (const side of [1, -1]) {
    rb.part('r_hips', limb([0.12 * side, 1.62, -0.02], [0.28 * side, 1.35, 0.15], 0.07), r.body === 'plate' ? r.metal : r.leather, r.body === 'plate' ? metal : { rough: 0.6 });
    rb.part('r_hips', limb([0.28 * side, 1.35, 0.15], [0.3 * side, 1.0, 0.05], 0.06), r.body === 'plate' ? r.metal : r.leather, r.body === 'plate' ? metal : { rough: 0.6 });
  }
  rb.part('r_hips', ball(0.16, [0, 1.62, -0.05], [1.1, 0.6, 0.85]), r.cloth, cloth);
  const torso = limb([0, 1.72, -0.05], [0, 1.98, -0.05], 0.16, 0.16, 'capsule', 12);
  rb.part('r_chest', torso, r.body === 'plate' ? r.metal : r.cloth, r.body === 'plate' ? metal : cloth);
  rb.part('r_chest', box(0.3, 0.4, 0.03, [0, 1.78, 0.1]), r.cloth, { ...cloth, tint: 1 });
  rb.part('r_chest', limb([0, 1.97, -0.05], [0, 2.08, -0.05], 0.05), r.skin, { rough: 0.6 });
  rb.part('r_head', ball(0.11, [0, 2.18, -0.05]), r.skin, { rough: 0.55 });
  rb.part('r_head', limb([0, 2.08, -0.05], [0, 2.32, -0.05], 0.125, 0.12, 'cyl', 12), r.metal, metal);
  rb.part('r_head', box(0.02, 0.13, 0.24, [0, 2.38, -0.07]), r.cloth, { ...cloth, tint: 1 });
  if (r.cape) rb.part('r_chest', box(0.42, 0.7, 0.025, [0, 1.6, -0.24], [0.35, 0, 0]), r.cloth, { ...cloth, tint: 1 });
  for (const side of [1, -1]) {
    const u = side > 0 ? 'r_uarm_l' : 'r_uarm_r';
    const f = side > 0 ? 'r_farm_l' : 'r_farm_r';
    rb.part(u, ball(0.08, [0.2 * side, 1.99, -0.05]), r.metal, metal);
    rb.part(u, limb([0.2 * side, 1.98, -0.05], [0.22 * side, 1.75, -0.05], 0.05), r.body === 'plate' ? r.metal : r.cloth, r.body === 'plate' ? metal : cloth);
    rb.part(f, limb([0.22 * side, 1.73, -0.05], [0.23 * side, 1.54, -0.05], 0.045), r.leather, { rough: 0.6 });
  }
  const wp: V3 = [-0.23, 1.5, -0.05];
  if (r.weapon === 'lance') {
    rb.part('r_weapon', limb([wp[0], wp[1], -0.6], [wp[0], wp[1], 2.6], 0.035, 0.012, 'cyl', 8), '#e9e2cf', { rough: 0.5 });
    rb.part('r_weapon', cone(0.09, 0.25, [wp[0], wp[1], 0.0], [-Math.PI / 2, 0, 0], 10), r.metal, metal);
    rb.part('r_weapon', box(0.012, 0.22, 0.32, [wp[0], wp[1] + 0.12, 2.0]), r.cloth, { rough: 0.85, tint: 1 });
  } else {
    rb.part('r_weapon', box(0.05, 0.012, 0.8, [wp[0], wp[1], 0.5]), '#d4dae3', { rough: 0.22, metal: 1 });
    rb.part('r_weapon', box(0.2, 0.035, 0.04, [wp[0], wp[1], 0.1]), '#b8913f', metal);
  }
  if (r.shield) {
    rb.part('r_farm_l', disc(0.26, 0.035, [0.27, 1.6, 0.02], [1, 0, 0.2], 16), r.cloth, { rough: 0.7, tint: 1 });
  }
  return { rig: rb, clips: horseClips(!!look.wings, r.weapon), prefix };
}

function riderStance(p: Pose, a: number, lance: boolean): void {
  sw(p, 'r_uarm_r', 0.3 * a, 0.1 * a);
  sw(p, 'r_farm_r', (lance ? 1.0 : 1.1) * a);
  sw(p, 'r_uarm_l', 0.4 * a, 0.1 * a);
  sw(p, 'r_farm_l', 0.9 * a);
}

function gallopLegs(p: Pose, ph: number, amp: number): void {
  const legs: [string, number][] = [['fl', 0], ['fr', 0.25], ['hl', 0.55], ['hr', 0.8]];
  for (const [n, o] of legs) {
    const a = ph + o * TAU;
    sw(p, `${n}_up`, amp * Math.sin(a));
    const front = n.startsWith('f');
    sw(p, `${n}_lo`, (front ? 1 : -1) * amp * 1.1 * Math.max(0, Math.cos(a)));
  }
}

function horseClips(wings: boolean, weapon: WeaponStyle): ClipSpec[] {
  const lance = weapon === 'lance';
  const flap = (p: Pose, t: number, period: number, amp: number) => {
    if (!wings) return;
    const f = Math.sin((TAU * t) / period);
    p.r('wing_l', 0, 0, amp * f + 0.1);
    p.r('wing_r', 0, 0, -amp * f - 0.1);
    p.r('wtip_l', 0, 0, amp * 0.6 * Math.sin((TAU * t) / period - 0.6));
    p.r('wtip_r', 0, 0, -amp * 0.6 * Math.sin((TAU * t) / period - 0.6));
  };
  const tuck = (p: Pose) => {
    if (!wings) return;
    sw(p, 'fl_up', 0.9);
    sw(p, 'fr_up', 0.8);
    sw(p, 'fl_lo', -1.6);
    sw(p, 'fr_lo', -1.5);
    sw(p, 'hl_up', -0.7);
    sw(p, 'hr_up', -0.6);
    sw(p, 'hl_lo', 0.9);
    sw(p, 'hr_lo', 0.8);
  };
  return [
    {
      name: 'idle', duration: wings ? 0.9 : 3, loop: true,
      pose: (t, p) => {
        const b = Math.sin((TAU * t) / (wings ? 0.9 : 3));
        riderStance(p, 1, lance);
        p.r('neck', 0.05 * b, 0, 0);
        p.r('head', -0.05 * b, 0, 0);
        p.r('tail', 0, 0.15 * b, 0);
        if (wings) {
          tuck(p);
          flap(p, t, 0.9, 0.75);
          p.p('body', 0, 0.08 * b, 0);
        }
      },
    },
    {
      name: 'move', duration: wings ? 1.0 : 0.9, loop: true,
      pose: (t, p) => {
        const ph = (TAU * t) / (wings ? 1.0 : 0.9);
        riderStance(p, 1, lance);
        if (wings) {
          tuck(p);
          flap(p, t, 1.0, 0.95);
          p.r('body', -0.08, 0, 0);
          p.p('body', 0, 0.1 * Math.sin(ph), 0);
        } else {
          gallopLegs(p, ph, 0.35);
          p.p('body', 0, 0.03 * Math.cos(ph * 2), 0);
          p.r('neck', 0.06 * Math.sin(ph * 2), 0, 0);
          p.p('r_hips', 0, -0.03 * Math.cos(ph * 2), 0);
        }
      },
    },
    {
      name: 'run', duration: wings ? 0.7 : 0.55, loop: true,
      pose: (t, p) => {
        const ph = (TAU * t) / (wings ? 0.7 : 0.55);
        riderStance(p, 1, lance);
        if (lance) sw(p, 'r_uarm_r', 0.9);
        if (wings) {
          tuck(p);
          flap(p, t, 0.7, 1.1);
          p.r('body', -0.15, 0, 0);
        } else {
          gallopLegs(p, ph, 0.7);
          p.r('body', 0.07 * Math.sin(ph), 0, 0);
          p.p('body', 0, 0.08 * Math.max(0, Math.sin(ph)), 0);
          p.r('neck', -0.15 + 0.12 * Math.sin(ph + 1), 0, 0);
          p.r('r_hips', -0.25, 0, 0);
          p.r('tail', -0.5, 0, 0);
        }
      },
    },
    {
      name: 'attack', duration: 0.9, loop: false,
      pose: (t, p) => {
        const wind = smooth(0, 0.32, t) * (1 - smooth(0.32, 0.46, t));
        const strike = smooth(0.32, 0.46, t) * (1 - smooth(0.55, 0.9, t));
        riderStance(p, 1 - Math.max(wind, strike), lance);
        if (lance) {
          sw(p, 'r_uarm_r', 0.5 * wind + 1.4 * strike, 0.2);
          sw(p, 'r_farm_r', 0.3 + 0.1 * strike);
        } else {
          sw(p, 'r_uarm_r', 2.5 * wind + 0.6 * strike, 0.3 * wind);
          sw(p, 'r_farm_r', 0.6 * wind + 0.15 * strike);
        }
        p.r('r_chest', 0.1 * wind - 0.3 * strike, 0.35 * wind - 0.4 * strike, 0);
        if (wings) {
          tuck(p);
          flap(p, t, 0.9, 0.9);
        } else {
          p.r('body', 0.12 * wind - 0.05 * strike, 0, 0);
          sw(p, 'fl_up', 0.6 * wind);
          sw(p, 'fr_up', 0.5 * wind);
          sw(p, 'fl_lo', -0.9 * wind);
          sw(p, 'fr_lo', -0.8 * wind);
        }
      },
    },
    {
      name: 'cast', duration: 1.0, loop: false,
      pose: (t, p) => {
        riderStance(p, 1, lance);
        sw(p, 'r_uarm_r', 2.0 * bump(0, 0.4, 0.6, 1, t));
        if (wings) {
          tuck(p);
          flap(p, t, 1.0, 0.8);
        }
      },
    },
    {
      name: 'hit', duration: 0.4, loop: false,
      pose: (t, p) => {
        const k = bump(0, 0.08, 0.15, 0.4, t);
        riderStance(p, 1, lance);
        p.r('r_chest', 0.3 * k, 0, 0);
        p.r('neck', 0.2 * k, 0.2 * k, 0);
        if (wings) {
          tuck(p);
          flap(p, t, 0.4, 0.6);
        }
      },
    },
    {
      name: 'death', duration: 1.4, loop: false,
      pose: (t, p) => {
        const k = smooth(0.1, 0.9, t) ** 1.5;
        riderStance(p, 1 - k, lance);
        p.r('root', 0, 0, 1.45 * k);
        p.p('root', 0, 0.3 * k, 0);
        for (const n of ['fl', 'fr', 'hl', 'hr']) sw(p, `${n}_up`, 0.3 * k * (n.endsWith('l') ? 1 : -1));
        p.r('neck', 0.6 * k, 0, 0.3 * k);
        p.r('r_hips', 0, 0, 0.5 * k);
        p.r('r_chest', 0.4 * k, 0, 0.4 * k);
        if (wings) {
          p.r('wing_l', 0, 0, -0.9 * k + 0.2);
          p.r('wing_r', 0, 0, 0.9 * k - 0.2);
        }
      },
    },
  ];
}

// ------------------------------------------------------------------ golem (giant humanoid, heroes path)

export function buildGolem(prefix: string): ModelBuild {
  const s = 2.1;
  const rock = { rough: 0.95 };
  const rb = new RigBuilder(prefix);
  humanBones(rb, s);
  const P = (x: number, y: number, z = 0): V3 => [x * s, y * s, z * s];
  const stone = '#8a8478';
  const dark = '#5d584f';
  const rune = '#59d6ff';
  const chunk = (bone: string, r: number, at: V3, sc: V3, c = stone) => {
    const g = new THREE.IcosahedronGeometry(r * s, 0).scale(...sc).translate(...at);
    rb.part(bone, g, c, rock);
  };
  for (const side of [L, R]) {
    const x = side;
    chunk(side === L ? 'thigh_l' : 'thigh_r', 0.13, P(0.12 * x, 0.75), [1, 1.6, 1]);
    chunk(side === L ? 'shin_l' : 'shin_r', 0.13, P(0.12 * x, 0.32), [1.1, 1.7, 1.1], dark);
    chunk(side === L ? 'shin_l' : 'shin_r', 0.12, P(0.12 * x, 0.07, 0.04), [1.2, 0.6, 1.5], dark);
    chunk(side === L ? 'uarm_l' : 'uarm_r', 0.17, P(0.28 * x, 1.42), [1.2, 1, 1.1]);
    chunk(side === L ? 'uarm_l' : 'uarm_r', 0.1, P(0.27 * x, 1.28), [1, 1.6, 1]);
    chunk(side === L ? 'farm_l' : 'farm_r', 0.12, P(0.28 * x, 1.07), [1, 1.6, 1], dark);
    chunk(side === L ? 'farm_l' : 'farm_r', 0.14, P(0.29 * x, 0.88), [1.1, 1, 1.1]);
    rb.part(side === L ? 'uarm_l' : 'uarm_r', ball(0.03 * s, P(0.31 * x, 1.42, 0.14)), rune, { emissive: 6 });
  }
  chunk('hips', 0.2, P(0, 0.96), [1.3, 0.8, 1]);
  chunk('chest', 0.26, P(0, 1.3), [1.35, 1.1, 1]);
  chunk('chest', 0.16, P(0.1, 1.45, 0.08), [1.2, 0.8, 1], dark);
  chunk('head', 0.1, P(0, 1.62, 0.05), [1.2, 1, 1.1], dark);
  rb.part('chest', ball(0.06 * s, P(0, 1.33, 0.25)), rune, { emissive: 8 });
  rb.part('head', box(0.1 * s, 0.025 * s, 0.03 * s, P(0, 1.64, 0.15)), rune, { emissive: 8 });
  const clips = humanClips('fists', false, s).map((c) =>
    c.name === 'move' ? { ...c, duration: 1.6 } : c.name === 'run' ? { ...c, duration: 1.1 } : c.name === 'attack' ? { ...c, duration: 1.2 } : c,
  );
  return { rig: rb, clips, prefix };
}

// ------------------------------------------------------------------ dragon / wyvern

export function buildDragon(prefix: string, opts: { scale: number; body: string; belly: string; wing: string; rider?: HumanLook; glow?: string }): ModelBuild {
  const s = opts.scale;
  const rb = new RigBuilder(prefix);
  const P = (x: number, y: number, z = 0): V3 => [x * s, y * s, z * s];
  rb.bone('root', null, [0, 0, 0])
    .bone('body', 'root', P(0, 1.2, 0))
    .bone('neck1', 'body', P(0, 1.4, 0.6))
    .bone('neck2', 'neck1', P(0, 1.7, 1.0))
    .bone('head', 'neck2', P(0, 1.95, 1.35))
    .bone('jaw', 'head', P(0, 1.88, 1.45))
    .bone('tail1', 'body', P(0, 1.2, -0.7))
    .bone('tail2', 'tail1', P(0, 1.1, -1.4))
    .bone('tail3', 'tail2', P(0, 1.0, -2.1))
    .bone('wing_l', 'body', P(0.3, 1.5, 0.25))
    .bone('wmid_l', 'wing_l', P(1.3, 1.65, 0.1))
    .bone('wtip_l', 'wmid_l', P(2.4, 1.6, -0.1))
    .bone('wing_r', 'body', P(-0.3, 1.5, 0.25))
    .bone('wmid_r', 'wing_r', P(-1.3, 1.65, 0.1))
    .bone('wtip_r', 'wmid_r', P(-2.4, 1.6, -0.1));
  for (const [n, x, z] of [['fl', 0.3, 0.45], ['fr', -0.3, 0.45], ['hl', 0.32, -0.45], ['hr', -0.32, -0.45]] as const) {
    rb.bone(`${n}_up`, 'body', P(x, 1.05, z)).bone(`${n}_lo`, `${n}_up`, P(x, 0.6, z + 0.05));
  }
  const scale = { rough: 0.55, metal: 0.15 };
  rb.part('body', ball(0.55 * s, P(0, 1.2, 0), [1.0, 0.92, 1.55], 14), opts.body, scale);
  rb.part('body', ball(0.42 * s, P(0, 1.05, 0.05), [0.9, 0.6, 1.45], 12), opts.belly, { rough: 0.7, tint: 0.5 });
  rb.part('neck1', limb(P(0, 1.35, 0.5), P(0, 1.72, 1.02), 0.24 * s, 0.17 * s, 'cyl', 10), opts.body, scale);
  rb.part('neck2', limb(P(0, 1.7, 1.0), P(0, 1.95, 1.35), 0.17 * s, 0.14 * s, 'cyl', 10), opts.body, scale);
  rb.part('head', limb(P(0, 1.98, 1.3), P(0, 1.95, 1.75), 0.15 * s, 0.09 * s, 'cyl', 10), opts.body, scale);
  rb.part('jaw', limb(P(0, 1.86, 1.42), P(0, 1.84, 1.72), 0.08 * s, 0.05 * s, 'cyl', 8), opts.belly, scale);
  for (const x of [1, -1]) {
    rb.part('head', cone(0.04 * s, 0.32 * s, P(0.08 * x, 2.12, 1.22), [-2.2, 0, 0.3 * x], 6), '#e8dcc0', { rough: 0.5 });
    rb.part('head', ball(0.025 * s, P(0.09 * x, 2.03, 1.5)), opts.glow ?? '#ffb347', { emissive: 8 });
  }
  rb.part('tail1', limb(P(0, 1.2, -0.6), P(0, 1.1, -1.4), 0.24 * s, 0.15 * s, 'cyl', 10), opts.body, scale);
  rb.part('tail2', limb(P(0, 1.1, -1.4), P(0, 1.0, -2.1), 0.15 * s, 0.08 * s, 'cyl', 8), opts.body, scale);
  rb.part('tail3', limb(P(0, 1.0, -2.1), P(0, 0.95, -2.9), 0.11 * s, 0.02 * s, 'cyl', 8), opts.body, scale);
  rb.part('tail3', box(0.4 * s, 0.03 * s, 0.3 * s, P(0, 0.95, -2.8)), opts.wing, { rough: 0.7, tint: 0.6 });
  for (let i = 0; i < 6; i++) rb.part(i < 3 ? 'body' : 'tail1', cone(0.06 * s, 0.22 * s, P(0, 1.62 - i * 0.04, 0.5 - i * 0.32), [-0.4, 0, 0], 5), '#e8dcc0', { rough: 0.5 });
  for (const side of [1, -1]) {
    const w = side > 0 ? '_l' : '_r';
    rb.part(`wing${w}`, limb(P(0.3 * side, 1.5, 0.25), P(1.3 * side, 1.65, 0.1), 0.06 * s, 0.05 * s, 'cyl', 6), opts.body, scale);
    rb.part(`wmid${w}`, limb(P(1.3 * side, 1.65, 0.1), P(2.4 * side, 1.6, -0.1), 0.05 * s, 0.03 * s, 'cyl', 6), opts.body, scale);
    // membranes (team-tinted), scalloped between finger spars
    const X = (x: number, y: number, z: number): V3 => P(x * side, y, z);
    rb.part(`wing${w}`, fan([X(0.3, 1.5, 0.25), X(1.3, 1.65, 0.1), X(1.25, 1.58, -0.55), X(0.95, 1.5, -0.75), X(0.55, 1.42, -0.62), X(0.25, 1.38, -0.35)], 0.025 * s), opts.wing, { rough: 0.75, tint: 0.45 });
    rb.part(`wmid${w}`, fan([X(1.3, 1.65, 0.1), X(2.4, 1.6, -0.1), X(2.3, 1.56, -0.45), X(2.05, 1.55, -0.62), X(1.85, 1.54, -0.95), X(1.6, 1.55, -0.78), X(1.25, 1.58, -0.55)], 0.02 * s), opts.wing, { rough: 0.75, tint: 0.45 });
    for (const [tx, tz] of [[2.05, -0.62], [1.85, -0.95], [1.25, -0.55]] as const) rb.part(`wmid${w}`, limb(X(1.3, 1.65, 0.1), X(tx, 1.56, tz), 0.025 * s, 0.012 * s, 'cyl', 5), opts.body, scale);
  }
  for (const n of ['fl', 'fr', 'hl', 'hr']) {
    const up = rb.pos(`${n}_up`);
    const lo = rb.pos(`${n}_lo`);
    rb.part(`${n}_up`, limb([up.x, up.y, up.z], [lo.x, lo.y, lo.z], 0.12 * s, 0.08 * s, 'cyl', 8), opts.body, scale);
    rb.part(`${n}_lo`, limb([lo.x, lo.y, lo.z], [lo.x, 0.08 * s, lo.z + 0.08 * s], 0.07 * s, 0.06 * s, 'cyl', 6), opts.body, scale);
  }
  if (opts.rider) {
    const r = opts.rider;
    rb.bone('r_chest', 'body', P(0, 1.95, 0.2));
    rb.part('body', limb(P(0, 1.6, 0.2), P(0, 1.8, 0.2), 0.14 * s, 0.14 * s, 'capsule'), r.cloth, { rough: 0.85, tint: 1 });
    rb.part('r_chest', limb(P(0, 1.8, 0.2), P(0, 2.05, 0.2), 0.15 * s, 0.15 * s, 'capsule'), r.metal, { rough: 0.32, metal: 0.85 });
    rb.part('r_chest', ball(0.11 * s, P(0, 2.2, 0.2)), r.metal, { rough: 0.32, metal: 0.85 });
    rb.part('r_chest', limb(P(-0.2, 1.95, 0.2), P(-0.25, 2.5, 0.6), 0.03 * s, 0.03 * s, 'cyl'), '#6a4a2e', { rough: 0.6 });
    rb.part('r_chest', box(0.03 * s, 0.3 * s, 0.25 * s, P(-0.25, 2.55, 0.7)), '#c9cfd8', { rough: 0.3, metal: 1 });
  }
  const flap = (p: Pose, t: number, period: number, amp: number, off = 0) => {
    const f = Math.sin((TAU * t) / period + off);
    p.r('wing_l', 0, 0, amp * f + 0.15);
    p.r('wing_r', 0, 0, -amp * f - 0.15);
    p.r('wmid_l', 0, 0, amp * 0.5 * Math.sin((TAU * t) / period + off - 0.7));
    p.r('wmid_r', 0, 0, -amp * 0.5 * Math.sin((TAU * t) / period + off - 0.7));
    p.r('wtip_l', 0, 0, amp * 0.3 * Math.sin((TAU * t) / period + off - 1.3));
    p.r('wtip_r', 0, 0, -amp * 0.3 * Math.sin((TAU * t) / period + off - 1.3));
    p.p('body', 0, -0.08 * s * f, 0);
  };
  const tuck = (p: Pose) => {
    for (const n of ['fl', 'fr']) {
      sw(p, `${n}_up`, 0.6);
      sw(p, `${n}_lo`, -1.0);
    }
    for (const n of ['hl', 'hr']) {
      sw(p, `${n}_up`, -0.8);
      sw(p, `${n}_lo`, 0.6);
    }
  };
  const tail = (p: Pose, t: number, k: number) => {
    const w = Math.sin(TAU * t * 0.7);
    p.r('tail1', 0.05, 0.15 * w * k, 0);
    p.r('tail2', 0.05, 0.2 * Math.sin(TAU * t * 0.7 - 0.6) * k, 0);
    p.r('tail3', 0.05, 0.25 * Math.sin(TAU * t * 0.7 - 1.2) * k, 0);
  };
  const clips: ClipSpec[] = [
    { name: 'idle', duration: 1.4, loop: true, pose: (t, p) => { tuck(p); flap(p, t, 1.4, 0.7); tail(p, t, 1); p.r('neck1', 0.1, 0, 0); p.r('head', -0.15, 0, 0); } },
    { name: 'move', duration: 1.2, loop: true, pose: (t, p) => { tuck(p); flap(p, t, 1.2, 0.85); tail(p, t, 0.6); p.r('body', -0.06, 0, 0); p.r('neck1', 0.2, 0, 0); p.r('head', -0.25, 0, 0); } },
    { name: 'run', duration: 0.9, loop: true, pose: (t, p) => { tuck(p); flap(p, t, 0.9, 1.0); tail(p, t, 0.4); p.r('body', -0.12, 0, 0); p.r('neck1', 0.3, 0, 0); p.r('head', -0.35, 0, 0); } },
    {
      name: 'attack', duration: 1.6, loop: false,
      pose: (t, p) => {
        tuck(p);
        flap(p, t, 0.8, 0.6);
        tail(p, t, 1);
        const rear = bump(0, 0.35, 0.5, 0.7, t);
        const breathe = bump(0.35, 0.5, 1.2, 1.55, t);
        p.r('neck1', -0.45 * rear + 0.35 * breathe, 0, 0);
        p.r('neck2', -0.25 * rear + 0.15 * breathe, 0, 0);
        p.r('head', 0.3 * rear - 0.25 * breathe, 0, 0);
        p.r('jaw', 0.6 * breathe + 0.15 * rear, 0, 0);
        p.r('body', 0.12 * rear - 0.05 * breathe, 0, 0);
      },
    },
    { name: 'cast', duration: 1.2, loop: false, pose: (t, p) => { tuck(p); flap(p, t, 0.6, 1.0); p.r('jaw', 0.5 * bump(0.2, 0.4, 0.8, 1.1, t), 0, 0); p.r('neck1', -0.3 * bump(0.1, 0.4, 0.8, 1.1, t), 0, 0); } },
    { name: 'hit', duration: 0.5, loop: false, pose: (t, p) => { tuck(p); flap(p, t, 0.5, 0.6); const k = bump(0, 0.08, 0.2, 0.5, t); p.r('neck1', -0.3 * k, 0.2 * k, 0); p.r('body', 0.1 * k, 0, 0.1 * k); } },
    {
      name: 'death', duration: 1.8, loop: false,
      pose: (t, p) => {
        const k = smooth(0.1, 1.5, t) ** 1.3;
        const fold = smooth(0, 1.0, t);
        p.r('wing_l', 0, 0.6 * fold, -0.6 * fold);
        p.r('wing_r', 0, -0.6 * fold, 0.6 * fold);
        p.r('wmid_l', 0, -1.0 * fold, 0);
        p.r('wmid_r', 0, 1.0 * fold, 0);
        p.r('root', 0, 0, 1.2 * k);
        p.p('root', 0, 0.45 * s * k, 0);
        p.r('neck1', 0.5 * k, 0, 0.4 * k);
        p.r('head', 0.4 * k, 0, 0);
        p.r('jaw', 0.25 * k, 0, 0);
        tail(p, t, 1 - k);
      },
    },
  ];
  return { rig: rb, clips, prefix };
}

// ------------------------------------------------------------------ siege engines (rigid parts on bones)

export function buildBallista(prefix: string, team: string): ModelBuild {
  const rb = new RigBuilder(prefix);
  rb.bone('root', null, [0, 0, 0]).bone('turret', 'root', [0, 0.75, 0]).bone('arm_l', 'turret', [0.15, 1.05, 0.55]).bone('arm_r', 'turret', [-0.15, 1.05, 0.55]).bone('slide', 'turret', [0, 1.05, -0.2]);
  const wood = { rough: 0.8 };
  const metal = { rough: 0.35, metal: 0.85 };
  const w = '#7a5534';
  const dw = '#4e3522';
  for (const [x, z] of [[0.55, 0.6], [-0.55, 0.6], [0.55, -0.7], [-0.55, -0.7]] as const) {
    rb.part('root', disc(0.3, 0.08, [x, 0.3, z], [1, 0, 0], 14), dw, wood);
    rb.part('root', disc(0.08, 0.1, [x, 0.3, z], [1, 0, 0], 8), '#8a8f98', metal);
  }
  rb.part('root', box(1.0, 0.16, 1.6, [0, 0.55, -0.05]), w, wood);
  rb.part('root', box(1.04, 0.05, 0.14, [0, 0.64, 0.5]), '#8a8f98', metal);
  rb.part('turret', limb([0, 0.62, 0], [0, 0.95, 0], 0.12, 0.12, 'cyl', 10), dw, wood);
  rb.part('turret', box(0.24, 0.16, 1.9, [0, 1.05, 0.05]), w, wood);
  rb.part('turret', box(0.5, 0.3, 0.2, [0, 1.08, 0.6]), dw, wood);
  rb.part('turret', box(0.52, 0.06, 0.22, [0, 1.25, 0.6]), team, { rough: 0.7, tint: 1 });
  rb.part('arm_l', limb([0.18, 1.05, 0.55], [1.05, 1.05, 0.25], 0.05, 0.035, 'cyl', 6), dw, wood);
  rb.part('arm_r', limb([-0.18, 1.05, 0.55], [-1.05, 1.05, 0.25], 0.05, 0.035, 'cyl', 6), dw, wood);
  rb.part('slide', limb([1.05, 1.06, 0.25], [0, 1.06, -0.2], 0.006, 0.006, 'cyl', 3), '#e8e0c8', wood);
  rb.part('slide', limb([-1.05, 1.06, 0.25], [0, 1.06, -0.2], 0.006, 0.006, 'cyl', 3), '#e8e0c8', wood);
  rb.part('slide', limb([0, 1.13, -0.2], [0, 1.13, 1.3], 0.025, 0.025, 'cyl', 6), '#c9b48a', wood);
  rb.part('slide', cone(0.05, 0.18, [0, 1.13, 1.38], [Math.PI / 2, 0, 0], 6), '#c9cfd8', metal);
  const clips: ClipSpec[] = [
    { name: 'idle', duration: 2, loop: true, pose: () => {} },
    { name: 'move', duration: 1, loop: true, pose: () => {} },
    { name: 'run', duration: 1, loop: true, pose: () => {} },
    {
      name: 'attack', duration: 1.4, loop: false,
      pose: (t, p) => {
        const release = smooth(0.08, 0.14, t);
        const reload = smooth(0.5, 1.3, t);
        const k = 1 - release + reload * release; // drawn → fire → re-draw
        p.r('arm_l', 0, -0.25 * k, 0);
        p.r('arm_r', 0, 0.25 * k, 0);
        p.p('slide', 0, 0, -0.35 * k);
        p.p('turret', 0, 0, -0.08 * bump(0.08, 0.12, 0.15, 0.4, t));
      },
    },
    { name: 'cast', duration: 1, loop: false, pose: () => {} },
    { name: 'hit', duration: 0.3, loop: false, pose: (t, p) => p.r('turret', 0, 0.05 * bump(0, 0.05, 0.1, 0.3, t), 0) },
    {
      name: 'death', duration: 1.2, loop: false,
      pose: (t, p) => {
        const k = smooth(0, 1, t);
        p.r('turret', 0.4 * k, 0.3 * k, 0.5 * k);
        p.p('turret', 0.2 * k, -0.4 * k, 0);
        p.r('arm_l', 0, 0, -0.8 * k);
        p.r('arm_r', 0, 0, 0.6 * k);
        p.r('root', 0, 0, 0.12 * k);
      },
    },
  ];
  return { rig: rb, clips, prefix };
}

export function buildTrebuchet(prefix: string, team: string): ModelBuild {
  const rb = new RigBuilder(prefix);
  rb.bone('root', null, [0, 0, 0]).bone('arm', 'root', [0, 3.4, 0]).bone('weight', 'arm', [0, 3.4, 1.1]).bone('sling', 'arm', [0, 3.4, -3.2]);
  const wood = { rough: 0.85 };
  const w = '#7a5534';
  const dw = '#4e3522';
  rb.part('root', box(2.0, 0.3, 4.2, [0, 0.35, 0]), dw, wood);
  for (const x of [0.75, -0.75]) {
    rb.part('root', limb([x, 0.4, 1.4], [x * 0.6, 3.5, 0], 0.1, 0.09, 'cyl', 6), w, wood);
    rb.part('root', limb([x, 0.4, -1.4], [x * 0.6, 3.5, 0], 0.1, 0.09, 'cyl', 6), w, wood);
    for (const z of [1.6, -1.6, 0]) rb.part('root', disc(0.35, 0.12, [x * 1.3, 0.35, z], [1, 0, 0], 12), dw, wood);
  }
  rb.part('root', limb([0.6, 3.4, 0], [-0.6, 3.4, 0], 0.07, 0.07, 'cyl', 8), '#8a8f98', { rough: 0.35, metal: 0.85 });
  rb.part('root', box(1.6, 0.1, 0.6, [0, 0.55, 1.6]), team, { rough: 0.8, tint: 1 });
  // arm: short end (counterweight) toward +Z, long end toward −Z resting down
  rb.part('arm', limb([0, 3.4, 1.2], [0, 3.4, -3.3], 0.09, 0.06, 'cyl', 6), w, wood);
  rb.part('weight', box(0.9, 0.9, 0.9, [0, 2.75, 1.1]), '#5c5850', { rough: 0.9 });
  rb.part('weight', box(0.94, 0.12, 0.94, [0, 3.05, 1.1]), team, { rough: 0.8, tint: 1 });
  rb.part('sling', ball(0.22, [0, 3.3, -3.3]), '#8a8478', { rough: 0.95 });
  const rest = -0.62; // arm tilted with the long end down
  const clips: ClipSpec[] = [
    { name: 'idle', duration: 2, loop: true, pose: (_t, p) => { p.r('arm', rest, 0, 0); p.r('weight', -rest, 0, 0); } },
    { name: 'move', duration: 1, loop: true, pose: (_t, p) => { p.r('arm', rest, 0, 0); p.r('weight', -rest, 0, 0); } },
    { name: 'run', duration: 1, loop: true, pose: (_t, p) => { p.r('arm', rest, 0, 0); p.r('weight', -rest, 0, 0); } },
    {
      name: 'attack', duration: 3.0, loop: false,
      pose: (t, p) => {
        const fling = smooth(0.0, 0.35, t) ** 1.8;
        const reset = smooth(0.9, 2.8, t);
        const a = rest + (1.9 - rest) * fling * (1 - reset) + 0;
        p.r('arm', a, 0, 0);
        p.r('weight', -a, 0, 0);
        p.p('sling', 0, 0, 0);
      },
    },
    { name: 'cast', duration: 1, loop: false, pose: (_t, p) => { p.r('arm', rest, 0, 0); } },
    { name: 'hit', duration: 0.3, loop: false, pose: (_t, p) => { p.r('arm', rest, 0, 0); } },
    {
      name: 'death', duration: 1.6, loop: false,
      pose: (t, p) => {
        const k = smooth(0, 1.2, t);
        p.r('arm', rest + 0.9 * k, 0.4 * k, 0.6 * k);
        p.p('arm', 0.5 * k, -2.2 * k, 0);
        p.r('root', 0, 0, 0.15 * k);
      },
    },
  ];
  return { rig: rb, clips, prefix };
}

/** Build every clip of a model into AnimationClips (named by clip). */
export function buildClips(m: ModelBuild): THREE.AnimationClip[] {
  return m.clips.map((c) => clipFromPose(m.prefix, m.rig, c));
}
