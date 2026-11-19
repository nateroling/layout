// Alternative arrangements of the same measured platforms, aimed at a squarer picture than
// TreeV's one-wide-row-per-depth. Selected by the shared geometry option `arrange`, so they
// combine with every strategy: a strategy still decides order, ghosts, empty slots and
// platform sizes (cols/rows reservations); the arrangement only decides where platforms go.
//
//   treev   (treev.ts) children side by side in one row below the parent.
//   wrap    TreeV, but a directory's children flow onto several rows. The row break is chosen
//           per directory so its whole subtree block is as close to square as possible.
//   nested  Code City districts: a directory is a rectangle holding its file grid and its
//           children's districts, shelf-packed near-square. No wires; nesting shows hierarchy.
//   radial  TreeV wrapped around a circle: root in the middle, one ring per depth, each subtree
//           gets the wedge its TreeV band would get (so band reservations still hold room).
//   spiral  every directory's children coil around its platform in a square spiral, in order.
//
// Band-width reservations (the `width` hook) are TreeV-specific: wrap and nested ignore them
// (only platform cols/rows reservations carry over); radial uses band widths as angles.

import type { LayoutNode } from '../types.ts';
import type { GeoOptions, LDir, Measured } from './treev.ts';

export type Arrange = 'treev' | 'wrap' | 'nested' | 'radial' | 'spiral';
export const ARRANGES: Arrange[] = ['treev', 'wrap', 'nested', 'radial', 'spiral'];

/** How a renderer should draw parent -> child wires for an arrangement. */
export type WireStyle = 'elbow' | 'bus' | 'straight' | 'chain' | 'none';
export function wireStyle(a: unknown): WireStyle {
  return a === 'wrap' ? 'bus' : a === 'spiral' ? 'chain' : a === 'radial' ? 'straight' : a === 'nested' ? 'none' : 'elbow';
}

const E = 1e-9;

// ---- shelf packing (shared by wrap and nested) ----

interface Box {
  w: number;
  h: number;
}
interface Packing {
  x: number[];
  y: number[];
  row: number[]; // row index per item
  rowW: number[];
  w: number;
  h: number;
}

/** Items left to right, a new row whenever the next one would pass `limit`. */
function shelf(items: Box[], limit: number, gx: number, gy: number): Packing {
  const p: Packing = { x: [], y: [], row: [], rowW: [], w: 0, h: 0 };
  let cx = 0, cy = 0, rowH = 0, r = 0;
  items.forEach((b, i) => {
    if (cx > 0 && cx + b.w > limit + E) {
      p.rowW.push(cx - gx);
      cy += rowH + gy;
      cx = 0;
      rowH = 0;
      r++;
    }
    p.x.push(cx);
    p.y.push(cy);
    p.row.push(r);
    cx += b.w + gx;
    if (b.h > rowH) rowH = b.h;
  });
  if (items.length) p.rowW.push(cx - gx);
  p.w = Math.max(0, ...p.rowW);
  p.h = items.length ? cy + rowH : 0;
  return p;
}

/**
 * The shelf packing whose framed size `outer(w, h)` is most square: minimise the longer side,
 * then the area. Candidate limits are the widths of the first k items in one row (every row
 * break the greedy shelf can produce for a first row), so the result is deterministic.
 */
function squarest(items: Box[], gx: number, gy: number, outer: (w: number, h: number) => Box): Packing {
  const n = items.length;
  const limits: number[] = [];
  let acc = 0;
  const step = n > 400 ? Math.ceil(n / 200) : 1; // keep huge directories cheap
  for (let k = 0; k < n; k++) {
    acc += items[k].w + (k > 0 ? gx : 0);
    if (k % step === 0 || k === n - 1) limits.push(acc);
  }
  let best: Packing | null = null, bestSide = Infinity, bestArea = Infinity;
  for (const L of limits) {
    const p = shelf(items, L, gx, gy);
    const o = outer(p.w, p.h);
    const side = Math.max(o.w, o.h), area = o.w * o.h;
    if (side < bestSide - E || (side < bestSide + E && area < bestArea - E)) {
      best = p;
      bestSide = side;
      bestArea = area;
    }
  }
  return best ?? shelf(items, 0, gx, gy);
}

