// "city": online, stateful. A stretchable nested grid: blocks never move across the city,
// space expands around them.
//
// Every directory is a district laid out on its own small grid of columns and rows. Cell 0
// holds the directory's own file lot (its file grid); each child directory gets the next free
// cell in square-shell order around it:
//
//    0 1 4 9        cell k sits on shell s = floor(sqrt(k)): first down column s,
//    3 2 5 .        then back along row s, so the grid grows about square
//    8 7 6 .
//
// Column widths and row heights are ratchets: each is the widest/tallest thing it has ever
// held, and never shrinks. So a growing block widens its column and everything beyond that
// seam slides outward by exactly the growth; nothing is ever re-packed. A district's size is
// the sum of its columns/rows, so growth propagates up the same way. The root is pinned at the
// origin and every move points away from it.
//
// Deletions leave holes: a deleted file frees its slot in the lot, a vanished directory frees
// its cell, and the column/row keep their size. New files take the earliest free slot, new
// directories the earliest free cell (in shell order), else the next one. File lots grow their
// column count (ceil(sqrt(slots))) and never shrink it.
//
// Arrangement options do not apply: the city is its own arrangement (nested districts, no
// wires). Never looks at the future.

import { defaultsOf, type Strategy } from '../engine.ts';
import { geoSchema } from '../geometry/treev.ts';
import { cmp, dirname, groupTree } from '../model/tree.ts';
import type { FileEntry, LayoutNode, OptionSchema, TreeState } from '../types.ts';
import { newWarp, polyBox, warpPoly, warpStep, type Mesh, type WarpState } from '../geometry/warp.ts';
import { newSqueeze, squeezeFrame, squeezeStep, type Anchor, type SqueezeMode, type SqueezeState } from './squeeze.ts';

/** A directory's file lot: slots keep their position; holes are reused, earliest first. */
export interface Lot {
  slots: (number | null)[]; // file id per lot slot, null = free
  pcols: number; // lot columns (ratchet)
}

/** Gone files free their slot, new ones take the earliest free slot; columns = ceil(sqrt(slots)), never shrink. */
export function syncSlots(d: Lot, files: FileEntry[]): void {
  const ids = new Set(files.map((f) => f.id));
  const have = new Set<number>();
  d.slots = d.slots.map((x) => (x !== null && ids.has(x) ? (have.add(x), x) : null));
  const arrivals = files.filter((f) => !have.has(f.id)).sort((a: FileEntry, b: FileEntry) => a.arrived - b.arrived || cmp(a.path, b.path));
  let j = 0;
  for (const f of arrivals) {
    while (j < d.slots.length && d.slots[j] !== null) j++;
    if (j < d.slots.length) d.slots[j] = f.id;
    else d.slots.push(f.id);
  }
  d.pcols = Math.max(d.pcols, Math.ceil(Math.sqrt(Math.max(1, d.slots.length))));
}

interface CDir {
  slots: (number | null)[]; // file id per lot slot, null = free
  pcols: number; // lot columns (ratchet)
  cells: Map<string, number>; // child dir path -> cell index (>= 1)
  colP: number[]; // ratchets (layout units): columns 0, 1, 2, ...
  colN: number[]; // columns -1, -2, ... (metro only)
  rowP: number[];
  rowN: number[];
}

export interface CityState {
  dirs: Map<string, CDir>; // live directories only
  sq: SqueezeState; // squeeze pass (empty unless squeeze=pack|slide)
  warp: WarpState; // organic warp mesh (empty unless squeeze=organic)
  mesh: Mesh | null; // this commit's warp mesh
}

/** Cell index -> [col, row] in square-shell order (city: grows right and down). */
export function shellCell(k: number): [number, number] {
  const s = Math.floor(Math.sqrt(k));
  const t = k - s * s;
  return t <= s ? [s, t] : [2 * s - t, s];
}

/** Cell index -> [col, row] on a square spiral around (0, 0) (metro: grows in every direction). */
const spiral: [number, number][] = [];
export function spiralCell(k: number): [number, number] {
  if (k >= spiral.length) {
    // walk right 1, down 1, left 2, up 2, right 3, down 3, ... (y grows downward)
    const steps = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const want = Math.max(k + 1, 2 * spiral.length, 64);
    spiral.length = 0;
    spiral.push([0, 0]);
    let x = 0, y = 0, d = 0;
    for (let len = 1; spiral.length < want; len++)
      for (let rep = 0; rep < 2; rep++, d = (d + 1) % 4)
        for (let i = 0; i < len; i++) {
          x += steps[d][0];
          y += steps[d][1];
          spiral.push([x, y]);
        }
  }
  return spiral[k];
}

