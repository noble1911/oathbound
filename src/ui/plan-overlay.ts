// Planning overlays drawn in the engine's scene (src/ui/engine-scene.ts owns one): footprint rings
// under the selected squads, the Lord's aura ring, the march routes, the seconds labels (plate tags
// and route marks) and the Lord's stance (a dashed watch ring round his post, or a tether to the squad he follows). Everything is built once and only rewritten when the UI hands over new data, so an
// idle planning screen still draws nothing: the caller wakes the engine after each change.
//
// Coordinates arrive in the engine's field frame (already flipped for a seat-1 viewer) as field cm.
import * as THREE from 'three';
import type { StanceSpec, TagBadge } from './scene-adapter.ts';
import type { Formation } from '../sim/types.ts';

/** Your livery on dark (--me-hi in src/style.css): a route, a ring or a tag that belongs to you. */
const ME_HI = '#94b6f6';
/** The enemy's livery on dark (--foe-hi): the intel marks on its ghosts. */
const FOE_HI = '#f4a097';
const MAX_RINGS = 24;
/** Route ribbon capacity (segments over all routes). */
const MAX_SEGS = 1600;
const ROUTE_W = 0.3;
const MAX_LABELS = 96;
/** Label heights as a fraction of the viewport height. */
const TAG_H = 0.022;
const MARK_H = 0.02;
/**
 * A squad plate's height as a fraction of the viewport height (src/render/plates.ts uSize 0.045, up to 16% larger
 * for a Lord or a selected squad), and its half-width in plate heights (crest disc + bar). The plate stands on
 * its anchor: it spans [anchor - h, anchor] on screen.
 */
const PLATE_H = 0.045 * 1.12;
const PLATE_HALF_W = 1.65;

type HeightAt = (x: number, z: number) => number;

interface LabelTex {
  tex: THREE.CanvasTexture;
  mat: THREE.SpriteMaterial;
  aspect: number;
}

const wx = (xcm: number) => xcm / 100 - 40;
const wz = (ycm: number) => 60 - ycm / 100;

export class PlanOverlay {
  private rings: THREE.InstancedMesh;
  private aura: THREE.Mesh;
  private auraFill: THREE.Mesh;
  private routes: THREE.Mesh;
  /** The Lord's stance: the dashed ring (hold: watch; follow: leash), the post mark (ring + dot) and the tether ribbon. */
  private stRing: THREE.Mesh;
  private stPost: THREE.Mesh;
  private stDot: THREE.Mesh;
  private stTether: THREE.Mesh;
  private stance: StanceSpec | null = null;
  private routePos: Float32Array;
  private routeCol: Float32Array;
  private labels: THREE.Sprite[] = [];
  private used = 0;
  private texCache = new Map<string, LabelTex>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();

  private scene: THREE.Scene;
  private heightAt: HeightAt;

