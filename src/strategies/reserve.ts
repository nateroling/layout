// Shared per-directory reservations (used by `slack`, and by `tombstone` when slack > 0).
//
// A reservation records, per directory path, the cols / rows / band width the
// layout has promised that directory. During step() the "growing" hooks update
// it: first sight -> ceil(required * (1 + slack)); requirement exceeds it ->
// ceil(required * growth); otherwise keep. Never shrinks. During frame() the
// "fixed" hooks only read it back, so frame() stays pure. Cols are reserved too:
// in sqrt grids a change of cols reflows every file of the platform.

import type { GeoHooks, GeoOptions, LDir } from '../geometry/treev.ts';
import { ancestors } from '../model/tree.ts';
import type { Options } from '../types.ts';

export interface Reservation {
  cols: number; // 0 = not yet reserved
  rows: number;
  width: number;
}

/** Keyed by directory path. Plain Map of plain objects: structuredClone-able. */
export type Reservations = Map<string, Reservation>;

export interface ReserveOptions {
  slack: number; // initial headroom fraction, e.g. 0.25
  growth: number; // growth factor when a reservation is exceeded, e.g. 1.5
}

export function reserveOptions(o: Options, base: ReserveOptions): ReserveOptions {
  const n = (v: unknown, d: number) => {
    const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(x) ? x : d;
  };
  return { slack: Math.max(0, n(o.slack, base.slack)), growth: Math.max(1, n(o.growth, base.growth)) };
}

// ceil that ignores float noise (e.g. 3 * 1.1 = 3.3000000000000003 is fine, 2 * 1.5 = 3 stays 3).
const ceil = (x: number) => Math.ceil(x - 1e-9);

function grow(cur: number, required: number, ro: ReserveOptions): number {
  if (cur <= 0) return Math.max(required, ceil(required * (1 + ro.slack)));
  if (required > cur) return Math.max(required, ceil(required * ro.growth));
  return cur;
}

function entry(res: Reservations, path: string): Reservation {
  let r = res.get(path);
  if (!r) res.set(path, (r = { cols: 0, rows: 0, width: 0 }));
  return r;
}

/**
 * Hooks for step(): consult and update the reservations during a full measure().
 * Strategies use updateReservations() instead (same result, incremental); this is
 * kept as the reference the tests compare against.
 */
export function growingHooks(res: Reservations, ro: ReserveOptions): GeoHooks {
  return {
    cols(d: LDir, required: number) {
      const r = entry(res, d.path);
      return (r.cols = grow(r.cols, required, ro));
    },
    rows(d: LDir, required: number) {
      const r = entry(res, d.path);
      return (r.rows = grow(r.rows, required, ro));
    },
    width(d: LDir, required: number) {
      const r = entry(res, d.path);
      return (r.width = grow(r.width, required, ro));
    },
  };
}

/** Hooks for frame(): read-only. */
export function fixedHooks(res: Reservations): GeoHooks {
  return {
    cols: (d: LDir, required: number) => Math.max(required, res.get(d.path)?.cols ?? 0),
    rows: (d: LDir, required: number) => Math.max(required, res.get(d.path)?.rows ?? 0),
    width: (d: LDir, required: number) => Math.max(required, res.get(d.path)?.width ?? 0),
  };
}

/** Drop reservations whose directory is gone. */
export function dropReservations(res: Reservations, keep: (path: string) => boolean): void {
  for (const p of [...res.keys()]) if (!keep(p)) res.delete(p);
}

export interface DirShape {
  files: number; // number of slots of the platform
  kids: string[]; // child directory paths, in layout order
}

/**
 * Incremental equivalent of `measure(root, g, growingHooks(res, ro))`.
 *
 * After a step every directory's band width equals its stored `width`
 * reservation (alloc = max(required, width) and width >= required), so a clean
 * subtree contributes exactly `res.width`. Only directories whose own slots or
 * child list changed (`dirty`) and their ancestors need re-measuring, deepest
 * first. Applies the very same arithmetic as measure() (same child order), so
 * the reservations are identical to a full pass: O(dirty * depth) per commit
 * instead of O(files).
 */
export function updateReservations(
  res: Reservations,
  ro: ReserveOptions,
  g: GeoOptions,
  dirty: Iterable<string>,
  shape: (path: string) => DirShape | undefined,
): void {
  const todo = new Set<string>();
  for (const p of dirty) {
    if (todo.has(p)) continue;
    todo.add(p);
    if (p !== '') for (const a of ancestors(p)) todo.add(a);
  }
  const depth = (p: string) => (p === '' ? 0 : p.split('/').length);
  const list = [...todo].map((p) => ({ p, d: depth(p) }));
  list.sort((a, b) => b.d - a.d || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  for (const { p } of list) {
    const sh = shape(p);
    if (!sh) continue; // directory gone
    const r = entry(res, p);
    const n = sh.files;
    let cols = g.gridMode === 'fixed' ? g.gridCols : Math.max(1, Math.ceil(Math.sqrt(n)));
    cols = Math.max(cols, (r.cols = grow(r.cols, cols, ro)));
    let rows = Math.max(1, Math.ceil(n / cols));
    rows = Math.max(rows, (r.rows = grow(r.rows, rows, ro)));
    const pw = cols * g.cell + 2 * g.pad;
    let childrenW = 0;
    sh.kids.forEach((k, i) => {
      childrenW += (res.get(k)?.width ?? 0) + (i > 0 ? g.hgap : 0);
    });
    r.width = grow(r.width, Math.max(pw, childrenW), ro);
  }
}
