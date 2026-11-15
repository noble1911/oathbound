// Planning overlays drawn in the engine's scene (src/ui/engine-scene.ts owns one): footprint rings
// under the selected squads, the Lord's aura ring, the march routes and the seconds labels (plate tags
// and route marks). Everything is built once and only rewritten when the UI hands over new data, so an
// idle planning screen still draws nothing: the caller wakes the engine after each change.
//
// Coordinates arrive in the engine's field frame (already flipped for a seat-1 viewer) as field cm.
import * as THREE from 'three';

/** Your livery on dark (--me-hi in src/style.css): a route, a ring or a tag that belongs to you. */
const ME_HI = '#94b6f6';
const MAX_RINGS = 24;
/** Route ribbon capacity (segments over all routes). */
const MAX_SEGS = 1600;
const ROUTE_W = 0.3;
const MAX_LABELS = 96;
/** Label heights as a fraction of the viewport height (the plates are 0.042). */
const TAG_H = 0.022;
const MARK_H = 0.02;

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
    scene.add(this.rings, this.aura, this.auraFill, this.routes);
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

  private tags: { pos: THREE.Vector3; text: string; hot: boolean }[] = [];
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
  setTags(tags: { pos: THREE.Vector3; text: string; hot: boolean }[]): void {
    this.tags = tags;
  }

  /** Rebuild the label sprites from the current tags, marks and aura label (call after any of them changes). */
  layoutLabels(): void {
    this.used = 0;
    for (const t of this.tags) this.label(t.pos, t.text, t.hot ? 'hot' : 'tag', TAG_H, 1.18);
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
    for (let i = this.used; i < this.labels.length; i++) this.labels[i]!.visible = false;
  }

  private label(pos: THREE.Vector3, text: string, tone: 'tag' | 'hot' | 'mark' | 'dim', h: number, cy: number): void {
    if (this.used >= MAX_LABELS) return;
    let sp = this.labels[this.used];
    if (!sp) {
      sp = new THREE.Sprite();
      sp.renderOrder = 12;
      sp.frustumCulled = false;
      // constant screen size: the scale follows the camera's field of view on the frames that draw anyway
      sp.onBeforeRender = (_r, _s, cam) => {
        // a sprite without size attenuation spans scale x projection[1][1] / 2 of the viewport height
        const hh = (2 * (sp!.userData.h as number)) / cam.projectionMatrix.elements[5]!;
        sp!.scale.set(hh * (sp!.userData.aspect as number), hh, 1);
        sp!.updateMatrixWorld();
      };
      this.scene.add(sp);
      this.labels.push(sp);
    }
    const t = this.tex(text, tone);
    sp.material = t.mat;
    sp.userData.h = h;
    sp.userData.aspect = t.aspect;
    sp.center.set(0.5, cy);
    sp.position.copy(pos);
    sp.visible = true;
    this.used++;
  }

  /** One texture per distinct text and tone, kept (seconds labels repeat a lot). */
  private tex(text: string, tone: 'tag' | 'hot' | 'mark' | 'dim'): LabelTex {
    const key = tone + '|' + text;
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
    const w = Math.ceil(ctx.measureText(text).width) + 22;
    c.width = w;
    c.height = H;
    ctx.font = font;
    // a small iron plate (--iron-800), a slate hairline, steel text; the hot ones (being moved) in your livery
    ctx.fillStyle = 'rgba(21, 25, 32, 0.86)';
    ctx.fillRect(1, 1, w - 2, H - 2);
    ctx.strokeStyle = tone === 'hot' ? ME_HI : '#56616f';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, H - 2);
    ctx.fillStyle = tone === 'dim' ? '#b8c2ce' : tone === 'hot' ? '#ffffff' : '#e8ebef';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, H / 2 + 1);
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
    for (const m of [this.rings, this.aura, this.auraFill, this.routes]) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
