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
import { cmp, groupTree } from '../model/tree.ts';
import type { FileEntry, LayoutNode, OptionSchema, TreeState } from '../types.ts';

interface CDir {
  slots: (number | null)[]; // file id per lot slot, null = free
  pcols: number; // lot columns (ratchet)
  cells: Map<string, number>; // child dir path -> cell index (>= 1)
  colW: number[]; // ratchets (layout units)
  rowH: number[];
}

export interface CityState {
  dirs: Map<string, CDir>; // live directories only
}

/** Cell index -> [col, row] in square-shell order. */
export function shellCell(k: number): [number, number] {
  const s = Math.floor(Math.sqrt(k));
  const t = k - s * s;
  return t <= s ? [s, t] : [2 * s - t, s];
}

interface Geo {
  cell: number;
  pad: number;
  hgap: number;
}
const geoOf = (o: Record<string, unknown>): Geo => ({ cell: Number(o.cell), pad: Number(o.pad), hgap: Number(o.hgap) });

const lotSize = (d: CDir, g: Geo) => {
  const n = Math.max(1, d.slots.length);
  return { w: d.pcols * g.cell, h: Math.ceil(n / d.pcols) * g.cell };
};
const span = (a: number[], gap: number) => a.reduce((s, v) => s + v, 0) + gap * Math.max(0, a.length - 1);
const blockSize = (d: CDir, g: Geo) => ({ w: span(d.colW, g.hgap) + 2 * g.pad, h: span(d.rowH, g.hgap) + 2 * g.pad });

const geo = geoSchema();
const schema: OptionSchema = { cell: geo.cell, pad: geo.pad, hgap: { ...geo.hgap, doc: 'gap between columns and rows of a district' } };

export const city: Strategy<CityState> = {
  name: 'city',
  description: 'Online: stretchable nested grid. Districts keep their cell; columns/rows only widen, so blocks slide outward but never jump. Holes are reused, nothing shrinks.',
  usesFuture: false,
  schema,
  defaults: defaultsOf(schema),
  wires: 'none',
  init: () => ({ dirs: new Map() }),

  step(s, tree, _c, _delta, ctx) {
    const { dirKids, fileKids } = groupTree(tree);
    const live = [...tree.dirs.keys()].sort(cmp); // parents before children
    const liveSet = new Set(live);
    // 1. Vanished directories drop their state; the parent's cell becomes free.
    for (const p of [...s.dirs.keys()]) if (!liveSet.has(p)) s.dirs.delete(p);
    for (const p of live) {
      let d = s.dirs.get(p);
      if (!d) {
        d = { slots: [], pcols: 1, cells: new Map(), colW: [], rowH: [] };
        s.dirs.set(p, d);
      }
      // 2. File slots: gone files free their slot, new ones take the earliest free slot.
      const files = fileKids.get(p) ?? [];
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
    ratchet(s, geoOf(ctx.options));
  },

  frame(s, tree, _c, ctx): LayoutNode[] {
    const g = geoOf(ctx.options);
    const { fileKids } = groupTree(tree);
    const nodes: LayoutNode[] = [];
    const box = g.cell * 0.8, inset = (g.cell - box) / 2;
    const rec = (p: string, x: number, y: number, parent: string | null) => {
      const d = s.dirs.get(p)!;
      const b = blockSize(d, g);
      nodes.push({ id: `d:${p}`, kind: 'dir', path: p, parent, x, y, w: b.w, h: b.h });
      const cx: number[] = [], ry: number[] = [];
      let acc = x + g.pad;
      for (const w of d.colW) (cx.push(acc), (acc += w + g.hgap));
      acc = y + g.pad;
      for (const h of d.rowH) (ry.push(acc), (acc += h + g.hgap));
      const byId = new Map((fileKids.get(p) ?? []).map((f) => [f.id, f]));
      d.slots.forEach((id, i) => {
        if (id === null) return;
        const f = byId.get(id)!;
        nodes.push({
          id: `f:${id}`,
          kind: 'file',
          path: f.path,
          parent: `d:${p}`,
          x: cx[0] + (i % d.pcols) * g.cell + inset,
          y: ry[0] + Math.floor(i / d.pcols) * g.cell + inset,
          w: box,
          h: box,
          size: f.size,
          born: f.born,
          modified: f.modified,
        });
      });
      for (const [k, cell] of [...d.cells].sort((a, b) => a[1] - b[1])) {
        const [col, row] = shellCell(cell);
        rec(k, cx[col], ry[row], `d:${p}`);
      }
    };
    rec('', 0, 0, null);
    return nodes;
  },
};

/** Step 4 of step(): widen columns/rows to fit their contents (never shrink). */
export function ratchet(s: CityState, g: Geo): void {
  const paths = [...s.dirs.keys()].sort((a, b) => depth(b) - depth(a) || cmp(a, b));
  for (const p of paths) {
    const d = s.dirs.get(p)!;
    const fit = (cell: number, w: number, h: number) => {
      const [c, r] = shellCell(cell);
      while (d.colW.length <= c) d.colW.push(0);
      while (d.rowH.length <= r) d.rowH.push(0);
      if (w > d.colW[c]) d.colW[c] = w;
      if (h > d.rowH[r]) d.rowH[r] = h;
    };
    const lot = lotSize(d, g);
    fit(0, lot.w, lot.h);
    for (const [k, cell] of d.cells) {
      const b = blockSize(s.dirs.get(k)!, g);
      fit(cell, b.w, b.h);
    }
  }
}

const depth = (p: string) => (p === '' ? 0 : p.split('/').length);