  constructor(scene: THREE.Scene, heightAt: HeightAt) {
    this.scene = scene;
    this.heightAt = heightAt;
    const flat = (g: THREE.BufferGeometry) => (g.rotateX(-Math.PI / 2), g);
    const mat = (opacity: number, color = ME_HI) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false });
    this.rings = new THREE.InstancedMesh(flat(new THREE.RingGeometry(0.9, 1, 48)), mat(0.85), MAX_RINGS);
    this.rings.count = 0;
    this.rings.renderOrder = 9;
    this.rings.frustumCulled = false;
    this.aura = new THREE.Mesh(flat(new THREE.RingGeometry(0.99, 1, 128)), mat(0.75));
    this.auraFill = new THREE.Mesh(flat(new THREE.CircleGeometry(1, 96)), mat(0.06));
    for (const m of [this.aura, this.auraFill]) {
      m.renderOrder = 9;
      m.visible = false;
    }
    // one ribbon mesh for every route: two triangles per segment, written in place
    const g = new THREE.BufferGeometry();
    this.routePos = new Float32Array(MAX_SEGS * 6 * 3);
    this.routeCol = new Float32Array(MAX_SEGS * 6 * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.routePos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.routeCol, 4).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.routes = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
    this.routes.renderOrder = 8;
    this.routes.frustumCulled = false;
    this.routes.visible = false;
    // stance: a unit dashed ring (scaled to the leash), a small post ring and dot, and a tether ribbon rebuilt on change
    this.stRing = new THREE.Mesh(flat(dashedRing(0.988, 1, 64, 0.55)), mat(0.7));
    this.stPost = new THREE.Mesh(flat(new THREE.RingGeometry(0.72, 1, 40)), mat(0.9));
    this.stDot = new THREE.Mesh(flat(new THREE.CircleGeometry(0.32, 20)), mat(0.9));
    this.stTether = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: ME_HI, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
    for (const m of [this.stRing, this.stPost, this.stDot, this.stTether]) {
      m.renderOrder = 9;
      m.visible = false;
      m.frustumCulled = false;
    }
    scene.add(this.rings, this.aura, this.auraFill, this.routes, this.stRing, this.stPost, this.stDot, this.stTether);
  }

  // ---------------------------------------------------------------- the Lord's stance

  /** My Lord's stance markers (engine-frame field cm), or null. Call layoutLabels() after: its label is one of them. */
  setStance(st: StanceSpec | null): void {
    this.stance = st;
    for (const m of [this.stRing, this.stPost, this.stDot, this.stTether]) m.visible = false;
    if (!st) return;
    const bright = st.focus ? 1 : 0.62;
    const px = wx(st.post[0]), pz = wz(st.post[1]);
    const py = this.heightAt(px, pz) + 0.15;
    // hold: the watch ring always (faint unless he is selected); follow: its leash ring only while he is selected
    if (st.kind === 'hold' || st.focus) {
      const r = st.leash / 100;
      this.stRing.position.set(px, py, pz);
      this.stRing.scale.set(r, 1, r);
      (this.stRing.material as THREE.MeshBasicMaterial).opacity = (st.kind === 'hold' ? 0.75 : 0.5) * bright;
      this.stRing.visible = true;
    }
    if (st.kind === 'follow') {
      const k = 1.1;
      this.stPost.position.set(px, py + 0.01, pz);
      this.stPost.scale.set(k, 1, k);
      this.stDot.position.set(px, py + 0.02, pz);
      (this.stPost.material as THREE.MeshBasicMaterial).opacity = 0.9 * bright;
      (this.stDot.material as THREE.MeshBasicMaterial).opacity = 0.9 * bright;
      this.stPost.visible = this.stDot.visible = true;
    }
    // the tether: dashed from the Lord to his spot, then a solid line on to the squad he follows
    const pts: number[] = [];
    const seg = (a: readonly number[], b: readonly number[], dash: boolean, from: number, to: number) => {
      const x0 = wx(a[0]), z0 = wz(a[1]), x1 = wx(b[0]), z1 = wz(b[1]);
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < from + to + 0.5) return;
      const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
      const nx = -uz * 0.13, nz = ux * 0.13;
      const step = dash ? 1.1 : len;
      for (let t = from; t < len - to; t += step) {
        const t1 = Math.min(len - to, t + (dash ? 0.65 : len));
        const ax = x0 + ux * t, az = z0 + uz * t, bx = x0 + ux * t1, bz = z0 + uz * t1;
        const ay = this.heightAt(ax, az) + 0.14, by = this.heightAt(bx, bz) + 0.14;
        pts.push(ax - nx, ay, az - nz, ax + nx, ay, az + nz, bx + nx, by, bz + nz, ax - nx, ay, az - nz, bx + nx, by, bz + nz, bx - nx, by, bz - nz);
      }
    };
    if (st.kind === 'follow') {
      seg(st.lord, st.post, true, 1.2, 1.2);
      if (st.lead) seg(st.post, st.lead, false, 1.2, 1.5);
    }
    if (pts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.stTether.geometry.dispose();
      this.stTether.geometry = g;
      (this.stTether.material as THREE.MeshBasicMaterial).opacity = 0.85 * bright;
      this.stTether.visible = true;
    }
  }

  // ---------------------------------------------------------------- selection rings

  /** Rings under the selected squads: centre (field cm) and radius (cm). */
  setRings(list: { pos: [number, number]; r: number }[]): void {
    const n = Math.min(MAX_RINGS, list.length);
    for (let i = 0; i < n; i++) {
      const it = list[i]!;
      const x = wx(it.pos[0]);
      const z = wz(it.pos[1]);
      const r = it.r / 100 + 0.55;
      this.m4.compose(this.v.set(x, this.heightAt(x, z) + 0.14, z), this.q, this.s.set(r, 1, r));
      this.rings.setMatrixAt(i, this.m4);
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- aura

  setAura(a: { pos: [number, number]; radius: number; label: string } | null): void {
    this.aura.visible = this.auraFill.visible = !!a;
    this.auraLabel = a;
  }
  private auraLabel: { pos: [number, number]; radius: number; label: string } | null = null;

  // ---------------------------------------------------------------- routes + labels

  private tags: { pos: THREE.Vector3; text: string; hot: boolean; badge?: TagBadge; foe?: boolean; form?: Formation }[] = [];
  /** Tag sprites in `tags` order (labels[0..n)), and the camera state their placement was worked out for. */
  private tagCount = 0;
  private clutterKey = '';
  private clutterFrame = -1;
  private pv = new THREE.Vector3();
  private marks: { pos: THREE.Vector3; text: string; dim: boolean }[] = [];

  /** Routes as field-cm polylines (engine frame). */
  setRoutes(routes: { pts: [number, number][]; hot?: boolean; marks: { pos: [number, number]; text: string; dim?: boolean }[] }[]): void {
    let k = 0;
    const P = this.routePos;
    const C = this.routeCol;
    const me = new THREE.Color(ME_HI);
    this.marks.length = 0;
    for (const r of routes) {
      const a = r.hot ? 0.95 : 0.6;
      for (let i = 1; i < r.pts.length && k < MAX_SEGS; i++) {
        const p0 = r.pts[i - 1]!;
        const p1 = r.pts[i]!;
        const x0 = wx(p0[0]), z0 = wz(p0[1]), x1 = wx(p1[0]), z1 = wz(p1[1]);
        const dx = x1 - x0, dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const nx = (-dz / len) * ROUTE_W * 0.5;
        const nz = (dx / len) * ROUTE_W * 0.5;
        const y0 = this.heightAt(x0, z0) + 0.1;
        const y1 = this.heightAt(x1, z1) + 0.1;
        // fade the first few metres in, so a route leaves its squad instead of starting on top of it
        const f0 = Math.min(1, i / 3) * a;
        const f1 = Math.min(1, (i + 1) / 3) * a;
        const quad = [x0 - nx, y0, z0 - nz, x0 + nx, y0, z0 + nz, x1 + nx, y1, z1 + nz, x0 - nx, y0, z0 - nz, x1 + nx, y1, z1 + nz, x1 - nx, y1, z1 - nz];
        const al = [f0, f0, f1, f0, f1, f1];
        for (let v = 0; v < 6; v++) {
          P.set(quad.slice(v * 3, v * 3 + 3), (k * 6 + v) * 3);
          C[(k * 6 + v) * 4] = me.r;
          C[(k * 6 + v) * 4 + 1] = me.g;
          C[(k * 6 + v) * 4 + 2] = me.b;
          C[(k * 6 + v) * 4 + 3] = al[v]!;
        }
        k++;
      }
      for (const m of r.marks) {
        const x = wx(m.pos[0]);
        const z = wz(m.pos[1]);
        this.marks.push({ pos: new THREE.Vector3(x, this.heightAt(x, z) + 0.3, z), text: m.text, dim: !!m.dim });
      }
    }
    const g = this.routes.geometry;
    g.setDrawRange(0, k * 6);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.routes.visible = k > 0;
  }

  /** Plate tags: world anchors (just under each squad's plate) and their text. */
  setTags(tags: { pos: THREE.Vector3; text: string; hot: boolean; badge?: TagBadge; foe?: boolean; form?: Formation }[]): void {
    this.tags = tags;
  }

  /** Rebuild the label sprites from the current tags, marks and aura label (call after any of them changes). */
  layoutLabels(): void {
    this.used = 0;
    for (const t of this.tags) this.label(t.pos, t.text, t.hot ? 'hot' : 'tag', TAG_H, 1.18, t.badge, t.foe, t.form);
    this.tagCount = this.used;
    this.clutterKey = '';
    this.clutterFrame = -1;
    for (const m of this.marks) this.label(m.pos, m.text, m.dim ? 'dim' : 'mark', MARK_H, 0.5);
    const a = this.auraLabel;
    if (a) {
      // the ring itself, and its name on the near edge (towards the viewer's own Keep)
      const x = wx(a.pos[0]);
      const z = wz(a.pos[1]);
      const r = a.radius / 100;
      const y = this.heightAt(x, z) + 0.16;
      this.aura.position.set(x, y, z);
      this.auraFill.position.set(x, y - 0.02, z);
      this.aura.scale.set(r, 1, r);
      this.auraFill.scale.set(r, 1, r);
      // on the ring's left edge: the near edge sits under the shop at planning zoom
      const ex = x - r;
      this.label(new THREE.Vector3(ex, this.heightAt(ex, z) + 0.3, z), `${a.label} · ${Math.round(a.radius / 100)} m`, 'mark', MARK_H, 0.5);
    }
    const st = this.stance;
    if (st) {
      // hold: the name on the ring's far-left edge (the aura's sits on its left edge, the near edge under the shop);
      // follow: just in front of the spot he will stand on
      const k = st.kind === 'hold' ? (st.leash / 100) * Math.SQRT1_2 : 0;
      const x = wx(st.post[0]) - k;
      const z = wz(st.post[1]) + (st.kind === 'hold' ? -k : 1.8);
      this.label(new THREE.Vector3(x, this.heightAt(x, z) + 0.3, z), st.label, 'mark', MARK_H, 0.5, st.kind);
    }
    for (let i = this.used; i < this.labels.length; i++) this.labels[i]!.visible = false;
  }

  private label(pos: THREE.Vector3, text: string, tone: 'tag' | 'hot' | 'mark' | 'dim', h: number, cy: number, badge?: TagBadge, foeTag = false, form?: Formation): void {
    if (this.used >= MAX_LABELS) return;
    let sp = this.labels[this.used];
    if (!sp) {
      sp = new THREE.Sprite();
      sp.renderOrder = 12;
      sp.frustumCulled = false;
      // constant screen size: the scale follows the camera's field of view on the frames that draw anyway
      sp.onBeforeRender = (r, _s, cam) => {
        this.declutter(cam, r.info.render.frame);
        // a sprite without size attenuation spans scale x projection[1][1] / 2 of the viewport height
        const hh = (2 * (sp!.userData.h as number)) / cam.projectionMatrix.elements[5]!;
        sp!.scale.set(hh * (sp!.userData.aspect as number), hh, 1);
        sp!.updateMatrixWorld();
      };
      this.scene.add(sp);
      this.labels.push(sp);
    }
    const t = this.tex(text, tone, badge, foeTag, form);
    sp.material = t.mat;
    sp.userData.h = h;
    sp.userData.aspect = t.aspect;
    sp.center.set(0.5, cy);
    sp.position.copy(pos);
    sp.visible = true;
    this.used++;
  }

  /**
   * Keep the seconds tags off the other squads' plates. A tag hangs under its own plate; where that spot would
   * cover another plate (squads stacked close on screen, which happens a lot at 1024x768) or an earlier tag, it
   * moves beside its plate (right, then left) or above it. Worked out in screen space for the camera being drawn,
   * and only again when that camera or the tags change, so it costs nothing on frames that are drawn anyway and
   * never asks for a frame of its own.
   */
  private declutter(cam: THREE.Camera, frame: number): void {
    const n = this.tagCount;
    if (!n || frame === this.clutterFrame) return;
    this.clutterFrame = frame;
    const pc = cam as THREE.PerspectiveCamera;
    const aspect = pc.aspect || 1;
    const e = cam.matrixWorld.elements, pe = cam.projectionMatrix.elements;
    const key = `${aspect.toFixed(4)}|${e.map((x) => x.toFixed(3)).join(',')}|${pe[0]!.toFixed(4)},${pe[5]!.toFixed(4)}`;
    if (key === this.clutterKey) return;
    this.clutterKey = key;
    // anchors in viewport-height units, y down
    const at: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      this.pv.copy(this.labels[i]!.position).project(cam);
      at.push([(this.pv.x * aspect) / 2, -this.pv.y / 2]);
    }
    const P = PLATE_H, pw = PLATE_HALF_W * P, th = TAG_H;
    const plates = at.map(([x, y]) => [x - pw, y - P, x + pw, y] as const);
    const placed: (readonly [number, number, number, number])[] = [];
    const hit = (b: readonly [number, number, number, number], own: number): boolean => {
      const over = (o: readonly [number, number, number, number]) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1];
      return plates.some((o, j) => j !== own && over(o)) || placed.some(over);
    };
    for (let i = 0; i < n; i++) {
      const sp = this.labels[i]!;
      const tw = th * (sp.userData.aspect as number);
      const [x, y] = at[i]!;
      // left / top corners of the candidate boxes: under the plate, right of it, left of it, above it
      const spots: [number, number][] = [
        [x - tw / 2, y + 0.18 * th],
        [x + pw + 0.004, y - P / 2 - th / 2],
        [x - pw - 0.004 - tw, y - P / 2 - th / 2],
        [x - tw / 2, y - P * 1.3 - th],
      ];
      let pick = spots[0]!;
      for (const s of spots) {
        if (!hit([s[0], s[1], s[0] + tw, s[1] + th], i)) { pick = s; break; }
      }
      placed.push([pick[0], pick[1], pick[0] + tw, pick[1] + th]);
      // the anchor maps to (cx, cy) of the sprite (0..1 left to right, bottom to top)
      sp.center.set((x - pick[0]) / tw, 1 - (y - pick[1]) / th);
    }
  }

  /** One texture per distinct text and tone, kept (seconds labels repeat a lot). */
  private tex(text: string, tone: 'tag' | 'hot' | 'mark' | 'dim', badge?: TagBadge, foeTag = false, form?: Formation): LabelTex {
    const key = tone + '|' + (badge ?? '') + (foeTag ? '!' : '') + (form ?? '') + '|' + text;
    let t = this.texCache.get(key);
    if (t) return t;
    if (this.texCache.size > 400) {
      for (const v of this.texCache.values()) {
        v.tex.dispose();
        v.mat.dispose();
      }
      this.texCache.clear();
    }
    const H = 44;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const font = `700 ${tone === 'tag' || tone === 'hot' ? 30 : 28}px "Source Sans 3", "Segoe UI", sans-serif`;
    ctx.font = font;
    const foe = foeTag || badge === 'moved' || badge === 'new';
    // a badge takes a square at the left of the text (or the whole tag when there is no text)
    const bw = badge ? (text ? 36 : 40) : 0;
    const tw = text ? Math.ceil(ctx.measureText(text).width) + 22 : 0;
    // a squad in the formation that is not the default (src/ui/formation.ts): its small glyph closes the tag, after a hairline
    const dw = form ? (text || badge ? (form === 'deep' ? 26 : 38) : form === 'deep' ? 32 : 44) : 0;
    const w = bw + tw + (badge && text ? -4 : 0) + dw;
    c.width = w;
    c.height = H;
    ctx.font = font;
    // a small iron plate (--iron-800), a slate hairline, steel text; the hot ones (being moved) in your livery, the
    // intel marks on enemy ghosts in theirs
    ctx.fillStyle = 'rgba(21, 25, 32, 0.86)';
    ctx.fillRect(1, 1, w - 2, H - 2);
    ctx.strokeStyle = tone === 'hot' ? ME_HI : foe ? FOE_HI : badge === 'reloc' || badge === 'open' || badge === 'hold' || badge === 'follow' ? ME_HI : '#56616f';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, H - 2);
    if (badge) drawBadge(ctx, badge, text ? 7 : 6, H / 2, badge === 'lock' ? '#b8c2ce' : foe ? FOE_HI : ME_HI);
    ctx.fillStyle = tone === 'dim' ? '#b8c2ce' : tone === 'hot' ? '#ffffff' : foe ? FOE_HI : '#e8ebef';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (text) ctx.fillText(text, bw + (badge ? -4 : 0) + tw / 2, H / 2 + 1);
    if (form) {
      const x0 = w - dw;
      if (text || badge) {
        ctx.fillStyle = '#56616f';
        ctx.fillRect(x0, 9, 2, H - 18);
      }
      drawFormation(ctx, form, x0 + dw / 2 + (text || badge ? 1 : 0), H / 2, foe ? FOE_HI : '#b8c2ce');
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
    t = { tex, mat, aspect: w / H };
    this.texCache.set(key, t);
    return t;
  }

  dispose(): void {
    for (const v of this.texCache.values()) {
      v.tex.dispose();
      v.mat.dispose();
    }
    this.texCache.clear();
    for (const sp of this.labels) this.scene.remove(sp);
    for (const m of [this.rings, this.aura, this.auraFill, this.routes, this.stRing, this.stPost, this.stDot, this.stTether]) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

/**
 * A 24-unit line glyph in the style of src/ui/icons.ts (2-unit strokes, round joins), drawn into a label at (x, cy)
 * scaled to the label: a padlock (shut, or open when a Muster relocation may move the squad), the relocation arrow,
 * and the two intel marks on enemy ghosts (moved: a footprint arrow; new: a small star).
 */
function drawBadge(ctx: CanvasRenderingContext2D, b: TagBadge, x: number, cy: number, color: string): void {
  const k = 1.15;
  ctx.save();
  ctx.translate(x, cy - 12 * k);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = (d: string) => ctx.stroke(new Path2D(d));
  if (b === 'lock' || b === 'open') {
    ctx.globalAlpha = 0.3;
    ctx.fill(new Path2D('M5 11h14v10H5z'));
    ctx.globalAlpha = 1;
    path('M5 11h14v10H5z');
    path(b === 'lock' ? 'M8 11V8a4 4 0 018 0v3' : 'M8 11V7a4 4 0 017.6-1.6');
    path('M12 15v2');
  } else if (b === 'hold') {
    // src/ui/icons.ts st_hold: a planted standard on its ground
    path('M11 18V3.5');
    ctx.globalAlpha = 0.3;
    ctx.fill(new Path2D('M11 4.5h7l-2.2 2.7L18 10h-7z'));
    ctx.globalAlpha = 1;
    path('M11 4.5h7l-2.2 2.7L18 10h-7z');
    path('M3.5 19c0-1.5 3.4-2.6 7.5-2.6s7.5 1.1 7.5 2.6-3.4 2.6-7.5 2.6-7.5-1.1-7.5-2.6z');
  } else if (b === 'follow') {
    // st_follow: a squad ahead, the Lord behind it on a tether
    ctx.globalAlpha = 0.3;
    ctx.fill(new Path2D('M8 2.5h8a1 1 0 011 1v4a1 1 0 01-1 1H8a1 1 0 01-1-1v-4a1 1 0 011-1z'));
    ctx.globalAlpha = 1;
    path('M8 2.5h8a1 1 0 011 1v4a1 1 0 01-1 1H8a1 1 0 01-1-1v-4a1 1 0 011-1z');
    path('M12 10.5v5');
    path('M12 19m-2.6 0a2.6 2.6 0 105.2 0a2.6 2.6 0 10-5.2 0');
  } else if (b === 'reloc' || b === 'moved') {
    path('M4 18c3-8 8-11 15-11');
    path('M15 3l4 4-4 4');
    ctx.fill(new Path2D('M4 18m-2.2 0a2.2 2.2 0 104.4 0a2.2 2.2 0 10-4.4 0'));
  } else {
    ctx.globalAlpha = 0.3;
    ctx.fill(new Path2D('M12 3l2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 16.6 6.4 20l1.5-6.3L3 9.5 9.4 9z'));
    ctx.globalAlpha = 1;
    path('M12 3l2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 16.6 6.4 20l1.5-6.3L3 9.5 9.4 9z');
  }
  ctx.restore();
}

/**
 * A formation's mark (src/ui/icons.ts fm_deep / fm_wide without the chevron), centred on (cx, cy): deep two files of
 * four soldiers, wide two ranks of four.
 */
function drawFormation(ctx: CanvasRenderingContext2D, f: Formation, cx: number, cy: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  const [files, ranks] = f === 'deep' ? [2, 4] : [4, 2];
  for (let r = 0; r < ranks; r++) for (let c = 0; c < files; c++) {
    ctx.beginPath();
    ctx.arc(cx + (c - (files - 1) / 2) * 7, cy + (r - (ranks - 1) / 2) * 7.4, 2.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A flat ring of `n` dashes (unit radius, in the XY plane like RingGeometry), each `fill` of its step long. */
function dashedRing(inner: number, outer: number, n: number, fill: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const SUB = 4;
  for (let d = 0; d < n; d++) {
    const a0 = (d / n) * Math.PI * 2;
    const a1 = a0 + ((Math.PI * 2) / n) * fill;
    const base = pos.length / 3;
    for (let i = 0; i <= SUB; i++) {
      const a = a0 + ((a1 - a0) * i) / SUB;
      pos.push(Math.cos(a) * inner, Math.sin(a) * inner, 0, Math.cos(a) * outer, Math.sin(a) * outer, 0);
      if (i < SUB) {
        const k = base + i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
