// Cell cities (experiment): the cells layout (Voronoi treemap, src/nature/cells.ts) combined with the
// metro city grid (src/strategies/city.ts). Three ways to combine them, each a stepper like the stable
// nature variants (src/nature/stable.ts): called once per frame, in commit order, remembering earlier
// frames but never seeing later ones.
//
//   districts  cells at the top level only: each top-level folder (and the root's own files) gets an
//              organic region; inside it the files sit on a square grid, clipped to the region, near
//              where metro puts them relative to their folder.
//   blocks     cells all the way down to the folder level: districts split into sub-districts, and each
//              folder's own files form a block that is cut into building lots, two rows back to back.
//   seeded     metro decides where everything is: each file and folder is a cell site pinned at its
//              metro position, and only the weights (so the borders) adapt to make areas fit.
//
// All three weigh files by count, not size, as metro does: an edit never moves anything.

import { area, centroid, clip, divideEx, inside, type Poly, powerCells, type Site } from './cells.ts';
import { hash, type Scene, type SDir, type SFile, type Snapshot } from './model.ts';
import type { StepCtx } from './stable.ts';
import type { LayoutNode } from '../types.ts';

/** Metro's layout of the same commit, by path. */
export interface MetroFrame {
  file: Map<string, LayoutNode>;
  dir: Map<string, LayoutNode>;
}
export interface CityCtx extends StepCtx {
  metro: MetroFrame;
}
export type CityStepper = (snap: Snapshot, ctx: CityCtx) => Scene;

const fkey = (ctx: StepCtx, f: SFile) => `f:${ctx.id(f)}`;
const dkey = (d: SDir) => `d:${d.path}`;
const INERTIA = 0.25; // as the steadiest cells variant

export const rect = (x: number, y: number, w: number, h: number): Poly => [x, y, x + w, y, x + w, y + h, x, y + h];
const circle = (r: number, k = 96): Poly => {
  const p: Poly = [];
  for (let i = 0; i < k; i++) p.push(r * Math.cos((2 * Math.PI * i) / k), r * Math.sin((2 * Math.PI * i) / k));
  return p;
};
const center = (n: LayoutNode): [number, number] => [n.x + n.w / 2, n.y + n.h / 2];

/** A file that got no area (its folder's cell was squeezed out): a dot, so every file still has a mark. */
export let squeezed = 0;
const dot = (scene: Scene, f: SFile, x: number, y: number) => {
  squeezed++;
  scene.marks.push({ f: f.i, x, y, r: 0, poly: rect(x - 0.01, y - 0.01, 0.02, 0.02) });
};

/** A folder that mostly holds other folders (like crates/): its subfolders become districts of their own. */
const container = (d: SDir) => d.dirs.length >= 2 && d.files.length <= 0.1 * d.count;

/** Files of a subtree, depth first. */
function subtreeFiles(d: SDir, out: SFile[] = []): SFile[] {
  out.push(...d.files);
  for (const c of d.dirs) subtreeFiles(c, out);
  return out;
}

// ---------------------------------------------------------------- metro itself, as a scene

/** Metro's frame drawn with the same marks: a square per file, a rectangle per folder. */
export function metroScene(snap: Snapshot, m: MetroFrame): Scene {
  const scene: Scene = { layout: 'metro', marks: [], shapes: [] };
  for (const d of snap.dirs) {
    const n = m.dir.get(d.path);
    if (n && d.parent) scene.shapes.push({ k: 'poly', d: d.i, pts: rect(n.x, n.y, n.w, n.h) });
  }
  for (const f of snap.files) {
    const n = m.file.get(f.path)!;
    const [x, y] = center(n);
    scene.marks.push({ f: f.i, x, y, r: Math.sqrt((n.w * n.h) / Math.PI), poly: rect(n.x, n.y, n.w, n.h) });
  }
  return scene;
}

// ---------------------------------------------------------------- 1. districts

const LOT_SLACK = 1.3; // region area per file, in grid squares: room for the squares lost at the border
const BOX = 0.8; // a file's square inside its grid square (as metro: cell 1, box 0.8)