export interface Geo {
  cell: number;
  pad: number;
  hgap: number;
}
export const geoOf = (o: Record<string, unknown>): Geo => ({ cell: Number(o.cell), pad: Number(o.pad), hgap: Number(o.hgap) });

export const lotSize = (d: Lot, g: Geo) => {
  const n = Math.max(1, d.slots.length);
  return { w: d.pcols * g.cell, h: Math.ceil(n / d.pcols) * g.cell };
};
const span = (a: number[], b: number[], gap: number) =>
  a.reduce((s, v) => s + v, 0) + b.reduce((s, v) => s + v, 0) + gap * Math.max(0, a.length + b.length - 1);
const blockSize = (d: CDir, g: Geo) => ({ w: span(d.colP, d.colN, g.hgap) + 2 * g.pad, h: span(d.rowP, d.rowN, g.hgap) + 2 * g.pad });
/** Offset from a block's top-left corner to its lot cell (column 0, row 0). */
const lotOffset = (d: CDir, g: Geo) => ({
  x: g.pad + d.colN.reduce((s, v) => s + v + g.hgap, 0),
  y: g.pad + d.rowN.reduce((s, v) => s + v + g.hgap, 0),
});

const geo = geoSchema();
export const schema: OptionSchema = { cell: geo.cell, pad: geo.pad, hgap: { ...geo.hgap, doc: 'gap between columns and rows of a district' } };
/** city / metro: the grid schema plus the optional squeeze pass (see squeeze.ts). */
const citySchema: OptionSchema = {
  ...schema,
  squeeze: { type: 'enum', default: 'none', values: ['none', 'pack', 'slide', 'organic'], doc: 'compaction pass after placement: pack / slide move districts toward their parent lot (axis slides / straight at it); organic warps the plane with a Townscaper-style mesh whose empty cells shrink' },
  squeezeRate: { type: 'number', default: 1, min: 0, doc: 'squeeze: max move per commit in layout units (pack/slide: a district; organic: a mesh vertex); 0 = all at once' },
  warpCell: { type: 'number', default: 4, min: 1, doc: 'organic: mesh spacing (layout units)' },
  warpMin: { type: 'number', default: 0.3, min: 0.05, max: 1, doc: 'organic: target size of an empty mesh cell (1 = no squeeze)' },
};

/** Where child cell k of directory `path` goes, as [col, row] (negative = left/up of the lot). */
type CellFn = (s: CityState, path: string, k: number) => [number, number];
/** Which way a district grows: +1 = right/down, -1 = left/up. */
type OrientFn = (s: CityState, path: string) => { x: number; y: number };

