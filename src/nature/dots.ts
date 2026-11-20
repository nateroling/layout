// Nested dot cells (experiment): files are dots and folders are the cells that grow around them.
//
// A file is a dot whose *volume* is its size, so its radius is the cube root of its size. A folder has no
// shape of its own: its cell is the ground within a margin of its files' dots, one margin per level of
// nesting, so a subfolder's cell sits inside its parent's with a margin of the parent around it. Cells are
// derived from the dots, never the other way round.
//
// Layout is nested and remembers the last frame (online: it never sees later commits). Every folder is
// laid out in its own frame of reference, deepest first. Its pieces are its own files (single dots) and
// its subfolders (each a rigid cluster of dots, already laid out). The pieces are pulled towards the
// folder's anchor and pushed apart until no two dots from different pieces are closer than their cells
// allow: a dot's reach at this level is its radius plus one margin per level it sits below this folder,
// and sibling pieces keep a small gap. Because a subfolder only ever moves as a whole inside its parent,
// nothing from outside can wedge into it, so every cell stays in one piece.
//
//  - Survivors keep their spot: each folder keeps its offset in its parent and each file its offset in
//    its folder.
//  - A new file goes to the free spot nearest its folder's anchor; a new folder (as a cluster) to the
//    free spot nearest its parent's.
//  - When a folder is renamed or moved, its files keep their spots on screen: the new folder is anchored
//    where its files were and is then pulled into its new parent. A file that moves on its own (rather
//    than with most of its old folder) is placed afresh.
// The root's anchor is the origin, so the root is pinned. Everything is deterministic: pieces are visited
// in a fixed order and new spots start from path hashes.

import { hash, type Scene, type SDir, type Snapshot } from './model.ts';

/** Dot radius: volume proportional to size. */
export const dotRadius = (size: number) => Math.max(0.35, 0.085 * Math.cbrt(Math.max(size, 1)));

export interface DotParams {
  margin: number; // cell margin around the dots, per nesting level
  gapIn: number; // gap between two dots of the same folder
  gapOut: number; // gap between sibling cells (and between a cell and its parent's own dots)
  pull: number; // per-iteration pull of each piece towards its folder's anchor
  iters: number; // iterations per folder per frame
  ring: number; // radius of the ring subfolders are pulled to, times the root-sum-square of the pieces' sizes
}

export const DOT_DEFAULTS: DotParams = { margin: 1, gapIn: 0.25, gapOut: 0.5, pull: 0.02, iters: 60, ring: 0.5 };

/** A fixed direction for a folder name: its place in alphabetical order around the circle, case-insensitive. */
export function nameAngle(name: string): number {
  const s = name.toLowerCase();
  let v = 0;
  let scale = 1;
  for (let k = 0; k < 8; k++) {
    const c = s.charCodeAt(k);
    const digit = Number.isNaN(c) ? 0 : c >= 48 && c <= 57 ? c - 47 : c >= 97 && c <= 122 ? c - 86 : c < 48 ? 0 : 37;
    scale /= 38;
    v += digit * scale;
  }
  return v * 2 * Math.PI - Math.PI / 2; // 'a' near the top, going clockwise on screen
}

/** A piece of a folder's layout: one own file, or a subfolder as a rigid cluster of dots. */
interface Piece {
  ox: number; // offset from the folder's anchor
  oy: number;
  file: boolean;
  f: number[]; // file indices
  lx: number[]; // dot positions relative to the piece's offset
  ly: number[];
  e: number[]; // dot reach at this level
  inv: number; // inverse mass
  cx: number; // mass centre, relative to the offset
  cy: number;
  br: number; // bounding radius around the mass centre (reach included)
  seed: number; // where its free-spot search starts
  ang: number | null; // direction of its spot in the parent (null: the middle)
  tx: number; // where its mass centre is pulled to
  ty: number;
}

export class DotCells {
  p: DotParams;
  prev = new Map<number, [number, number]>(); // file id -> position last frame
  prevDir = new Map<number, string>(); // file id -> folder last frame
  off = new Map<string, [number, number]>(); // folder path -> offset from its parent's anchor
  constructor(p: Partial<DotParams> = {}) {
    this.p = { ...DOT_DEFAULTS, ...p };
    if (process.env.DOTS_PARAMS) Object.assign(this.p, JSON.parse(process.env.DOTS_PARAMS));
  }

