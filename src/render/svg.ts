// Top-down fsn-style SVG of one Frame.
//
//   ground   dark, with a faint grid
//   wires    parent platform bottom-centre -> child platform top-centre (orthogonal)
//   platform one rect per directory
//   files    boxes coloured by recency of last modification (hot = just changed,
//            cool = untouched for a long time) and lightness by blob size
//   ghosts   dashed outlines (tombstoned slots)
//   moved    optional outline for nodes whose position changed since a previous frame
//
// Files are batched into one <path> per colour class, so a frame costs roughly
// 25-30 bytes per node. Coordinates are rounded to 2 decimals.

import type { Frame, LayoutNode } from '../types.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Caption {
  index: number;
  total?: number;
  time?: number; // unix seconds
  sha?: string;
  subject?: string;
  label?: string; // e.g. "chalk · recompute name"
}

export interface SvgOptions {
  scale?: number; // px per layout unit (when width is not given)
  maxPx?: number; // cap on the longer side in px
  width?: number | null; // explicit px width; null = no width/height attrs (responsive)
  title?: string; // legacy one-line title (bin/viz.ts)
  caption?: Caption;
  totalCommits?: number; // for recency colouring (default: frame.commit + 1)
  viewport?: Rect; // fixed layout-unit window (filmstrips share one); default bbox + margin
  moved?: Set<string>; // node ids to outline
  titles?: boolean; // per-node <title> tooltips (default true; costly for big frames)
}

// ---- shared colour scheme (also used by the HTML player) ----

export const RECENCY_BUCKETS = 6;
export const SIZE_BUCKETS = 3;
/** [recency][size] -> colour. recency 0 = modified at this commit ... 5 = oldest. size 0 = small ... 2 = large. */
export const FILE_COLOURS: string[][] = (() => {
  // hot (amber) -> cool (steel blue) in OKLCH-ish steps, hand-picked for a dark ground
  const hue = [48, 38, 160, 190, 215, 225];
  const chroma = [95, 85, 55, 55, 45, 25];
  const light = [62, 55, 48, 44, 40, 36];
  const out: string[][] = [];
  for (let r = 0; r < RECENCY_BUCKETS; r++) {
    const row: string[] = [];
    for (let s = 0; s < SIZE_BUCKETS; s++) row.push(`hsl(${hue[r]} ${chroma[r]}% ${light[r] + (s - 1) * 9}%)`);
    out.push(row);
  }
  return out;
})();
export const PALETTE = {
  ground: '#080c11',
  grid: '#111a24',
  wire: '#4f6a85',
  platform: '#16212d',
  platformEdge: '#33506d',
  ghost: '#5d6b7a',
  moved: '#ff4fd8',
  text: '#c8d6e5',
  textDim: '#7d90a6',
};

/** Commits-since-modified -> bucket 0..5 (log scale relative to history length). */
export function recencyBucket(age: number, total: number): number {
  if (age <= 0) return 0;
  const t = Math.log1p(age) / Math.log1p(Math.max(2, total));
  return Math.min(RECENCY_BUCKETS - 1, 1 + Math.floor(t * (RECENCY_BUCKETS - 1)));
}
/** Blob bytes -> 0 (<1 KB), 1 (<16 KB), 2 (larger). */
export function sizeBucket(size: number): number {
  return size < 1024 ? 0 : size < 16384 ? 1 : 2;
}

const r2 = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const rectPath = (n: { x: number; y: number; w: number; h: number }) => `M${r2(n.x)} ${r2(n.y)}h${r2(n.w)}v${r2(n.h)}h${r2(-n.w)}z`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function defaultViewport(f: Frame, margin = 2): Rect {
  const b = f.bbox;
  return { x: b.x - margin, y: b.y - margin, w: Math.max(1, b.w + 2 * margin), h: Math.max(1, b.h + 2 * margin) };
}

/** Union of rects (e.g. every filmstrip frame's bbox), with a margin. */
export function unionViewport(rects: Rect[], margin = 2): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of rects) {
    if (b.w <= 0 && b.h <= 0) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return { x: -margin, y: -margin, w: 2 * margin + 1, h: 2 * margin + 1 };
  return { x: x0 - margin, y: y0 - margin, w: x1 - x0 + 2 * margin, h: y1 - y0 + 2 * margin };
}

/** Ids of non-ghost nodes whose top-left differs between two frames (by more than eps). */
export function movedIds(prev: Frame | null, cur: Frame, eps = 1e-6): Set<string> {
  const out = new Set<string>();
  if (!prev) return out;
  const p = new Map<string, LayoutNode>();
  for (const n of prev.nodes) if (!n.ghost) p.set(n.id, n);
  for (const n of cur.nodes) {
    if (n.ghost) continue;
    const q = p.get(n.id);
    if (q && Math.hypot(n.x - q.x, n.y - q.y) > eps) out.add(n.id);
  }
  return out;
}

export function captionText(c: Caption): string {
  const parts: string[] = [];
  if (c.label) parts.push(c.label);
  parts.push(`#${c.index}${c.total ? `/${c.total - 1}` : ''}`);
  if (c.time) parts.push(new Date(c.time * 1000).toISOString().slice(0, 10));
  if (c.sha) parts.push(c.sha.slice(0, 7));
  return parts.join(' · ');
}