function makeCity(name: string, description: string, cellOf: CellFn, orient: OrientFn): Strategy<CityState> {
  return {
    name,
    description,
    usesFuture: false,
    schema: citySchema,
    defaults: defaultsOf(citySchema),
    wires: 'none',
    init: () => ({ dirs: new Map(), sq: newSqueeze(), warp: newWarp(), mesh: null }),

    step(s, tree, _c, _delta, ctx) {
      const { dirKids, fileKids } = groupTree(tree);
      const live = [...tree.dirs.keys()].sort(cmp); // parents before children
      const liveSet = new Set(live);
      // 1. Vanished directories drop their state; the parent's cell becomes free.
      for (const p of [...s.dirs.keys()]) if (!liveSet.has(p)) s.dirs.delete(p);
      for (const p of live) {
        let d = s.dirs.get(p);
        if (!d) {
          d = { slots: [], pcols: 1, cells: new Map(), colP: [], colN: [], rowP: [], rowN: [] };
          s.dirs.set(p, d);
        }
        // 2. File slots: gone files free their slot, new ones take the earliest free slot.
        syncSlots(d, fileKids.get(p) ?? []);
        // 3. Child cells: vanished children free theirs, new ones take the earliest free cell.
        const kids = dirKids.get(p) ?? [];
        const kidSet = new Set(kids);
        for (const k of [...d.cells.keys()]) if (!kidSet.has(k)) d.cells.delete(k);
        const used = new Set(d.cells.values());
        let c = 1;
        for (const k of kids.filter((k) => !d!.cells.has(k)).sort((a, b) => tree.dirs.get(a)!.arrived - tree.dirs.get(b)!.arrived || cmp(a, b))) {
          while (used.has(c)) c++;
          d.cells.set(k, c);
          used.add(c);
        }
      }
      // 4. Ratchet column widths / row heights, deepest directories first.
      const g = geoOf(ctx.options);
      ratchet(s, g, cellOf);
      // 5. Optional squeeze pass on top of the placement.
      const mode = ctx.options.squeeze as SqueezeMode;
      if (mode === 'pack' || mode === 'slide') {
        const { nodes, anchors } = place(s, tree, g);
        squeezeStep(s.sq, nodes, anchors, mode, Number(ctx.options.squeezeRate), g.hgap, g.pad);
      } else if (mode === 'organic') {
        const { nodes } = place(s, tree, g);
        const files = nodes.filter((n) => n.kind === 'file');
        s.mesh = warpStep(s.warp, bboxOf(nodes), files, { s: Number(ctx.options.warpCell), min: Number(ctx.options.warpMin), rate: Number(ctx.options.squeezeRate) });
      }
    },

    frame(s, tree, _c, ctx): LayoutNode[] {
      const { nodes, anchors } = place(s, tree, geoOf(ctx.options));
      const mode = ctx.options.squeeze;
      if (mode === 'pack' || mode === 'slide') return squeezeFrame(s.sq, nodes, anchors);
      if (mode === 'organic' && s.mesh) {
        const m = s.mesh;
        return nodes.map((n) => {
          const b = n.kind === 'file' ? quadBox(m, n) : polyBox(warpPoly(m, n.x, n.y, n.w, n.h));
          return { ...n, base: [n.x, n.y, n.w, n.h], x: b.x, y: b.y, w: b.w, h: b.h };
        });
      }
      return nodes;
    },

    mesh: (s, ctx) => (ctx.options.squeeze === 'organic' ? (s.mesh ?? undefined) : undefined),
  };

  /** The grid placement (pure): every node, plus each district's lot anchor for the squeeze. */
  function place(s: CityState, tree: TreeState, g: Geo): { nodes: LayoutNode[]; anchors: Map<string, Anchor> } {
      const { fileKids } = groupTree(tree);
      const nodes: LayoutNode[] = [];
      const anchors = new Map<string, Anchor>();
      const box = g.cell * 0.8, inset = (g.cell - box) / 2;
      // Column c's left edge and width; negative columns run leftward from column 0.
      const edges = (pos: number[], neg: number[], start: number) => {
        const at = new Map<number, number>();
        let acc = start;
        for (let c = -neg.length; c < pos.length; c++) {
          at.set(c, acc);
          acc += (c < 0 ? neg[-c - 1] : pos[c]) + g.hgap;
        }
        return at;
      };
      const colWidth = (d: CDir, c: number) => (c < 0 ? d.colN[-c - 1] : d.colP[c]);
      const rowHeight = (d: CDir, r: number) => (r < 0 ? d.rowN[-r - 1] : d.rowP[r]);
      const rec = (p: string, x: number, y: number, parent: string | null) => {
        const d = s.dirs.get(p)!;
        const b = blockSize(d, g);
        const o = orient(s, p);
        nodes.push({ id: `d:${p}`, kind: 'dir', path: p, parent, x, y, w: b.w, h: b.h });
        const cx = edges(d.colP, d.colN, x + g.pad), ry = edges(d.rowP, d.rowN, y + g.pad);
        const byId = new Map((fileKids.get(p) ?? []).map((f) => [f.id, f]));
        // The lot hugs the corner of its cell facing the centre; files fill away from it.
        const lot = lotSize(d, g);
        const lx = o.x < 0 ? cx.get(0)! + d.colP[0] - lot.w : cx.get(0)!;
        const ly = o.y < 0 ? ry.get(0)! + d.rowP[0] - lot.h : ry.get(0)!;
        anchors.set(p, { x: o.x < 0 ? lx + lot.w : lx, y: o.y < 0 ? ly + lot.h : ly, o, lot });
        d.slots.forEach((id, i) => {
          if (id === null) return;
          const f = byId.get(id)!;
          nodes.push({
            id: `f:${id}`,
            kind: 'file',
            path: f.path,
            parent: `d:${p}`,
            x: (o.x < 0 ? lx + lot.w - ((i % d.pcols) + 1) * g.cell : lx + (i % d.pcols) * g.cell) + inset,
            y: (o.y < 0 ? ly + lot.h - (Math.floor(i / d.pcols) + 1) * g.cell : ly + Math.floor(i / d.pcols) * g.cell) + inset,
            w: box,
            h: box,
            size: f.size,
            born: f.born,
            modified: f.modified,
          });
        });
        // A child hugs the side of its cell nearest the lot (right/bottom in negative
        // columns/rows, and in column/row 0 of a district that grows left/up), so it only
        // moves when space opens between it and the centre.
        for (const [k, cell] of [...d.cells].sort((a, b) => a[1] - b[1])) {
          const [col, row] = cellOf(s, p, cell);
          const kb = blockSize(s.dirs.get(k)!, g);
          const kx = col < 0 || (col === 0 && o.x < 0) ? cx.get(col)! + colWidth(d, col) - kb.w : cx.get(col)!;
          const ky = row < 0 || (row === 0 && o.y < 0) ? ry.get(row)! + rowHeight(d, row) - kb.h : ry.get(row)!;
          rec(k, kx, ky, `d:${p}`);
        }
      };
      // The root's lot is pinned at the origin.
      const root = s.dirs.get('')!;
      const o = lotOffset(root, g);
      rec('', -o.x, -o.y, null);
      return { nodes, anchors };
  }
}

