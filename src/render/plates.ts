// In-world squad plates: one per squad, floating over its soldiers, so armies stay readable at
// planning / battle zoom where a soldier is a dozen pixels tall. Each plate shows
//   · a round crest ringed in the team colour (gold for Lords) with the unit's portrait,
//   · the squad's total HP as a bar,
//   · level pips (1–5),
// and brightens / grows when the UI marks the squad hovered or selected.
//
// ONE instanced draw call: every plate is a quad whose fragment shader draws the frame, bar and
// pips as signed-distance shapes and samples the portrait from a small atlas (built on a canvas
// from public/ui/unit_*.webp / lord_*.webp as the images arrive). Plates keep a constant screen
// size, fade out when the camera is close enough to read the soldiers themselves, and draw over
// the world (no depth test). The buffers are rewritten only on frames that render anyway, so an
// idle planning screen stays at 0 fps.
import * as THREE from 'three';
import type { Engine } from './core/engine.ts';
import { LAYER_VFX } from './core/post.ts';
import type { Slot } from './crowd/units.ts';
import { assetUrl, loadAssetVersions } from '../assets.ts';

export interface PlateState {
  selected?: boolean;
  hovered?: boolean;
}

const ICONS = [
  'unit_militia', 'unit_pikemen', 'unit_berserkers', 'unit_archers', 'unit_knights', 'unit_cavaliers', 'unit_mages', 'unit_clerics',
  'unit_pegasus', 'unit_ballista', 'unit_trebuchet', 'unit_golem', 'unit_wyvern', 'unit_dragon',
  'lord_marshal', 'lord_archmage', 'lord_warden', 'lord_skylady',
  // the Ashen Covenant / the Sun Caliphate
  'unit_skeleton', 'unit_grave_knight', 'unit_bone_archer', 'unit_wraith_rider', 'unit_grave_acolyte', 'unit_bone_drake', 'unit_corpse_catapult', 'unit_bone_golem', 'lord_lich',
  'unit_spear_levy', 'unit_scimitar', 'unit_camel_archer', 'unit_mamluk', 'unit_djinn_binder', 'unit_sun_priest', 'unit_djinn', 'unit_war_elephant', 'unit_sand_golem', 'lord_sultana',
];
const COLS = 8;
const ROWS = 8; // 8 x 8 cells of 64 px = 512 x 512 (power of two): room for 63 portraits + the fallback glyph
const CELL = 64;
const FALLBACK = ICONS.length; // a plain helm glyph for anything without a portrait (skeletons)
const MAX = 96;

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aInfo;   // hp 0..1, level, icon, state (bit 1 hover, 2 selected, 4 lord)
attribute vec4 aTeam;   // rgb, alpha
uniform float uSize;    // plate height as a fraction of the viewport height
varying vec2 vP;
varying vec4 vInfo;
varying vec4 vTeam;
varying vec3 vFlags;  // hovered, selected, lord (0 or 1)
void main() {
  if (aTeam.a <= 0.001) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vP = vec2(0.0); vInfo = vec4(0.0); vTeam = vec4(0.0); vFlags = vec3(0.0); return; }
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float dist = max(-mv.z, 1.0);
  // The state bits are decoded HERE, from the exact attribute value. Decoding them per fragment
  // from the interpolated varying made the Lord's plate flicker: its state is 4 (lord bit), and
  // an interpolated 3.9999 turns mod(st, 4) / mod(st, 2) into "selected + hovered" for that pixel.
  float st = floor(aInfo.w + 0.5);
  float hov = mod(st, 2.0);
  float sel = mod(floor(st * 0.5), 2.0);
  float lord = mod(floor(st * 0.25), 2.0);
  vFlags = vec3(hov, sel, lord);
  // constant screen size, a touch larger for Lords and for the hovered / selected squad
  float h = uSize * (1.0 + 0.16 * lord + 0.14 * sel + 0.07 * hov) * 2.0 * dist / projectionMatrix[1][1];
  vP = vec2(position.x * 3.4, position.y);
  mv.xy += vec2(position.x * 3.4, position.y + 0.5) * h;
  gl_Position = projectionMatrix * mv;
  gl_Position.z = 0.0;
  vInfo = aInfo;
  // hide when the camera is close enough to read the soldiers
  vTeam = vec4(aTeam.rgb, aTeam.a * smoothstep(11.0, 19.0, dist));
}`;

const FRAG = /* glsl */ `
uniform sampler2D uIcons;
varying vec2 vP;
varying vec4 vInfo;
varying vec4 vTeam;
varying vec3 vFlags;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
void over(inout vec4 dst, vec3 c, float a) {
  a = clamp(a, 0.0, 1.0);
  dst.rgb = mix(dst.rgb, c, a);
  dst.a = a + dst.a * (1.0 - a);
}
void main() {
  if (vTeam.a < 0.01) discard;
  vec2 p = vP;
  float aa = fwidth(p.y) * 1.3;
  float hp = clamp(vInfo.x, 0.0, 1.0);
  float hov = step(0.5, vFlags.x);
  float sel = step(0.5, vFlags.y);
  float lord = step(0.5, vFlags.z);
  vec3 team = vTeam.rgb;
  vec3 gold = vec3(1.0, 0.76, 0.28);
  vec3 rim = mix(mix(team, vec3(1.0), 0.18), gold, lord);
  vec3 ink = vec3(0.035, 0.03, 0.03);
  vec4 col = vec4(0.0);

  // ---- hp bar
  vec2 bc = vec2(0.42, -0.08);
  vec2 bh = vec2(1.08, 0.135);
  float d0 = sdBox(p - bc, bh, 0.07);
  over(col, vec3(0.0), 0.5 * (1.0 - smoothstep(0.0, 0.14, d0)));                       // drop shadow
  over(col, mix(vec3(1.0, 0.95, 0.8), gold, lord), max(sel, hov * 0.55) * (1.0 - smoothstep(0.02, 0.09, d0))); // highlight halo
  over(col, mix(ink, gold * 0.55, lord), 1.0 - smoothstep(-aa, aa, d0));               // frame
  float d1 = sdBox(p - bc, bh - 0.05, 0.035);
  float inside = 1.0 - smoothstep(-aa, aa, d1);
  over(col, vec3(0.1, 0.085, 0.08), inside);
  float x0 = bc.x - bh.x + 0.05;
  float fillTo = x0 + (bh.x - 0.05) * 2.0 * hp;
  float fill = inside * (1.0 - smoothstep(-aa, aa, p.x - fillTo));
  float shade = 0.78 + 0.5 * smoothstep(-0.1, 0.1, p.y - bc.y) - 0.25 * smoothstep(0.04, 0.09, p.y - bc.y);
  vec3 bar = mix(team, vec3(1.0), 0.22) * shade;
  bar = mix(bar, vec3(1.0, 0.25, 0.16) * shade, smoothstep(0.34, 0.2, hp));           // nearly broken: red
  over(col, bar, fill);
  // quarter ticks
  float tick = 1.0 - smoothstep(0.0, aa, abs(fract((p.x - x0) / ((bh.x - 0.05) * 0.5) + 0.5) - 0.5) * ((bh.x - 0.05) * 0.5) - 0.006);
  over(col, ink, tick * inside * 0.5);

  // ---- level pips (diamonds above the bar)
  float lv = floor(vInfo.y + 0.5);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= lv) break;
    vec2 q = p - vec2(-0.48 + float(i) * 0.3, 0.27);
    float dd = abs(q.x) + abs(q.y) - 0.115;
    over(col, ink, 1.0 - smoothstep(0.02 - aa, 0.02 + aa, dd));
    over(col, gold * (0.85 + 0.6 * smoothstep(-0.02, 0.06, q.y - q.x)), 1.0 - smoothstep(-aa, aa, dd + 0.015));
  }

  // ---- crest: portrait in a ring
  vec2 cc = vec2(-1.2, 0.0);
  float R = 0.47;
  float dc = length(p - cc) - R;
  over(col, vec3(0.0), 0.5 * (1.0 - smoothstep(0.0, 0.14, dc)));
  over(col, mix(vec3(1.0, 0.95, 0.8), gold, lord), max(sel, hov * 0.55) * (1.0 - smoothstep(0.02, 0.1, dc)));
  over(col, ink, 1.0 - smoothstep(-aa, aa, dc));
  over(col, rim * (0.8 + 0.4 * smoothstep(-0.3, 0.4, p.y)), 1.0 - smoothstep(-aa, aa, dc + 0.035));
  float icon = floor(vInfo.z + 0.5);
  vec2 iuv = (p - cc) / (R - 0.1) * 0.5 + 0.5;
  vec2 cell = vec2(mod(icon, ${COLS}.0), floor(icon / ${COLS}.0));
  vec3 tex = texture2D(uIcons, vec2((cell.x + clamp(iuv.x, 0.02, 0.98)) / ${COLS}.0, 1.0 - (cell.y + 1.0 - clamp(iuv.y, 0.02, 0.98)) / ${ROWS}.0)).rgb;
  over(col, ink, 1.0 - smoothstep(-aa, aa, dc + 0.085));
  over(col, min(tex * 1.7 + 0.03, vec3(1.0)), 1.0 - smoothstep(-aa, aa, dc + 0.1));

  col.a *= vTeam.a;
  if (col.a < 0.01) discard;
  gl_FragColor = col;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Agg {
  x: number;
  y: number;
  z: number;
  n: number;
  hp: number;
  max: number;
  top: number;
  level: number;
  icon: number;
  lord: boolean;
  team: THREE.Color;
  ghost: number;
  squad: number;
}