export function renderSvg(f: Frame, o: SvgOptions = {}): string {
  const vp = o.viewport ?? defaultViewport(f);
  const total = Math.max(1, o.totalCommits ?? f.commit + 1);
  const titles = o.titles !== false;
  const byId = new Map<string, LayoutNode>();
  for (const n of f.nodes) byId.set(n.id, n);

  // caption band above the viewport, sized relative to the viewport width
  const cap = o.caption ?? (o.title ? { index: f.commit, label: o.title } : undefined);
  const capFont = Math.max(0.8, Math.min(vp.w / 38, 6));
  const capH = cap ? capFont * (cap.subject ? 3.1 : 1.8) : 0;
  const vx = vp.x, vy = vp.y - capH, vw = vp.w, vh = vp.h + capH;

  let scale = o.scale ?? 6;
  const maxPx = o.maxPx ?? 2400;
  if (Math.max(vw, vh) * scale > maxPx) scale = maxPx / Math.max(vw, vh);
  let size = '';
  if (o.width !== null) {
    const pxW = o.width ?? vw * scale;
    size = ` width="${Math.round(pxW)}" height="${Math.round((pxW * vh) / vw)}"`;
  }

  let wires = '', dirs = '', ghostDirs = '', ghostFiles = '', moved = '';
  const filePaths: string[] = new Array(RECENCY_BUCKETS * SIZE_BUCKETS).fill('');
  const tips: string[] = [];
  for (const n of f.nodes) {
    if (n.kind === 'dir') {
      if (n.parent) {
        const p = byId.get(n.parent);
        if (p) {
          const x1 = p.x + p.w / 2, y1 = p.y + p.h, x2 = n.x + n.w / 2, y2 = n.y;
          const ym = (y1 + y2) / 2;
          wires += `M${r2(x1)} ${r2(y1)}V${r2(ym)}H${r2(x2)}V${r2(y2)}`;
        }
      }
      if (n.ghost) ghostDirs += rectPath(n);
      else dirs += rectPath(n);
      if (titles) tips.push(`<rect x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(n.h)}"><title>${esc(n.path || '/')}</title></rect>`);
    } else if (n.ghost) {
      ghostFiles += rectPath(n);
    } else {
      const k = recencyBucket(f.commit - (n.modified ?? 0), total) * SIZE_BUCKETS + sizeBucket(n.size ?? 0);
      filePaths[k] += rectPath(n);
      if (titles) tips.push(`<rect x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(n.h)}"><title>${esc(n.path)}</title></rect>`);
    }
    if (o.moved?.has(n.id)) moved += rectPath(n);
  }

  const sw = (k: number) => r2(Math.min(0.12 * k, Math.max(0.04, (Math.max(vw, vh) / 400) * k)));
  const grid = 5;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(vx)} ${r2(vy)} ${r2(vw)} ${r2(vh)}"${size} preserveAspectRatio="xMidYMin meet">`);
  out.push(`<defs><pattern id="gr" width="${grid}" height="${grid}" patternUnits="userSpaceOnUse"><path d="M${grid} 0H0V${grid}" fill="none" stroke="${PALETTE.grid}" stroke-width="${sw(0.6)}"/></pattern></defs>`);
  out.push(`<rect x="${r2(vx)}" y="${r2(vy)}" width="${r2(vw)}" height="${r2(vh)}" fill="${PALETTE.ground}"/>`);
  out.push(`<rect x="${r2(vp.x)}" y="${r2(vp.y)}" width="${r2(vp.w)}" height="${r2(vp.h)}" fill="url(#gr)"/>`);
  // Outlines use screen-pixel widths (non-scaling-stroke) so they read at any display size.
  const ns = 'vector-effect="non-scaling-stroke"';
  if (wires) out.push(`<path d="${wires}" fill="none" stroke="${PALETTE.wire}" stroke-width="0.8" ${ns}/>`);
  if (dirs) out.push(`<path d="${dirs}" fill="${PALETTE.platform}" stroke="${PALETTE.platformEdge}" stroke-width="0.6" ${ns}/>`);
  if (ghostDirs) out.push(`<path d="${ghostDirs}" fill="none" stroke="${PALETTE.ghost}" stroke-width="0.6" stroke-dasharray="2 1.5" ${ns}/>`);
  filePaths.forEach((d, k) => {
    if (d) out.push(`<path d="${d}" fill="${FILE_COLOURS[Math.floor(k / SIZE_BUCKETS)][k % SIZE_BUCKETS]}"/>`);
  });
  if (ghostFiles) out.push(`<path d="${ghostFiles}" fill="none" stroke="${PALETTE.ghost}" stroke-width="0.5" stroke-dasharray="1.5 1" ${ns}/>`);
  if (moved) out.push(`<path d="${moved}" fill="none" stroke="${PALETTE.moved}" stroke-width="1.1" ${ns}/>`);
  if (tips.length) out.push(`<g fill="transparent">${tips.join('')}</g>`);
  if (cap) {
    const tx = r2(vx + capFont * 0.5);
    out.push(`<text x="${tx}" y="${r2(vy + capFont * 1.25)}" font-family="ui-monospace,Menlo,monospace" font-size="${r2(capFont)}" fill="${PALETTE.text}">${esc(captionText(cap))}</text>`);
    if (cap.subject) {
      const maxChars = Math.max(10, Math.floor(vw / (capFont * 0.55)));
      const s = cap.subject.length > maxChars ? cap.subject.slice(0, maxChars - 1) + '…' : cap.subject;
      out.push(`<text x="${tx}" y="${r2(vy + capFont * 2.55)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${r2(capFont * 0.9)}" fill="${PALETTE.textDim}">${esc(s)}</text>`);
    }
  }
  out.push('</svg>');
  return out.join('\n');
}