export const city = makeCity(
  'city',
  'Online: stretchable nested grid growing right and down. Districts keep their cell; columns/rows only widen, so blocks slide outward but never jump. Holes are reused, nothing shrinks.',
  (_s, _p, k) => shellCell(k),
  () => ({ x: 1, y: 1 }),
);

export const metro = makeCity(
  'metro',
  'Online: city grown from the centre. Each district keeps its cell on a square spiral around its file lot; columns/rows only widen, pushing everything beyond them away from the centre.',
  metroCell,
  metroOrient,
);

/**
 * metro: the root spirals in all four directions; every other district is a city mirrored to
 * face away from the centre. Its orientation comes from the cell it sits in (left of its
 * parent's lot -> grows left, above -> grows up; in the lot's own column/row it inherits the
 * parent's direction). Cells never change, so neither does a district's orientation.
 */
function metroCell(s: CityState, path: string, k: number): [number, number] {
  return mirrored(path, k, metroOrient(s, path));
}
function mirrored(path: string, k: number, o: { x: number; y: number }): [number, number] {
  if (path === '') return spiralCell(k);
  const [c, r] = shellCell(k);
  return [o.x * c, o.y * r];
}
/** One walk up the ancestors (O(depth)): each level's cell is mirrored by the level above. */
function metroOrient(s: CityState, path: string): { x: number; y: number } {
  if (path === '') return { x: 1, y: 1 };
  const parent = dirname(path);
  const po = metroOrient(s, parent);
  const [c, r] = mirrored(parent, s.dirs.get(parent)!.cells.get(path)!, po);
  return { x: c ? Math.sign(c) : po.x, y: r ? Math.sign(r) : po.y };
}

/** Step 4 of step(): widen columns/rows to fit their contents (never shrink). */
export function ratchet(s: CityState, g: Geo, cellOf: CellFn): void {
  const paths = [...s.dirs.keys()].sort((a, b) => depth(b) - depth(a) || cmp(a, b));
  const grow = (pos: number[], neg: number[], i: number, v: number) => {
    const a = i < 0 ? neg : pos;
    const j = i < 0 ? -i - 1 : i;
    while (a.length <= j) a.push(0);
    if (v > a[j]) a[j] = v;
  };
  for (const p of paths) {
    const d = s.dirs.get(p)!;
    const fit = (cell: number, w: number, h: number) => {
      const [c, r] = cellOf(s, p, cell);
      grow(d.colP, d.colN, c, w);
      grow(d.rowP, d.rowN, r, h);
    };
    const lot = lotSize(d, g);
    fit(0, lot.w, lot.h);
    for (const [k, cell] of d.cells) {
      const b = blockSize(s.dirs.get(k)!, g);
      fit(cell, b.w, b.h);
    }
  }
}

const bboxOf = (ns: LayoutNode[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) (x0 = Math.min(x0, n.x)), (y0 = Math.min(y0, n.y)), (x1 = Math.max(x1, n.x + n.w)), (y1 = Math.max(y1, n.y + n.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
/** A file (smaller than a mesh cell) mapped through the mesh: bbox of its warped polygon. */
const quadBox = (m: Mesh, n: LayoutNode) => polyBox(warpPoly(m, n.x, n.y, n.w, n.h));

export const depth = (p: string) => (p === '' ? 0 : p.split('/').length);