  /** Lay out one frame. `ids[f.i]` is file f's identity across frames. */
  step(snap: Snapshot, ids: number[]): Scene {
    const P = this.p;
    const n = snap.files.length;
    const r = snap.files.map((f) => dotRadius(f.size));
    const fdepth = snap.files.map((f) => f.dir.depth);

    // ---- which files keep their spot: those that stayed, and those that moved with their folder ----
    const dest = new Map<string, Map<string, number>>();
    for (const f of snap.files) {
      const old = this.prevDir.get(ids[f.i]);
      if (old === undefined || old === f.dir.path) continue;
      let t = dest.get(old);
      if (!t) dest.set(old, (t = new Map()));
      t.set(f.dir.path, (t.get(f.dir.path) ?? 0) + 1);
    }
    const kept = snap.files.map((f) => {
      const old = this.prevDir.get(ids[f.i]);
      if (old === undefined) return false;
      if (old === f.dir.path) return true;
      const t = dest.get(old)!;
      const top = Math.max(...t.values());
      return t.get(f.dir.path) === top && top >= 2;
    });

    // ---- anchors, top down: a known folder sits at its old offset, a new one where its files were ----
    const nd = snap.dirs.length;
    const anchor: ([number, number] | null)[] = new Array(nd).fill(null);
    const desc: number[][] = snap.dirs.map(() => []);
    for (const f of snap.files) for (let d: SDir | null = f.dir; d; d = d.parent) desc[d.i].push(f.i);
    for (const d of snap.dirs) {
      if (!d.parent) {
        anchor[d.i] = [0, 0];
        continue;
      }
      const pa = anchor[d.parent.i];
      const o = this.off.get(d.path);
      if (o && pa) {
        anchor[d.i] = [pa[0] + o[0], pa[1] + o[1]];
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (const i of desc[d.i]) {
        if (!kept[i]) continue;
        const p = this.prev.get(ids[i])!;
        const a = r[i] * r[i];
        sx += p[0] * a;
        sy += p[1] * a;
        sw += a;
      }
      if (sw) anchor[d.i] = [sx / sw, sy / sw];
    }

    // ---- bottom up: lay out each folder's pieces in its own frame ----
    const flat: { f: number[]; x: number[]; y: number[] }[] = new Array(nd); // dots relative to the anchor
    const offset: [number, number][] = new Array(nd); // each folder's offset in its parent, after layout
    const clumpOff = new Map<string, [number, number]>(); // each folder's own-file clump, offset from its anchor
    for (let k = nd - 1; k >= 0; k--) {
      const d = snap.dirs[k];
      const D = d.depth;
      const a = anchor[d.i];
      const pieces: Piece[] = [];
      const fresh: Piece[] = [];
      const dirPiece = new Map<number, Piece>();
      // the folder's own files first, as one clump laid out in its own frame
      let clump: Piece | null = null;
      if (d.files.length) {
        const key = d.path + '/\0files';
        const known = this.off.get(key);
        let ca: [number, number] | null = known && a ? [a[0] + known[0], a[1] + known[1]] : null;
        if (!ca) {
          let sx = 0;
          let sy = 0;
          let sw = 0;
          for (const file of d.files) {
            if (!kept[file.i]) continue;
            const p = this.prev.get(ids[file.i])!;
            const w = r[file.i] ** 2;
            sx += p[0] * w;
            sy += p[1] * w;
            sw += w;
          }
          if (sw) ca = [sx / sw, sy / sw];
        }
        const fp: Piece[] = [];
        const ff: Piece[] = [];
        for (const file of d.files) {
          const i = file.i;
          const pc = piece(true, [i], [0], [0], [r[i]], r, hash(file.path));
          if (kept[i] && ca) {
            const p = this.prev.get(ids[i])!;
            pc.ox = p[0] - ca[0];
            pc.oy = p[1] - ca[1];
            fp.push(pc);
          } else ff.push(pc);
        }
        for (const pc of ff) {
          placeFree(pc, fp, P, pc.seed);
          fp.push(pc);
        }
        relax(fp, P, P.iters);
        const fl = { f: [] as number[], x: [] as number[], y: [] as number[] };
        for (const pc of fp) {
          fl.f.push(pc.f[0]);
          fl.x.push(pc.ox);
          fl.y.push(pc.oy);
        }
        clump = piece(false, fl.f, fl.x, fl.y, fl.f.map((i) => r[i]), r, hash(key));
        clump.ang = null;
        if (ca && a) {
          clump.ox = ca[0] - a[0];
          clump.oy = ca[1] - a[1];
          pieces.push(clump);
        } else fresh.push(clump);
      }
      for (const c of d.dirs) {
        const fl = flat[c.i];
        const pc = piece(false, fl.f, fl.x, fl.y, fl.f.map((i) => r[i] + P.margin * (fdepth[i] - D)), r, hash(c.path + '/'));
        pc.ang = nameAngle(c.name);
        dirPiece.set(c.i, pc);
        const ca = anchor[c.i];
        if (a && ca) {
          pc.ox = ca[0] - a[0];
          pc.oy = ca[1] - a[1];
          pieces.push(pc);
        } else fresh.push(pc);
      }
      // targets: the clump in the middle, subfolders on a ring in name order, so Foo/ and FooTests/ sit side by side
      const all = [...pieces, ...fresh];
      const ring = all.length > 1 ? P.ring * Math.sqrt(all.reduce((t, pc) => t + pc.br * pc.br, 0)) : 0;
      for (const pc of all) {
        pc.tx = pc.ang === null ? 0 : ring * Math.cos(pc.ang);
        pc.ty = pc.ang === null ? 0 : ring * Math.sin(pc.ang);
      }
      for (const pc of fresh) {
        placeFree(pc, pieces, P, pc.seed);
        pieces.push(pc);
      }
      relax(pieces, P, P.iters);
      const out = { f: [] as number[], x: [] as number[], y: [] as number[] };
      for (const pc of pieces)
        for (let j = 0; j < pc.f.length; j++) {
          out.f.push(pc.f[j]);
          out.x.push(pc.ox + pc.lx[j]);
          out.y.push(pc.oy + pc.ly[j]);
        }
      flat[d.i] = out;
      for (const [ci, pc] of dirPiece) offset[ci] = [pc.ox, pc.oy];
      if (clump) clumpOff.set(d.path + '/\0files', [clump.ox, clump.oy]);
    }

    // ---- remember, and report global positions (root anchor = origin) ----
    this.prev = new Map();
    this.prevDir = new Map();
    this.off = new Map();
    for (const d of snap.dirs) if (d.parent) this.off.set(d.path, offset[d.i]);
    for (const [k, v] of clumpOff) this.off.set(k, v);
    const scene: Scene = { layout: 'dots', marks: [], shapes: [] };
    const root = flat[0];
    for (let j = 0; j < root.f.length; j++) {
      const i = root.f[j];
      this.prev.set(ids[i], [root.x[j], root.y[j]]);
      this.prevDir.set(ids[i], snap.files[i].dir.path);
      scene.marks.push({ f: i, x: root.x[j], y: root.y[j], r: r[i] });
    }
    scene.marks.sort((p, q) => p.f - q.f);
    if (scene.marks.length !== n) throw new Error('dots: lost a file');
    return scene;
  }
}

function piece(file: boolean, f: number[], lx: number[], ly: number[], e: number[], r: number[], seed: number): Piece {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let j = 0; j < f.length; j++) {
    const a = r[f[j]] * r[f[j]];
    sx += lx[j] * a;
    sy += ly[j] * a;
    sw += a;
  }
  const cx = sx / sw;
  const cy = sy / sw;
  let br = 0;
  for (let j = 0; j < f.length; j++) br = Math.max(br, Math.hypot(lx[j] - cx, ly[j] - cy) + e[j]);
  return { ox: 0, oy: 0, file, f, lx, ly, e, inv: 1 / sw, cx, cy, br, seed, ang: null, tx: 0, ty: 0 };
}

