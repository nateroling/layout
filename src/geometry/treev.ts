// Shared fsn "TreeV"-style geometry, seen from above.
//
// Each directory is a platform holding its files in a grid. A directory's
// subtree owns a vertical band of width `alloc`; the platform sits at the top of
// the band and child subtrees sit side by side in the row beneath it, joined to
// the parent by wires. A platform growing taller only pushes its own subtree
// down; a band growing wider pushes later siblings (and everything to their
// right) sideways. Strategies differ only in how they build the LDir tree
// (order, ghosts, empty slots) and in the hooks that reserve extra room.

import type { LayoutNode } from '../types.ts';

export interface LFile {
  id: string;
  path: string;
  size: number;
  born: number;
  modified: number;
  ghost?: boolean;
}

export interface LDir {
  id: string;
  path: string;
  slots: (LFile | null)[]; // null = reserved empty cell
  dirs: LDir[];
  ghost?: boolean;
}

export interface GeoOptions {
  cell: number;
  pad: number;
  hgap: number;
  vgap: number;
  align: 'left' | 'center';
  gridMode: 'sqrt' | 'fixed';
  gridCols: number;
}

export const defaultGeo: GeoOptions = { cell: 1, pad: 0.5, hgap: 1, vgap: 2, align: 'left', gridMode: 'sqrt', gridCols: 8 };

/** Hooks let a strategy reserve more room than strictly required. Each must return >= required. */
export interface GeoHooks {
  cols?(d: LDir, required: number): number;
  rows?(d: LDir, required: number, cols: number): number;
  width?(d: LDir, required: number): number;
}

export interface Measured {
  cols: number;
  rows: number;
  pw: number; // platform width
  ph: number; // platform height
  childrenW: number;
  alloc: number; // band width
}

export function measure(root: LDir, g: GeoOptions, hooks: GeoHooks = {}): Map<string, Measured> {
  const out = new Map<string, Measured>();
  const rec = (d: LDir): number => {
    const n = d.slots.length;
    let cols = g.gridMode === 'fixed' ? g.gridCols : Math.max(1, Math.ceil(Math.sqrt(n)));
    if (hooks.cols) cols = Math.max(cols, hooks.cols(d, cols));
    let rows = Math.max(1, Math.ceil(n / cols));
    if (hooks.rows) rows = Math.max(rows, hooks.rows(d, rows, cols));
    const pw = cols * g.cell + 2 * g.pad;
    const ph = rows * g.cell + 2 * g.pad;
    let childrenW = 0;
    d.dirs.forEach((c, i) => {
      childrenW += rec(c) + (i > 0 ? g.hgap : 0);
    });
    const required = Math.max(pw, childrenW);
    let alloc = required;
    if (hooks.width) alloc = Math.max(required, hooks.width(d, required));
    out.set(d.id, { cols, rows, pw, ph, childrenW, alloc });
    return alloc;
  };
  rec(root);
  return out;
}

export function place(root: LDir, g: GeoOptions, m: Map<string, Measured>): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  const box = g.cell * 0.8;
  const inset = (g.cell - box) / 2;
  const rec = (d: LDir, x: number, y: number, parent: string | null) => {
    const me = m.get(d.id)!;
    const px = g.align === 'center' ? x + (me.alloc - me.pw) / 2 : x;
    nodes.push({ id: d.id, kind: 'dir', path: d.path, parent, x: px, y, w: me.pw, h: me.ph, ghost: d.ghost || undefined });
    d.slots.forEach((f, i) => {
      if (!f) return;
      const col = i % me.cols;
      const row = Math.floor(i / me.cols);
      nodes.push({
        id: f.id,
        kind: 'file',
        path: f.path,
        parent: d.id,
        x: px + g.pad + col * g.cell + inset,
        y: y + g.pad + row * g.cell + inset,
        w: box,
        h: box,
        ghost: f.ghost || d.ghost || undefined,
        size: f.size,
        born: f.born,
        modified: f.modified,
      });
    });
    let cx = g.align === 'center' ? x + (me.alloc - me.childrenW) / 2 : x;
    const cy = y + me.ph + g.vgap;
    for (const c of d.dirs) {
      rec(c, cx, cy, d.id);
      cx += m.get(c.id)!.alloc + g.hgap;
    }
  };
  rec(root, 0, 0, null);
  return nodes;
}

export function bbox(nodes: LayoutNode[]): { x: number; y: number; w: number; h: number } {
  if (!nodes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x + n.w > x1) x1 = n.x + n.w;
    if (n.y + n.h > y1) y1 = n.y + n.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function geoFromOptions(o: Record<string, unknown>, base: GeoOptions = defaultGeo): GeoOptions {
  return {
    cell: num(o.cell, base.cell),
    pad: num(o.pad, base.pad),
    hgap: num(o.hgap, base.hgap),
    vgap: num(o.vgap, base.vgap),
    align: o.align === 'center' ? 'center' : o.align === 'left' ? 'left' : base.align,
    gridMode: o.gridMode === 'fixed' ? 'fixed' : o.gridMode === 'sqrt' ? 'sqrt' : base.gridMode,
    gridCols: num(o.gridCols, base.gridCols),
  };
}

function num(v: unknown, d: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}