function pushFiles(nodes: LayoutNode[], d: LDir, me: Measured, g: GeoOptions, gx: number, gy: number, ghostDir: boolean) {
  const box = g.cell * 0.8;
  const inset = (g.cell - box) / 2;
  d.slots.forEach((f, i) => {
    if (!f) return;
    nodes.push({
      id: f.id,
      kind: 'file',
      path: f.path,
      parent: d.id,
      x: gx + (i % me.cols) * g.cell + inset,
      y: gy + Math.floor(i / me.cols) * g.cell + inset,
      w: box,
      h: box,
      ghost: f.ghost || ghostDir || undefined,
      size: f.size,
      born: f.born,
      modified: f.modified,
    });
  });
}

// ---- wrap ----

export function placeWrap(root: LDir, g: GeoOptions, m: Map<string, Measured>): LayoutNode[] {
  const blocks = new Map<string, { w: number; h: number; pack: Packing | null }>();
  const size = (d: LDir): Box => {
    const me = m.get(d.id)!;
    const kids = d.dirs.map(size);
    let w = me.pw, h = me.ph, pack: Packing | null = null;
    if (kids.length) {
      pack = squarest(kids, g.hgap, g.vgap, (pw, ph) => ({ w: Math.max(me.pw, pw), h: me.ph + g.vgap + ph }));
      w = Math.max(me.pw, pack.w);
      h = me.ph + g.vgap + pack.h;
    }
    blocks.set(d.id, { w, h, pack });
    return { w, h };
  };
  size(root);
  const nodes: LayoutNode[] = [];
  const rec = (d: LDir, x: number, y: number, parent: string | null) => {
    const me = m.get(d.id)!;
    const b = blocks.get(d.id)!;
    const px = g.align === 'center' ? x + (b.w - me.pw) / 2 : x;
    nodes.push({ id: d.id, kind: 'dir', path: d.path, parent, x: px, y, w: me.pw, h: me.ph, ghost: d.ghost || undefined });
    pushFiles(nodes, d, me, g, px + g.pad, y + g.pad, !!d.ghost);
    const p = b.pack;
    if (!p) return;
    d.dirs.forEach((c, i) => {
      const off = g.align === 'center' ? (b.w - p.rowW[p.row[i]]) / 2 : 0;
      rec(c, x + off + p.x[i], y + me.ph + g.vgap + p.y[i], d.id);
    });
  };
  rec(root, 0, 0, null);
  return nodes;
}

// ---- nested (Code City districts) ----

export function placeNested(root: LDir, g: GeoOptions, m: Map<string, Measured>): LayoutNode[] {
  // Items of a district: its file grid (if it has slots) followed by its child districts.
  const blocks = new Map<string, { w: number; h: number; pack: Packing; hasFiles: boolean }>();
  const size = (d: LDir): Box => {
    const me = m.get(d.id)!;
    const hasFiles = d.slots.length > 0;
    const items: Box[] = [];
    if (hasFiles) items.push({ w: me.cols * g.cell, h: me.rows * g.cell });
    for (const c of d.dirs) items.push(size(c));
    const frame = (w: number, h: number) => ({ w: Math.max(w, g.cell) + 2 * g.pad, h: Math.max(h, g.cell) + 2 * g.pad });
    const pack = squarest(items, g.hgap, g.hgap, frame);
    const o = frame(pack.w, pack.h);
    blocks.set(d.id, { ...o, pack, hasFiles });
    return o;
  };
  size(root);
  const nodes: LayoutNode[] = [];
  const rec = (d: LDir, x: number, y: number, parent: string | null) => {
    const me = m.get(d.id)!;
    const b = blocks.get(d.id)!;
    nodes.push({ id: d.id, kind: 'dir', path: d.path, parent, x, y, w: b.w, h: b.h, ghost: d.ghost || undefined });
    const ix = x + g.pad, iy = y + g.pad;
    let k = 0;
    if (b.hasFiles) {
      pushFiles(nodes, d, me, g, ix + b.pack.x[0], iy + b.pack.y[0], !!d.ghost);
      k = 1;
    }
    d.dirs.forEach((c, i) => rec(c, ix + b.pack.x[k + i], iy + b.pack.y[k + i], d.id));
  };
  rec(root, 0, 0, null);
  return nodes;
}

