// Painted 2D art (tools/art/ui-art.mjs -> public/ui/*.webp): Lord portraits, unit card art, item
// base icons, title key art. `public/ui/manifest.json` lists what exists; anything missing falls
// back to the crest / glyph placeholders. URLs are relative (the game is served under a path).
let have = new Set<string>();

export async function loadArt(): Promise<void> {
  try {
    const r = await fetch('ui/manifest.json', { cache: 'no-cache' });
    if (r.ok) have = new Set(await r.json());
  } catch {
    /* offline / no art yet: placeholders */
  }
}

/** Relative URL of an art piece, or null if it hasn't been made. */
export function art(id: string): string | null {
  // absolute (from the page URL): a relative url() inside a CSS variable would resolve against
  // the stylesheet in assets/, not the page
  return have.has(id) ? new URL(`ui/${id}.webp`, document.baseURI).href : null;
}
