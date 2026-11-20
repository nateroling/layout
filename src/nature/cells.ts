// Cells: a Voronoi treemap, like plant tissue or a cross-section of a stem. The root is a round cell;
// it divides into one cell per child (its files and its subdirectories), and each subdirectory cell
// divides again, down to one cell per file. Cell area is proportional to the file's weight (the area of
// its circle in the other layouts), so the picture is space-filling and nothing overlaps.
//
// Each division is a power diagram (additively weighted Voronoi), relaxed Lloyd-style: sites move to
// their cell's centroid and weights grow or shrink until every cell's area is close to its share
// (Nocaj & Brandes, "Computing Voronoi treemaps", 2012). All cells are convex polygons.

import { fileRadius, hash, rng, type Scene, type SDir, type Snapshot } from './model.ts';

type Poly = number[]; // [x0,y0,x1,y1,...], counter-clockwise

const ITERS = 200;

export function area(p: Poly): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return s / 2;
}

function centroid(p: Poly): [number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const c = p[i] * p[j + 1] - p[j] * p[i + 1];
    a += c;
    cx += (p[i] + p[j]) * c;
    cy += (p[i + 1] + p[j + 1]) * c;
  }
  if (Math.abs(a) < 1e-12) return [p[0], p[1]];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Keep the side of the line where nx*x + ny*y <= c. */
function clip(p: Poly, nx: number, ny: number, c: number): Poly {
  const out: Poly = [];
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const ax = p[i];
    const ay = p[i + 1];
    const bx = p[j];
    const by = p[j + 1];
    const da = nx * ax + ny * ay - c;
    const db = nx * bx + ny * by - c;
    if (da <= 0) out.push(ax, ay);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

function inside(p: Poly, x: number, y: number): boolean {
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    if ((p[j] - p[i]) * (y - p[i + 1]) - (p[j + 1] - p[i + 1]) * (x - p[i]) < 0) return false;
  }
  return true;
}

/** Power cells of the sites, clipped to the convex region. */
function powerCells(region: Poly, xs: number[], ys: number[], ws: number[]): Poly[] {
  const cells: Poly[] = [];
  for (let i = 0; i < xs.length; i++) {
    let p = region;
    for (let j = 0; j < xs.length && p.length >= 6; j++) {
      if (j === i) continue;
      // |x-pi|^2 - wi <= |x-pj|^2 - wj  <=>  2(pj-pi).x <= |pj|^2 - |pi|^2 - wj + wi
      const nx = 2 * (xs[j] - xs[i]);
      const ny = 2 * (ys[j] - ys[i]);
      const c = xs[j] ** 2 + ys[j] ** 2 - xs[i] ** 2 - ys[i] ** 2 - ws[j] + ws[i];
      p = clip(p, nx, ny, c);
    }
    cells.push(p.length >= 6 ? p : []);
  }
  return cells;
}

/** Split a convex region into cells with areas proportional to `weights`. */
export function divide(region: Poly, weights: number[], seed: number): Poly[] {
  const n = weights.length;
  if (n === 1) return [region];
  const A = area(region);
  const W = weights.reduce((s, w) => s + w, 0);
  const target = weights.map((w) => (A * w) / W);
  // initial sites: random points inside the region's bounding box, kept if inside
  const rand = rng(seed);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < region.length; i += 2) {
    minX = Math.min(minX, region[i]);
    maxX = Math.max(maxX, region[i]);
    minY = Math.min(minY, region[i + 1]);
    maxY = Math.max(maxY, region[i + 1]);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  while (xs.length < n) {
    const x = minX + rand() * (maxX - minX);
    const y = minY + rand() * (maxY - minY);
    if (inside(region, x, y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  const ws = new Array(n).fill(A / n / 10);
  let cells = powerCells(region, xs, ys, ws);
  // the iteration can oscillate, so keep the best diagram seen: smallest worst-case area error
  const error = (cs: Poly[]) => Math.max(...cs.map((c, i) => (c.length ? Math.abs(Math.log(area(c) / target[i])) : Infinity)));
  let best = cells;
  let bestErr = error(cells);
  for (let it = 0; it < ITERS && bestErr > 0.01; it++) {
    for (let i = 0; i < n; i++) {
      if (!cells[i].length) {
        // swallowed: re-seed inside the region with the smallest weight
        do {
          xs[i] = minX + rand() * (maxX - minX);
          ys[i] = minY + rand() * (maxY - minY);
        } while (!inside(region, xs[i], ys[i]));
        ws[i] = Math.min(...ws) - target[i] / Math.PI;
        continue;
      }
      const a = area(cells[i]);
      [xs[i], ys[i]] = centroid(cells[i]);
      // weights are in area units (a weight w adds sqrt(w) to the cell's reach); any sign is fine,
      // since the diagram only depends on weight differences
      ws[i] += (0.5 * (target[i] - a)) / Math.PI;
    }
    // no site may be swallowed by a neighbour's weight: w_i - w_j < |pi - pj|^2
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const d2 = (xs[i] - xs[j]) ** 2 + (ys[i] - ys[j]) ** 2;
        const over = ws[i] - ws[j] - d2;
        if (over > 0) ws[i] -= over + 1e-6;
      }
    cells = powerCells(region, xs, ys, ws);
    const e = error(cells);
    if (e < bestErr) {
      best = cells;
      bestErr = e;
    }
  }
  return best;
}

export function cells(snap: Snapshot): Scene {
  const scene: Scene = { layout: 'cells', marks: [], shapes: [] };
  const wFile = (size: number) => fileRadius(size) ** 2 * Math.PI * 1.25;
  const wDir = new Map<SDir, number>();
  const measure = (d: SDir): number => {
    let s = d.files.reduce((t, f) => t + wFile(f.size), 0);
    for (const c of d.dirs) s += measure(c);
    wDir.set(d, s);
    return s;
  };
  const total = measure(snap.root);
  const R = Math.sqrt(total / Math.PI);
  const root: Poly = [];
  for (let k = 0; k < 96; k++) root.push(R * Math.cos((2 * Math.PI * k) / 96), R * Math.sin((2 * Math.PI * k) / 96));
  const split = (d: SDir, region: Poly) => {
    if (d !== snap.root) scene.shapes.push({ k: 'poly', d: d.i, pts: region });
    const kids = [...d.files.map((f) => ({ w: wFile(f.size), f: f.i, d: null as SDir | null })), ...d.dirs.map((c) => ({ w: wDir.get(c)!, f: -1, d: c }))];
    if (!kids.length || region.length < 6) return;
    const parts = divide(region, kids.map((k) => k.w), hash(d.path || '/'));
    kids.forEach((k, i) => {
      const p = parts[i];
      if (k.d) split(k.d, p);
      else {
        const [x, y] = p.length ? centroid(p) : [0, 0];
        scene.marks.push({ f: k.f, x, y, r: Math.sqrt(Math.max(p.length ? area(p) : 0, 0) / Math.PI), poly: p });
      }
    });
  };
  split(snap.root, root);
  return scene;
}
