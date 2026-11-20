// Coral: growth by accretion. Files are polyps that settle one at a time, each touching a polyp of
// its own directory (the first polyp of a directory settles on its parent's), so every directory grows
// as one branch of the colony and subdirectories bud off their parent's branch.
//
// Where a polyp settles mimics diffusion-limited aggregation: food arrives from outside, so spots far
// from the colony's centre and with few neighbours (tips) are much likelier than crevices. A seeded
// random draw among the free spots, weighted that way, gives the irregular branching of real coral.
// Each polyp is linked to the polyp it grew on; those links are the skeleton drawn under the colony.

import { type Disc, fileRadius, hash, rng, type Scene, type SDir, type Snapshot } from './model.ts';

const GAP = 0.06;
const ANGLES = 16;
const TIP_BIAS = 1.6; // weight = exp(dist / (TIP_BIAS * r)) ; smaller = spikier

export interface Polyp extends Disc {
  f: number;
}

/**
 * The colony: polyps with a spatial hash, and the settling rule. Polyps can be removed (their slot
 * stays null, so indices are stable).
 */
export class Colony {
  polyps: (Polyp | null)[] = [];
  private cell = 2 * fileRadius(1e9) + GAP;
  private grid = new Map<string, number[]>();

  private key(x: number, y: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
  free(x: number, y: number, r: number): boolean {
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(y / this.cell);
    for (let u = -1; u <= 1; u++)
      for (let v = -1; v <= 1; v++)
        for (const j of this.grid.get(`${gx + u},${gy + v}`) ?? []) {
          const p = this.polyps[j]!;
          if (Math.hypot(p.x - x, p.y - y) < p.r + r + GAP - 1e-9) return false;
        }
    return true;
  }
  private crowd(x: number, y: number, R: number): number {
    let n = 0;
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(y / this.cell);
    for (let u = -2; u <= 2; u++)
      for (let v = -2; v <= 2; v++)
        for (const j of this.grid.get(`${gx + u},${gy + v}`) ?? []) {
          const p = this.polyps[j]!;
          if (Math.hypot(p.x - x, p.y - y) < R) n++;
        }
    return n;
  }
  add(p: Polyp): number {
    const i = this.polyps.length;
    this.polyps.push(p);
    const k = this.key(p.x, p.y);
    const b = this.grid.get(k);
    if (b) b.push(i);
    else this.grid.set(k, [i]);
    return i;
  }
  remove(i: number) {
    const p = this.polyps[i];
    if (!p) return;
    const b = this.grid.get(this.key(p.x, p.y))!;
    b.splice(b.indexOf(i), 1);
    this.polyps[i] = null;
  }
  live(): number[] {
    const out: number[] = [];
    this.polyps.forEach((p, i) => p && out.push(i));
    return out;
  }
  /** Where a polyp of radius r settles, touching one of the anchors: { x, y, from } (from = anchor index, -1 at the origin). */
  settle(r: number, anchorSets: number[][], rand: () => number): { x: number; y: number; from: number } {
    if (!this.live().length) return { x: 0, y: 0, from: -1 };
    // try the preferred anchors first, then wider sets (the parent's whole branch, the whole colony)
    for (const anchors of anchorSets) {
      const s = this.trySettle(r, anchors, rand);
      if (s) return s;
    }
    // buried everywhere (cannot happen with the whole colony as the last set, but stay safe)
    const last = this.live().at(-1)!;
    const p = this.polyps[last]!;
    for (let t = p.r + r; ; t += 0.25) if (this.free(p.x + t, p.y, r)) return { x: p.x + t, y: p.y, from: last };
  }
  private trySettle(r: number, anchors: number[], rand: () => number): { x: number; y: number; from: number } | null {
    const spots: { x: number; y: number; from: number; w: number }[] = [];
    for (const a of anchors) {
      const p = this.polyps[a];
      if (!p) continue;
      const off = rand() * Math.PI * 2;
      for (let k = 0; k < ANGLES; k++) {
        const ang = off + (2 * Math.PI * k) / ANGLES;
        const d = p.r + r + GAP;
        const x = p.x + Math.cos(ang) * d;
        const y = p.y + Math.sin(ang) * d;
        if (!this.free(x, y, r)) continue;
        spots.push({ x, y, from: a, w: Math.hypot(x, y) / (1 + 0.6 * this.crowd(x, y, 3 * r + 1)) });
      }
    }
    if (!spots.length) return null;
    const best = Math.max(...spots.map((s) => s.w));
    let sum = 0;
    const ps = spots.map((s) => (sum += Math.exp((s.w - best) / (TIP_BIAS * (r + 0.5)))));
    const pick = rand() * sum;
    const s = spots[ps.findIndex((c) => c >= pick)];
    return { x: s.x, y: s.y, from: s.from };
  }
}

export function coral(snap: Snapshot): Scene {
  const scene: Scene = { layout: 'coral', marks: [], shapes: [] };
  const col = new Colony();
  const add = (f: number, at: { x: number; y: number; from: number }, r: number): number => {
    const i = col.add({ f, x: at.x, y: at.y, r });
    scene.marks.push({ f, x: at.x, y: at.y, r });
    if (at.from >= 0) {
      const q = col.polyps[at.from]!;
      scene.shapes.push({ k: 'line', d: snap.files[f].dir.i, pts: [q.x, q.y, at.x, at.y], w: [Math.min(q.r, r) * 0.5, Math.min(q.r, r) * 0.5], a: q.f, b: f });
    }
    return i;
  };
  const owned = new Map<SDir, number[]>(); // polyps of each directory
  const anchorsOf = (d: SDir | null): number[] => {
    for (let e = d; e; e = e.parent) {
      const a = owned.get(e);
      if (a?.length) return a;
    }
    return col.polyps.length ? [0] : [];
  };
  // breadth-first by directory, so siblings start growing before any one of them races ahead
  const queue: SDir[] = [snap.root];
  while (queue.length) {
    const d = queue.shift()!;
    const rand = rng(hash(d.path || '/'));
    const mine: number[] = [];
    owned.set(d, mine);
    // the first polyp settles on the parent; prefer the parent's newest polyps (its growing tip)
    for (const f of d.files) {
      const parent = anchorsOf(d.parent);
      const sets = mine.length ? [mine, parent] : [parent.slice(-12), parent];
      const r = fileRadius(f.size);
      mine.push(add(f.i, col.settle(r, [...sets, col.live()], rand), r));
    }
    queue.push(...d.dirs);
  }
  return scene;
}
