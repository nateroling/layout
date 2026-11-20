// Nature layouts (experiment): one snapshot of a repo's tree, no history, no stability.
//
// A Snapshot is the file tree at one commit (`git ls-tree -r -l`). Every layout in this folder takes a
// Snapshot and returns a Scene: one circle or polygon per file plus decorative shapes (directory
// outlines, branches, arm trails). Layouts are deterministic: any randomness comes from `rng(seed)`.

import { execFileSync } from 'node:child_process';
import { cmp } from '../model/tree.ts';

export interface SFile {
  i: number; // index into Snapshot.files
  path: string;
  name: string;
  size: number;
  dir: SDir;
}

export interface SDir {
  i: number; // index into Snapshot.dirs (root = 0)
  path: string; // '' for the root
  name: string;
  parent: SDir | null;
  depth: number;
  files: SFile[]; // sorted by name
  dirs: SDir[]; // sorted by name
  count: number; // files in the subtree
}

export interface Snapshot {
  name: string;
  sha: string;
  date: string;
  root: SDir;
  files: SFile[]; // DFS order: a directory's files, then its subdirectories
  dirs: SDir[]; // DFS pre-order
}

/** Build a Snapshot from [path, size] pairs. */
export function buildSnapshot(name: string, entries: [string, number][], sha = '', date = ''): Snapshot {
  const root: SDir = { i: 0, path: '', name: '', parent: null, depth: 0, files: [], dirs: [], count: 0 };
  const byPath = new Map<string, SDir>([['', root]]);
  const dirOf = (p: string): SDir => {
    let d = byPath.get(p);
    if (d) return d;
    const cut = p.lastIndexOf('/');
    const parent = dirOf(cut < 0 ? '' : p.slice(0, cut));
    d = { i: 0, path: p, name: p.slice(cut + 1), parent, depth: parent.depth + 1, files: [], dirs: [], count: 0 };
    parent.dirs.push(d);
    byPath.set(p, d);
    return d;
  };
  for (const [path, size] of entries) {
    const cut = path.lastIndexOf('/');
    const dir = dirOf(cut < 0 ? '' : path.slice(0, cut));
    dir.files.push({ i: 0, path, name: path.slice(cut + 1), size, dir });
  }
  const files: SFile[] = [];
  const dirs: SDir[] = [];
  const walk = (d: SDir): number => {
    d.i = dirs.length;
    dirs.push(d);
    d.files.sort((a, b) => cmp(a.name, b.name));
    d.dirs.sort((a, b) => cmp(a.name, b.name));
    for (const f of d.files) {
      f.i = files.length;
      files.push(f);
    }
    d.count = d.files.length;
    for (const c of d.dirs) d.count += walk(c);
    return d.count;
  };
  walk(root);
  return { name, sha, date, root, files, dirs };
}

/** The tree at HEAD of a local clone (regular files only; symlinks and submodules skipped). */
export function loadSnapshot(repo: string, name: string, ref = 'HEAD'): Snapshot {
  const out = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-l', '-z', ref], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const entries: [string, number][] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, , size] = rec.slice(0, tab).split(/\s+/);
    if (type !== 'blob' || mode === '120000') continue;
    entries.push([rec.slice(tab + 1), Number(size)]);
  }
  const meta = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%h %cs', ref], { encoding: 'utf8' }).trim().split(' ');
  return buildSnapshot(name, entries, meta[0], meta[1]);
}

// ---- scene ----

export interface FileMark {
  f: number; // file index
  x: number;
  y: number;
  r: number; // circle radius (for polygon marks: radius of the equal-area circle)
  poly?: number[]; // optional cell outline [x0,y0,x1,y1,...] (drawn instead of the circle)
}

export type Shape =
  | { k: 'disc'; d: number; x: number; y: number; r: number } // directory outline
  | { k: 'poly'; d: number; pts: number[] } // directory cell
  | { k: 'line'; d: number; pts: number[]; w: number[]; a?: number; b?: number }; // polyline with a width per vertex (branches, arms, links; a link between two files names them in a, b)

export interface Scene {
  layout: string;
  marks: FileMark[];
  shapes: Shape[]; // drawn under the marks, in order
}

// ---- shared helpers ----

/** File circle radius: compressive in size so a 100 KB file is ~3x a 1 KB one, not 10x. */
export function fileRadius(size: number): number {
  return Math.min(2.6, Math.max(0.4, 0.5 * Math.pow(Math.max(size, 1) / 1000, 0.25)));
}

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed from a string (FNV-1a), so each directory gets its own stream. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export interface Disc {
  x: number;
  y: number;
  r: number;
}