/**
 * Cells as districts. The root circle divides (warm start + inertia, as the steadiest cells variant)
 * into one region per top-level folder plus one for the root's own files; a folder that mostly holds
 * other folders (crates/) is opened up, so its subfolders are districts and its own files a small lot. Each region takes the grid
 * squares whose centres fall inside it, and its files sit on those squares: a file keeps last frame's
 * square while that square is still in its region, and a newcomer (or a file whose square left the
 * region) takes the free square nearest to where metro puts it, relative to its district.
 */
export function districts(): CityStepper {
  const sites = new Map<string, Site>();
  const square = new Map<string, string>(); // file key -> 'gx,gy'
  return (snap, ctx) => {
    const scene: Scene = { layout: 'districts', marks: [], shapes: [] };
    type Item = { key: string; dir: SDir | null; files: SFile[] };
    const items: Item[] = [];
    const open = (d: SDir) => {
      if (d.files.length) items.push({ key: 'lot:' + d.path, dir: null, files: [...d.files] });
      for (const c of d.dirs) container(c) ? open(c) : items.push({ key: dkey(c), dir: c, files: subtreeFiles(c) });
    };
    open(snap.root);
    const total = items.reduce((s, it) => s + it.files.length, 0) * LOT_SLACK;
    const root = circle(Math.sqrt(total / Math.PI));
    const { cells, sites: out } = divideEx(
      root,
      items.map((it) => it.files.length),
      items.map((it) => hash(it.key)),
      items.map((it) => sites.get(it.key)),
      INERTIA,
    );
    sites.clear();
    items.forEach((it, i) => sites.set(it.key, out[i]));
    const taken = new Set<string>();
    items.forEach((it, i) => {
      const region = cells[i];
      if (it.dir) scene.shapes.push({ k: 'poly', d: it.dir.i, pts: region });
      if (!region.length) return;
      // the grid squares of this district
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < region.length; k += 2) (x0 = Math.min(x0, region[k])), (x1 = Math.max(x1, region[k])), (y0 = Math.min(y0, region[k + 1])), (y1 = Math.max(y1, region[k + 1]));
      const free = new Map<string, [number, number]>();
      for (let gx = Math.floor(x0); gx <= Math.ceil(x1); gx++)
        for (let gy = Math.floor(y0); gy <= Math.ceil(y1); gy++) {
          const k = `${gx},${gy}`;
          if (!taken.has(k) && inside(region, gx + 0.5, gy + 0.5)) free.set(k, [gx, gy]);
        }
      // where metro puts each file, relative to its district, scaled to the region's size
      const [cx, cy] = centroid(region);
      const mBlock = it.dir ? ctx.metro.dir.get(it.dir.path)! : null;
      const mFiles = it.files.map((f) => center(ctx.metro.file.get(f.path)!));
      const [ax, ay] = mBlock ? center(mBlock) : [mFiles.reduce((s, p) => s + p[0], 0) / mFiles.length, mFiles.reduce((s, p) => s + p[1], 0) / mFiles.length];
      const k = mBlock ? Math.sqrt(area(region) / (mBlock.w * mBlock.h)) : 1;
      const target = (j: number): [number, number] => [cx + (mFiles[j][0] - ax) * k, cy + (mFiles[j][1] - ay) * k];
      const place = (f: SFile, sq: string) => {
        free.delete(sq);
        taken.add(sq);
        square.set(fkey(ctx, f), sq);
        const [gx, gy] = sq.split(',').map(Number);
        const p = rect(gx + (1 - BOX) / 2, gy + (1 - BOX) / 2, BOX, BOX);
        scene.marks.push({ f: f.i, x: gx + 0.5, y: gy + 0.5, r: Math.sqrt((BOX * BOX) / Math.PI), poly: p });
      };
      // keepers first, then newcomers in birth order
      const order = it.files.map((f, j) => ({ f, j, seq: ctx.seq(fkey(ctx, f)) })).sort((a, b) => a.seq - b.seq);
      const rest: typeof order = [];
      for (const o of order) {
        const sq = square.get(fkey(ctx, o.f));
        if (sq && free.has(sq)) place(o.f, sq);
        else rest.push(o);
      }
      for (const o of rest) {
        const [tx, ty] = target(o.j);
        let best = '';
        let bd = Infinity;
        for (const [key, [gx, gy]] of free) {
          const d = (gx + 0.5 - tx) ** 2 + (gy + 0.5 - ty) ** 2;
          if (d < bd || (d === bd && key < best)) (bd = d), (best = key);
        }
        if (!best) {
          // the region ran out of squares: the nearest free square outside it
          for (let r = 0; !best; r++)
            for (let gx = Math.floor(tx) - r; gx <= Math.floor(tx) + r; gx++)
              for (let gy = Math.floor(ty) - r; gy <= Math.floor(ty) + r; gy++) {
                const key = `${gx},${gy}`;
                const d = (gx + 0.5 - tx) ** 2 + (gy + 0.5 - ty) ** 2;
                if (!taken.has(key) && d < bd) (bd = d), (best = key);
              }
        }
        place(o.f, best);
      }
    });
    return scene;
  };
}