const gapOf = (a: Piece, b: Piece, P: DotParams) => (a.file && b.file ? P.gapIn : P.gapOut);

/** True if piece a, at offset (ax, ay), overlaps piece b. */
function hits(a: Piece, b: Piece, P: DotParams, ax: number, ay: number, slack = 0): boolean {
  const g = gapOf(a, b, P);
  if (Math.hypot(ax + a.cx - b.ox - b.cx, ay + a.cy - b.oy - b.cy) >= a.br + b.br + g) return false;
  for (let i = 0; i < a.f.length; i++) {
    const xi = ax + a.lx[i];
    const yi = ay + a.ly[i];
    for (let j = 0; j < b.f.length; j++) {
      const need = a.e[i] + b.e[j] + g - slack;
      const dx = b.ox + b.lx[j] - xi;
      const dy = b.oy + b.ly[j] - yi;
      if (dx * dx + dy * dy < need * need) return true;
    }
  }
  return false;
}

/** Put a piece at the free spot nearest the anchor, searching rings outwards from a hashed angle. */
function placeFree(pc: Piece, placed: Piece[], P: DotParams, seed: number): void {
  const a0 = pc.ang ?? (seed / 4294967296) * 2 * Math.PI;
  const step = 0.4;
  for (let ring = 0; ring < 5000; ring++) {
    const rad = ring * step;
    const k = ring === 0 ? 1 : Math.max(6, Math.ceil((2 * Math.PI * rad) / step));
    for (let s = 0; s < k; s++) {
      const ang = a0 + (2 * Math.PI * s) / k;
      // the piece's mass centre goes on the candidate spot
      const ox = pc.tx + rad * Math.cos(ang) - pc.cx;
      const oy = pc.ty + rad * Math.sin(ang) - pc.cy;
      if (!placed.some((q) => hits(pc, q, P, ox, oy))) {
        pc.ox = ox;
        pc.oy = oy;
        return;
      }
    }
  }
}