/**
 * Smallest t >= 0 such that a disc of radius r at (ox,oy) + t*(dx,dy) clears every placed disc by `gap`.
 * (dx,dy) must be a unit vector. Exact: each placed disc blocks one interval of t.
 */
export function rayFree(placed: Disc[], ox: number, oy: number, dx: number, dy: number, r: number, gap: number): number {
  const iv: [number, number][] = [];
  for (const p of placed) {
    const R = p.r + r + gap;
    const fx = ox - p.x;
    const fy = oy - p.y;
    const b = fx * dx + fy * dy;
    const c = fx * fx + fy * fy - R * R;
    const disc = b * b - c;
    if (disc <= 0) continue;
    const s = Math.sqrt(disc);
    const t1 = -b - s;
    const t2 = -b + s;
    if (t2 > 0) iv.push([t1, t2]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  let t = 0;
  for (const [a, b] of iv) {
    if (a > t) break;
    if (b > t) t = b;
  }
  return t;
}

/** Push overlapping discs apart (fixed discs never move). Uniform-grid broad phase. */
export function relax(discs: Disc[], gap: number, iters: number, fixed?: (i: number) => boolean): void {
  if (discs.length < 2) return;
  const maxR = Math.max(...discs.map((d) => d.r));
  const cell = 2 * maxR + gap;
  for (let it = 0; it < iters; it++) {
    const grid = new Map<string, number[]>();
    discs.forEach((d, i) => {
      const k = `${Math.floor(d.x / cell)},${Math.floor(d.y / cell)}`;
      const b = grid.get(k);
      if (b) b.push(i);
      else grid.set(k, [i]);
    });
    let moved = 0;
    for (let i = 0; i < discs.length; i++) {
      const a = discs[i];
      const gx = Math.floor(a.x / cell);
      const gy = Math.floor(a.y / cell);
      for (let u = -1; u <= 1; u++)
        for (let v = -1; v <= 1; v++) {
          for (const j of grid.get(`${gx + u},${gy + v}`) ?? []) {
            if (j <= i) continue;
            const b = discs[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d = Math.hypot(dx, dy);
            const need = a.r + b.r + gap;
            if (d >= need) continue;
            if (d < 1e-9) {
              dx = Math.cos(i + j);
              dy = Math.sin(i + j);
              d = 1;
            } else {
              dx /= d;
              dy /= d;
            }
            const fa = fixed?.(i) ?? false;
            const fb = fixed?.(j) ?? false;
            if (fa && fb) continue;
            const push = need - (d < 1e-9 ? 0 : d);
            const sa = fa ? 0 : fb ? 1 : 0.5;
            const sb = fb ? 0 : fa ? 1 : 0.5;
            a.x -= dx * push * sa;
            a.y -= dy * push * sa;
            b.x += dx * push * sb;
            b.y += dy * push * sb;
            moved++;
          }
        }
    }
    if (!moved) return;
  }
}

/** Greedy golden-angle packing of discs around a centre: item n goes at angle n*GA, as close in as fits. */
export function phyllotaxis(radii: number[], gap: number, angle0 = 0): Disc[] {
  const placed: Disc[] = [];
  radii.forEach((r, n) => {
    const a = angle0 + n * GOLDEN_ANGLE;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const t = n === 0 ? 0 : rayFree(placed, 0, 0, dx, dy, r, gap);
    placed.push({ x: dx * t, y: dy * t, r });
  });
  return placed;
}

/** Approximate smallest circle enclosing the discs (Badoiu-Clarkson iteration). */
export function enclosingCircle(discs: Disc[]): Disc {
  if (!discs.length) return { x: 0, y: 0, r: 0 };
  let x = discs[0].x;
  let y = discs[0].y;
  for (let k = 1; k <= 400; k++) {
    let far = -1;
    let fx = 0;
    let fy = 0;
    for (const d of discs) {
      const dx = d.x - x;
      const dy = d.y - y;
      const len = Math.hypot(dx, dy);
      const e = len + d.r;
      if (e > far) {
        far = e;
        // farthest point of this disc from the centre
        fx = len > 1e-12 ? d.x + (dx / len) * d.r : d.x + d.r;
        fy = len > 1e-12 ? d.y + (dy / len) * d.r : d.y;
      }
    }
    x += (fx - x) / (k + 1);
    y += (fy - y) / (k + 1);
  }
  return { x, y, r: enclosing(discs, x, y) };
}

export function enclosing(discs: Disc[], cx = 0, cy = 0): number {
  let R = 0;
  for (const d of discs) R = Math.max(R, Math.hypot(d.x - cx, d.y - cy) + d.r);
  return R;
}