export class SquadPlates {
  readonly mesh: THREE.Mesh;
  private engine: Engine;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.InstancedBufferAttribute;
  private aInfo: THREE.InstancedBufferAttribute;
  private aTeam: THREE.InstancedBufferAttribute;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private states = new Map<number, number>();
  private aggs = new Map<number, Agg>();
  /** Master switch (the UI may prefer its own labels on some screens). */
  enabled = true;

  constructor(engine: Engine, iconBase = 'ui/') {
    this.engine = engine;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (name: string, n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.aPos = mk('aPos', 3);
    this.aInfo = mk('aInfo', 4);
    this.aTeam = mk('aTeam', 4);
    geo.instanceCount = 0;
    this.geo = geo;
    this.buildIcons(iconBase);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uIcons: { value: this.tex }, uSize: { value: 0.042 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 90;
    this.mesh.name = 'squad-plates';
    this.mesh.visible = false;
    engine.scene.add(this.mesh);
  }

  private buildIcons(base: string): void {
    const c = this.canvas;
    c.width = COLS * CELL;
    c.height = ROWS * CELL;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#2a2622';
    ctx.fillRect(0, 0, c.width, c.height);
    // fallback glyph: a plain helm
    const fx = (FALLBACK % COLS) * CELL + CELL / 2;
    const fy = Math.floor(FALLBACK / COLS) * CELL + CELL / 2;
    ctx.fillStyle = '#cfc7b4';
    ctx.beginPath();
    ctx.arc(fx, fy - 2, 17, Math.PI, 0);
    ctx.lineTo(fx + 17, fy + 16);
    ctx.lineTo(fx + 6, fy + 16);
    ctx.lineTo(fx + 6, fy + 2);
    ctx.lineTo(fx - 6, fy + 2);
    ctx.lineTo(fx - 6, fy + 16);
    ctx.lineTo(fx - 17, fy + 16);
    ctx.closePath();
    ctx.fill();
    ICONS.forEach((name, i) => {
      const img = new Image();
      img.onload = () => {
        // centre-top square crop (portraits keep the face / silhouette up top)
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = Math.max(0, (img.height - s) * 0.25);
        ctx.drawImage(img, sx, sy, s, s, (i % COLS) * CELL, Math.floor(i / COLS) * CELL, CELL, CELL);
        this.tex.needsUpdate = true;
        this.engine.wake();
      };
      void loadAssetVersions().then(() => (img.src = assetUrl(`${base}${name}.webp`)));
    });
  }

  /** Hover / selected state for a squad's plate (cleared states: pass {}). */
  setState(squadId: number, s: PlateState): void {
    const v = (s.hovered ? 1 : 0) + (s.selected ? 2 : 0);
    if (v) this.states.set(squadId, v);
    else this.states.delete(squadId);
    this.engine.wake();
  }

  clearStates(): void {
    if (!this.states.size) return;
    this.states.clear();
    this.engine.wake();
  }

  /** Rebuild the plates from the soldiers' current positions and HP (`hp[i]` per soldier). */
  sync(slots: readonly Slot[], hp: ArrayLike<number> | null): void {
    if (!this.enabled || !slots.length) {
      this.mesh.visible = false;
      return;
    }
    const aggs = this.aggs;
    aggs.clear();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const h = s.header;
      if (h.summoned) continue;
      const key = h.squad * 2 + h.side;
      let a = aggs.get(key);
      if (!a) {
        const lord = h.type === 'lord';
        const name = lord ? `lord_${h.lord}` : `unit_${h.type}`;
        const icon = ICONS.indexOf(name);
        a = { x: 0, y: 0, z: 0, n: 0, hp: 0, max: 0, top: 0, level: h.level, icon: icon < 0 ? FALLBACK : icon, lord, team: s.team, ghost: s.ghost, squad: h.squad };
        aggs.set(key, a);
      }
      a.max += h.maxHp;
      if (!s.visible || s.deadAt >= 0) continue;
      a.hp += hp ? Math.max(0, hp[i]) : h.maxHp;
      a.x += s.pos.x;
      a.y += s.pos.y;
      a.z += s.pos.z;
      a.n++;
      a.top = Math.max(a.top, s.arch.render === 'hero' ? 3.4 : 2.5);
    }
    const P = this.aPos.array as Float32Array;
    const I = this.aInfo.array as Float32Array;
    const T = this.aTeam.array as Float32Array;
    let k = 0;
    for (const a of aggs.values()) {
      if (!a.n || k >= MAX) continue;
      P[k * 3] = a.x / a.n;
      P[k * 3 + 1] = a.y / a.n + a.top;
      P[k * 3 + 2] = a.z / a.n;
      I[k * 4] = a.max > 0 ? a.hp / a.max : 1;
      I[k * 4 + 1] = Math.max(1, Math.min(5, a.level));
      I[k * 4 + 2] = a.icon;
      I[k * 4 + 3] = (this.states.get(a.squad) ?? 0) + (a.lord ? 4 : 0);
      T[k * 4] = a.team.r;
      T[k * 4 + 1] = a.team.g;
      T[k * 4 + 2] = a.team.b;
      T[k * 4 + 3] = a.ghost < 1 ? 0.5 : 1;
      k++;
    }
    this.geo.instanceCount = k;
    this.mesh.visible = k > 0;
    this.aPos.needsUpdate = this.aInfo.needsUpdate = this.aTeam.needsUpdate = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