/** Pull pieces towards the anchor and push overlapping pieces apart, as rigid bodies. */
function relax(ps: Piece[], P: DotParams, iters: number): void {
  if (ps.length === 1) {
    // a lone piece sits on the anchor
    ps[0].ox = -ps[0].cx;
    ps[0].oy = -ps[0].cy;
    ps[0].tx = ps[0].ty = 0;
    return;
  }
  const collide = (): number => {
    let worst = 0;
    for (let a = 0; a < ps.length; a++)
      for (let b = a + 1; b < ps.length; b++) {
        const A = ps[a];
        const B = ps[b];
        const g = gapOf(A, B, P);
        if (Math.hypot(A.ox + A.cx - B.ox - B.cx, A.oy + A.cy - B.oy - B.cy) >= A.br + B.br + g) continue;
        for (let i = 0; i < A.f.length; i++)
          for (let j = 0; j < B.f.length; j++) {
            const need = A.e[i] + B.e[j] + g;
            const dx = B.ox + B.lx[j] - A.ox - A.lx[i];
            const dy = B.oy + B.ly[j] - A.oy - A.ly[i];
            const d2 = dx * dx + dy * dy;
            if (d2 >= need * need) continue;
            let d = Math.sqrt(d2);
            let ux = dx / d;
            let uy = dy / d;
            if (d < 1e-9) {
              const t = ((a * 7919 + b * 104729 + i * 31 + j) % 360) * (Math.PI / 180);
              ux = Math.cos(t);
              uy = Math.sin(t);
              d = 0;
            }
            const over = need - d;
            worst = Math.max(worst, over);
            const wa = A.inv / (A.inv + B.inv);
            A.ox -= ux * over * wa;
            A.oy -= uy * over * wa;
            B.ox += ux * over * (1 - wa);
            B.oy += uy * over * (1 - wa);
          }
      }
    return worst;
  };
  for (let it = 0; it < iters; it++) {
    for (const pc of ps) {
      pc.ox += (pc.tx - pc.ox - pc.cx) * P.pull;
      pc.oy += (pc.ty - pc.oy - pc.cy) * P.pull;
    }
    collide();
    collide();
  }
  // then settle: push apart until nothing overlaps
  for (let k = 0; k < 300 && collide() > 0.005; k++);
  // a piece still caught (say, a file trapped in the folds of a cell that just formed around it) is
  // lifted out to the free spot nearest the anchor
  for (let round = 0; round < 20; round++) {
    let stuck: Piece | null = null;
    for (let a = 0; a < ps.length && !stuck; a++)
      for (let b = a + 1; b < ps.length && !stuck; b++)
        if (hits(ps[a], ps[b], P, ps[a].ox, ps[a].oy, 0.02)) stuck = ps[a].inv > ps[b].inv || (ps[a].inv === ps[b].inv && a > b) ? ps[a] : ps[b];
    if (!stuck) return;
    placeFree(stuck, ps.filter((q) => q !== stuck), P, stuck.seed);
    for (let k = 0; k < 100 && collide() > 0.005; k++);
  }
}