// ---------------------------------------------------------------- 2. blocks

/** Cut a convex polygon at u.x = c, with c chosen so the near side has `share` of the area. */
function cutAt(p: Poly, ux: number, uy: number, share: number): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const v = ux * p[i] + uy * p[i + 1];
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const A = area(p);
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (area(clip(p, ux, uy, mid)) < share * A) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/** Split p along direction u into pieces with the given weights, in order. */
function slices(p: Poly, ux: number, uy: number, ws: number[]): Poly[] {
  const out: Poly[] = [];
  let rest = p;
  let left = ws.reduce((s, w) => s + w, 0);
  ws.forEach((w, i) => {
    if (i === ws.length - 1 || rest.length < 6) {
      out.push(rest);
      rest = [];
      return;
    }
    const c = cutAt(rest, ux, uy, w / left);
    out.push(clip(rest, ux, uy, c));
    rest = clip(rest, -ux, -uy, -c);
    left -= w;
  });
  return out;
}
/** Long axis of a polygon: the angle that maximises its extent (sampled every 5 degrees). */
function extent(p: Poly, a: number): number {
  const ux = Math.cos(a), uy = Math.sin(a);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const v = ux * p[i] + uy * p[i + 1];
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi - lo;
}

/**
 * Cells all the way down. Every folder's region divides (warm start + inertia) into one cell per
 * subfolder plus one block for its own files (a folder with no subfolders is all block). A block is cut
 * into building lots like a real city block: two rows back to back along its long axis, each row
 * sliced across into lots in birth order. A file keeps its row; a newcomer joins the shorter row, so it
 * only reshapes the lots in its own row. The long axis has hysteresis: it turns only when the block's
 * other way becomes 1.4 times longer.
 */
