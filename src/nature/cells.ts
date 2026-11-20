// Cells: a Voronoi treemap, like plant tissue or a cross-section of a stem. The root is a round cell;
// it divides into one cell per child (its files and its subdirectories), and each subdirectory cell
// divides again, down to one cell per file. Cell area is proportional to the file's weight (the area of
// its circle in the other layouts), so the picture is space-filling and nothing overlaps.
//
// Each division is a power diagram (additively weighted Voronoi), relaxed Lloyd-style: sites move to
// their cell's centroid and weights grow or shrink until every cell's area is close to its share
// (Nocaj & Brandes, "Computing Voronoi treemaps", 2012). All cells are convex polygons.

import { fileRadius, hash, rng, type Scene, type SDir, type SFile, type Snapshot } from './model.ts';

export type Poly = number[]; // [x0,y0,x1,y1,...], counter-clockwise

const ITERS = 200;

export function area(p: Poly): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return s / 2;
}

export function centroid(p: Poly): [number, number] {
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
export function clip(p: Poly, nx: number, ny: number, c: number): Poly {
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

export function inside(p: Poly, x: number, y: number): boolean {
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    if ((p[j] - p[i]) * (y - p[i + 1]) - (p[j + 1] - p[i + 1]) * (x - p[i]) < 0) return false;
  }
  return true;
}

/** Power cells of the sites, clipped to the convex region. */
export function powerCells(region: Poly, xs: number[], ys: number[], ws: number[]): Poly[] {
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
export function divide(region: Poly, weights: number[], seeds: number[]): Poly[] {
  return divideEx(region, weights, seeds).cells;
}

/** A site in region-relative terms: position in the region's bounding box (0..1) and weight / region area. */
export type Site = [number, number, number];

/**
 * divide(), plus a warm start and inertia, for the stable variants: `init[i]` (if given) starts item i
 * where it ended last frame; `inertia` < 1 moves each site only that fraction of the way to its cell's
 * centroid per iteration. Returns the final sites so the caller can keep them.
 */
export function divideEx(region: Poly, weights: number[], seeds: number[], init?: (Site | undefined)[], inertia = 1): { cells: Poly[]; sites: Site[] } {
  const n = weights.length;
  if (n === 1) return { cells: [region], sites: [[0.5, 0.5, 0]] };
  const A = area(region);
  const W = weights.reduce((s, w) => s + w, 0);
  const target = weights.map((w) => (A * w) / W);
  // initial sites: a point per item, from the item's own seed (its name), relative to the region's
  // bounding box, so adding or removing a sibling doesn't reshuffle the others
  const rands = seeds.map((s) => rng(s));
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
  for (let i = 0; i < n; i++) {
    const s = init?.[i];
    if (s) {
      xs.push(minX + s[0] * (maxX - minX));
      ys.push(minY + s[1] * (maxY - minY));
      continue;
    }
    for (let tries = 0; ; tries++) {
      const x = minX + rands[i]() * (maxX - minX);
      const y = minY + rands[i]() * (maxY - minY);
      if (inside(region, x, y) || tries > 1000) {
        xs.push(x);
        ys.push(y);
        break;
      }
    }
  }
  const ws = new Array(n).fill(A / n / 10);
  if (init?.some((s) => s)) {
    const known = init.filter((s): s is Site => !!s).map((s) => s[2] * A);
    const low = Math.min(...known);
    for (let i = 0; i < n; i++) ws[i] = init[i] ? init[i]![2] * A : low;
  }
  let cells = powerCells(region, xs, ys, ws);
  const snapshot = (): Site[] => xs.map((x, i) => [(x - minX) / (maxX - minX || 1), (ys[i] - minY) / (maxY - minY || 1), ws[i] / A]);
  let bestSites = snapshot();
  // the iteration can oscillate, so keep the best diagram seen: smallest worst-case area error
  const error = (cs: Poly[]) => Math.max(...cs.map((c, i) => (c.length ? Math.abs(Math.log(area(c) / target[i])) : Infinity)));
  let best = cells;
  let bestErr = error(cells);
  for (let it = 0; it < ITERS && bestErr > 0.01; it++) {
    for (let i = 0; i < n; i++) {
      if (!cells[i].length) {
        // swallowed: re-seed inside the region with the smallest weight
        do {
          xs[i] = minX + rands[i]() * (maxX - minX);
          ys[i] = minY + rands[i]() * (maxY - minY);
        } while (!inside(region, xs[i], ys[i]));
        ws[i] = Math.min(...ws) - target[i] / Math.PI;
        continue;
      }
      const a = area(cells[i]);
      const [cx, cy] = centroid(cells[i]);
      xs[i] += (cx - xs[i]) * inertia;
      ys[i] += (cy - ys[i]) * inertia;
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
      bestSites = snapshot();
    }
  }
  return { cells: best, sites: bestSites };
}

export function cells(snap: Snapshot): Scene {
  return cellsWith(snap);
}

/** Memory for the stable cells variants: per folder, each child's last site; per item, its smoothed weight. */
export interface CellsMemory {
  sites: Map<string, Map<string, Site>>;
  weights: Map<string, number>;
}

/**
 * cells(), with hooks for the stable variants. keyOf names a file across frames (default: its path);
 * with `mem`, each division starts from last frame's sites (warm start); `inertia` slows the sites;
 * `smooth` (0..1) eases each item's weight towards its new value instead of jumping.
 */
export function cellsWith(snap: Snapshot, o: { keyOf?: (f: SFile) => string; mem?: CellsMemory; inertia?: number; smooth?: number } = {}): Scene {
  const scene: Scene = { layout: 'cells', marks: [], shapes: [] };
  const keyOf = o.keyOf ?? ((f: SFile) => f.path);
  const eased = (key: string, w: number): number => {
    if (!o.mem || o.smooth === undefined) return w;
    const prev = o.mem.weights.get(key);
    const v = prev === undefined ? w : prev + (w - prev) * o.smooth;
    o.mem.weights.set(key, v);
    return v;
  };
  const wFile = (size: number) => fileRadius(size) ** 2 * Math.PI * 1.25;
  const wDir = new Map<SDir, number>();
  const measure = (d: SDir): number => {
    let s = d.files.reduce((t, f) => t + eased(keyOf(f), wFile(f.size)), 0);
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
    const kids = [
      ...d.files.map((f) => ({ w: o.mem && o.smooth !== undefined ? o.mem.weights.get(keyOf(f))! : wFile(f.size), f: f.i, d: null as SDir | null, key: keyOf(f) })),
      ...d.dirs.map((c) => ({ w: wDir.get(c)!, f: -1, d: c, key: 'd:' + c.path })),
    ];
    if (!kids.length || region.length < 6) return;
    const seeds = kids.map((k) => hash(k.d ? k.d.path : snap.files[k.f].path));
    const prev = o.mem?.sites.get(d.path);
    const { cells: parts, sites } = divideEx(region, kids.map((k) => k.w), seeds, prev ? kids.map((k) => prev.get(k.key)) : undefined, o.inertia ?? 1);
    if (o.mem) o.mem.sites.set(d.path, new Map(kids.map((k, i) => [k.key, sites[i]])));
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
