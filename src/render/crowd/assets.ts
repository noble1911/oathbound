// Unit assets: for each archetype, either a VAT crowd asset (instanced) or a hero template
// (skinned mesh + clips for an AnimationMixer). Procedural stand-ins are available synchronously;
// the art pipeline's models (public/models/v2/manifest.json, docs/ART.md) replace them lazily —
// only for unit types present in the current roster — via `upgrade()`.
//
// Manifest (v2): { models: { <id>: { kind, scale, height, glb, vat?, tintMask?, mr?, clips, detail, tris, bytes, totalBytes } } }
//   crowd units: glb = single-primitive skinned LOD1 mesh with a `_vid` attribute; vat = VatMeta
//   ('f16', normals octahedral-packed in pos.w, per-clip fps); tintMask = R channel at UV0.
//   heroes / large / siege: skinned glb with clips mapped by `clips` {role: glbClipName}.
//   structures (keep_<faction>, arrow_tower_<faction>): glb (+ lod1); Keeps have stage0..stage3 child nodes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Engine } from '../core/engine.ts';
import { bakeVat, loadVat, createCrowdMaterials, type VatData } from './vat.ts';
import { buildClips } from './models.ts';
import type { Archetype } from './archetypes.ts';
import { assetUrl, loadAssetVersions, registerAssetHashes } from '../../assets.ts';

export interface CrowdAsset {
  key: string;
  geometry: THREE.BufferGeometry;
  vat: VatData;
  material: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
  ghost: THREE.MeshBasicMaterial;
  clip: Map<string, VatData['clips'][number]>;
  /** Fraction of the attack clip at which the blow lands (art clips); procedural uses the archetype. */
  impactFrac: number | null;
  /** From the art pipeline (not a procedural stand-in). */
  art: boolean;
}

export interface HeroAsset {
  key: string;
  template: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
  /** True when meshes carry surf/tint attributes (procedural). */
  surf: boolean;
  tintMap: THREE.Texture | null;
  art: boolean;
  /** Siege: seconds into the 'attack' (fire) clip at which the projectile is released. */
  fireTime?: number;
}

/** A static prop baked to float geometry (meshopt / quantization resolved, node transforms applied). */
export interface PropMesh {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  box: THREE.Box3;
  /** Fraction of triangles with an edge longer than 35% of the bounding diagonal (shredded meshes score high). */
  shred: number;
}
export interface PropAsset {
  id: string;
  lod0: PropMesh;
  lod1: PropMesh | null;
  tintMap: THREE.Texture | null;
  height: number;
}

export interface ArtEntry {
  kind?: string;
  glb?: string;
  vat?: string;
  tintMask?: string;
  /** Optional packed metal/roughness map (glTF: G roughness, B metal). */
  mr?: string;
  scale?: number;
  height?: number;
  clips?: Record<string, string>;
  totalBytes?: number;
  nodes?: string[];
  lod1?: string;
  fireTime?: number;
  clipInfo?: Record<string, { duration: number; loop: boolean }>;
}
export type ArtManifest = Record<string, ArtEntry>;

export interface LoadRecord {
  model: string;
  ms: number;
  bytes: number;
}

const CLIP_ALIASES: Record<string, string[]> = {
  idle: ['idle', 'Idle'],
  move: ['move', 'walk', 'Walk'],
  run: ['run', 'Run'],
  attack: ['attack', 'attack_melee_a', 'attack1', 'Attack'],
  attack2: ['attack2', 'attack_melee_b'],
  cast: ['cast', 'spell', 'Cast'],
  hit: ['hit', 'Hit', 'hurt'],
  death: ['death', 'death_a', 'die', 'Death'],
  death2: ['death2', 'death_b'],
  victory: ['victory'],
  reload: ['reload'],
};

/** Armoured units get a metallic default until the MR maps land. */
const ARMOURED = /knight|lord_marshal|lord_warden|lord_skylady|cavalier|golem/;