export function blocks(): CityStepper {
  const sites = new Map<string, Map<string, Site>>();
  const axis = new Map<string, number>(); // block -> angle
  const row = new Map<string, number>(); // file key -> 0 | 1
  return (snap, ctx) => {
    const scene: Scene = { layout: 'blocks', marks: [], shapes: [] };
    const lots = (d: SDir, region: Poly) => {
      const files = [...d.files].sort((a, b) => ctx.seq(fkey(ctx, a)) - ctx.seq(fkey(ctx, b)));
      if (!files.length) return;
      if (region.length < 6) {
        for (const f of files) dot(scene, f, 0, 0);
        return;
      }
      let a = axis.get(d.path);
      if (a === undefined) {
        a = 0;
        for (let k = 1; k < 36; k++) if (extent(region, (k * Math.PI) / 36) > extent(region, a)) a = (k * Math.PI) / 36;
      } else {
        const perp = a + Math.PI / 2;
        if (extent(region, perp) > 1.4 * extent(region, a)) a = perp % Math.PI;
      }
      axis.set(d.path, a);
      const ux = Math.cos(a), uy = Math.sin(a);
      const rows: SFile[][] = [[], []];
      if (files.length < 4) rows[0] = files;
      else
        for (const f of files) {
          let r = row.get(fkey(ctx, f));
          if (r === undefined || rows[r].length > files.length / 2) r = rows[0].length <= rows[1].length ? 0 : 1;
          rows[r].push(f);
        }
      for (const [r, fs] of rows.entries()) for (const f of fs) row.set(fkey(ctx, f), r);
      const halves = rows[1].length ? slices(region, -uy, ux, [rows[0].length, rows[1].length]) : [region];
      rows.forEach((fs, r) => {
        if (!fs.length) return;
        slices(halves[r], ux, uy, fs.map(() => 1)).forEach((p, i) => {
          if (p.length < 6) return dot(scene, fs[i], ...centroid(halves[r].length >= 6 ? halves[r] : region));
          const [x, y] = centroid(p);
          scene.marks.push({ f: fs[i].i, x, y, r: Math.sqrt(Math.max(p.length >= 6 ? area(p) : 0, 0) / Math.PI), poly: p });
        });
      });
    };
    const split = (d: SDir, region: Poly) => {
      if (d.parent) scene.shapes.push({ k: 'poly', d: d.i, pts: region });
      if (region.length < 6) {
        for (const f of subtreeFiles(d)) dot(scene, f, 0, 0);
        return;
      }
      if (!d.dirs.length) return lots(d, region);
      const kids = [...(d.files.length ? [{ key: 'lot', w: d.files.length, dir: null as SDir | null }] : []), ...d.dirs.map((c) => ({ key: dkey(c), w: c.count, dir: c as SDir | null }))];
      const prev = sites.get(d.path);
      const { cells, sites: out } = divideEx(
        region,
        kids.map((k) => k.w),
        kids.map((k) => hash(d.path + '|' + k.key)),
        prev ? kids.map((k) => prev.get(k.key)) : undefined,
        INERTIA,
      );
      sites.set(d.path, new Map(kids.map((k, i) => [k.key, out[i]])));
      kids.forEach((k, i) => (k.dir ? split(k.dir, cells[i]) : lots(d, cells[i])));
    };
    split(snap.root, circle(Math.sqrt((snap.files.length * 1.6) / Math.PI)));
    for (const p of [...sites.keys()]) if (!snap.dirs.some((d) => d.path === p)) sites.delete(p);
    return scene;
  };
}

// ---------------------------------------------------------------- 3. seeded

const SEED_ITERS = 150;
const TETHER = 0.5; // how far a site may drift from its metro anchor, in units of its cell's natural radius

/** Move a site that fell outside the region onto it, just inside, along the line to the centroid. */
function pull(region: Poly, x: number, y: number): [number, number] {
  if (inside(region, x, y)) return [x, y];
  const [cx, cy] = centroid(region);
  let lo = 0, hi = 1; // fraction of the way from the centroid to the site
  for (let it = 0; it < 30; it++) {
    const m = (lo + hi) / 2;
    if (inside(region, cx + (x - cx) * m, cy + (y - cy) * m)) lo = m;
    else hi = m;
  }
  const m = lo * 0.98;
  return [cx + (x - cx) * m, cy + (y - cy) * m];
}

/**
 * A power diagram with tethered sites: the weights move until each cell's area is close to its share,
 * and each site drifts towards its cell's centre but stays within TETHER of its anchor (xs, ys). Starts
 * from last frame's weights (in units of the region's area) and drifts. Returns the cells, the final
 * relative weights and the drifts.
 */
