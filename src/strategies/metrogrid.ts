// Metro variants on looser grids: the same idea as `metro` (a city grown from a pinned centre,
// every push pointing away from it, nothing ever re-packed), but with grids whose seams are
// local instead of running across a whole district. Four variants:
//
//   metro-seams  columns keep a shared width, but each column stacks its own cells with their
//                own heights (masonry). A tall district only pushes its own column down.
//   metro-hex    rows keep a shared height, each row lines up its own cells with their own
//                widths, odd rows staggered by half a cell (brick bond = hex topology: six
//                neighbours). Children fill hex rings instead of square shells.
//   metro-warp   Townscaper-style irregular grid: every cell keeps its grid neighbours but has
//                its own size; a cell sits just after its left and upper neighbours, so seams
//                bend locally around big cells instead of running straight across.
//   metro-pack   no grid: a new child goes to the free spot (next to the lot or an earlier
//                child) that keeps its district smallest and squarest, skyline-style. When a
//                block grows into a neighbour, the neighbour is shoved outward by the overlap.
//
// Shared rules (all four):
// - Every district is laid out in local coordinates growing +x/+y from its file lot at (0, 0);
//   the frame mirrors it to face away from the centre. Positions are ratchets: a cell or block
//   only ever moves further from its lot, never back. Holes from deletions are reused.
// - The root is a pinwheel: its lot is pinned at the origin and four arms run off its sides
//   (right arm grows down, bottom arm grows left, left arm grows up, top arm grows right), so the
//   arms never meet however big they get. A new top-level directory joins the arm that keeps the
//   whole city smallest and squarest, and its whole subtree faces that arm's way.
// - File lots are city's (slots kept, holes reused, ceil(sqrt) columns that only widen).
// Never looks at the future; all state changes happen in step().

import { defaultsOf, type Strategy } from '../engine.ts';
import { cmp, groupTree } from '../model/tree.ts';
import type { LayoutNode, TreeState } from '../types.ts';
import { depth, geoOf, lotSize, schema, shellCell, syncSlots, type Geo, type Lot } from './city.ts';

export type Variant = 'seams' | 'hex' | 'warp' | 'pack';

interface Pt {
  x: number;
  y: number;
}
interface Size {
  w: number;
  h: number;
}
interface Rect extends Pt, Size {}

/** One district's child grid (a non-root district, or one arm of the root pinwheel). */
interface Grid {
  lot: boolean; // cell 0 / (0, 0) holds the district's file lot
  kids: Map<string, number>; // child path -> cell index (pack: -1)
  pos: Map<string, Pt>; // pack: child path -> anchor; cell variants: `#<cell>` -> anchor (ratchets)
  cw: Map<number, number>; // cell variants: per-cell width ratchet (cell index -> width)
  ch: Map<number, number>; // per-cell height ratchet
  ext: Size; // extent of lot + children after the last layout (local units)
}

interface MDir extends Lot {
  grid: Grid | null; // non-root
  arms: Grid[] | null; // root only: right, bottom, left, top
  armOf: Map<string, number> | null; // root only: top-level dir -> arm
  size: Size; // block size (non-root), set in step
}

export interface MetroGridState {
  dirs: Map<string, MDir>;
}

const EPS = 1e-9;
/** Arm orientations (pinwheel): right grows down, bottom grows left, left grows up, top grows right. */
const ARM_O: Pt[] = [{ x: 1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: -1 }];
/** Arm anchors around a root lot of size (lw, lh) with gap g. */
const armAnchor = (a: number, lw: number, lh: number, g: number): Pt =>
  [{ x: lw + g, y: 0 }, { x: lw, y: lh + g }, { x: -g, y: lh }, { x: 0, y: -g }][a];

const newGrid = (lot: boolean): Grid => ({ lot, kids: new Map(), pos: new Map(), cw: new Map(), ch: new Map(), ext: { w: 0, h: 0 } });

// ---- cell orders ----

