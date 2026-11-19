// Squeeze: an optional, stateful compaction pass on top of a placement (city / metro).
//
// The placement (the grid) decides where every district goes; the squeeze then lets each
// district slide toward its parent's file lot until it touches something, closing the empty
// space the grid leaves (wide seams, holes from deletions). Districts keep their identity and
// neighbours; only the gaps close.
//
//   pack     axis slides only: x toward the lot, then y, then x again (Tetris-like; blocks
//            stay lined up with each other).
//   organic  slide straight at the centre of the parent's lot, in any direction, then slip
//            along whatever stopped it (the axis slides), so blocks settle around their lot
//            like cells in a Townscaper grid instead of in rows and columns.
//
// Stability rules:
// - Stateful: each district's squeezed offset from its parent's lot (`q`) is remembered and the
//   next commit starts from it, not from the grid. A new district starts at its grid position.
// - Gradual: a district slides inward at most `rate` units per commit (0 = all the way at once).
// - Never across the city: a district only moves relative to its own parent, and only toward
//   that parent's lot. When something grows into it, it is pushed straight back out along the
//   same line, by exactly the overlap.
// - The root is pinned (its lot stays where the placement puts it, at the origin).
// - Bottom-up: children are squeezed before their parent, so a parent sees its children's
//   squeezed shapes. All of this runs in step(); frame() only applies the stored offsets.

import type { LayoutNode } from '../types.ts';

export type SqueezeMode = 'none' | 'pack' | 'organic';

