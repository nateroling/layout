// Shared pieces of the animated nature pages (bin/nature-anim.ts, bin/cellcity.ts): the binary writer,
// the cell encoding (a convex polygon as rays from its centroid) and the movement metrics.

import type { Scene, Snapshot } from './model.ts';

export class Writer {
  buf = Buffer.alloc(1 << 16);
  n = 0;
  private room(k: number) {
    if (this.n + k > this.buf.length) {
      const b = Buffer.alloc(this.buf.length * 2 + k);
      this.buf.copy(b);
      this.buf = b;
    }
  }
  u8(v: number) {
    this.room(1);
    this.buf.writeUInt8(Math.max(0, Math.min(255, Math.round(v))), this.n++);
  }
  u16(v: number) {
    this.room(2);
    this.buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(v))), this.n);
    this.n += 2;
  }
  u32(v: number) {
    this.room(4);
    this.buf.writeUInt32LE(Math.min(0xffffffff, v), this.n);
    this.n += 4;
  }
  xy(v: number) {
    this.room(2);
    this.buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 20))), this.n);
    this.n += 2;
  }
}

/** Distances from (cx,cy) to a convex polygon's boundary at k evenly spaced angles. */
export function rays(poly: number[], cx: number, cy: number, k: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < k; j++) {
    const a = (2 * Math.PI * j) / k;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let best = 0;
    for (let i = 0; i < poly.length; i += 2) {
      const ax = poly[i] - cx;
      const ay = poly[i + 1] - cy;
      const bx = poly[(i + 2) % poly.length] - cx;
      const by = poly[(i + 3) % poly.length] - cy;
      // ray t*(dx,dy) meets segment a + s*(b-a)
      const ex = bx - ax;
      const ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;
      const s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
    }
    out.push(best);
  }
  return out;
}

export function polyCentroid(p: number[]): [number, number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    const c = p[i] * p[j + 1] - p[j] * p[i + 1];
    a += c;
    cx += (p[i] + p[j]) * c;
    cy += (p[i + 1] + p[j + 1]) * c;
  }
  if (Math.abs(a) < 1e-12) return [p[0] ?? 0, p[1] ?? 0, 0];
  return [cx / (3 * a), cy / (3 * a), Math.abs(a / 2)];
}


/** A cells-family frame: per file { xy, u8 r, u8 ray[16] }, per folder { xy, u16 R, u8 ray[dirRays] } (R = 0: no wall). */
export function writeCells(W: Writer, sc: Scene, snap: Snapshot, dirRays = 24): void {
  const byF = new Array(snap.files.length);
  for (const m of sc.marks) byF[m.f] = m;
  for (const m of byF) {
    const [cx, cy, a] = polyCentroid(m.poly);
    const r = Math.sqrt(a / Math.PI);
    W.xy(cx);
    W.xy(cy);
    W.u8(r * 50);
    for (const d of rays(m.poly, cx, cy, 16)) W.u8(r > 0 ? (d / r) * 64 : 0);
  }
  const walls = new Array(snap.dirs.length).fill(null);
  for (const s of sc.shapes) if (s.k === 'poly') walls[s.d] = s;
  for (const s of walls) {
    const [cx, cy, a] = s && s.pts.length >= 6 ? polyCentroid(s.pts) : [0, 0, 0];
    const r = Math.sqrt(a / Math.PI);
    W.xy(cx);
    W.xy(cy);
    W.u16(r * 20);
    const rs = r > 0 ? rays(s.pts, cx, cy, dirRays) : new Array(dirRays).fill(0);
    for (const d of rs) W.u8(r > 0 ? (d / r) * 64 : 0);
  }
}

// ---- movement: per frame step, how far each surviving file moved, in file widths ----
// Positions are in each layout's own coordinates, where the root is pinned (sunflower: root head
// centre, tree: trunk base, cells: root cell centre, coral: first polyp, galaxy: bulge). A file width is
// sqrt(bounding-box area / files) of the later frame, so layouts of different density compare fairly.
export interface Moves {
  steps: number[]; // mean move per step
  all: number[]; // every file-step move
  density: number[]; // u^2 per file per frame
}
export function bboxOf(sc: Scene) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of sc.marks) {
    x0 = Math.min(x0, m.x - m.r);
    y0 = Math.min(y0, m.y - m.r);
    x1 = Math.max(x1, m.x + m.r);
    y1 = Math.max(y1, m.y + m.r);
  }
  return (x1 - x0) * (y1 - y0);
}


/** Record one frame's file positions (keyed by identity) and density into m; `prev` is last frame's positions. */
export function track(m: Moves, sc: Scene, ids: number[], nfiles: number, prev: Map<number, [number, number]> | null): Map<number, [number, number]> {
  const area = bboxOf(sc);
  const unit = Math.sqrt(area / nfiles);
  m.density.push(area / nfiles);
  const pos = new Map<number, [number, number]>(sc.marks.map((mk) => [ids[mk.f], [mk.x, mk.y]]));
  if (prev) {
    let sum = 0;
    let n = 0;
    for (const [id, [x, y]] of pos) {
      const p = prev.get(id);
      if (!p) continue;
      const d = Math.hypot(x - p[0], y - p[1]) / unit;
      m.all.push(d);
      sum += d;
      n++;
    }
    if (n) m.steps.push(sum / n);
  }
  return pos;
}

export const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export const metrics = (m: Moves) => {
  const sorted = [...m.all].sort((a, b) => a - b);
  return {
    move: +mean(m.all).toFixed(3), // mean move per surviving file per frame, in file widths
    jumps: +(m.all.filter((d) => d > 2).length / (m.all.length || 1)).toFixed(4), // share of file-steps moving > 2 widths
    p95: +(sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0).toFixed(2),
    worst: +Math.max(0, ...m.steps).toFixed(2), // the worst single step (mean over files): a big subtree shifting
    density: +mean(m.density).toFixed(1), // bounding box u^2 per file, averaged over frames
  };
};