// ---- radial ----

export function placeRadial(root: LDir, g: GeoOptions, m: Map<string, Measured>): LayoutNode[] {
  // 1. TreeV band centres -> angles. The full circle is the root's band (alloc), so slack a
  //    strategy reserved at the root is an empty wedge rather than a rotation of everything.
  const total = m.get(root.id)!.alloc;
  const angle = new Map<string, number>();
  const depth = new Map<string, number>();
  const byDepth: LDir[][] = [];
  const bands = (d: LDir, x: number, dep: number) => {
    const me = m.get(d.id)!;
    angle.set(d.id, (2 * Math.PI * (x + me.alloc / 2)) / total - Math.PI / 2);
    depth.set(d.id, dep);
    (byDepth[dep] ??= []).push(d);
    let cx = g.align === 'center' ? x + (me.alloc - me.childrenW) / 2 : x;
    for (const c of d.dirs) {
      bands(c, cx, dep + 1);
      cx += m.get(c.id)!.alloc + g.hgap;
    }
  };
  bands(root, 0, 0);

  // 2. One ring per depth. Every platform lies inside its circumscribed circle (radius R), so
  //    rings at least R_prev + R + vgap apart cannot touch, and on a ring two platforms are
  //    clear when the chord between their centres is >= R_i + R_j + hgap.
  const circ = (d: LDir) => {
    const me = m.get(d.id)!;
    return Math.hypot(me.pw, me.ph) / 2;
  };
  const radius = [0];
  let prevMax = circ(root);
  for (let dep = 1; dep < byDepth.length; dep++) {
    const ring = byDepth[dep].map((d) => ({ a: norm(angle.get(d.id)!), R: circ(d) })).sort((p, q) => p.a - q.a);
    const maxR = Math.max(...ring.map((p) => p.R));
    let r = radius[dep - 1] + prevMax + maxR + g.vgap;
    const need = (i: number, j: number) => {
      let da = Math.abs(ring[j].a - ring[i].a);
      if (da > Math.PI) da = 2 * Math.PI - da;
      const s = 2 * Math.sin(da / 2);
      return s > E ? (ring[i].R + ring[j].R + g.hgap) / s : Infinity;
    };
    // Raise r until no pair conflicts. A pair can only conflict while their angular distance
    // is below the angle at which even the two biggest platforms clear at radius r.
    for (let changed = true; changed; ) {
      changed = false;
      const reach = 2 * Math.asin(Math.min(1, (2 * maxR + g.hgap) / (2 * r)));
      for (let i = 0; i < ring.length; i++)
        for (let k = 1; k < ring.length; k++) {
          const j = (i + k) % ring.length;
          let da = ring[j].a - ring[i].a;
          if (da < 0) da += 2 * Math.PI;
          // Sorted by angle, so every later j is further on; a close pair across the wrap is
          // found from the other end's forward scan.
          if (da > reach + E) break;
          const q = need(i, j);
          if (q > r + E) {
            r = q;
            changed = true;
          }
        }
    }
    radius.push(Math.ceil(r / g.cell) * g.cell); // whole cells: fewer tiny radial jitters
    prevMax = maxR;
  }

  // 3. Platforms centred on their ring at their angle; files in the usual grid.
  const nodes: LayoutNode[] = [];
  const rec = (d: LDir, parent: string | null) => {
    const me = m.get(d.id)!;
    const r = radius[depth.get(d.id)!];
    const a = angle.get(d.id)!;
    const x = r * Math.cos(a) - me.pw / 2, y = r * Math.sin(a) - me.ph / 2;
    nodes.push({ id: d.id, kind: 'dir', path: d.path, parent, x, y, w: me.pw, h: me.ph, ghost: d.ghost || undefined });
    pushFiles(nodes, d, me, g, x + g.pad, y + g.pad, !!d.ghost);
    for (const c of d.dirs) rec(c, d.id);
  };
  rec(root, null);
  return nodes;
}