interface Pt {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Placement output the squeeze needs: per directory, its lot corner nearest the centre (global), its facing, its lot size. */
export interface Anchor {
  x: number;
  y: number;
  o: Pt; // +1/-1: direction the district grows in
  lot: { w: number; h: number };
}

export interface SqueezeState {
  q: Map<string, Pt>; // non-root dir -> its anchor in its parent's local frame (squeezed)
  shape: Map<string, Rect>; // dir -> its squeezed block in its own local frame
}

export const newSqueeze = (): SqueezeState => ({ q: new Map(), shape: new Map() });

const EPS = 1e-9;
const dirOf = (n: LayoutNode) => (n.parent ?? '').slice(2);

/** Local frame of a district: origin at its anchor, axes flipped so it grows +u/+v. */
const toLocal = (a: Anchor, X: number, Y: number): Pt => ({ x: a.o.x * (X - a.x), y: a.o.y * (Y - a.y) });
/** A rect in one frame seen through sign flips f (componentwise) and translated by t. */
const flip = (r: Rect, f: Pt, t: Pt): Rect => {
  const x0 = f.x * r.x, x1 = f.x * (r.x + r.w), y0 = f.y * r.y, y1 = f.y * (r.y + r.h);
  return { x: t.x + Math.min(x0, x1), y: t.y + Math.min(y0, y1), w: r.w, h: r.h };
};

const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap - EPS && b.x < a.x + a.w + gap - EPS && a.y < b.y + b.h + gap - EPS && b.y < a.y + a.h + gap - EPS;

/** Time at which rect a, moving along unit d, first touches b (inflated by gap); Infinity if never. */
function contact(a: Rect, d: Pt, b: Rect, gap: number): number {
  const axis = (a0: number, aw: number, b0: number, bw: number, v: number): [number, number] => {
    const lo = b0 - gap - (a0 + aw), hi = b0 + bw + gap - a0; // a's offset range that overlaps
    if (Math.abs(v) < EPS) return lo < -EPS && hi > EPS ? [-Infinity, Infinity] : [Infinity, -Infinity];
    const t0 = lo / v, t1 = hi / v;
    return [Math.min(t0, t1), Math.max(t0, t1)];
  };
  const [x0, x1] = axis(a.x, a.w, b.x, b.w, d.x);
  const [y0, y1] = axis(a.y, a.h, b.y, b.h, d.y);
  const enter = Math.max(x0, y0), exit = Math.min(x1, y1);
  if (enter >= exit - EPS || exit <= EPS) return Infinity;
  return Math.max(0, enter);
}

/** Exit time: how far rect a must travel along unit d to stop overlapping b. */
function escape(a: Rect, d: Pt, b: Rect, gap: number): number {
  const ex = d.x > EPS ? (b.x + b.w + gap - a.x) / d.x : d.x < -EPS ? (a.x + a.w - (b.x - gap)) / -d.x : Infinity;
  const ey = d.y > EPS ? (b.y + b.h + gap - a.y) / d.y : d.y < -EPS ? (a.y + a.h - (b.y - gap)) / -d.y : Infinity;
  return Math.min(ex, ey);
}

const move = (r: Rect, d: Pt, t: number): Rect => ({ ...r, x: r.x + d.x * t, y: r.y + d.y * t });
const unit = (x: number, y: number): Pt => {
  const l = Math.hypot(x, y);
  return l < EPS ? { x: 0, y: 0 } : { x: x / l, y: y / l };
};

/** Push r out along d until it clears every settled rect. */
function pushOut(r: Rect, d: Pt, settled: Rect[], gap: number): Rect {
  if (Math.abs(d.x) < EPS && Math.abs(d.y) < EPS) d = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  for (let guard = 0; guard < 4 * settled.length + 8; guard++) {
    const hit = settled.find((s) => overlaps(r, s, gap));
    if (!hit) return r;
    r = move(r, d, escape(r, d, hit, gap) + 1e-7);
  }
  throw new Error('squeeze: push-out did not converge');
}

/** Slide r along d by at most `max`, stopping at the first contact. */
function slide(r: Rect, d: Pt, max: number, settled: Rect[], gap: number): Rect {
  if (max <= EPS || (Math.abs(d.x) < EPS && Math.abs(d.y) < EPS)) return r;
  let t = max;
  for (const s of settled) t = Math.min(t, contact(r, d, s, gap));
  return t > EPS ? move(r, d, t) : r;
}

/**
 * Update the squeeze state from this commit's placement. `nodes` is the placement's frame,
 * `anchors` its per-directory anchors.
 */
export function squeezeStep(st: SqueezeState, nodes: LayoutNode[], anchors: Map<string, Anchor>, mode: SqueezeMode, rate: number, gap: number, pad: number): void {
  const kidsOf = new Map<string, string[]>();
  for (const n of nodes) if (n.kind === 'dir' && n.parent !== null) (kidsOf.get(dirOf(n)) ?? kidsOf.set(dirOf(n), []).get(dirOf(n))!).push(n.path);
  for (const p of [...st.q.keys()]) if (!anchors.has(p)) st.q.delete(p);
  for (const p of [...st.shape.keys()]) if (!anchors.has(p)) st.shape.delete(p);
  const budget = rate > 0 ? rate : Infinity;
  const depth = (p: string) => (p === '' ? 0 : p.split('/').length);
  const paths = [...anchors.keys()].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const p of paths) {
    const A = anchors.get(p)!;
    const lot: Rect = { x: 0, y: 0, w: A.lot.w, h: A.lot.h };
    const lc = { x: lot.w / 2, y: lot.h / 2 };
    const settled: Rect[] = [lot];
    const kids = (kidsOf.get(p) ?? []).map((k) => {
      const K = anchors.get(k)!;
      const f = { x: A.o.x * K.o.x, y: A.o.y * K.o.y };
      const q = st.q.get(k) ?? toLocal(A, K.x, K.y); // new: start at the grid position
      return { k, f, rel: flip(st.shape.get(k)!, f, { x: 0, y: 0 }), q };
    });
    const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const at = (c: (typeof kids)[0]): Rect => ({ ...c.rel, x: c.rel.x + c.q.x, y: c.rel.y + c.q.y });
    // Nearest first, so inner districts settle before outer ones lean on them.
    kids.sort((a, b) => {
      const ca = centre(at(a)), cb = centre(at(b));
      return Math.hypot(ca.x - lc.x, ca.y - lc.y) - Math.hypot(cb.x - lc.x, cb.y - lc.y) || (a.k < b.k ? -1 : 1);
    });
    let box: Rect = { ...lot };
    for (const c of kids) {
      let r = at(c);
      const cc = centre(r);
      const inward = unit(lc.x - cc.x, lc.y - cc.y);
      r = pushOut(r, { x: -inward.x, y: -inward.y }, settled, gap);
      let left = budget;
      if (mode === 'organic') {
        // Straight at the lot centre until something is in the way...
        const c2 = centre(r);
        const before = { x: r.x, y: r.y };
        r = slide(r, inward, Math.min(left, Math.hypot(lc.x - c2.x, lc.y - c2.y)), settled, gap);
        left -= Math.hypot(r.x - before.x, r.y - before.y);
      }
      // ...then (organic) or only (pack) slide along the axes, x then y then x, so a block
      // that hit a corner slips along the surface. Never past the lot's centre line.
      for (const ax of ['x', 'y', 'x'] as const) {
        if (left <= EPS) break;
        const c2 = centre(r);
        const dist = Math.abs(lc[ax] - c2[ax]);
        const d = ax === 'x' ? { x: Math.sign(lc.x - c2.x), y: 0 } : { x: 0, y: Math.sign(lc.y - c2.y) };
        const before = r[ax];
        r = slide(r, d, Math.min(left, dist), settled, gap);
        left -= Math.abs(r[ax] - before);
      }
      c.q = { x: r.x - c.rel.x, y: r.y - c.rel.y };
      st.q.set(c.k, c.q);
      settled.push(r);
      const x0 = Math.min(box.x, r.x), y0 = Math.min(box.y, r.y);
      box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
    }
    st.shape.set(p, { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad });
  }
}

/** Apply the stored squeeze to this commit's placement (pure). */
export function squeezeFrame(st: SqueezeState, nodes: LayoutNode[], anchors: Map<string, Anchor>): LayoutNode[] {
  const parentOf = new Map<string, string>();
  for (const n of nodes) if (n.kind === 'dir' && n.parent !== null) parentOf.set(n.path, dirOf(n));
  const final = new Map<string, Pt>();
  const finalOf = (p: string): Pt => {
    let f = final.get(p);
    if (f) return f;
    const A = anchors.get(p)!;
    if (p === '') f = { x: A.x, y: A.y };
    else {
      const par = parentOf.get(p)!;
      const P = anchors.get(par)!, pf = finalOf(par), q = st.q.get(p)!;
      f = { x: pf.x + P.o.x * q.x, y: pf.y + P.o.y * q.y };
    }
    final.set(p, f);
    return f;
  };
  return nodes.map((n) => {
    if (n.kind === 'dir') {
      const A = anchors.get(n.path)!, f = finalOf(n.path);
      const r = flip(st.shape.get(n.path)!, A.o, f);
      return { ...n, x: r.x, y: r.y, w: r.w, h: r.h };
    }
    const p = dirOf(n), A = anchors.get(p)!, f = finalOf(p);
    return { ...n, x: n.x + f.x - A.x, y: n.y + f.y - A.y };
  });
}
