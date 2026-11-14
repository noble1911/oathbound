// Static file serving: cache policy, strong ETags + 304s, brotli/gzip for text-like assets, byte ranges for audio.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'oathbound-static-'));
const files: Record<string, Buffer> = {
  'index.html': Buffer.from('<!doctype html><title>Oathbound</title>' + '<p>hello</p>'.repeat(200)),
  'assets/index-AbC123.js': Buffer.from('export const x = 1;\n'.repeat(400)),
  'models/v2/knight.vat.bin': Buffer.alloc(64 * 1024, 7),
  'models/v2/knight.vat.json': Buffer.from(JSON.stringify({ frames: Array.from({ length: 300 }, (_, i) => i) })),
  'ui/unit_knights.webp': Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) & 255)),
  'audio/theme.webm': Buffer.from(Array.from({ length: 4000 }, (_, i) => i & 255)),
  'models/v2/manifest.json': Buffer.from(JSON.stringify({ version: 2, models: { knight: { glb: 'knight.glb' } } })),
  'models/v2/knight.glb': Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 31) & 255)),
  'textures/grass.webp': Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 13) & 255)),
};
for (const [p, b] of Object.entries(files)) {
  mkdirSync(join(dir, p, '..'), { recursive: true });
  writeFileSync(join(dir, p), b);
}
process.env.DIST = dir;

