// Procedural sprite atlas for the particle system, drawn on a canvas at startup (no licensed
// textures). 4 × 2 cells of 128 px, white shapes in RGB with coverage in alpha; the shader uses
// alpha × red so smoke keeps some internal structure.
import * as THREE from 'three';

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
export const CELL = { dot: 0, spark: 1, smoke: 2, ring: 3, star: 4, ember: 5, flame: 6, shard: 7 } as const;

const S = 128;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function makeAtlas(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = S * ATLAS_COLS;
  canvas.height = S * ATLAS_ROWS;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rnd = lcg(1337);
  const cell = (i: number, draw: (cx: number, cy: number) => void) => {
    const cx = (i % ATLAS_COLS) * S + S / 2;
    const cy = Math.floor(i / ATLAS_COLS) * S + S / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - S / 2, cy - S / 2, S, S);
    ctx.clip();
    draw(cx, cy);
    ctx.restore();
  };
  const radial = (cx: number, cy: number, r: number, stops: [number, number][]) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(cx - S / 2, cy - S / 2, S, S);
  };

  // 0 soft dot (gaussian-ish)
  cell(CELL.dot, (cx, cy) => radial(cx, cy, S / 2, [[0, 1], [0.2, 0.75], [0.5, 0.25], [0.8, 0.05], [1, 0]]));

  // 1 spark streak: a thin vertical bright line with soft falloff
  cell(CELL.spark, (cx, cy) => {
    const g = ctx.createLinearGradient(cx, cy - S / 2, cx, cy + S / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    for (let w = 26; w >= 4; w -= 4) {
      ctx.globalAlpha = 0.16 + (26 - w) / 30;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, S / 2 - 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

  // 2 smoke puff: overlapping soft blobs, blurred
  cell(CELL.smoke, (cx, cy) => {
    ctx.filter = 'blur(5px)';
    for (let i = 0; i < 22; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.pow(rnd(), 0.7) * S * 0.24;
      const r = S * (0.1 + rnd() * 0.15);
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const v = 180 + Math.floor(rnd() * 75);
      g.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
      g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.filter = 'none';
  });

  // 3 ring
  cell(CELL.ring, (cx, cy) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.0)');
    g.addColorStop(0.8, 'rgba(255,255,255,1)');
    g.addColorStop(0.9, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - S / 2, cy - S / 2, S, S);
  });

  // 4 star / flare: glow + 4 long thin rays + 4 short diagonal rays
  cell(CELL.star, (cx, cy) => {
    radial(cx, cy, S * 0.3, [[0, 1], [0.25, 0.6], [1, 0]]);
    const ray = (ang: number, len: number, w: number) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      const g = ctx.createLinearGradient(-len, 0, len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, len, w, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    ray(0, S / 2 - 2, 3.5);
    ray(Math.PI / 2, S / 2 - 2, 3.5);
    ray(Math.PI / 4, S * 0.26, 2.2);
    ray(-Math.PI / 4, S * 0.26, 2.2);
  });

  // 5 ember: hot sharp core with small halo
  cell(CELL.ember, (cx, cy) => radial(cx, cy, S * 0.42, [[0, 1], [0.12, 1], [0.22, 0.45], [0.5, 0.1], [1, 0]]));

  // 6 flame tongue: teardrop, noisy edges
  cell(CELL.flame, (cx, cy) => {
    ctx.filter = 'blur(3px)';
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const y = cy + S * 0.3 - t * S * 0.62;
      const r = S * 0.26 * Math.sin(Math.PI * Math.pow(1 - t, 0.8)) * (0.85 + rnd() * 0.3) + 2;
      const x = cx + (rnd() - 0.5) * S * 0.06 * t;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.filter = 'none';
  });

  // 7 shard: an angular crystal / chip
  cell(CELL.shard, (cx, cy) => {
    ctx.filter = 'blur(1px)';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - S * 0.42);
    ctx.lineTo(cx + S * 0.16, cy - S * 0.05);
    ctx.lineTo(cx + S * 0.06, cy + S * 0.4);
    ctx.lineTo(cx - S * 0.14, cy + S * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.filter = 'none';
    radial(cx, cy, S * 0.45, [[0, 0.35], [1, 0]]);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