function pinned(region: Poly, xs: number[], ys: number[], weights: number[], init: (number | undefined)[], drift: ([number, number] | undefined)[]): { cells: Poly[]; ws: number[]; drift: [number, number][] } {
  const n = xs.length;
  const A = area(region);
  if (n === 1) return { cells: [region], ws: [0], drift: [[0, 0]] };
  const ax = [...xs];
  const ay = [...ys];
  // start where each site drifted to last frame (relative to its anchor), if that is still in the region
  xs = xs.map((x, i) => (drift[i] && inside(region, x + drift[i]![0], ys[i] + drift[i]![1]) ? x + drift[i]![0] : x));
  ys = ys.map((y, i) => (drift[i] && inside(region, ax[i] + drift[i]![0], y + drift[i]![1]) ? y + drift[i]![1] : y));
  const W = weights.reduce((s, w) => s + w, 0);
  const target = weights.map((w) => (A * w) / W);
  const known = init.filter((w): w is number => w !== undefined);
  const low = known.length ? Math.min(...known) * A : 0;
  const ws = init.map((w) => (w === undefined ? low : w * A));
  // every site must stay in its own cell: w_i - w_j < |p_i - p_j|^2 (lowering one weight can break an
  // earlier pair, so repeat until clean)
  const legal = () => {
    for (let pass = 0; pass < 50; pass++) {
      let bad = false;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const d2 = (xs[i] - xs[j]) ** 2 + (ys[i] - ys[j]) ** 2;
          const over = ws[i] - ws[j] - 0.9 * d2;
          if (over > 0) (ws[i] -= over), (bad = true);
        }
      if (!bad) return;
    }
  };
  legal();
  let cells = powerCells(region, xs, ys, ws);
  const error = (cs: Poly[]) => Math.max(...cs.map((c, i) => (c.length ? Math.abs(Math.log(area(c) / target[i])) : 10)));
  let best = cells;
  let bestW = [...ws];
  let bestD = xs.map((x, i): [number, number] => [x - ax[i], ys[i] - ay[i]]);
  let bestErr = error(cells);
  for (let it = 0; it < SEED_ITERS && bestErr > 0.02; it++) {
    for (let i = 0; i < n; i++) {
      ws[i] += (0.5 * (target[i] - (cells[i].length ? area(cells[i]) : 0))) / Math.PI;
      if (!cells[i].length) continue;
      // the site drifts towards its cell's centre, but only within its tether around the metro anchor
      const [cx, cy] = centroid(cells[i]);
      let x = xs[i] + (cx - xs[i]) * 0.5;
      let y = ys[i] + (cy - ys[i]) * 0.5;
      const rho = TETHER * Math.sqrt(target[i] / Math.PI);
      const dx = x - ax[i];
      const dy = y - ay[i];
      const len = Math.hypot(dx, dy);
      if (len > rho) (x = ax[i] + (dx / len) * rho), (y = ay[i] + (dy / len) * rho);
      if (inside(region, x, y)) (xs[i] = x), (ys[i] = y);
    }
    legal();
    cells = powerCells(region, xs, ys, ws);
    const e = error(cells);
    if (e < bestErr) (best = cells), (bestErr = e), (bestW = [...ws]), (bestD = xs.map((x, i): [number, number] => [x - ax[i], ys[i] - ay[i]]));
  }
  return { cells: best, ws: bestW.map((w) => w / A), drift: bestD };
}

/**
 * Metro skeleton, cells skin. The root region is metro's own footprint (the root block). Each folder's
 * region divides into one cell per subfolder, anchored at the centre of its metro block, and one for its
 * own files, anchored at the middle of its metro file lot (pulled inside the region if it doesn't reach
 * them). A site may drift from its anchor by at most its cell's natural radius (TETHER), so folders sit
 * where metro puts them; the weights and drifts, warm-started from last frame, make each cell's area
 * match its file count. (Fully pinned sites, TETHER = 0, made slivers and badly wrong areas.) Inside a
 * folder's lot the files are free cells (warm start + inertia), as in the cells layout: pinning every
 * file to its metro square made long slivers, because metro's lots are tight and its streets wide.
 */
