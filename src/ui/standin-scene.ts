// Stand-in battlefield renderer behind SceneAdapter: enough three.js to plan and watch battles
// (painted terrain, keeps, instanced soldier blobs, ghosts, rings, projectiles, impact flashes,
// an RTS camera and a battle director) until the render agent's engine is mapped in.
//
// World axes: X = (x - 4000) / 100 m, Z = (6000 - y) / 100 m, so seat 0's Keep (y = 0) sits at
// +Z, nearest the default camera. A field facing f (0..255, 0 = +x, 64 = +y) is rotation.y = f·2π/256.
import * as THREE from 'three';
import type { DecodedReplay, ReplayEvent, Seat, SoldierTransforms, SquadType, Terrain, Vec2 } from '../sim/types.ts';
import { FIELD_H, FIELD_W, KEYFRAME_TICKS } from '../sim/constants.ts';
import { UNITS } from '../sim/data/units.ts';
import type { CameraMode, PlaybackHandle, PreviewSpec, RangeSpec, SceneAdapter, SceneMode, ScreenPoint, SquadVisual } from './scene-adapter.ts';
import { formation, squadRadius } from './gamedata.ts';
import { RARITY_CSS } from './gamedata.ts';

const OWN = new THREE.Color('#4f9dff');
const FOE = new THREE.Color('#e3434c');
const GOOD = new THREE.Color('#5fe08a');
const BAD = new THREE.Color('#ff4a3f');
const TWO_PI = Math.PI * 2;

const wx = (x: number) => (x - FIELD_W / 2) / 100;
const wz = (y: number) => (FIELD_H / 2 - y) / 100;
const fx = (X: number) => X * 100 + FIELD_W / 2;
const fy = (Z: number) => FIELD_H / 2 - Z * 100;

interface Look { sx: number; sy: number; sz: number; lift: number }
function look(t: SquadType | 'skeleton'): Look {
  switch (t) {
    case 'lord': return { sx: 1.25, sy: 1.35, sz: 1.25, lift: 0 };
    case 'cavaliers': return { sx: 2.4, sy: 1.15, sz: 1.25, lift: 0 };
    case 'knights': return { sx: 1.35, sy: 1.15, sz: 1.35, lift: 0 };
    case 'pegasus': return { sx: 2.2, sy: 1.0, sz: 1.2, lift: 5 };
    case 'wyvern': return { sx: 4, sy: 1.6, sz: 2.4, lift: 7 };
    case 'dragon': return { sx: 7, sy: 2.6, sz: 3.6, lift: 9 };
    case 'ballista': return { sx: 4, sy: 1.1, sz: 2.6, lift: 0 };
    case 'trebuchet': return { sx: 4.6, sy: 3, sz: 3.4, lift: 0 };
    case 'golem': return { sx: 3.4, sy: 3.2, sz: 3.4, lift: 0 };
    case 'skeleton': return { sx: 0.9, sy: 0.95, sz: 0.9, lift: 0 };
    default: return { sx: 1, sy: 1, sz: 1, lift: 0 };
  }
}

