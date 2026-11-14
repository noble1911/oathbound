// Versioned asset URLs. The server caches art, textures, audio and UI images for a year when the
// request carries `?v=<content hash>` and makes the browser revalidate them otherwise. The hashes
// come from /asset-versions.json (every file under models/, textures/, audio/ and ui/) and from the
// `hashes` map the server appends to each manifest.json.
//
//   await loadAssetVersions();            // once, before the first load (cheap; safe to call again)
//   fetch(assetUrl('audio/ui_click.webm'))
//   img.src = assetUrl('ui/unit_mages.webp')
//
// `assetUrl` is synchronous and best-effort: a path whose hash is not known (the table has not
// arrived yet, the dev server has no table, or the file is not listed) comes back unchanged and is
// then simply revalidated by the browser. Paths are relative to the page, as everywhere else in the
// client (the game is served under a sub-path); absolute same-origin URLs work too.
// No DOM is needed to import this module (the sim / server tests may pull it in).

const versions = new Map<string, string>();
let loading: Promise<void> | null = null;

function pageDir(): string {
  return new URL('.', document.baseURI).pathname;
}

/** "models/v2/knight.glb" for a page-relative path or a same-origin absolute URL; null when it is not ours. */
function keyOf(path: string): string | null {
  if (typeof document === 'undefined') return null;
  let u: URL;
  try {
    u = new URL(path, document.baseURI);
  } catch {
    return null;
  }
  if (u.origin !== location.origin) return null;
  const dir = pageDir();
  return u.pathname.startsWith(dir) ? decodeURIComponent(u.pathname.slice(dir.length)) : null;
}

/** Fetch the hash table once. Resolves (never rejects) when it is in, or when there is none. */
export function loadAssetVersions(): Promise<void> {
  if (loading) return loading;
  if (typeof document === 'undefined' || typeof fetch === 'undefined') return (loading = Promise.resolve());
  loading = fetch('asset-versions.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      if (!j || typeof j !== 'object' || Array.isArray(j)) return;
      for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (typeof v === 'string' && !versions.has(k)) versions.set(k, v);
    })
    .catch(() => {});
  return loading;
}

/** Add the `hashes` map of a served manifest.json; `manifestUrl` is that manifest's URL. */
export function registerAssetHashes(manifestUrl: string, hashes: unknown): void {
  if (!hashes || typeof hashes !== 'object' || typeof document === 'undefined') return;
  const dir = keyOf(new URL('.', new URL(manifestUrl, document.baseURI)).href);
  if (dir === null) return;
  for (const [k, v] of Object.entries(hashes as Record<string, unknown>)) if (typeof v === 'string') versions.set(dir + k, v);
}

/** `path` with `?v=<hash>` appended when its hash is known (see the header). */
export function assetUrl(path: string): string {
  const key = keyOf(path);
  const v = key === null ? undefined : versions.get(key);
  if (!v || path.includes('?')) return path;
  return `${path}?v=${v}`;
}

/** Wait for the hash table, then `assetUrl(path)`. */
export async function assetUrlReady(path: string): Promise<string> {
  await loadAssetVersions();
  return assetUrl(path);
}