export class UnitAssets {
  private crowdCache = new Map<string, CrowdAsset>();
  private heroCache = new Map<string, HeroAsset>();
  private manifest: ArtManifest | null = null;
  private propManifest: ArtManifest | null = null;
  private loader = new GLTFLoader();
  private texLoader = new THREE.TextureLoader();
  private readonly engine: Engine;
  private manifestBase = '';
  private manifestReady: Promise<void> = Promise.resolve();
  private upgrades = new Map<string, Promise<boolean>>();
  /** Download + decode time per art model (for the power / load report). */
  readonly loads: LoadRecord[] = [];
  constructor(engine: Engine) {
    this.engine = engine;
    this.loader.setMeshoptDecoder(MeshoptDecoder); // packed GLBs: EXT_meshopt_compression + KHR_mesh_quantization
  }

  /** Point at the art manifest (relative URL, e.g. 'models/v2/manifest.json'); missing is fine. */
  loadManifest(url: string): Promise<void> {
    this.manifestReady = (async () => {
      try {
        // the manifest is always revalidated; everything it points at is fetched by content hash
        const [r] = await Promise.all([fetch(url, { cache: 'no-cache' }), loadAssetVersions()]);
        if (!r.ok) return;
        const j = (await r.json()) as unknown;
        if (j && typeof j === 'object') {
          const o = j as Record<string, unknown>;
          this.manifest = (o.models ?? o.units ?? o) as ArtManifest;
          this.propManifest = (o.props ?? null) as ArtManifest | null;
          this.manifestBase = new URL('.', new URL(url, location.href)).href;
          registerAssetHashes(url, o.hashes);
        }
      } catch {
        this.manifest = null;
      }
    })();
    return this.manifestReady;
  }

  /** The manifest entry for a model id (tolerates 'knights' → 'knight'). */
  entry(...ids: string[]): ArtEntry | null {
    const m = this.manifest;
    if (!m) return null;
    for (const id of ids) {
      const e = m[id] ?? m[id.replace(/s$/, '')] ?? m[id.replace(/men$/, 'man')];
      if (e) return e;
    }
    return null;
  }
  url(rel: string): string {
    return assetUrl(new URL(rel, this.manifestBase).href);
  }
  async ready(): Promise<void> {
    await this.manifestReady;
  }

  /** Synchronous crowd asset: the upgraded art asset if loaded, else the procedural bake. */
  crowd(arch: Archetype): CrowdAsset {
    let a = this.crowdCache.get(arch.key);
    if (a) return a;
    const m = arch.build();
    const placeholder = new THREE.MeshStandardMaterial();
    const { root, mesh } = m.rig.build(placeholder);
    const clips = buildClips(m);
    const { geometry, vat } = bakeVat(root, mesh, clips, 30);
    const mats = createCrowdMaterials(this.engine, vat, { surf: true, vertexColors: true, key: arch.key });
    a = { key: arch.key, geometry, vat, ...mats, clip: new Map(vat.clips.map((c) => [c.name, c])), impactFrac: null, art: false };
    this.crowdCache.set(arch.key, a);
    placeholder.dispose();
    mesh.geometry.dispose();
    return a;
  }

  /** Synchronous hero template: the upgraded art asset if loaded, else procedural. */
  hero(arch: Archetype): HeroAsset {
    let a = this.heroCache.get(arch.key);
    if (a) return a;
    const m = arch.build();
    const { root } = m.rig.build(new THREE.MeshStandardMaterial());
    const clips = buildClips(m);
    a = { key: arch.key, template: root, clips: new Map(clips.map((c) => [c.name, c])), surf: true, tintMap: null, art: false };
    this.heroCache.set(arch.key, a);
    return a;
  }

  /**
   * Replace an archetype's procedural asset with the art pipeline's model, once (lazy: call it for
   * unit types actually present). Resolves true when upgraded; the caller swaps its instances.
   */
  upgrade(arch: Archetype, modelId: string): Promise<boolean> {
    let p = this.upgrades.get(arch.key);
    if (!p) {
      p = this.doUpgrade(arch, modelId);
      this.upgrades.set(arch.key, p);
    }
    return p;
  }

