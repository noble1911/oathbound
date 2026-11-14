// Painted 2D art (tools/art/ui-art.mjs -> public/ui/*.webp): Lord portraits, unit card art, item
// base icons, title key art. `public/ui/manifest.json` lists what exists; anything missing falls
// back to the crest / glyph placeholders. URLs are relative (the game is served under a path).
import { assetUrl, loadAssetVersions } from '../assets.ts';

let have = new Set<string>();

export async function loadArt(): Promise<void> {
  try {
    // the content hashes arrive with the manifest, so every art URL below can carry its `?v=`
    const [r] = await Promise.all([fetch('ui/manifest.json', { cache: 'no-cache' }), loadAssetVersions()]);
    if (r.ok) have = new Set(await r.json());
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
