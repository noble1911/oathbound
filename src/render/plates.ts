// In-world squad plates: one per squad, floating over its soldiers, so armies stay readable at
// planning / battle zoom where a soldier is a dozen pixels tall. Each plate shows
//   · a crest with the unit's ROLE glyph (bow = ranged, horse = cavalry, ...) on its FACTION's colour
//     (ultramarine Kingdom, charcoal Covenant, terracotta Caliphate). The crest's SHAPE and ring say whose
//     it is: a round disc ringed blue is yours, a diamond ringed red is the enemy's; Lords wear a gold crown,
//   · the squad's total HP as a bar,
//   · level pips (1–5),
// and brightens / grows when the UI marks the squad hovered or selected.
//
// ONE instanced draw call: every plate is a quad whose fragment shader draws the frame, bar and
// pips as signed-distance shapes and samples the glyph from one atlas (public/ui/plates.webp, 128 px
// cells; its order is public/ui/plates.json; both are built by tools/art/glyph-atlas.py). The plate is
// drawn before the grade pass, so the shader pre-applies the inverse of the tone map and grade: the
// colours authored here and in the atlas are the colours on screen. Plates keep a constant screen
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

const COLS = 8;
const ROWS = 8; // 8 x 8 cells of 128 px = 1024 x 1024: room for 63 glyphs + the fallback
const MAX = 96;

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aInfo;   // hp 0..1, level, icon, state (bit 1 hover, 2 selected, 4 lord, 8 enemy)
attribute vec4 aTeam;   // rgb, alpha
uniform float uSize;    // plate height as a fraction of the viewport height
varying vec2 vP;
varying vec4 vInfo;
varying vec4 vTeam;
varying vec4 vFlags;  // hovered, selected, lord, enemy (0 or 1)
void main() {
  if (aTeam.a <= 0.001) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vP = vec2(0.0); vInfo = vec4(0.0); vTeam = vec4(0.0); vFlags = vec4(0.0); return; }
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float dist = max(-mv.z, 1.0);
  // The state bits are decoded HERE, from the exact attribute value. Decoding them per fragment
  // from the interpolated varying made the Lord's plate flicker: its state is 4 (lord bit), and
  // an interpolated 3.9999 turns mod(st, 4) / mod(st, 2) into "selected + hovered" for that pixel.
  float st = floor(aInfo.w + 0.5);
  float hov = mod(st, 2.0);
  float sel = mod(floor(st * 0.5), 2.0);
  float lord = mod(floor(st * 0.25), 2.0);
  float foe = mod(floor(st * 0.125), 2.0);
  vFlags = vec4(hov, sel, lord, foe);
  // constant screen size, a touch larger for Lords and for the hovered / selected squad
  float h = uSize * (1.0 + 0.16 * lord + 0.14 * sel + 0.07 * hov) * 2.0 * dist / projectionMatrix[1][1];
  // the quad is larger than the plate (1 unit tall): the enemy diamond's points and the Lord's crown stick out
  vP = vec2(position.x * 3.9, position.y * 1.8);
  mv.xy += vec2(vP.x, vP.y + 0.5) * h;
  gl_Position = projectionMatrix * mv;
  gl_Position.z = 0.0;
  vInfo = aInfo;
  // hide when the camera is close enough to read the soldiers
  vTeam = vec4(aTeam.rgb, aTeam.a * smoothstep(11.0, 19.0, dist));
}`;

const FRAG = /* glsl */ `
uniform sampler2D uIcons;
uniform float uPost;      // 1: the grade pass follows (ACES + curves); 0: three tone-maps in this shader
uniform float uExposure;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
varying vec2 vP;
varying vec4 vInfo;
varying vec4 vTeam;
varying vec4 vFlags;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
void over(inout vec4 dst, vec3 c, float a) {
  a = clamp(a, 0.0, 1.0);
  dst.rgb = mix(dst.rgb, c, a);
  dst.a = a + dst.a * (1.0 - a);
}
// ---- the inverse of the grade pass (core/post.ts), so a colour written here is the colour on screen
vec3 invFit(vec3 y) {
  y = clamp(y, 0.0, 0.93);
  vec3 A = 0.983729 * y - 1.0;
  vec3 B = 0.4329510 * y - 0.0245786;
  vec3 C = 0.238081 * y + 0.000090537;
  return (-B - sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
}
vec3 unAces(vec3 c) {
  const mat3 invOut = mat3(vec3(0.643038, 0.059269, 0.005962), vec3(0.311187, 0.931436, 0.063929), vec3(0.045775, 0.009295, 0.930118));
  const mat3 invIn = mat3(vec3(1.764741, -0.147028, -0.036337), vec3(-0.675778, 1.160252, -0.162436), vec3(-0.088963, -0.013224, 1.198773));
  return max(invIn * invFit(invOut * c), 0.0);
}
vec3 ungrade(vec3 t) {
  vec3 c = clamp(t, 0.0, 1.0);
  if (uPost > 0.5) {
    // contrast S-curve: g(c) = mix(c, c*c*(3-2c), k); three Newton steps
    for (int i = 0; i < 3; i++) {
      vec3 g = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
      vec3 dg = (1.0 - uContrast) + uContrast * 6.0 * c * (1.0 - c);
      c = clamp(c - (g - t) / dg, 0.0, 1.0);
    }
    c = max((c / uGain - uLift) / (1.0 - uLift), 0.0);   // lift / gain
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c /= mix(uShadowTint, uHighTint, smoothstep(0.05, 0.75, l)); // split tone
  }
  // scene-linear; kept under the bloom threshold so a pale glyph never glows
  return min(unAces(c) * 0.6 / uExposure, vec3(1.25));
}
void main() {
  if (vTeam.a < 0.01) discard;
  vec2 p = vP;
  float aa = fwidth(p.y) * 1.3;
  float hp = clamp(vInfo.x, 0.0, 1.0);
  float hov = step(0.5, vFlags.x);
  float sel = step(0.5, vFlags.y);
  float lord = step(0.5, vFlags.z);
  float foe = step(0.5, vFlags.w);
  vec3 team = vTeam.rgb;
  vec3 gold = vec3(1.0, 0.72, 0.2);
  vec3 ink = vec3(0.012, 0.011, 0.012);
  vec3 halo = mix(vec3(1.0, 0.97, 0.85), gold, lord);
  vec4 col = vec4(0.0);

  // ---- hp bar (the side's colour: blue is yours, red is the enemy's)
  vec2 bc = vec2(0.46, -0.08);
  vec2 bh = vec2(1.08, 0.135);
  float d0 = sdBox(p - bc, bh, 0.07);
  over(col, vec3(0.0), 0.5 * (1.0 - smoothstep(0.0, 0.14, d0)));                       // drop shadow
  over(col, halo, max(sel, hov * 0.55) * (1.0 - smoothstep(0.02, 0.09, d0)));          // highlight halo
  over(col, mix(ink, gold * 0.4, lord), 1.0 - smoothstep(-aa, aa, d0));                // frame
  float d1 = sdBox(p - bc, bh - 0.05, 0.035);
  float inside = 1.0 - smoothstep(-aa, aa, d1);
  over(col, vec3(0.03, 0.028, 0.03), inside);
  float x0 = bc.x - bh.x + 0.05;
  float fillTo = x0 + (bh.x - 0.05) * 2.0 * hp;
  float fill = inside * (1.0 - smoothstep(-aa, aa, p.x - fillTo));
  float shade = 0.7 + 0.3 * smoothstep(-0.1, 0.06, p.y - bc.y);
  vec3 side = mix(vec3(0.08, 0.36, 1.0), vec3(0.96, 0.05, 0.04), foe);   // display-linear: sky blue / scarlet
  vec3 bar = side * shade;
  over(col, bar, fill);
  // quarter ticks
  float tick = 1.0 - smoothstep(0.0, aa, abs(fract((p.x - x0) / ((bh.x - 0.05) * 0.5) + 0.5) - 0.5) * ((bh.x - 0.05) * 0.5) - 0.006);
  over(col, ink, tick * inside * 0.5);

  // ---- level pips (diamonds above the bar)
  float lv = floor(vInfo.y + 0.5);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= lv) break;
    vec2 q = p - vec2(-0.44 + float(i) * 0.3, 0.27);
    float dd = abs(q.x) + abs(q.y) - 0.115;
    over(col, ink, 1.0 - smoothstep(0.02 - aa, 0.02 + aa, dd));
    over(col, gold * (0.75 + 0.5 * smoothstep(-0.02, 0.06, q.y - q.x)), 1.0 - smoothstep(-aa, aa, dd + 0.015));
  }

  // ---- crest: the role glyph on the faction's colour. Yours is a DISC, the enemy's a DIAMOND; the thick
  // ring is the side's colour, held off the faction colour by an ink line on both sides.
  vec2 q = p - vec2(-1.2, 0.0);
  float R = 0.5;
  float dDisc = length(q) - R;
  float dDiam = sdBox(vec2(q.x + q.y, q.y - q.x) * 0.70711, vec2(R * 0.93), 0.07);
  float dc = mix(dDisc, dDiam, foe);
  over(col, vec3(0.0), 0.55 * (1.0 - smoothstep(0.0, 0.14, dc)));
  over(col, halo, max(sel, hov * 0.55) * (1.0 - smoothstep(0.02, 0.1, dc)));
  over(col, ink, 1.0 - smoothstep(-aa, aa, dc));
  over(col, side * (0.85 + 0.15 * smoothstep(-0.3, 0.4, q.y)), 1.0 - smoothstep(-aa, aa, dc + 0.03));
  over(col, ink, 1.0 - smoothstep(-aa, aa, dc + 0.105));
  float icon = floor(vInfo.z + 0.5);
  vec2 iuv = clamp(q / (R - 0.125) * 0.5 + 0.5, 0.03, 0.97);
  vec2 cell = vec2(mod(icon, ${COLS}.0), floor(icon / ${COLS}.0));
  vec3 tex = texture2D(uIcons, vec2((cell.x + iuv.x) / ${COLS}.0, 1.0 - (cell.y + 1.0 - iuv.y) / ${ROWS}.0), -0.6).rgb;
  over(col, tex, 1.0 - smoothstep(-aa, aa, dc + 0.125));

  // ---- Lords: a gold crown over the crest
  if (lord > 0.5) {
    vec2 k = q - vec2(0.0, R - 0.1 + 0.16 * foe);
    float top = 0.1 + 0.17 * abs(cos(k.x * 13.09));
    float dk = max(max(abs(k.x) - 0.27, k.y - top), -k.y);
    over(col, ink, 1.0 - smoothstep(0.03 - aa, 0.03 + aa, dk));
    over(col, gold * (0.8 + 0.5 * smoothstep(0.0, 0.25, k.y)), 1.0 - smoothstep(-aa, aa, dk));
  }

  col.rgb = ungrade(col.rgb);
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
  foe: boolean;
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
  private tex: THREE.Texture;
  /** `unit_<type>` / `lord_<id>` -> atlas cell (public/ui/plates.json); empty until it arrives. */
  private icons = new Map<string, number>();
  private fallback = COLS * ROWS - 1;
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
    // a 1 px slate stand-in until the atlas arrives
    this.tex = new THREE.DataTexture(new Uint8Array([58, 67, 80, 255]), 1, 1);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.needsUpdate = true;
    const g = engine.post.grade;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uIcons: { value: this.tex }, uSize: { value: 0.045 }, uPost: { value: 1 }, uExposure: { value: g.exposure }, uContrast: { value: g.contrast },
        uLift: { value: g.lift }, uGain: { value: g.gain }, uShadowTint: { value: g.shadowTint }, uHighTint: { value: g.highTint },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    void this.loadIcons(iconBase);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 90;
    this.mesh.name = 'squad-plates';
    this.mesh.visible = false;
    engine.scene.add(this.mesh);
  }

  private async loadIcons(base: string): Promise<void> {
    await loadAssetVersions();
    try {
      const r = await fetch(assetUrl(`${base}plates.json`));
      const j = (await r.json()) as { ids: string[]; fallback: number; cols: number; rows: number };
      if (j.cols !== COLS || j.rows !== ROWS) throw new Error('plate atlas layout changed');
      const img = new Image();
      img.src = assetUrl(`${base}plates.webp`);
      await img.decode();
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.tex.dispose();
      this.tex = tex;
      this.mat.uniforms.uIcons.value = tex;
      j.ids.forEach((id, i) => this.icons.set(id, i));
      this.fallback = j.fallback;
      this.engine.wake();
    } catch {
      /* no atlas: every plate keeps the slate stand-in */
    }
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
    const u = this.mat.uniforms;
    u.uPost.value = this.engine.renderer.toneMapping === THREE.NoToneMapping ? 1 : 0;
    u.uExposure.value = this.engine.post.grade.exposure;
    u.uContrast.value = this.engine.post.grade.contrast;
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
        a = { x: 0, y: 0, z: 0, n: 0, hp: 0, max: 0, top: 0, level: h.level, icon: this.icons.get(name) ?? this.fallback, lord, foe: h.side === 1, team: s.team, ghost: s.ghost, squad: h.squad };
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
      I[k * 4 + 3] = (this.states.get(a.squad) ?? 0) + (a.lord ? 4 : 0) + (a.foe ? 8 : 0);
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