/** Hex rings in one quadrant: odd rows are shifted right by half a cell ("odd-r" offset). */
const hexOrder: [number, number][] = [];
function hexCell(k: number): [number, number] {
  if (k >= hexOrder.length) {
    const R = Math.max(8, Math.ceil(Math.sqrt(2 * (k + 1))) + 4);
    const all: [number, number, number][] = [];
    for (let r = 0; r <= 2 * R; r++)
      for (let c = 0; c <= 2 * R; c++) {
        const q = c - (r - (r & 1)) / 2;
        all.push([c, r, (Math.abs(q) + Math.abs(q + r) + r) / 2]);
      }
    all.sort((a, b) => a[2] - b[2] || a[1] - a[0] - (b[1] - b[0]) || a[1] - b[1]);
    hexOrder.length = 0;
    for (const [c, r, d] of all) if (d <= R) hexOrder.push([c, r]);
  }
  return hexOrder[k];
}
const cellRC = (v: Variant, k: number): [number, number] => (v === 'hex' ? hexCell(k) : shellCell(k));

// ---- geometry helpers ----

const hits = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap - EPS && b.x < a.x + a.w + gap - EPS && a.y < b.y + b.h + gap - EPS && b.y < a.y + a.h + gap - EPS;

/** Shove r outward (+x or +y, whichever is shorter) until it clears every settled rect. */
function shove(r: Rect, settled: Rect[], gap: number): void {
  for (let guard = 0; guard <= settled.length * 2 + 2; guard++) {
    const s = settled.find((o) => hits(r, o, gap));
    if (!s) return;
    const dx = s.x + s.w + gap - r.x;
    const dy = s.y + s.h + gap - r.y;
    if (dx <= dy) r.x += dx;
    else r.y += dy;
  }
  throw new Error('metrogrid: shove did not converge');
}

const extentOf = (rects: Rect[]): Size => ({
  w: rects.reduce((m, r) => Math.max(m, r.x + r.w), 0),
  h: rects.reduce((m, r) => Math.max(m, r.y + r.h), 0),
});

/** First free cell index (cell 0 is the lot when the grid has one). */
function freeCell(gr: Grid): number {
  const used = new Set(gr.kids.values());
  let c = gr.lot ? 1 : 0;
  while (used.has(c)) c++;
  return c;
}

/** Pack: the free spot for a w×h block that keeps the grid smallest, then squarest. */
function packSpot(gr: Grid, lot: Size | null, size: (p: string) => Size, w: number, h: number, gap: number): Pt {
  const obs: Rect[] = [];
  if (lot) obs.push({ x: 0, y: 0, ...lot });
  for (const [k] of gr.kids) obs.push({ ...gr.pos.get(k)!, ...size(k) });
  const ext = extentOf(obs);
  const xs = [0, ...obs.map((o) => o.x + o.w + gap)];
  const ys = [0, ...obs.map((o) => o.y + o.h + gap)];
  let best: Pt = { x: 0, y: ext.h + (obs.length ? gap : 0) };
  let bestKey: number[] | null = null;
  for (const x of xs)
    for (const y of ys) {
      const r = { x, y, w, h };
      if (obs.some((o) => hits(r, o, gap))) continue;
      const nw = Math.max(ext.w, x + w), nh = Math.max(ext.h, y + h);
      const key = [Math.max(nw, nh), nw * nh, x + y, y, x];
      if (!bestKey || less(key, bestKey)) (bestKey = key), (best = { x, y });
    }
  return best;
}
const less = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i];
  return false;
};

/**
 * Lay out one grid in place: settle every child's anchor (ratchets: only ever outward) and
 * record the extent. `lot` is the district's file lot at (0, 0), or null for a root arm.
 */