  private async loadTex(rel: string | undefined, color: boolean): Promise<THREE.Texture | null> {
    if (!rel) return null;
    const t = await this.texLoader.loadAsync(this.url(rel));
    t.flipY = false; // glTF UV convention
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  }

  private async doUpgrade(arch: Archetype, modelId: string): Promise<boolean> {
    await this.manifestReady;
    const e = this.entry(modelId, arch.key);
    if (!e?.glb) return false;
    const t0 = performance.now();
    try {
      const [gltf, tintMap, mrMap] = await Promise.all([this.loader.loadAsync(this.url(e.glb)), this.loadTex(e.tintMask, false), this.loadTex(e.mr, false)]);
      const root = gltf.scene;
      const clips = new Map<string, THREE.AnimationClip>();
      for (const [role, aliases] of Object.entries(CLIP_ALIASES)) {
        const want = e.clips?.[role];
        const c = gltf.animations.find((a) => a.name === want) ?? gltf.animations.find((a) => aliases.includes(a.name));
        if (c) {
          const cc = c.clone();
          cc.name = role;
          cc.userData = { loop: ['idle', 'move', 'run', 'victory'].includes(role) };
          clips.set(role, cc);
        }
      }
      if (arch.render === 'hero') {
        if (e.scale && e.scale !== 1) root.scale.setScalar(e.scale);
        const fire = clips.get('attack');
        const fireTime = e.fireTime ?? (e.kind === 'siege' && fire ? fire.duration * 0.25 : undefined);
        this.heroCache.set(arch.key, { key: arch.key, template: root, clips, surf: false, tintMap, art: true, fireTime });
      } else {
        let mesh: THREE.Mesh | null = null;
        root.traverse((o) => {
          if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
        });
        if (!mesh) return false;
        const sk = mesh as THREE.Mesh;
        const src = sk.material as THREE.MeshStandardMaterial;
        let vat: VatData;
        let geometry: THREE.BufferGeometry;
        if (e.vat) {
          vat = await loadVat(this.url(e.vat));
          geometry = sk.geometry.clone();
          geometry.deleteAttribute('skinIndex');
          geometry.deleteAttribute('skinWeight');
          const vid = geometry.getAttribute(vat.vertexIndexAttribute ?? '_vid') ?? geometry.getAttribute('_vid');
          const n = geometry.getAttribute('position').count;
          const idx = new Float32Array(n);
          for (let i = 0; i < n; i++) idx[i] = vid ? vid.getX(i) : i;
          geometry.setAttribute('vatIndex', new THREE.BufferAttribute(idx, 1));
          geometry.boundingBox = vat.bounds.clone();
          geometry.boundingSphere = vat.bounds.getBoundingSphere(new THREE.Sphere());
        } else {
          if (!(sk as THREE.SkinnedMesh).isSkinnedMesh) return false;
          ({ geometry, vat } = bakeVat(root, sk as THREE.SkinnedMesh, [...clips.values()], 30));
        }
        const armoured = ARMOURED.test(arch.key) || ARMOURED.test(modelId);
        const mats = createCrowdMaterials(this.engine, vat, {
          surf: false, vertexColors: false, key: `art:${arch.key}`, map: src.map ?? null, tintMap, mrMap,
          roughness: armoured ? 0.45 : 0.78, metalness: armoured ? 0.5 : 0.04,
        });
        this.crowdCache.set(arch.key, { key: arch.key, geometry, vat, ...mats, clip: new Map(vat.clips.map((c) => [c.name, c])), impactFrac: 0.42, art: true });
      }
      this.loads.push({ model: modelId, ms: Math.round(performance.now() - t0), bytes: e.totalBytes ?? 0 });
      return true;
    } catch (err) {
      console.warn(`art model ${modelId}: ${(err as Error).message}; keeping the stand-in`);
      return false;
    }
  }