function norm(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

// ---- spiral ----

/**
 * Each directory's platform sits in the middle of its block, and its children's blocks coil
 * around it counter-clockwise in strips: along the bottom left to right, up the right side,
 * along the top right to left, down the left side, then the next turn outside the last. A
 * strip ends when the next block would pass the current box's side (a strip always takes at
 * least one block), so blocks stay in the strategy's order and the box grows about evenly in
 * both directions. Recursive: every subtree is itself a spiral.
 */
export function placeSpiral(root: LDir, g: GeoOptions, m: Map<string, Measured>): LayoutNode[] {
  interface Blk {
    w: number;
    h: number;
    px: number; // platform offset inside the block
    py: number;
    kx: number[]; // child block offsets inside the block
    ky: number[];
  }
  const blocks = new Map<string, Blk>();
  const gap = g.vgap, hg = g.hgap;
  const size = (d: LDir): Blk => {
    const me = m.get(d.id)!;
    const kids = d.dirs.map(size);
    let x0 = 0, y0 = 0, x1 = me.pw, y1 = me.ph;
    const kx: number[] = [], ky: number[] = [];
    let side = 0, i = 0;
    while (i < kids.length) {
      const bx0 = x0, by0 = y0, bx1 = x1, by1 = y1;
      let cur = side === 0 ? bx0 : side === 1 ? by1 : side === 2 ? bx1 : by0;
      for (let first = true; i < kids.length; first = false, i++) {
        const k = kids[i];
        let x: number, y: number;
        if (side === 0) {
          if (!first && cur + k.w > bx1 + E) break;
          x = cur; y = by1 + gap; cur += k.w + hg;
        } else if (side === 1) {
          if (!first && cur - k.h < by0 - E) break;
          x = bx1 + gap; y = cur - k.h; cur -= k.h + hg;
        } else if (side === 2) {
          if (!first && cur - k.w < bx0 - E) break;
          x = cur - k.w; y = by0 - gap - k.h; cur -= k.w + hg;
        } else {
          if (!first && cur + k.h > by1 + E) break;
          x = bx0 - gap - k.w; y = cur; cur += k.h + hg;
        }
        kx.push(x);
        ky.push(y);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + k.w); y1 = Math.max(y1, y + k.h);
      }
      side = (side + 1) % 4;
    }
    const b: Blk = { w: x1 - x0, h: y1 - y0, px: -x0, py: -y0, kx: kx.map((v) => v - x0), ky: ky.map((v) => v - y0) };
    blocks.set(d.id, b);
    return b;
  };
  size(root);
  const nodes: LayoutNode[] = [];
  // Wires follow the coil: the first child hangs off its parent, every later child off the
  // sibling before it (Frame.wires = 'chain', LayoutNode.link).
  const rec = (d: LDir, ox: number, oy: number, parent: string | null, link?: string) => {
    const me = m.get(d.id)!;
    const b = blocks.get(d.id)!;
    const x = ox + b.px, y = oy + b.py;
    nodes.push({ id: d.id, kind: 'dir', path: d.path, parent, x, y, w: me.pw, h: me.ph, ghost: d.ghost || undefined, link });
    pushFiles(nodes, d, me, g, x + g.pad, y + g.pad, !!d.ghost);
    d.dirs.forEach((c, i) => rec(c, ox + b.kx[i], oy + b.ky[i], d.id, i > 0 ? d.dirs[i - 1].id : undefined));
  };
  rec(root, 0, 0, null);
  return nodes;
}