/** Painted ground: field features on a canvas (1 px = 12.5 cm). */
function paintGround(t: Terrain | null): THREE.CanvasTexture {
  const S = 0.08;
  const c = document.createElement('canvas');
  c.width = FIELD_W * S;
  c.height = FIELD_H * S;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, c.height);
  grd.addColorStop(0, '#3e4a2a');
  grd.addColorStop(0.5, '#4a5631');
  grd.addColorStop(1, '#3e4a2a');
  g.fillStyle = grd;
  g.fillRect(0, 0, c.width, c.height);
  // mottling
  let s = 99;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${rnd() > 0.5 ? '90,100,50' : '40,48,28'},${0.05 + rnd() * 0.08})`;
    g.beginPath();
    g.arc(rnd() * c.width, rnd() * c.height, 3 + rnd() * 26, 0, TWO_PI);
    g.fill();
  }
  // canvas y grows downward; field y=0 (seat 0 keep) must land at +Z (texture bottom)
  const X = (x: number) => x * S;
  const Y = (y: number) => c.height - y * S;
  for (const f of t?.features ?? []) {
    const fill: Record<string, string> = { forest: '#253318', hill: '#6b6a3e', river: '#2a5268', ford: '#4f7d86', bridge: '#6d5235', ruins: '#5e5a55' };
    g.fillStyle = fill[f.kind] ?? '#555';
    if (f.shape === 'circle') {
      const rg = g.createRadialGradient(X(f.x), Y(f.y), 0, X(f.x), Y(f.y), f.r * S);
      rg.addColorStop(0, fill[f.kind]!);
      rg.addColorStop(0.75, fill[f.kind]!);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(X(f.x), Y(f.y), f.r * S, 0, TWO_PI);
      g.fill();
    } else {
      g.fillRect(X(f.x), Y(f.y + f.h), f.w * S, f.h * S);
      if (f.kind === 'river') {
        g.fillStyle = 'rgba(160,210,230,0.15)';
        for (let i = 0; i < 40; i++) g.fillRect(X(f.x) + rnd() * f.w * S, Y(f.y + f.h) + rnd() * f.h * S, 20 + rnd() * 40, 1.5);
      }
      if (f.kind === 'bridge') {
        g.strokeStyle = '#3d2c1a';
        g.lineWidth = 1.5;
        for (let yy = 0; yy < f.h * S; yy += 6) {
          g.beginPath();
          g.moveTo(X(f.x), Y(f.y) - yy);
          g.lineTo(X(f.x + f.w), Y(f.y) - yy);
          g.stroke();
        }
      }
    }
  }
  // centre line
  g.strokeStyle = 'rgba(230,210,160,0.12)';
  g.setLineDash([12, 10]);
  g.beginPath();
  g.moveTo(0, c.height / 2);
  g.lineTo(c.width, c.height / 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

class Instances {
  readonly body: THREE.InstancedMesh;
  readonly tip: THREE.InstancedMesh;
  n = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(scene: THREE.Scene, cap: number, opts: { opacity?: number; shadows?: boolean } = {}) {
    const op = opts.opacity ?? 1;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.15, transparent: op < 1, opacity: op, depthWrite: op >= 1 });
    const body = new THREE.CapsuleGeometry(0.3, 0.9, 4, 10);
    body.translate(0, 0.75, 0);
    this.body = new THREE.InstancedMesh(body, mat, cap);
    const tipGeo = new THREE.ConeGeometry(0.12, 0.6, 6);
    tipGeo.rotateZ(-Math.PI / 2);
    tipGeo.translate(0.45, 1.05, 0);
    this.tip = new THREE.InstancedMesh(tipGeo, new THREE.MeshStandardMaterial({ color: '#d8d2c0', metalness: 0.7, roughness: 0.3, transparent: op < 1, opacity: op }), cap);
    for (const im of [this.body, this.tip]) {
      im.count = 0;
      im.castShadow = opts.shadows ?? true;
      im.frustumCulled = false;
      scene.add(im);
    }
    this.body.setColorAt(0, OWN);
  }

  begin(): void {
    this.n = 0;
  }

  /** x, y field cm; yaw radians (world); roll lies a corpse down. */
  add(x: number, y: number, yaw: number, lk: Look, color: THREE.Color, roll = 0, bob = 0): void {
    if (this.n >= this.body.instanceMatrix.count) return;
    this.p.set(wx(x), lk.lift + bob, wz(y));
    this.e.set(roll, yaw, 0, 'YXZ');
    this.q.setFromEuler(this.e);
    // stand-in figures are drawn ~1.8x life size so squads read from the strategic camera
    this.s.set(lk.sx * 1.8, lk.sy * 1.8, lk.sz * 1.8);
    this.m.compose(this.p, this.q, this.s);
    this.body.setMatrixAt(this.n, this.m);
    this.tip.setMatrixAt(this.n, this.m);
    this.body.setColorAt(this.n, color);
    this.n++;
  }

  end(): void {
    this.body.count = this.n;
    this.tip.count = this.n;
    this.body.instanceMatrix.needsUpdate = true;
    this.tip.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
  }

  setOpacity(o: number): void {
    for (const im of [this.body, this.tip]) (im.material as THREE.MeshStandardMaterial).opacity = o;
  }
}

interface Flash { mesh: THREE.Mesh; t0: number; dur: number; r0: number; r1: number }
interface Shot { kind: string; arc: string; from: Vec2; to: Vec2; t0: number; t1: number }

export class StandInScene implements SceneAdapter {
  readonly kind = 'standin' as const;
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.5, 1200);
  private ground: THREE.Mesh;
  private solid: Instances;
  private ghosts: Instances;
  private preview: Instances;
  private selRing: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private rangeRing: THREE.Mesh;
  private minRing: THREE.Mesh;
  private zone: THREE.Group;
  private keeps: THREE.Group[] = [];
  private trees: THREE.InstancedMesh;
  private rocks: THREE.InstancedMesh;
  private auras: THREE.InstancedMesh;
  private shotMesh: THREE.InstancedMesh;
  private orbMesh: THREE.InstancedMesh;
  private flashes: Flash[] = [];
  private shots: Shot[] = [];
  private mode: SceneMode = 'title';
  private camMode: CameraMode = 'director';
  private persp: Seat = 0;
  private army: SquadVisual[] = [];
  private ghostArmy: SquadVisual[] | null = null;
  private hidden: number | null = null;
  private selected: number | null = null;
  private hovered: number | null = null;
  private replay: DecodedReplay | null = null;
  private tf: SoldierTransforms | null = null;
  private sample: ((d: DecodedReplay, ms: number, out: SoldierTransforms) => SoldierTransforms) | null = null;
  private evIndex = 0;
  private lastMs = 0;
  private playMs = 0;
  private keepHp: [number, number] = [1, 1];
  private keepMax: [number, number] = [1, 1];
  private shake = 0;
  // camera rig
  private target = new THREE.Vector3(0, 0, 25);
  private dist = 95;
  private yaw = 0;
  private pitch = 0.95;
  private goal = { target: new THREE.Vector3(0, 0, 25), dist: 95, yaw: 0, pitch: 0.95 };
  private locked = false;
  private keys = new Set<string>();
  private raf = 0;
  private last = performance.now();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private disposed = false;

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: /[?&]shots\b/.test(location.search) });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    host.appendChild(this.canvas);

    const sc = this.scene;
    sc.background = new THREE.Color('#141a22');
    sc.fog = new THREE.Fog('#141a22', 140, 330);
    sc.add(new THREE.HemisphereLight('#b9c8e0', '#3a2e1e', 1.4));
    const sun = new THREE.DirectionalLight('#ffe2b8', 2.6);
    sun.position.set(-50, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sh = sun.shadow.camera;
    sh.left = -75; sh.right = 75; sh.top = 85; sh.bottom = -85; sh.far = 300;
    sun.shadow.bias = -0.0005;
    sc.add(sun);

    // surroundings and field
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ color: '#232a1c', roughness: 1 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.05;
    outer.receiveShadow = true;
    sc.add(outer);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W / 100, FIELD_H / 100), new THREE.MeshStandardMaterial({ map: paintGround(null), roughness: 0.95 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    sc.add(this.ground);
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(FIELD_W / 100, 0.01, FIELD_H / 100)), new THREE.LineBasicMaterial({ color: '#8a7448', transparent: true, opacity: 0.5 }));
    border.position.y = 0.03;
    sc.add(border);

    const treeGeo = new THREE.ConeGeometry(1.4, 5, 7);
    treeGeo.translate(0, 2.5, 0);
    this.trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: '#1e3a1c', roughness: 0.9 }), 900);
    this.trees.castShadow = true;
    this.trees.count = 0;
    sc.add(this.trees);
    this.rocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#6d6a64', roughness: 0.9 }), 200);
    this.rocks.castShadow = true;
    this.rocks.count = 0;
    sc.add(this.rocks);

    this.solid = new Instances(sc, 900);
    this.ghosts = new Instances(sc, 500, { opacity: 0.42, shadows: false });
    this.preview = new Instances(sc, 40, { opacity: 0.5, shadows: false });

    const aGeo = new THREE.RingGeometry(0.75, 1, 40);
    aGeo.rotateX(-Math.PI / 2);
    this.auras = new THREE.InstancedMesh(aGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }), 40);
    this.auras.count = 0;
    this.auras.position.y = 0.06;
    sc.add(this.auras);

    const ring = (color: string, opacity: number, inner = 0.92) => {
      const g = new THREE.RingGeometry(inner, 1, 72);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      m.position.y = 0.08;
      m.visible = false;
      sc.add(m);
      return m;
    };
    this.selRing = ring('#ffd77a', 0.95, 0.86);
    this.hoverRing = ring('#ffffff', 0.45, 0.9);
    this.rangeRing = ring('#ffd77a', 0.55, 0.985);
    this.minRing = ring('#ff6a5a', 0.5, 0.975);

    this.zone = new THREE.Group();
    const zr = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#4f9dff', transparent: true, opacity: 0.08, depthWrite: false }));
    zr.rotation.x = -Math.PI / 2;
    const ze = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.001, 1)), new THREE.LineBasicMaterial({ color: '#8fc4ff', transparent: true, opacity: 0.7 }));
    this.zone.add(zr, ze);
    this.zone.position.y = 0.05;
    this.zone.visible = false;
    sc.add(this.zone);

    for (const seat of [0, 1] as Seat[]) this.keeps.push(this.buildKeep(seat));

    const shotGeo = new THREE.BoxGeometry(1.2, 0.06, 0.06);
    this.shotMesh = new THREE.InstancedMesh(shotGeo, new THREE.MeshBasicMaterial({ color: '#fff1c8' }), 600);
    this.shotMesh.count = 0;
    this.shotMesh.frustumCulled = false;
    sc.add(this.shotMesh);
    this.orbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffb050' }), 200);
    this.orbMesh.count = 0;
    this.orbMesh.frustumCulled = false;
    sc.add(this.orbMesh);

    this.bindInput();
    window.addEventListener('resize', this.resize);
    this.resize();
    this.setPerspective(0);
    this.snap();
    this.wake();
    document.addEventListener('visibilitychange', () => !document.hidden && this.wake());
  }

  private buildKeep(seat: Seat): THREE.Group {
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: '#7d766c', roughness: 0.85 });
    const roof = new THREE.MeshStandardMaterial({ color: seat === this.persp ? '#2d5a9c' : '#9c2d35', roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(14, 7, 6), stone);
    body.position.y = 3.5;
    g.add(body);
    for (const sx of [-1, 1]) {
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.1, 11, 10), stone);
      tw.position.set(sx * 8, 5.5, 0);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(2.4, 3.5, 10), roof);
      cap.position.set(sx * 8, 12.6, 0);
      g.add(tw, cap);
    }
    const keep = new THREE.Mesh(new THREE.BoxGeometry(6, 13, 5), stone);
    keep.position.y = 6.5;
    const kr = new THREE.Mesh(new THREE.ConeGeometry(4.4, 4, 4), roof);
    kr.position.y = 15;
    kr.rotation.y = Math.PI / 4;
    g.add(keep, kr);
    g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    g.position.set(0, 0, wz(seat === 0 ? -250 : FIELD_H + 250));
    g.userData.roof = roof;
    this.scene.add(g);
    return g;
  }

  // ---------------------------------------------------------------- SceneAdapter

  setMode(m: SceneMode): void {
    this.wake();
    this.mode = m;
    this.zone.visible = this.zone.visible && m === 'planning';
    if (m !== 'planning') {
      this.selRing.visible = this.hoverRing.visible = this.rangeRing.visible = this.minRing.visible = false;
      this.preview.begin();
      this.preview.end();
    }
    if (m === 'planning') this.frameOwnHalf();
    if (m === 'title' || m === 'lobby' || m === 'lordPick') {
      this.goal.target.set(0, 0, 0);
      this.goal.dist = 120;
      this.goal.pitch = 0.62;
    }
  }

  setPerspective(seat: Seat | null): void {
    this.wake();
    this.persp = seat ?? 0;
    this.goal.yaw = this.persp === 0 ? 0 : Math.PI;
    for (const s of [0, 1] as Seat[]) (this.keeps[s]!.userData.roof as THREE.MeshStandardMaterial).color.set(s === this.persp ? '#2d5a9c' : '#9c2d35');
    if (this.mode === 'planning') this.frameOwnHalf();
  }

  private frameOwnHalf(): void {
    // the whole field: own half in front, the enemy's (and its ghosts) beyond the river
    const ownY = this.persp === 0 ? 4600 : FIELD_H - 4600;
    this.goal.target.set(0, 0, wz(ownY));
    this.goal.dist = 150;
    this.goal.pitch = 1.02;
    this.goal.yaw = this.persp === 0 ? 0 : Math.PI;
  }

  private snap(): void {
    this.target.copy(this.goal.target);
    this.dist = this.goal.dist;
    this.yaw = this.goal.yaw;
    this.pitch = this.goal.pitch;
  }

  private tSeed = -1;
  setTerrain(t: Terrain): void {
    if (t.seed === this.tSeed) return;
    this.tSeed = t.seed;
    this.wake();
    const mat = this.ground.material as THREE.MeshStandardMaterial;
    mat.map?.dispose();
    mat.map = paintGround(t);
    mat.needsUpdate = true;
    // trees in forests, stones in ruins (deterministic scatter)
    let s = t.seed | 1;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    const m = new THREE.Matrix4();
    let nt = 0;
    let nr = 0;
    for (const f of t.features) {
      if (f.kind === 'forest') {
        const count = Math.min(60, Math.round((f.r * f.r) / 36000));
        for (let i = 0; i < count && nt < 900; i++) {
          const a = rnd() * TWO_PI;
          const r = Math.sqrt(rnd()) * f.r * 0.9;
          const sc = 0.7 + rnd() * 0.6;
          m.compose(new THREE.Vector3(wx(f.x + Math.cos(a) * r), 0, wz(f.y + Math.sin(a) * r)), new THREE.Quaternion(), new THREE.Vector3(sc, sc * (0.8 + rnd() * 0.5), sc));
          this.trees.setMatrixAt(nt++, m);
        }
      } else if (f.kind === 'ruins') {
        const cx = f.shape === 'circle' ? f.x : f.x + f.w / 2;
        const cy = f.shape === 'circle' ? f.y : f.y + f.h / 2;
        const rr = f.shape === 'circle' ? f.r : Math.min(f.w, f.h) / 2;
        for (let i = 0; i < 12 && nr < 200; i++) {
          const a = rnd() * TWO_PI;
          const r = rnd() * rr * 0.9;
          const h = 0.5 + rnd() * 2.5;
          m.compose(new THREE.Vector3(wx(cx + Math.cos(a) * r), h / 2, wz(cy + Math.sin(a) * r)), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd() * 3, 0)), new THREE.Vector3(0.6 + rnd() * 1.4, h, 0.5 + rnd()));
          this.rocks.setMatrixAt(nr++, m);
        }
      }
    }
    this.trees.count = nt;
    this.rocks.count = nr;
    this.trees.instanceMatrix.needsUpdate = true;
    this.rocks.instanceMatrix.needsUpdate = true;
  }

  setFactions(): void {
    // the stand-in draws one plain keep for every faction
  }

  setKeeps(hp: [number, number], max: [number, number]): void {
    this.wake();
    this.keepHp = hp;
    this.keepMax = max;
    this.drawKeeps();
  }

  private drawKeeps(): void {
    for (const s of [0, 1] as Seat[]) {
      const f = Math.max(0, this.keepHp[s] / Math.max(1, this.keepMax[s]));
      const k = this.keeps[s]!;
      k.scale.y = 0.45 + 0.55 * f;
      k.children.forEach((c) => {
        const mm = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (mm && mm !== k.userData.roof) mm.color.setScalar(0.25 + 0.27 * f).lerp(new THREE.Color('#7d766c'), f);
      });
    }
  }

  groundAt(clientX: number, clientY: number): Vec2 | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.plane, hit)) return null;
    const x = Math.round(fx(hit.x));
    const y = Math.round(fy(hit.z));
    if (x < -2000 || x > FIELD_W + 2000 || y < -2000 || y > FIELD_H + 2000) return null;
    return [x, y];
  }

  squadAt(clientX: number, clientY: number): { id: number; ghost: boolean } | null {
    const g = this.groundAt(clientX, clientY);
    if (!g) return null;
    let best: { id: number; ghost: boolean } | null = null;
    let bd = Infinity;
    const test = (list: SquadVisual[], ghost: boolean) => {
      for (const s of list) {
        const d = Math.hypot(s.pos[0] - g[0], s.pos[1] - g[1]);
        if (d < squadRadius(s.type, s.size) && d < bd) {
          bd = d;
          best = { id: s.id, ghost };
        }
      }
    };
    test(this.army, false);
    if (!best && this.ghostArmy) test(this.ghostArmy, true);
    return best;
  }

  showDeployZone(seat: Seat | null): void {
    this.wake();
    if (seat === null) {
      this.zone.visible = false;
      return;
    }
    const y0 = seat === 0 ? 400 : 8000;
    const y1 = seat === 0 ? 4000 : 11600;
    this.zone.scale.set(FIELD_W / 100, 1, (y1 - y0) / 100);
    this.zone.position.set(0, 0.05, wz((y0 + y1) / 2));
    this.zone.visible = true;
  }

  setArmy(squads: SquadVisual[]): void {
    this.wake();
    this.army = squads;
    if (!this.replay) this.drawArmy();
  }

  setGhosts(squads: SquadVisual[] | null): void {
    this.wake();
    this.ghostArmy = squads;
    this.drawGhosts();
  }

  private colorFor(owner: Seat): THREE.Color {
    return owner === this.persp ? OWN : FOE;
  }

  private placeSquad(inst: Instances, s: SquadVisual, color: THREE.Color): void {
    const lk = look(s.type);
    const yaw = (s.facing / 256) * TWO_PI;
    for (const [dx, dy] of formation(s.type, s.facing, s.lord, s.size)) inst.add(s.pos[0] + dx, s.pos[1] + dy, yaw, lk, color);
  }

  private drawArmy(): void {
    this.solid.begin();
    let na = 0;
    const m = new THREE.Matrix4();
    for (const s of this.army) {
      if (s.id === this.hidden) continue;
      const c = this.colorFor(s.owner).clone();
      if (s.level >= 3) c.offsetHSL(0, 0, 0.08);
      this.placeSquad(this.solid, s, c);
      if (s.rarity && s.rarity !== 'common' && na < 40) {
        const r = squadRadius(s.type, s.size) / 100;
        m.compose(new THREE.Vector3(wx(s.pos[0]), 0, wz(s.pos[1])), new THREE.Quaternion(), new THREE.Vector3(r, 1, r));
        this.auras.setMatrixAt(na, m);
        this.auras.setColorAt(na, new THREE.Color(RARITY_CSS[s.rarity]));
        na++;
      }
    }
    this.solid.end();
    this.auras.count = na;
    this.auras.instanceMatrix.needsUpdate = true;
    if (this.auras.instanceColor) this.auras.instanceColor.needsUpdate = true;
    this.updateRings();
  }

  private drawGhosts(): void {
    this.ghosts.begin();
    if (this.ghostArmy && !this.replay) for (const s of this.ghostArmy) this.placeSquad(this.ghosts, s, FOE);
    this.ghosts.end();
  }

  setPreview(p: PreviewSpec | null): void {
    this.wake();
    this.preview.begin();
    if (p) this.placeSquad(this.preview, { id: -1, type: p.type, lord: p.lord, owner: p.seat, pos: p.pos, facing: p.facing, level: 1 }, p.valid ? GOOD : BAD);
    this.preview.end();
  }

  private squadById(id: number | null): SquadVisual | null {
    if (id === null) return null;
    return this.army.find((s) => s.id === id) ?? this.ghostArmy?.find((s) => s.id === id) ?? null;
  }

  private updateRings(): void {
    const put = (ring: THREE.Mesh, s: SquadVisual | null) => {
      ring.visible = !!s && this.mode === 'planning';
      if (!s) return;
      const r = squadRadius(s.type, s.size) / 100;
      ring.scale.set(r, 1, r);
      ring.position.set(wx(s.pos[0]), 0.08, wz(s.pos[1]));
    };
    put(this.selRing, this.squadById(this.selected));
    put(this.hoverRing, this.hovered !== this.selected ? this.squadById(this.hovered) : null);
  }

  setSelected(id: number | null): void {
    this.wake();
    this.selected = id;
    this.updateRings();
  }

  setHovered(id: number | null): void {
    this.wake();
    this.hovered = id;
    this.updateRings();
  }

  setHidden(id: number | null): void {
    this.wake();
    if (this.hidden === id) return;
    this.hidden = id;
    this.drawArmy();
  }

  setRange(r: RangeSpec | null): void {
    this.wake();
    this.rangeRing.visible = !!r;
    this.minRing.visible = !!r && r.minRange > 0;
    if (!r) return;
    const R = r.range / 100;
    (this.rangeRing.material as THREE.MeshBasicMaterial).color.set(r.enemy ? '#ff6a5a' : '#ffd77a');
    this.rangeRing.scale.set(R, 1, R);
    this.rangeRing.position.set(wx(r.pos[0]), 0.09, wz(r.pos[1]));
    if (r.minRange) {
      const m = r.minRange / 100;
      this.minRing.scale.set(m, 1, m);
      this.minRing.position.copy(this.rangeRing.position);
    }
  }

  toScreen(pos: Vec2, heightM = 0): ScreenPoint | null {
    const v = new THREE.Vector3(wx(pos[0]), heightM, wz(pos[1])).project(this.camera);
    if (v.z > 1) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  setInputLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) this.drag = null;
  }

  // ---------------------------------------------------------------- battle

  loadReplay(d: DecodedReplay): void {
    this.wake();
    this.replay = d;
    this.evIndex = 0;
    this.lastMs = -1;
    this.flashes.forEach((f) => this.scene.remove(f.mesh));
    this.flashes = [];
    this.shots = [];
    this.ghosts.begin();
    this.ghosts.end();
    this.auras.count = 0;
    void import('../sim/index.ts').then((sim) => {
      this.sample = sim.sampleReplay;
      this.tf = sim.makeTransforms(d.soldierCount);
      this.setTime(this.playMs);
    });
    const k = d.replay.keeps;
    this.keepHp = [k[0].hpBefore, k[1].hpBefore];
    this.keepMax = [k[0].hpMax, k[1].hpMax];
    this.drawKeeps();
    if (this.camMode === 'director') {
      this.goal.target.set(0, 0, 0);
      this.goal.dist = 100;
    }
  }

  clearReplay(): void {
    cancelAnimationFrame(this.pbRaf);
    this.wake();
    this.replay = null;
    this.tf = null;
    this.shots = [];
    this.shotMesh.count = 0;
    this.orbMesh.count = 0;
    this.drawArmy();
    this.drawGhosts();
  }

  onCameraMode: ((m: CameraMode) => void) | null = null;
  private claim: ((e: PointerEvent) => boolean) | null = null;
  private pbRaf = 0;

  setPointerClaim(fn: ((e: PointerEvent) => boolean) | null): void {
    this.claim = fn;
  }

  setInsets(): void {
    /* the stand-in frames the whole field */
  }

  /** Playback clock for the stand-in: a rAF loop only while a battle plays. */
  playReplay(d: DecodedReplay, o: { offsetMs: number; onEvent(e: ReplayEvent, ms: number): void; onEnd(): void }): PlaybackHandle {
    cancelAnimationFrame(this.pbRaf);
    this.loadReplay(d);
    const dur = d.replay.ticks * 50;
    const evs = d.events;
    const st = { t: Math.max(0, o.offsetMs), speed: 1, cursor: 0, ended: false, last: performance.now() };
    const skipTo = (ms: number) => {
      st.t = Math.min(dur, ms);
      st.cursor = 0;
      while (st.cursor < evs.length && evs[st.cursor]!.tick * 50 <= st.t) st.cursor++;
      this.setTime(st.t);
    };
    skipTo(st.t);
    const step = (now: number) => {
      const dt = Math.min(100, now - st.last);
      st.last = now;
      if (st.ended) return;
      st.t = Math.min(dur, st.t + dt * st.speed);
      while (st.cursor < evs.length && evs[st.cursor]!.tick * 50 <= st.t) o.onEvent(evs[st.cursor]!, st.t), st.cursor++;
      this.setTime(st.t);
      if (st.t >= dur) {
        st.ended = true;
        o.onEnd();
        return;
      }
      this.pbRaf = requestAnimationFrame(step);
    };
    this.pbRaf = requestAnimationFrame(step);
    return {
      get speed() { return st.speed; },
      set speed(v: number) { st.speed = v; },
      get timeMs() { return st.t; },
      durationMs: dur,
      seek: (ms: number) => {
        skipTo(ms);
        if (st.t >= dur && !st.ended) {
          st.ended = true;
          cancelAnimationFrame(this.pbRaf);
        }
      },
      stop: () => {
        st.ended = true;
        cancelAnimationFrame(this.pbRaf);
      },
    };
  }

  setCameraMode(m: CameraMode): void {
    this.wake();
    this.camMode = m;
  }

  setTime(ms: number): void {
    this.wake();
    this.playMs = ms;
    const d = this.replay;
    if (!d || !this.tf || !this.sample) return;
    if (ms < this.lastMs) {
      this.evIndex = 0;
      this.shots = [];
    }
    const tick = ms / 50;
    const evs = d.events;
    const jump = ms - this.lastMs > 1500;
    while (this.evIndex < evs.length && evs[this.evIndex]!.tick <= tick) {
      const e = evs[this.evIndex++]!;
      if (!jump || e.tick > tick - 20) this.fx(e, ms);
      if (e.k === 'keepHit') this.keepHp[e.seat] = e.hpAfter;
    }
    this.lastMs = ms;
    const tf = this.sample(d, ms, this.tf);
    const sol = d.replay.soldiers;
    this.solid.begin();
    const dead = new THREE.Color('#3a3530');
    let cx = 0, cy = 0, cn = 0;
    for (let i = 0; i < tf.count; i++) {
      if (!tf.visible[i]) continue;
      const h = sol[i]!;
      const lk = look(h.type);
      const isDead = tf.anim[i] === 4;
      const att = tf.anim[i] === 2 || tf.anim[i] === 3;
      const col = isDead ? dead : h.side === this.persp ? OWN : FOE;
      const bob = att ? Math.abs(Math.sin(ms / 90 + i)) * 0.25 : 0;
      this.solid.add(tf.x[i]!, tf.y[i]!, tf.facing[i]!, isDead ? { ...lk, lift: 0 } : lk, col, isDead ? Math.PI / 2 : 0, bob);
      if (!isDead) {
        cx += tf.x[i]!;
        cy += tf.y[i]!;
        cn++;
      }
    }
    this.solid.end();
    if (this.camMode === 'director' && cn) {
      this.goal.target.set(wx(cx / cn), 0, wz(cy / cn));
      this.goal.dist = 70;
      this.goal.pitch = 0.78;
      this.goal.yaw = (this.persp === 0 ? 0 : Math.PI) + Math.sin(ms / 9000) * 0.5;
    }
    this.drawShots(ms);
    this.drawKeeps();
  }

  private fx(e: ReplayEvent, ms: number): void {
    const now = performance.now();
    switch (e.k) {
      case 'projectile': {
        this.shots.push({ kind: e.kind, arc: e.arc, from: e.from, to: e.to, t0: e.tick * 50, t1: (e.tick + Math.max(1, e.flight)) * 50 });
        break;
      }
      case 'impact':
        if (e.splash > 0 || e.kind === 'stone' || e.kind === 'fireball') this.flash(e.pos, Math.max(150, e.splash) / 100, e.kind === 'fireball' ? '#ff8a30' : '#c9b08a', 450, now);
        break;
      case 'ability': {
        const col: Record<string, string> = { rally: '#ffd24a', meteor: '#ff5a1e', bulwark: '#6ab0ff', skyfall: '#d8f0ff', chain: '#a8c8ff', ember_burst: '#ff7a2a', stomp: '#c9a070', earthshaker: '#c9a070', sunfire: '#ffb84a', lifebinder: '#7dffa0', levelup: '#ffe8a0',
          radiance: '#ffd46a', necromancy: '#5fe08a', soul_reap: '#5fe08a', grave_taunt: '#e6e0c8', plague_breath: '#8fd04a', whirlwind: '#4fd8d0', stampede: '#c9a070', talon: '#ffd890' };
        if (e.ability === 'burn' || e.ability === 'frost' || e.ability === 'brace' || e.ability === 'charge' || e.ability === 'reflect') break;
        if (e.ability === 'grave_taunt' && e.radius === 0) break; // the per-soldier marks: the Warden's own event flashes
        this.flash(e.pos, Math.max(2, e.radius / 100), col[e.ability] ?? '#ffffff', e.ability === 'meteor' ? 1200 : 700, now);
        if (e.ability === 'meteor' || e.ability === 'skyfall' || e.ability === 'plague_breath' || e.ability === 'stampede' || e.ability === 'talon') this.shake = 0.8;
        break;
      }
      case 'keepHit': {
        const y = e.seat === 0 ? -250 : FIELD_H + 250;
        this.flash([FIELD_W / 2, y], e.final ? 14 : 5, '#ffb050', 600, now);
        if (e.final || e.dmg > 100) this.shake = Math.max(this.shake, 0.5);
        break;
      }
      case 'death':
        break;
      case 'revive':
      case 'summon':
        break;
    }
    void ms;
  }

  private flash(pos: Vec2, radiusM: number, color: string, dur: number, now: number): void {
    if (this.flashes.length > 40) return;
    const g = new THREE.RingGeometry(0.55, 1, 40);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.position.set(wx(pos[0]), 0.3, wz(pos[1]));
    this.scene.add(m);
    this.flashes.push({ mesh: m, t0: now, dur, r0: radiusM * 0.3, r1: radiusM });
  }

  private drawShots(ms: number): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s1 = new THREE.Vector3(1, 1, 1);
    let ns = 0;
    let no = 0;
    this.shots = this.shots.filter((s) => ms < s.t1);
    for (const s of this.shots) {
      if (ms < s.t0) continue;
      const t = (ms - s.t0) / (s.t1 - s.t0);
      const x = s.from[0] + (s.to[0] - s.from[0]) * t;
      const y = s.from[1] + (s.to[1] - s.from[1]) * t;
      const dist = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) / 100;
      const hmax = s.arc === 'line' ? 0 : s.arc === 'high_arc' ? dist * 0.45 : dist * 0.18;
      const h = 1.3 + 4 * hmax * t * (1 - t);
      p.set(wx(x), h, wz(y));
      if (s.kind === 'arrow' || s.kind === 'bolt' || s.kind === 'tower_arrow') {
        const dh = 4 * hmax * (1 - 2 * t) / Math.max(1, dist);
        const yaw = Math.atan2(-(s.to[1] - s.from[1]), s.to[0] - s.from[0]);
        q.setFromEuler(new THREE.Euler(0, yaw, Math.atan(dh), 'YZX'));
        m.compose(p, q, s.kind === 'bolt' ? new THREE.Vector3(2.4, 2, 2) : s1);
        if (ns < 600) this.shotMesh.setMatrixAt(ns++, m);
      } else {
        const sc = s.kind === 'stone' ? 1.6 : s.kind === 'firebreath' ? 1.4 : 1;
        m.compose(p, q.identity(), new THREE.Vector3(sc, sc, sc));
        if (no < 200) {
          this.orbMesh.setMatrixAt(no, m);
          this.orbMesh.setColorAt(no, new THREE.Color(s.kind === 'stone' ? '#8a8070' : s.kind === 'lightning' ? '#b8d0ff' : '#ff9a3a'));
          no++;
        }
      }
    }
    this.shotMesh.count = ns;
    this.orbMesh.count = no;
    this.shotMesh.instanceMatrix.needsUpdate = true;
    this.orbMesh.instanceMatrix.needsUpdate = true;
    if (this.orbMesh.instanceColor) this.orbMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- camera & loop

  private drag: { x: number; y: number; button: number; moved: boolean; ground: Vec2 | null } | null = null;
  private pinch: { d: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
        this.drag = null;
        return;
      }
      if (e.button === 0 && this.claim?.(e)) {
        this.drag = null;
        return;
      }
      this.drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, ground: this.groundAt(e.clientX, e.clientY) };
    });
    window.addEventListener('pointermove', (e) => {
      if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.zoom(this.pinch.d / Math.max(1, d));
        this.pinch.d = d;
        return;
      }
      const dr = this.drag;
      if (!dr || this.locked || !this.freeCam()) return;
      if (!dr.moved && Math.hypot(e.clientX - dr.x, e.clientY - dr.y) < 6) return;
      dr.moved = true;
      if (dr.button === 1 || (dr.button === 0 && e.altKey)) {
        // orbit
        this.wake();
        this.goal.yaw -= (e.clientX - dr.x) * 0.005;
        this.goal.pitch = Math.min(1.35, Math.max(0.35, this.goal.pitch + (e.clientY - dr.y) * 0.004));
        dr.x = e.clientX;
        dr.y = e.clientY;
        return;
      }
      // pan: keep the grabbed ground point under the pointer
      if (!dr.ground) return;
      const now = this.groundAt(e.clientX, e.clientY);
      if (!now) return;
      this.goal.target.x -= (now[0] - dr.ground[0]) / 100;
      this.goal.target.z -= -(now[1] - dr.ground[1]) / 100;
      this.clampTarget();
      this.target.copy(this.goal.target);
      this.place();
      this.wake();
    });
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      this.drag = null;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      if (!this.freeCam()) return;
      e.preventDefault();
      this.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      this.keys.add(e.key.toLowerCase());
      if (/^(w|a|s|d|arrow)/i.test(e.key)) this.wake();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Was the last pointer gesture a camera drag (so the UI should ignore its click)? */
  get dragged(): boolean {
    return !!this.drag?.moved;
  }

  private freeCam(): boolean {
    return this.mode === 'planning' || (this.mode === 'battle' && this.camMode === 'free') || this.mode === 'results';
  }

  private zoom(f: number): void {
    this.wake();
    this.goal.dist = Math.min(190, Math.max(22, this.goal.dist * f));
  }

  private clampTarget(): void {
    const t = this.goal.target;
    t.x = Math.max(-45, Math.min(45, t.x));
    t.z = Math.max(-68, Math.min(68, t.z));
  }

  private resize = () => {
    this.wake();
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1.2 ? 52 : 40;
    this.camera.updateProjectionMatrix();
  };

  private place(): void {
    const c = this.camera;
    const sh = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    c.position.set(
      this.target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist + sh,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
    );
    c.lookAt(this.target.x, this.target.y + sh, this.target.z);
  }

  // ---- on-demand loop: nothing is drawn unless something changed or is still moving. Every setter
  // calls wake(); the loop keeps going only while the camera eases, flashes fly, keys pan, or the
  // title orbits (30 fps; battery saver stops the orbit). Idle planning draws 0 frames per second.
  framesDrawn = 0;
  private dirty = 0;
  private lastDraw = 0;
  private fpsCap = Number(localStorage.getItem('oathbound.fps') ?? '60') || 60;
  private saver = localStorage.getItem('oathbound.saver') === '1';

  setPower(p: { batterySaver?: boolean; fpsCap?: number }): void {
    if (p.batterySaver !== undefined) this.saver = p.batterySaver;
    if (p.fpsCap) this.fpsCap = p.fpsCap;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.saver ? 1 : 2));
    this.resize();
  }

  wake(frames = 2): void {
    this.dirty = Math.max(this.dirty, frames);
    if (!this.raf && !this.disposed) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private settled(): boolean {
    const g = this.goal;
    return this.target.distanceToSquared(g.target) < 1e-4 && Math.abs(this.dist - g.dist) < 0.01 && Math.abs(this.yaw - g.yaw) < 1e-4 && Math.abs(this.pitch - g.pitch) < 1e-4;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    const orbit = (this.mode === 'title' || this.mode === 'lobby' || this.mode === 'lordPick') && !this.saver;
    const cap = orbit || this.saver ? 30 : this.fpsCap;
    if (now - this.lastDraw < 1000 / cap - 2) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.lastDraw = now;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (orbit) this.goal.yaw += dt * 0.05;
    if (this.freeCam() && this.keys.size) {
      const sp = this.dist * 0.9 * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const k = this.keys;
      if (k.has('w') || k.has('arrowup')) this.goal.target.addScaledVector(fwd, sp);
      if (k.has('s') || k.has('arrowdown')) this.goal.target.addScaledVector(fwd, -sp);
      if (k.has('d') || k.has('arrowright')) this.goal.target.addScaledVector(right, sp);
      if (k.has('a') || k.has('arrowleft')) this.goal.target.addScaledVector(right, -sp);
      this.clampTarget();
    }
    if (this.settled()) {
      this.target.copy(this.goal.target);
      this.dist = this.goal.dist;
      this.yaw = this.goal.yaw;
      this.pitch = this.goal.pitch;
    } else {
      const a = 1 - Math.exp(-dt * (this.mode === 'battle' && this.camMode === 'director' ? 1.6 : 7));
      this.target.lerp(this.goal.target, a);
      this.dist += (this.goal.dist - this.dist) * a;
      this.yaw += (this.goal.yaw - this.yaw) * a;
      this.pitch += (this.goal.pitch - this.pitch) * a;
    }
    this.shake = Math.max(0, this.shake - dt * 1.5);
    this.place();
    this.flashes = this.flashes.filter((f) => {
      const t = (now - f.t0) / f.dur;
      if (t >= 1) {
        this.scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        return false;
      }
      const r = f.r0 + (f.r1 - f.r0) * (1 - (1 - t) * (1 - t));
      f.mesh.scale.set(r, 1, r);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      return true;
    });
    this.renderer.render(this.scene, this.camera);
    this.framesDrawn++;
    if (this.dirty > 0) this.dirty--;
    const moving = orbit || !this.settled() || this.flashes.length > 0 || this.shake > 0 || (this.keys.size > 0 && this.freeCam()) || this.dirty > 0;
    if (moving && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
    this.canvas.remove();
  }
}

void KEYFRAME_TICKS;
void UNITS;
