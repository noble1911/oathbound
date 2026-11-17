// Shared by the remodel review scripts (model-compare.mjs, slide-check.mjs, anim-audit.mjs with STAGE set):
//  * a vite dev server (no HMR, no file watching) that also serves two model sets next to public/models/v2:
//      /models/v2-old/  = art-work/backup_v2/pre_remodel/        (the models before the remodel + their manifest)
//      /models/v2-new/  = the staging dir (STAGE env / --stage, default art-work/stage_v2) laid over public/models/v2;
//                         its manifest.json = public's manifest with the staged entries (models + props) on top
//    render-test.html takes `&manifest=models/v2-old/manifest.json`, so nothing is copied into public/.
//  * the unit table: model id -> showArmy squad (type / lord / modelId), close-up distance, faction, squad or single.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OLD_DIR = path.resolve(ROOT, process.env.OLD_DIR ?? 'art-work/backup_v2/pre_remodel');   // OLD_DIR env: compare against another set (e.g. public/models/v2 before a ship)
export const PUBLIC_DIR = path.join(ROOT, 'public/models/v2');
export const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const K = 'kingdom', A = 'ashen', C = 'caliphate';
/** id -> { type, lord?, modelId?, dist (close-up side view, m), f (faction), sq (crowd squad), isNew (no old model) } */
export const UNITS = {
  militia: { type: 'militia', dist: 4.6, f: K, sq: 1 }, pikeman: { type: 'pikemen', dist: 5.4, f: K, sq: 1 }, berserker: { type: 'berserkers', dist: 4.6, f: K, sq: 1 },
  archer: { type: 'archers', dist: 4.6, f: K, sq: 1 }, knight: { type: 'knights', dist: 5.4, f: K, sq: 1 }, mage: { type: 'mages', dist: 4.6, f: K, sq: 1 },
  cleric: { type: 'clerics', dist: 4.6, f: K, sq: 1 }, cavalier: { type: 'cavaliers', dist: 6.2, f: K, sq: 1 }, pegasus: { type: 'pegasus', dist: 6.8, f: K, sq: 1 },
  lord_marshal: { type: 'lord', lord: 'marshal', dist: 5, f: K }, lord_archmage: { type: 'lord', lord: 'archmage', dist: 5, f: K },
  lord_warden: { type: 'lord', lord: 'warden', dist: 5.4, f: K }, lord_skylady: { type: 'lord', lord: 'skylady', dist: 5.6, f: K },
  golem: { type: 'golem', dist: 11, f: K }, wyvern: { type: 'wyvern', dist: 11, f: K }, dragon: { type: 'dragon', dist: 19, f: K },
  ballista: { type: 'ballista', dist: 7, f: K, siege: 1 }, trebuchet: { type: 'trebuchet', dist: 15, f: K, siege: 1 },
  skeleton: { type: 'militia', modelId: 'skeleton', dist: 4.6, f: A, sq: 1 },
  grave_knight: { type: 'grave_knight', dist: 5.4, f: A, sq: 1 }, bone_archer: { type: 'bone_archer', dist: 4.6, f: A, sq: 1 }, wraith_rider: { type: 'wraith_rider', dist: 6.2, f: A, sq: 1 },
  grave_acolyte: { type: 'grave_acolyte', dist: 4.8, f: A, sq: 1 }, bone_drake: { type: 'bone_drake', dist: 19, f: A }, corpse_catapult: { type: 'corpse_catapult', dist: 14, f: A, siege: 1 },
  bone_golem: { type: 'bone_golem', dist: 11, f: A }, lord_lich: { type: 'lord', lord: 'lich', dist: 5.8, f: A },
  lord_deathknight: { type: 'lord', lord: 'deathknight', dist: 5.8, f: A, isNew: 1 }, lord_ossuary: { type: 'lord', lord: 'ossuary', dist: 8.5, f: A, isNew: 1 },
  lord_drakerider: { type: 'lord', lord: 'drakerider', dist: 12, f: A, isNew: 1 },
  spear_levy: { type: 'spear_levy', dist: 4.8, f: C, sq: 1 }, scimitar: { type: 'scimitar', dist: 4.8, f: C, sq: 1 }, camel_archer: { type: 'camel_archer', dist: 7.4, f: C, sq: 1 },
  mamluk: { type: 'mamluk', dist: 6.2, f: C, sq: 1 }, djinn_binder: { type: 'djinn_binder', dist: 4.8, f: C, sq: 1 }, sun_priest: { type: 'sun_priest', dist: 4.6, f: C, sq: 1 },
  djinn: { type: 'djinn', dist: 9, f: C }, war_elephant: { type: 'war_elephant', dist: 14, f: C }, sand_golem: { type: 'sand_golem', dist: 11, f: C },
  lord_sultana: { type: 'lord', lord: 'sultana', dist: 6.5, f: C },
  lord_vizier: { type: 'lord', lord: 'vizier', dist: 6, f: C, isNew: 1 }, lord_rajah: { type: 'lord', lord: 'rajah', dist: 6, f: C, isNew: 1 },
  lord_rocrider: { type: 'lord', lord: 'rocrider', dist: 12, f: C, isNew: 1 },
};
/** The showArmy squad of a unit. */
export const squadOf = (id, o = {}) => {
  const u = UNITS[id];
  return { id: 1, owner: 0, type: u.type, lord: u.lord, modelId: u.modelId ?? (u.lord ? `lord_${u.lord}` : id), pos: [4000, 4300], facing: 64, size: u.sq ? undefined : 1, ...o };
};

const MIME = { '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.webp': 'image/webp' };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export function newManifest(stage) {
  const m = readJson(path.join(PUBLIC_DIR, 'manifest.json'));
  delete m.hashes;
  const sm = path.join(stage, 'manifest.json');
  if (fs.existsSync(sm)) {
    const s = readJson(sm);
    for (const key of ['models', 'props']) Object.assign((m[key] ??= {}), s[key] ?? {});
  }
  return m;
}
export function oldManifest() {
  const m = readJson(path.join(OLD_DIR, 'manifest.json'));
  delete m.hashes;
  return m;
}

/** Start the review server. Returns { base, close, stage }. */
export async function startServer({ stage = process.env.STAGE ?? path.join(ROOT, 'art-work/stage_v2'), port = Number(process.env.PORT ?? 5188) } = {}) {
  stage = path.resolve(ROOT, stage);
  const { createServer } = await import('vite');
  const models = {
    name: 'remodel-model-sets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const u = new URL(req.url, 'http://x');
        const m = /\/models\/v2-(old|new)\/([^/]+)$/.exec(u.pathname);
        if (!m) return next();
        const [, set, file] = m;
        const name = decodeURIComponent(file);
        const send = (body, ext) => { res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.end(body); };
        if (name === 'manifest.json') return send(JSON.stringify(set === 'old' ? oldManifest() : newManifest(stage)), '.json');
        for (const dir of set === 'old' ? [OLD_DIR] : [stage, PUBLIC_DIR]) {
          const f = path.join(dir, name);
          if (fs.existsSync(f)) return send(fs.readFileSync(f), path.extname(name));
        }
        res.statusCode = 404; res.end('not found');
      });
    },
  };
  const server = await createServer({ root: ROOT, logLevel: 'error', plugins: [models], server: { port, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
  await server.listen();
  return { base: `http://127.0.0.1:${server.config.server.port}/`, close: () => server.close(), stage };
}
export const manifestParam = (set) => (set === 'cur' ? '' : `&manifest=models/v2-${set}/manifest.json`);