function layoutGrid(gr: Grid, v: Variant, lot: Size | null, size: (p: string) => Size, gap: number): void {
  if (v === 'pack') {
    const settled: Rect[] = lot ? [{ x: 0, y: 0, ...lot }] : [];
    const order = [...gr.kids.keys()].sort((a, b) => {
      const pa = gr.pos.get(a)!, pb = gr.pos.get(b)!;
      return pa.x + pa.y - (pb.x + pb.y) || pa.y - pb.y || cmp(a, b);
    });
    for (const k of order) {
      const r = { ...gr.pos.get(k)!, ...size(k) };
      shove(r, settled, gap);
      gr.pos.set(k, { x: r.x, y: r.y });
      settled.push(r);
    }
    gr.ext = extentOf(settled);
    return;
  }
  // Cell variants: ratchet each cell's size, then place every cell that has ever been used.
  const bump = (cell: number, s: Size) => {
    gr.cw.set(cell, Math.max(gr.cw.get(cell) ?? 0, s.w));
    gr.ch.set(cell, Math.max(gr.ch.get(cell) ?? 0, s.h));
  };
  if (lot) bump(0, lot);
  for (const [k, cell] of gr.kids) bump(cell, size(k));
  const known = [...gr.cw.keys()].sort((a, b) => a - b);
  const at = new Map<string, number>(); // "c,r" -> cell index
  for (const cell of known) at.set(cellRC(v, cell).join(), cell);
  const W = (c: number, r: number) => gr.cw.get(at.get(`${c},${r}`) ?? -1) ?? 0;
  const H = (c: number, r: number) => gr.ch.get(at.get(`${c},${r}`) ?? -1) ?? 0;
  const want = new Map<number, Pt>();
  if (v === 'seams') {
    const colW: number[] = [];
    for (const cell of known) {
      const [c] = cellRC(v, cell);
      colW[c] = Math.max(colW[c] ?? 0, gr.cw.get(cell)!);
    }
    const colX: number[] = [];
    for (let c = 0, x = 0; c < colW.length; c++) (colX[c] = x), (x += (colW[c] ?? 0) + gap);
    for (const cell of known) {
      const [c, r] = cellRC(v, cell);
      let y = 0;
      for (let i = 0; i < r; i++) y += H(c, i) + gap;
      want.set(cell, { x: colX[c], y });
    }
  } else if (v === 'hex') {
    const rowH: number[] = [];
    for (const cell of known) {
      const [, r] = cellRC(v, cell);
      rowH[r] = Math.max(rowH[r] ?? 0, gr.ch.get(cell)!);
    }
    const rowY: number[] = [];
    for (let r = 0, y = 0; r < rowH.length; r++) (rowY[r] = y), (y += (rowH[r] ?? 0) + gap);
    for (const cell of known) {
      const [c, r] = cellRC(v, cell);
      let x = r & 1 ? (W(0, r - 1) + gap) / 2 : 0; // brick bond: odd rows start half a cell in
      for (let i = 0; i < c; i++) x += W(i, r) + gap;
      want.set(cell, { x, y: rowY[r] });
    }
  } else {
    // warp: each cell sits after its left and upper neighbours, then is shoved clear of
    // anything nearer the lot. Anti-diagonal order, so both neighbours are already placed.
    const order = known.map((cell) => [cell, ...cellRC(v, cell)]).sort((a, b) => a[1] + a[2] - (b[1] + b[2]) || a[1] - b[1]);
    const settled: Rect[] = [];
    for (const [cell, c, r] of order) {
      const left = at.get(`${c - 1},${r}`), up = at.get(`${c},${r - 1}`);
      const lp = left !== undefined ? want.get(left) : undefined;
      const upp = up !== undefined ? want.get(up) : undefined;
      const prev = gr.pos.get(`#${cell}`) ?? { x: 0, y: 0 };
      const rect = {
        x: Math.max(prev.x, lp ? lp.x + gr.cw.get(left!)! + gap : 0),
        y: Math.max(prev.y, upp ? upp.y + gr.ch.get(up!)! + gap : 0),
        w: gr.cw.get(cell)!,
        h: gr.ch.get(cell)!,
      };
      shove(rect, settled, gap);
      settled.push(rect);
      want.set(cell, { x: rect.x, y: rect.y });
    }
  }
  const rects: Rect[] = [];
  for (const cell of known) {
    const prev = gr.pos.get(`#${cell}`);
    const w = want.get(cell)!;
    const p = prev ? { x: Math.max(prev.x, w.x), y: Math.max(prev.y, w.y) } : w;
    gr.pos.set(`#${cell}`, p);
  }
  if (lot) rects.push({ x: 0, y: 0, ...lot });
  for (const [k, cell] of gr.kids) rects.push({ ...gr.pos.get(`#${cell}`)!, ...size(k) });
  gr.ext = extentOf(rects);
}