export function seeded(): CityStepper {
  const weights = new Map<string, number>(); // child key (in its parent) -> relative weight
  const drift = new Map<string, [number, number]>(); // child key -> where its site drifted from its anchor
  const sites = new Map<string, Map<string, Site>>(); // folder -> its files' cell sites
  return (snap, ctx) => {
    const scene: Scene = { layout: 'seeded', marks: [], shapes: [] };
    const split = (d: SDir, region: Poly) => {
      if (d.parent) scene.shapes.push({ k: 'poly', d: d.i, pts: region });
      if (region.length < 6) {
        for (const f of subtreeFiles(d)) dot(scene, f, ...center(ctx.metro.file.get(f.path)!));
        return;
      }
      if (!d.dirs.length) return lot(d, region);
      const mf = d.files.map((f) => center(ctx.metro.file.get(f.path)!));
      const kids = [
        ...(d.files.length ? [{ key: 'lot', w: d.files.length, at: [mf.reduce((s, p) => s + p[0], 0) / mf.length, mf.reduce((s, p) => s + p[1], 0) / mf.length] as [number, number], dir: null as SDir | null }] : []),
        ...d.dirs.map((c) => ({ key: dkey(c), w: c.count, at: center(ctx.metro.dir.get(c.path)!), dir: c as SDir | null })),
      ];
      const at = kids.map((k) => pull(region, k.at[0], k.at[1]));
      // two sites on one spot would have no border between them
      for (let i = 1; i < at.length; i++)
        for (let j = 0; j < i; j++) if (Math.hypot(at[i][0] - at[j][0], at[i][1] - at[j][1]) < 1e-3) at[i] = [at[i][0] + 1e-2 * Math.cos(i), at[i][1] + 1e-2 * Math.sin(i)];
      const keys = kids.map((k) => d.path + '|' + k.key);
      const { cells, ws, drift: dr } = pinned(region, at.map((p) => p[0]), at.map((p) => p[1]), kids.map((k) => k.w), keys.map((k) => weights.get(k)), keys.map((k) => drift.get(k)));
      kids.forEach((k, i) => {
        weights.set(keys[i], ws[i]);
        drift.set(keys[i], dr[i]);
        const p = cells[i];
        if (k.dir) split(k.dir, p);
        else lot(d, p);
      });
    };
    // a folder's own files: free cells (warm start + inertia) inside the lot's region
    const lot = (d: SDir, region: Poly) => {
      if (region.length < 6) {
        for (const f of d.files) dot(scene, f, ...center(ctx.metro.file.get(f.path)!));
        return;
      }
      const prev = sites.get(d.path);
      const keys = d.files.map((f) => fkey(ctx, f));
      const { cells, sites: out } = divideEx(region, d.files.map(() => 1), keys.map((k) => hash(k)), prev ? keys.map((k) => prev.get(k)) : undefined, INERTIA);
      sites.set(d.path, new Map(keys.map((k, i) => [k, out[i]])));
      d.files.forEach((f, i) => {
        const p = cells[i];
        if (p.length < 6) return dot(scene, f, ...centroid(region));
        const [x, y] = centroid(p);
        scene.marks.push({ f: f.i, x, y, r: Math.sqrt(area(p) / Math.PI), poly: p });
      });
    };
    const r = ctx.metro.dir.get('')!;
    split(snap.root, rect(r.x, r.y, r.w, r.h));
    return scene;
  };
}

export interface CityVariant {
  name: string;
  title: string;
  blurb: string;
  make: () => CityStepper;
}

export const CELL_CITIES: CityVariant[] = [
  {
    name: 'districts',
    title: 'Cells as districts',
    blurb: 'Cells at the top level only: each top-level folder (and the root’s own files) gets an organic region (a folder that only holds folders, like crates/, is opened up into its subfolders) that keeps last frame’s shape as far as it can. Inside, files sit on a square grid clipped to the region, near where metro puts them in their folder, and keep their square while it stays in the district.',
    make: districts,
  },
  {
    name: 'blocks',
    title: 'Cells all the way down',
    blurb: 'Districts split into sub-districts for every folder, with no grid anywhere. A folder’s own files form one block, cut into building lots like a city block: two rows back to back, lots in birth order. A newcomer only reshapes its own row.',
    make: blocks,
  },
  {
    name: 'seeded',
    title: 'Metro skeleton, cells skin',
    blurb: 'Metro decides where every folder goes: each folder, and each folder’s own file lot, is a cell anchored at its metro position (it may drift half a cell), inside metro’s footprint. Mostly the borders move, as the cells trade area to match their file counts. Files are free cells inside their lot.',
    make: seeded,
  },
];
