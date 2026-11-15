// Painted 2D art (tools/art/ui-art.mjs -> public/ui/*.webp): Lord portraits, unit card art, item
// base icons, title key art. `public/ui/manifest.json` lists what exists; anything missing falls
// back to the crest / glyph placeholders. URLs are relative (the game is served under a path).
import { assetUrl, loadAssetVersions } from '../assets.ts';

let have = new Set<string>();
/** The battlefield glyph atlas (public/ui/plates.webp + plates.json, as src/render/plates.ts): id -> cell. */
let glyphs = new Map<string, number>();
let glyphCols = 8;
let glyphRows = 8;

export async function loadArt(): Promise<void> {
  try {
    // the content hashes arrive with the manifest, so every art URL below can carry its `?v=`
    const [r] = await Promise.all([fetch('ui/manifest.json', { cache: 'no-cache' }), loadAssetVersions()]);
    if (r.ok) have = new Set(await r.json());
    const g = await fetch(assetUrl('ui/plates.json'));
    if (g.ok) {
      const j = (await g.json()) as { ids: string[]; cols: number; rows: number };
      glyphs = new Map(j.ids.map((id, i) => [id, i]));
      glyphCols = j.cols;
      glyphRows = j.rows;
    }
  } catch {
    /* offline / no art yet: placeholders */
  }
}

/** Relative URL of an art piece, or null if it hasn't been made. */
export function art(id: string): string | null {
  // absolute (from the page URL): a relative url() inside a CSS variable would resolve against
  // the stylesheet in assets/, not the page
  if (!have.has(id)) return null;
  const url = new URL(`ui/${id}.webp`, document.baseURI).href;
  // versioned (cached for a year); the key art keeps its plain URL, which index.html preloads
  return id === 'keyart' ? url : assetUrl(url);
}

/**
 * CSS custom properties that place a unit's / Lord's battlefield glyph (`unit_<type>` / `lord_<id>`) as a sprite:
 * `--gimg` (the atlas), `--gx` / `--gy` (background-position), `--gs` (background-size). '' if there is none.
 * Small crests show this instead of the portrait, so the role glyphs of the battlefield are learnt in the menus.
 */
export function glyphVars(id: string): string {
  const i = glyphs.get(id);
  if (i === undefined) return '';
  const url = assetUrl(new URL('ui/plates.webp', document.baseURI).href);
  const x = ((i % glyphCols) / (glyphCols - 1)) * 100;
  const y = (Math.floor(i / glyphCols) / (glyphRows - 1)) * 100;
  return `--gimg:url(${url});--gx:${x.toFixed(3)}%;--gy:${y.toFixed(3)}%;--gs:${glyphCols * 100}% ${glyphRows * 100}%`;
}