let port = 0;
let close: () => Promise<void> = async () => {};
beforeAll(async () => {
  const { startServer } = await import('../server/index.ts');
  const s = await startServer(0);
  port = s.port;
  close = s.close;
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static files', () => {
  it('index.html is no-cache with a strong ETag and answers 304 when unchanged', async () => {
    const a = await get('/');
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBe('no-cache');
    const etag = String(a.headers.etag);
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(a.body.equals(files['index.html'])).toBe(true);
    const b = await get('/index.html', { 'If-None-Match': etag });
    expect(b.status).toBe(304);
    expect(b.body.length).toBe(0);
  });

  it('hashed Vite assets are immutable; brotli preferred, gzip as fallback, identity otherwise', async () => {
    const br = await get('/assets/index-AbC123.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(brotliDecompressSync(br.body).equals(files['assets/index-AbC123.js'])).toBe(true);
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    const gz = await get('/assets/index-AbC123.js', { 'Accept-Encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).equals(files['assets/index-AbC123.js'])).toBe(true);
    const none = await get('/assets/index-AbC123.js', { 'Accept-Encoding': 'br;q=0, gzip;q=0' });
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(none.body.equals(files['assets/index-AbC123.js'])).toBe(true);
    // each encoding has its own strong validator
    expect(new Set([br.headers.etag, gz.headers.etag, none.headers.etag]).size).toBe(3);
  });

  it('models and UI art without a version revalidate every time; VAT .bin and .json compressed; 304 via the ETag', async () => {
    const bin = await get('/models/v2/knight.vat.bin', { 'Accept-Encoding': 'br' });
    expect(bin.headers['cache-control']).toBe('no-cache');
    expect(bin.headers['content-encoding']).toBe('br');
    expect(bin.body.length).toBeLessThan(files['models/v2/knight.vat.bin'].length / 10);
    const again = await get('/models/v2/knight.vat.bin', { 'Accept-Encoding': 'br', 'If-None-Match': String(bin.headers.etag) });
    expect(again.status).toBe(304);
    const json = await get('/models/v2/knight.vat.json', { 'Accept-Encoding': 'gzip' });
    expect(json.headers['content-encoding']).toBe('gzip');
    expect(json.headers['cache-control']).toBe('no-cache');
    const art = await get('/ui/unit_knights.webp', { 'Accept-Encoding': 'br, gzip' });
    expect(art.headers['cache-control']).toBe('no-cache');
    expect(art.headers['content-encoding']).toBeUndefined(); // images are never re-encoded
    expect(art.headers.etag).toBeTruthy();
  });

  it('versioned art (?v=hash) is immutable; the served manifest and /asset-versions.json carry the hashes', async () => {
    const man = await get('/models/v2/manifest.json');
    expect(man.status).toBe(200);
    expect(man.headers['cache-control']).toBe('no-cache');
    const m = JSON.parse(man.body.toString());
    expect(m.models.knight.glb).toBe('knight.glb'); // the manifest itself is untouched
    expect(Object.keys(m.hashes).sort()).toEqual(['knight.glb', 'knight.vat.bin', 'knight.vat.json']);
    expect(m.hashes['knight.glb']).toMatch(/^[\w-]{12}$/);
    expect((await get('/models/v2/manifest.json', { 'If-None-Match': String(man.headers.etag) })).status).toBe(304);
    const all = await get('/asset-versions.json');
    expect(all.headers['cache-control']).toBe('no-cache');
    const v = JSON.parse(all.body.toString());
    expect(v['models/v2/knight.glb']).toBe(m.hashes['knight.glb']);
    expect(v['textures/grass.webp']).toBeTruthy();
    expect(v['audio/theme.webm']).toBeTruthy();
    expect(v['ui/unit_knights.webp']).toBeTruthy();
    expect(v['index.html']).toBeUndefined();
    for (const p of ['models/v2/knight.glb', 'textures/grass.webp', 'audio/theme.webm', 'ui/unit_knights.webp']) {
      const r = await get(`/${p}?v=${v[p]}`);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control'], p).toBe('public, max-age=31536000, immutable');
      expect(r.body.equals(files[p])).toBe(true);
      expect((await get(`/${p}`)).headers['cache-control']).toBe('no-cache');
    }
    // JSON metadata is never immutable, versioned or not
    expect((await get('/models/v2/knight.vat.json?v=abc')).headers['cache-control']).toBe('no-cache');
    // a redeployed model changes its hash, so its versioned URL changes
    writeFileSync(join(dir, 'models/v2/knight.glb'), Buffer.from('new model bytes'));
    const m2 = JSON.parse((await get('/models/v2/manifest.json', { 'If-None-Match': String(man.headers.etag) })).body.toString());
    expect(m2.hashes['knight.glb']).not.toBe(m.hashes['knight.glb']);
    expect(m2.hashes['knight.vat.bin']).toBe(m.hashes['knight.vat.bin']);
  });

  it('a changed file gets a new ETag (the hash follows the content)', async () => {
    const a = await get('/models/v2/knight.vat.json');
    writeFileSync(join(dir, 'models/v2/knight.vat.json'), JSON.stringify({ frames: [1, 2, 3], v: 2 }));
    const b = await get('/models/v2/knight.vat.json', { 'If-None-Match': String(a.headers.etag) });
    expect(b.status).toBe(200);
    expect(b.headers.etag).not.toBe(a.headers.etag);
  });

  it('audio: byte ranges from the identity bytes (never compressed), If-Range honoured, 416 out of range, HEAD', async () => {
    const full = await get('/audio/theme.webm', { 'Accept-Encoding': 'br' });
    expect(full.headers['content-type']).toBe('audio/webm');
    expect(full.headers['content-encoding']).toBeUndefined();
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await get('/audio/theme.webm', { Range: 'bytes=10-19', 'Accept-Encoding': 'br' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/4000');
    expect(part.body.equals(files['audio/theme.webm'].subarray(10, 20))).toBe(true);
    const tail = await get('/audio/theme.webm', { Range: 'bytes=-5' });
    expect(tail.body.equals(files['audio/theme.webm'].subarray(3995))).toBe(true);
    const ok = await get('/audio/theme.webm', { Range: 'bytes=0-3', 'If-Range': String(full.headers.etag) });
    expect(ok.status).toBe(206);
    const stale = await get('/audio/theme.webm', { Range: 'bytes=0-3', 'If-Range': '"stale"' });
    expect(stale.status).toBe(200);
    expect(stale.body.length).toBe(4000);
    expect((await get('/audio/theme.webm', { Range: 'bytes=9000-' })).status).toBe(416);
    const head = await get('/audio/theme.webm', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(Number(head.headers['content-length'])).toBe(4000);
    expect(head.body.length).toBe(0);
  });

  it('errors are never cached', async () => {
    const r = await get('/models/v2/missing.glb');
    expect(r.status).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('display names and chat', () => {
  it('keep the raw text (the client escapes it) but drop control characters and cap the length', async () => {
    const { cleanName, cleanText } = await import('../server/index.ts');
    expect(cleanName('<b>Al</b>')).toBe('<b>Al</b>');
    expect(cleanName('  Tom & "Jerry"  ')).toBe('Tom & "Jerry"');
    expect(cleanName('A\u0000l\u202eice\u200b\n')).toBe('Alice');
    expect(cleanName('\u0007\u0008')).toBe('Player');
    expect(cleanName('x'.repeat(40))).toBe('x'.repeat(16));
    // code points, not UTF-16 units: an emoji is never cut in half
    const emoji = '\u{1F409}'.repeat(20);
    expect(Array.from(cleanName(emoji)).length).toBe(16);
    expect(cleanName(emoji)).toBe('\u{1F409}'.repeat(16));
    expect(cleanText('  hello <b>there</b>\u0007  ')).toBe('hello <b>there</b>');
    expect(cleanText('y'.repeat(500)).length).toBe(200);
  });
});