  /** Every prop of the manifest's `props` (LOD0 + LOD1), baked for instancing. Empty if none. */
  async props(): Promise<Map<string, PropAsset>> {
    await this.manifestReady;
    const out = new Map<string, PropAsset>();
    const pm = this.propManifest;
    if (!pm) return out;
    const t0 = performance.now();
    let bytes = 0;
    await Promise.all(
      Object.entries(pm).map(async ([id, e]) => {
        if (!e.glb) return;
        try {
          const [g0, g1, tintMap] = await Promise.all([
            this.loader.loadAsync(this.url(e.glb)),
            e.lod1 ? this.loader.loadAsync(this.url(e.lod1)) : Promise.resolve(null),
            this.loadTex(e.tintMask, false),
          ]);
          const lod0 = bakeProp(g0.scene);
          if (!lod0) return;
          let lod1 = g1 ? bakeProp(g1.scene) : null;
          // a broken (shredded) LOD1 would show as spiky shards: fall back to LOD0
          if (lod1 && lod1.shred > Math.max(0.02, lod0.shred * 3)) {
            console.warn(`art prop ${id}: LOD1 looks shredded (${(lod1.shred * 100).toFixed(1)}% long triangles vs ${(lod0.shred * 100).toFixed(1)}% in LOD0); using LOD0`);
            lod1 = null;
          }
          out.set(id, { id, lod0, lod1, tintMap, height: e.height ?? lod0.box.max.y });
          bytes += e.totalBytes ?? 0;
        } catch (err) {
          console.warn(`art prop ${id}: ${(err as Error).message}`);
        }
      }),
    );
    this.loads.push({ model: `props(${out.size})`, ms: Math.round(performance.now() - t0), bytes });
    return out;
  }

  /** Load a structure GLB (a faction Keep, an arrow tower) from the manifest; `lod1` = its far / low-tier file. Null if absent. */
  async structure(id: string, lod1 = false): Promise<THREE.Object3D | null> {
    await this.manifestReady;
    const e = this.manifest?.[id];
    const file = lod1 ? e?.lod1 : e?.glb;
    if (!e || !file) return null;
    const t0 = performance.now();
    try {
      const g = await this.loader.loadAsync(this.url(file));
      this.loads.push({ model: lod1 ? `${id}_lod1` : id, ms: Math.round(performance.now() - t0), bytes: (e as { bytes?: Record<string, number> }).bytes?.[file] ?? e.totalBytes ?? 0 });
      return g.scene;
    } catch (err) {
      console.warn(`art structure ${id}: ${(err as Error).message}`);
      return null;
    }
  }

  cloneHero(a: HeroAsset): THREE.Object3D {
    return SkeletonUtils.clone(a.template);
  }
}

/** Float copy of any (quantized / interleaved / normalized) attribute. */
function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const n = a.count;
  const k = a.itemSize;
  const out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    out[i * k] = a.getX(i);
    if (k > 1) out[i * k + 1] = a.getY(i);
    if (k > 2) out[i * k + 2] = a.getZ(i);
    if (k > 3) out[i * k + 3] = a.getW(i);
  }
  return new THREE.BufferAttribute(out, k);
}

/** The first mesh of a prop scene, with its node transforms baked into float geometry. */
export function bakeProp(root: THREE.Object3D): PropMesh | null {
  root.updateMatrixWorld(true);
  let mesh: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
  });
  if (!mesh) return null;
  const m = mesh as THREE.Mesh;
  const src = m.geometry;
  const g = new THREE.BufferGeometry();
  // every attribute (some props sample their maps from uv1), dequantized to float
  for (const [name, a] of Object.entries(src.attributes)) g.setAttribute(name, toFloat(a as THREE.BufferAttribute));
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(m.matrixWorld);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
  return { geometry: g, material: mat, box: g.boundingBox!.clone(), shred: shredScore(g) };
}

/** Fraction of triangles with an edge longer than 35 % of the bounding-box diagonal. */
function shredScore(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const idx = g.index;
  const n = (idx ? idx.count : p.count) / 3;
  const diag = g.boundingBox!.getSize(new THREE.Vector3()).length();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let bad = 0;
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(p, i0);
    b.fromBufferAttribute(p, i1);
    c.fromBufferAttribute(p, i2);
    if (Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) > diag * 0.35) bad++;
  }
  return n ? bad / n : 0;
}