/** Where a child's block anchor sits in its parent grid's local frame. */
const anchorOf = (gr: Grid, k: string): Pt => (gr.kids.get(k)! < 0 ? gr.pos.get(k)! : gr.pos.get(`#${gr.kids.get(k)}`)!);

/** Add a new child to a grid (cell variants: earliest free cell; pack: best free spot). */
function addKid(gr: Grid, v: Variant, k: string, lot: Size | null, size: (p: string) => Size, gap: number): void {
  if (v === 'pack') {
    const s = size(k);
    gr.pos.set(k, packSpot(gr, lot, size, s.w, s.h, gap));
    gr.kids.set(k, -1);
  } else gr.kids.set(k, freeCell(gr));
}

/** Global bounding box of the root: lot at the origin plus each arm's extent. */
function rootBox(lot: Size, arms: Grid[], g: number): Rect {
  let x0 = 0, y0 = 0, x1 = lot.w, y1 = lot.h;
  arms.forEach((a, i) => {
    if (!a.kids.size) return;
    const A = armAnchor(i, lot.w, lot.h, g), o = ARM_O[i];
    const ex = A.x + o.x * a.ext.w, ey = A.y + o.y * a.ext.h;
    x0 = Math.min(x0, A.x, ex), x1 = Math.max(x1, A.x, ex);
    y0 = Math.min(y0, A.y, ey), y1 = Math.max(y1, A.y, ey);
  });
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function makeMetroGrid(v: Variant, name: string, description: string): Strategy<MetroGridState> {
  return {
    name,
    description,
    usesFuture: false,
    schema,
    defaults: defaultsOf(schema),
    wires: 'none',
    init: () => ({ dirs: new Map() }),

    step(s, tree: TreeState, _c, _delta, ctx) {
      const g: Geo = geoOf(ctx.options);
      const gap = g.hgap;
      const { dirKids, fileKids } = groupTree(tree);
      const live = new Set(tree.dirs.keys());
      for (const p of [...s.dirs.keys()]) if (!live.has(p)) s.dirs.delete(p);
      const size = (p: string) => s.dirs.get(p)!.size;
      const arrival = (a: string, b: string) => tree.dirs.get(a)!.arrived - tree.dirs.get(b)!.arrived || cmp(a, b);
      // Deepest first, so every child's block size is known before its parent is laid out.
      const paths = [...live].sort((a, b) => depth(b) - depth(a) || cmp(a, b));
      for (const p of paths) {
        let d = s.dirs.get(p);
        if (!d) {
          d = { slots: [], pcols: 1, grid: p === '' ? null : newGrid(true), arms: p === '' ? [0, 1, 2, 3].map(() => newGrid(false)) : null, armOf: p === '' ? new Map() : null, size: { w: 0, h: 0 } };
          s.dirs.set(p, d);
        }
        syncSlots(d, fileKids.get(p) ?? []);
        const lot = lotSize(d, g);
        const kids = dirKids.get(p) ?? [];
        const kidSet = new Set(kids);
        if (d.grid) {
          const gr = d.grid;
          for (const k of [...gr.kids.keys()]) if (!kidSet.has(k)) gr.kids.delete(k), gr.pos.delete(k);
          layoutGrid(gr, v, lot, size, gap); // settle existing children first
          for (const k of kids.filter((k) => !gr.kids.has(k)).sort(arrival)) addKid(gr, v, k, lot, size, gap);
          layoutGrid(gr, v, lot, size, gap);
          d.size = { w: gr.ext.w + 2 * g.pad, h: gr.ext.h + 2 * g.pad };
        } else {
          const arms = d.arms!, armOf = d.armOf!;
          for (const [k, a] of [...armOf]) if (!kidSet.has(k)) armOf.delete(k), arms[a].kids.delete(k), arms[a].pos.delete(k);
          for (const a of arms) layoutGrid(a, v, null, size, gap);
          for (const k of kids.filter((k) => !armOf.has(k)).sort(arrival)) {
            // Try the newcomer on each arm; keep the one that leaves the city smallest, then squarest.
            let best = -1, bestKey: number[] = [], bestArm: Grid | null = null;
            for (let i = 0; i < 4; i++) {
              const trial = structuredClone(arms[i]);
              addKid(trial, v, k, null, size, gap);
              layoutGrid(trial, v, null, size, gap);
              const box = rootBox(lot, arms.map((a, j) => (j === i ? trial : a)), gap);
              const key = [Math.max(box.w, box.h), box.w * box.h, i];
              if (best < 0 || less(key, bestKey)) (best = i), (bestKey = key), (bestArm = trial);
            }
            arms[best] = bestArm!;
            armOf.set(k, best);
          }
        }
      }
    },

    frame(s, tree, _c, ctx): LayoutNode[] {
      const g = geoOf(ctx.options);
      const { fileKids } = groupTree(tree);
      const nodes: LayoutNode[] = [];
      const box = g.cell * 0.8, inset = (g.cell - box) / 2;
      // Files of a lot whose corner nearest the centre is (lx, ly), filling in direction o.
      const files = (p: string, d: MDir, lx: number, ly: number, o: Pt) => {
        const byId = new Map((fileKids.get(p) ?? []).map((f) => [f.id, f]));
        d.slots.forEach((id, i) => {
          if (id === null) return;
          const f = byId.get(id)!;
          const c = i % d.pcols, r = Math.floor(i / d.pcols);
          nodes.push({
            id: `f:${id}`,
            kind: 'file',
            path: f.path,
            parent: `d:${p}`,
            x: (o.x > 0 ? lx + c * g.cell : lx - (c + 1) * g.cell) + inset,
            y: (o.y > 0 ? ly + r * g.cell : ly - (r + 1) * g.cell) + inset,
            w: box,
            h: box,
            size: f.size,
            born: f.born,
            modified: f.modified,
          });
        });
      };
      // A district whose corner nearest the centre is (ax, ay), growing in direction o.
      const rec = (p: string, ax: number, ay: number, o: Pt, parent: string) => {
        const d = s.dirs.get(p)!;
        const { w, h } = d.size;
        nodes.push({ id: `d:${p}`, kind: 'dir', path: p, parent, x: o.x > 0 ? ax : ax - w, y: o.y > 0 ? ay : ay - h, w, h });
        const lx = ax + o.x * g.pad, ly = ay + o.y * g.pad;
        files(p, d, lx, ly, o);
        const gr = d.grid!;
        for (const k of [...gr.kids.keys()].sort(cmp)) {
          const a = anchorOf(gr, k);
          rec(k, lx + o.x * a.x, ly + o.y * a.y, o, `d:${p}`);
        }
      };
      const root = s.dirs.get('')!;
      const lot = lotSize(root, g);
      const rb = rootBox(lot, root.arms!, g.hgap);
      nodes.push({ id: 'd:', kind: 'dir', path: '', parent: null, x: rb.x - g.pad, y: rb.y - g.pad, w: rb.w + 2 * g.pad, h: rb.h + 2 * g.pad });
      files('', root, 0, 0, { x: 1, y: 1 });
      for (const k of [...root.armOf!.keys()].sort(cmp)) {
        const i = root.armOf!.get(k)!;
        const A = armAnchor(i, lot.w, lot.h, g.hgap), o = ARM_O[i];
        const a = anchorOf(root.arms![i], k);
        rec(k, A.x + o.x * a.x, A.y + o.y * a.y, o, 'd:');
      }
      return nodes;
    },
  };
}

export const metroSeams = makeMetroGrid(
  'seams',
  'metro-seams',
  'Online: metro on a masonry grid. Columns share a width but each column stacks its own cells, so a tall district only pushes its own column. Root is a four-arm pinwheel; positions only move outward.',
);
export const metroHex = makeMetroGrid(
  'hex',
  'metro-hex',
  'Online: metro on a hex (brick-bond) grid. Rows share a height, each row lines up its own cells with odd rows staggered half a cell; children fill hex rings. Positions only move outward.',
);
export const metroWarp = makeMetroGrid(
  'warp',
  'metro-warp',
  'Online: metro on a Townscaper-style irregular grid. Every cell keeps its grid neighbours but has its own size, so seams bend around big cells instead of running straight across. Positions only move outward.',
);
export const metroPack = makeMetroGrid(
  'pack',
  'metro-pack',
  'Online: metro without a grid. A new directory takes the free spot that keeps its district smallest and squarest (skyline packing); a growing block shoves its neighbours outward. Positions only move outward.',
);
