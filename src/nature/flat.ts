// Flat cities (experiment): layouts where the folder hierarchy only groups files. Every folder's own
// files form one flat cluster; nothing encloses anything, so there are no nested boxes and no parent
// has to make room for its children. Six ways to place the clusters, each a stepper like the cell
// cities (src/nature/cellcity.ts): called once per frame in commit order, remembering earlier frames,
// never seeing later ones.
//
//   homestead  every folder gets a seed square when it first appears, next to its parent's seed; each
//              new file claims the free grid square nearest its folder's seed and keeps it for life.
//   cells      one flat power diagram (cells) of all folders at once; a folder's site is born on its
//              parent's site and then drifts with inertia; files sit on grid squares inside the cell.
//   affinity   folders are discs placed by co-change: a new folder appears beside the folder it has most
//              often been committed with so far, and springs keep co-changing folders close.
//   rings      chronology only: folders take positions on a golden-angle spiral in the order they
//              appeared, like growth rings; a growing disc only ever pushes younger discs outward.
//   streets    each folder is a block of two rows of lots along a street; a new folder joins its
//              parent's street while there is room, otherwise the nearest street with room, or a new one.
//   hilbert    the city is one Hilbert curve; folders allocate runs of it like a file system allocates
//              disk blocks, next to their parent's run, and a full folder takes a new run further on.
//
// All weigh files by count, so an edit never moves anything. Files keep their identity through renames.

import { centroid, divideEx, inside, type Poly, type Site } from './cells.ts';
import { hash, type Scene, type SDir, type SFile, type Snapshot } from './model.ts';
import type { CityCtx, CityStepper } from './cellcity.ts';
import { rect } from './cellcity.ts';
import { cmp } from '../model/tree.ts';

/** Co-change affinity seen so far: partners of a folder, strongest first (cosine of commit counts). */
export interface FlatCtx extends CityCtx {
  affinity: (dir: string) => [string, number][];
}
export type FlatStepper = (snap: Snapshot, ctx: FlatCtx) => Scene;

const fkey = (ctx: CityCtx, f: SFile) => `f:${ctx.id(f)}`;
const BOX = 0.8; // a file's square inside its grid square, as metro
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const angleOf = (s: string) => ((hash(s) % 3600) / 3600) * 2 * Math.PI;

/** Folders that hold files, oldest first (birth number, then path). */
function clusters(snap: Snapshot, ctx: CityCtx): SDir[] {
  return snap.dirs.filter((d) => d.files.length).sort((a, b) => ctx.seq(`d:${a.path}`) - ctx.seq(`d:${b.path}`) || cmp(a.path, b.path));
}
const bySeq = (ctx: CityCtx, fs: SFile[]) => [...fs].sort((a, b) => ctx.seq(fkey(ctx, a)) - ctx.seq(fkey(ctx, b)) || cmp(a.path, b.path));

/** Nearest ancestor of d (not d itself) that `has`. */
function ancestor<T>(d: SDir, has: Map<string, T>): T | undefined {
  for (let p = d.parent; p; p = p.parent) {
    const v = has.get(p.path);
    if (v !== undefined) return v;
  }
  return undefined;
}

function squareMark(scene: Scene, f: SFile, gx: number, gy: number) {
  scene.marks.push({ f: f.i, x: gx + 0.5, y: gy + 0.5, r: Math.sqrt((BOX * BOX) / Math.PI), poly: rect(gx + (1 - BOX) / 2, gy + (1 - BOX) / 2, BOX, BOX) });
}
function discPoly(x: number, y: number, r: number, k = 40): Poly {
  const p: Poly = [];
  for (let i = 0; i < k; i++) p.push(x + r * Math.cos((2 * Math.PI * i) / k), y + r * Math.sin((2 * Math.PI * i) / k));
  return p;
}

/** The free grid square nearest (tx, ty), searching outward ring by ring; ties go to the smaller key. */
function nearestFree(tx: number, ty: number, free: (gx: number, gy: number) => boolean): [number, number] {
  const cx = Math.floor(tx);
  const cy = Math.floor(ty);
  let best: [number, number] | null = null;
  let bd = Infinity;
  for (let r = 0; ; r++) {
    if (best && r - 1 > Math.sqrt(bd)) return best;
    for (let gx = cx - r; gx <= cx + r; gx++)
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r || !free(gx, gy)) continue;
        const d = (gx + 0.5 - tx) ** 2 + (gy + 0.5 - ty) ** 2;
        if (d < bd || (d === bd && best && (gx < best[0] || (gx === best[0] && gy < best[1])))) (bd = d), (best = [gx, gy]);
      }
  }
}

/**
 * Slots within a folder, for the disc and block layouts: a file keeps its slot while it stays in the
 * folder; a newcomer takes the lowest free slot (so holes left by deletions are reused).
 */
class Slots {
  private of = new Map<string, { dir: string; k: number }>();
  assign(ctx: CityCtx, d: SDir): Map<SFile, number> {
    const out = new Map<SFile, number>();
    const used = new Set<number>();
    const rest: SFile[] = [];
    for (const f of bySeq(ctx, d.files)) {
      const s = this.of.get(fkey(ctx, f));
      if (s && s.dir === d.path && !used.has(s.k)) (out.set(f, s.k), used.add(s.k));
      else rest.push(f);
    }
    let k = 0;
    for (const f of rest) {
      while (used.has(k)) k++;
      used.add(k);
      out.set(f, k);
      this.of.set(fkey(ctx, f), { dir: d.path, k });
    }
    return out;
  }
}
const slotCount = (m: Map<SFile, number>) => Math.max(0, ...m.values()) + 1;

// ---- sunflower discs (affinity, rings) ----
const SP = 1 / Math.sqrt(Math.PI); // slot spacing: one unit of area per file
const slotXY = (k: number): [number, number] => [SP * Math.sqrt(k + 0.5) * Math.cos(k * GOLDEN), SP * Math.sqrt(k + 0.5) * Math.sin(k * GOLDEN)];
const discR = (n: number) => SP * Math.sqrt(n) + 0.5;
const FILE_R = 0.4;
function discScene(scene: Scene, d: SDir, slots: Map<SFile, number>, x: number, y: number) {
  for (const [f, k] of slots) {
    const [dx, dy] = slotXY(k);
    scene.marks.push({ f: f.i, x: x + dx, y: y + dy, r: FILE_R, poly: discPoly(x + dx, y + dy, FILE_R, 12) });
  }
  if (d.parent) scene.shapes.push({ k: 'poly', d: d.i, pts: discPoly(x, y, discR(slotCount(slots))) });
}

// ---------------------------------------------------------------- 1. homestead

export function homestead(): FlatStepper {
  const seed = new Map<string, [number, number]>(); // folder -> seed square
  const home = new Map<string, { dir: string; sq: [number, number] }>(); // file -> its square
  return (snap, ctx) => {
    const scene: Scene = { layout: 'homestead', marks: [], shapes: [] };
    const taken = new Set<string>();
    const live = clusters(snap, ctx);
    const keep = new Map<SFile, [number, number]>();
    for (const d of live)
      for (const f of d.files) {
        const h = home.get(fkey(ctx, f));
        if (h && h.dir === d.path) (keep.set(f, h.sq), taken.add(h.sq.join()));
      }
    // seeds of live folders are reserved for their own folder
    const reserved = new Map<string, string>();
    for (const d of live) {
      if (!seed.has(d.path)) {
        if (!d.parent) seed.set(d.path, [0, 0]);
        else {
          const [px, py] = ancestor(d, seed) ?? [0, 0];
          const roomy = (gx: number, gy: number) => {
            for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) if (taken.has(`${x},${y}`) || reserved.has(`${x},${y}`)) return false;
            return true;
          };
          seed.set(d.path, nearestFree(px + 0.5, py + 0.5, roomy));
        }
      }
      reserved.set(seed.get(d.path)!.join(), d.path);
    }
    for (const d of live) {
      const [sx, sy] = seed.get(d.path)!;
      for (const f of bySeq(ctx, d.files)) {
        let sq = keep.get(f);
        if (!sq) {
          sq = nearestFree(sx + 0.5, sy + 0.5, (gx, gy) => {
            const k = `${gx},${gy}`;
            return !taken.has(k) && (reserved.get(k) ?? d.path) === d.path;
          });
          taken.add(sq.join());
          home.set(fkey(ctx, f), { dir: d.path, sq });
        }
        squareMark(scene, f, sq[0], sq[1]);
      }
    }
    return scene;
  };
}

// ---------------------------------------------------------------- 2. flat cells

const CELL_SLACK = 1.3; // region area per file, in grid squares
export function flatCells(): FlatStepper {
  const sites = new Map<string, Site>();
  const home = new Map<string, { dir: string; sq: string }>();
  return (snap, ctx) => {
    const scene: Scene = { layout: 'flat-cells', marks: [], shapes: [] };
    const live = clusters(snap, ctx);
    const n = snap.files.length;
    const R = Math.sqrt((n * CELL_SLACK) / Math.PI);
    const region = discPoly(0, 0, R, 96);
    // a newborn folder's site starts on its parent's (nudged towards its own angle), with the smallest weight
    const known = live.map((d) => sites.get(d.path)).filter((s): s is Site => !!s);
    const low = known.length ? Math.min(...known.map((s) => s[2])) : 0;
    const init: Site[] = [];
    for (const d of live) {
      let s = sites.get(d.path);
      if (!s) {
        const p = ancestor(d, sites) ?? [0.5, 0.5, low];
        const a = angleOf(d.path);
        s = [Math.min(0.98, Math.max(0.02, p[0] + 0.03 * Math.cos(a))), Math.min(0.98, Math.max(0.02, p[1] + 0.03 * Math.sin(a))), low];
        sites.set(d.path, s); // so its own children (born in the same frame) start near it
      }
      init.push(s);
    }
    const { cells, sites: out } = divideEx(region, live.map((d) => d.files.length), live.map((d) => hash(d.path)), init, 0.25);
    live.forEach((d, i) => sites.set(d.path, out[i]));
    const taken = new Set<string>();
    // keepers first, everywhere, so a newcomer never takes a square someone still holds
    const keepers = new Map<SFile, string>();
    live.forEach((d, i) => {
      for (const f of d.files) {
        const h = home.get(fkey(ctx, f));
        if (!h || h.dir !== d.path || taken.has(h.sq)) continue;
        const [gx, gy] = h.sq.split(',').map(Number);
        if (cells[i].length && inside(cells[i], gx + 0.5, gy + 0.5)) (keepers.set(f, h.sq), taken.add(h.sq));
      }
    });
    live.forEach((d, i) => {
      const cell = cells[i];
      const [cx, cy] = cell.length ? centroid(cell) : [0, 0];
      const dist2 = (q: [number, number]) => (q[0] + 0.5 - cx) ** 2 + (q[1] + 0.5 - cy) ** 2 + 1e-9 * (q[0] * 7 + q[1]);
      let inCell: [number, number][] = [];
      if (cell.length >= 6) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < cell.length; k += 2) (x0 = Math.min(x0, cell[k])), (x1 = Math.max(x1, cell[k])), (y0 = Math.min(y0, cell[k + 1])), (y1 = Math.max(y1, cell[k + 1]));
        for (let gx = Math.floor(x0); gx <= Math.ceil(x1); gx++)
          for (let gy = Math.floor(y0); gy <= Math.ceil(y1); gy++) if (!taken.has(`${gx},${gy}`) && inside(cell, gx + 0.5, gy + 0.5)) inCell.push([gx, gy]);
      }
      for (const f of bySeq(ctx, d.files)) {
        let sq = keepers.get(f);
        if (!sq) {
          // the free square nearest the cell's centre, inside the cell while any is left there
          const p = inCell.length ? inCell.reduce((m, q) => (dist2(q) < dist2(m) ? q : m)) : nearestFree(cx, cy, (gx, gy) => !taken.has(`${gx},${gy}`));
          sq = p.join();
          taken.add(sq);
          inCell = inCell.filter((q) => q.join() !== sq);
          home.set(fkey(ctx, f), { dir: d.path, sq });
        }
        const [gx, gy] = sq.split(',').map(Number);
        squareMark(scene, f, gx, gy);
      }
      if (d.parent && cell.length) scene.shapes.push({ k: 'poly', d: d.i, pts: cell });
    });
    return scene;
  };
}
// ---------------------------------------------------------------- 3. affinity

const GAP = 0.3; // between discs
const PARTNERS = 4; // springs per folder: its strongest co-change partners
export function affinity(): FlatStepper {
  const pos = new Map<string, [number, number]>();
  const slots = new Slots();
  return (snap, ctx) => {
    const scene: Scene = { layout: 'affinity', marks: [], shapes: [] };
    const live = clusters(snap, ctx);
    const S = live.map((d) => slots.assign(ctx, d));
    const r = S.map((s) => discR(slotCount(s)));
    const idx = new Map(live.map((d, i) => [d.path, i]));
    const P = live.map(() => [0, 0] as [number, number]);
    const pinned = live.map((d) => !d.parent);
    const springs: [number, number, number][] = [];
    live.forEach((d, i) => {
      for (const [o, w] of ctx.affinity(d.path).filter(([o]) => idx.has(o)).slice(0, PARTNERS)) springs.push([i, idx.get(o)!, w]);
    });
    // place: old folders where they were; a newborn beside its strongest partner already placed (else its parent)
    live.forEach((d, i) => {
      const p = pos.get(d.path);
      if (p) return void (P[i] = [...p]);
      if (!d.parent) return void (P[i] = [0, 0]);
      const partner = ctx.affinity(d.path).find(([o]) => idx.has(o) && (pos.has(o) || idx.get(o)! < i));
      let j = partner ? idx.get(partner[0])! : -1;
      if (j < 0) for (let a = d.parent; a && j < 0; a = a.parent) j = idx.get(a.path) ?? -1;
      const [bx, by] = j >= 0 ? P[j] : [0, 0];
      const a = angleOf(d.path);
      const dist = (j >= 0 ? r[j] : 0) + r[i] + GAP;
      P[i] = [bx + dist * Math.cos(a), by + dist * Math.sin(a)];
      pos.set(d.path, P[i]);
    });
    const homeP = P.map((p) => [...p] as [number, number]);
    const collide = () => {
      for (let i = 0; i < P.length; i++)
        for (let j = i + 1; j < P.length; j++) {
          const dx = P[j][0] - P[i][0];
          const dy = P[j][1] - P[i][1];
          const d = Math.hypot(dx, dy) || 1e-6;
          const over = r[i] + r[j] + GAP - d;
          if (over <= 0) continue;
          const ux = d > 1e-6 ? dx / d : Math.cos(angleOf(live[j].path));
          const uy = d > 1e-6 ? dy / d : Math.sin(angleOf(live[j].path));
          // the bigger disc gives way less
          const ai = r[i] ** 2;
          const aj = r[j] ** 2;
          let si = pinned[i] ? 0 : aj / (ai + aj);
          let sj = pinned[j] ? 0 : ai / (ai + aj);
          if (pinned[i]) sj = 1;
          if (pinned[j]) si = 1;
          P[i][0] -= ux * over * si;
          P[i][1] -= uy * over * si;
          P[j][0] += ux * over * sj;
          P[j][1] += uy * over * sj;
        }
    };
    for (let it = 0; it < 80; it++) {
      for (const [i, j, w] of springs) {
        const dx = P[j][0] - P[i][0];
        const dy = P[j][1] - P[i][1];
        const d = Math.hypot(dx, dy) || 1;
        const ext = d - (r[i] + r[j] + GAP);
        if (ext <= 0) continue;
        const k = 0.03 * w * ext;
        if (!pinned[i]) (P[i][0] += (dx / d) * k), (P[i][1] += (dy / d) * k);
        if (!pinned[j]) (P[j][0] -= (dx / d) * k), (P[j][1] -= (dy / d) * k);
      }
      for (let i = 0; i < P.length; i++) if (!pinned[i]) (P[i][0] += 0.08 * (homeP[i][0] - P[i][0])), (P[i][1] += 0.08 * (homeP[i][1] - P[i][1]));
      collide();
    }
    for (let it = 0; it < 60; it++) collide();
    live.forEach((d, i) => {
      pos.set(d.path, P[i]);
      discScene(scene, d, S[i], P[i][0], P[i][1]);
    });
    return scene;
  };
}

// ---------------------------------------------------------------- 4. rings

export function rings(): FlatStepper {
  const born = new Map<string, { k: number; a: number; dist: number }>();
  const slots = new Slots();
  return (snap, ctx) => {
    const scene: Scene = { layout: 'rings', marks: [], shapes: [] };
    const live = clusters(snap, ctx);
    for (const d of live)
      if (!born.has(d.path)) {
        const k = born.size;
        born.set(d.path, { k, a: k * GOLDEN, dist: 0 });
      }
    const order = [...live].sort((a, b) => born.get(a.path)!.k - born.get(b.path)!.k);
    const placed: { x: number; y: number; r: number }[] = [];
    for (const d of order) {
      const b = born.get(d.path)!;
      const s = slots.assign(ctx, d);
      const r = discR(slotCount(s));
      // born at the first free spot along its ray; after that, older discs hold their ground and a
      // younger disc they now touch slides outward along its own ray
      const clash = (x: number, y: number) => placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + GAP);
      let dist = b.dist;
      if (d.parent) while (clash(dist * Math.cos(b.a), dist * Math.sin(b.a))) dist += 0.25;
      b.dist = dist; // a ratchet: never slides back in
      const x = dist * Math.cos(b.a);
      const y = dist * Math.sin(b.a);
      placed.push({ x, y, r });
      discScene(scene, d, s, x, y);
    }
    return scene;
  };
}

// ---------------------------------------------------------------- 5. streets

const ROAD = 1; // between the two blocks facing each other across a street... and between blocks along it
export function streets(): FlatStepper {
  type Lot = { dir: string | null; len: number }; // dir null: a vacant lot left by a deleted folder
  const streetsOf: Lot[][] = []; // street s: east (s even) or west (s odd) of x = 0, on row pair floor(s/2)
  const where = new Map<string, number>(); // folder -> street
  const slots = new Slots();
  const rowY = (s: number) => {
    const p = Math.floor(s / 2);
    return (p % 2 ? -1 : 1) * Math.ceil(p / 2) * (2 + ROAD);
  };
  const used = (s: number) => streetsOf[s].reduce((t, l) => t + l.len + ROAD, 0);
  return (snap, ctx) => {
    const scene: Scene = { layout: 'streets', marks: [], shapes: [] };
    const live = clusters(snap, ctx);
    const alive = new Set(live.map((d) => d.path));
    for (const st of streetsOf) for (const l of st) if (l.dir !== null && !alive.has(l.dir)) (where.delete(l.dir), (l.dir = null));
    const cap = Math.max(8, Math.round(1.2 * Math.sqrt(snap.files.length)));
    const S = new Map(live.map((d) => [d.path, slots.assign(ctx, d)]));
    for (const d of live) {
      const need = Math.ceil(slotCount(S.get(d.path)!) / 2);
      const s0 = where.get(d.path);
      if (s0 !== undefined) {
        const lot = streetsOf[s0].find((l) => l.dir === d.path)!;
        lot.len = Math.max(lot.len, need); // a block only lengthens: what lies beyond it slides along
        continue;
      }
      // the parent's street if it has room, else the nearest street with room, else a new street
      const ps = ancestor(d, where) ?? 0;
      const fits = (s: number) => streetsOf[s].some((l) => l.dir === null && l.len >= need) || used(s) + need <= cap;
      let best = -1;
      for (let s = 0; s < streetsOf.length; s++) {
        if (!fits(s)) continue;
        const dist = Math.abs(rowY(s) - rowY(ps)) + (s % 2 !== ps % 2 ? 0.5 : 0);
        if (best < 0 || dist < Math.abs(rowY(best) - rowY(ps)) + (best % 2 !== ps % 2 ? 0.5 : 0)) best = s;
      }
      if (best < 0) best = streetsOf.push([]) - 1;
      const st = streetsOf[best];
      const vacant = st.find((l) => l.dir === null && l.len >= need);
      if (vacant) vacant.dir = d.path;
      else st.push({ dir: d.path, len: need });
      where.set(d.path, best);
    }
    const byPath = new Map(live.map((d) => [d.path, d]));
    streetsOf.forEach((st, s) => {
      const east = s % 2 === 0;
      const y = rowY(s);
      let x = east ? 0 : -ROAD;
      for (const l of st) {
        const x0 = east ? x : x - l.len;
        const d = l.dir === null ? undefined : byPath.get(l.dir);
        if (d) {
          for (const [f, k] of S.get(d.path)!) {
            // lots fill outward from the street's start, two rows back to back
            const col = east ? x0 + Math.floor(k / 2) : x0 + l.len - 1 - Math.floor(k / 2);
            squareMark(scene, f, col, y + (k % 2));
          }
        }
        x = east ? x + l.len + ROAD : x - l.len - ROAD;
      }
    });
    return scene;
  };
}

// ---------------------------------------------------------------- 6. hilbert

const ORDER = 1 << 10;
function d2xy(d: number): [number, number] {
  let x = 0;
  let y = 0;
  for (let s = 1, t = d; s < ORDER; s *= 2) {
    const rx = 1 & (t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) (x = s - 1 - x), (y = s - 1 - y);
      [x, y] = [y, x];
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}
export function hilbert(): FlatStepper {
  const runs = new Map<string, [number, number][]>(); // folder -> runs [start, length] on the curve
  const owner: (string | undefined)[] = []; // curve index -> folder owning it
  const home = new Map<string, { dir: string; d: number }>();
  const freeRun = (from: number, len: number) => {
    for (let s = from; ; s++) {
      let ok = true;
      for (let k = 0; k < len; k++)
        if (owner[s + k] !== undefined) {
          ok = false;
          s += k;
          break;
        }
      if (ok) return s;
    }
  };
  const claim = (dir: string, s: number, len: number) => {
    for (let k = 0; k < len; k++) owner[s + k] = dir;
    runs.get(dir)!.push([s, len]);
  };
  return (snap, ctx) => {
    const scene: Scene = { layout: 'hilbert', marks: [], shapes: [] };
    const live = clusters(snap, ctx);
    const alive = new Set(live.map((d) => d.path));
    for (const [dir, rs] of runs)
      if (!alive.has(dir)) {
        for (const [s, len] of rs) for (let k = 0; k < len; k++) owner[s + k] = undefined;
        runs.delete(dir);
      }
    const at = new Map<number, SFile>();
    const rest: [SDir, SFile][] = [];
    for (const d of live)
      for (const f of bySeq(ctx, d.files)) {
        const h = home.get(fkey(ctx, f));
        if (h && h.dir === d.path && runs.has(d.path) && !at.has(h.d)) at.set(h.d, f);
        else rest.push([d, f]);
      }
    for (const [d, f] of rest) {
      if (!runs.has(d.path)) {
        runs.set(d.path, []);
        const after = (ancestor(d, runs) ?? []).reduce((m, [s, len]) => Math.max(m, s + len), 0);
        const len = Math.max(4, Math.ceil(d.files.length * 1.25));
        claim(d.path, freeRun(after, len), len);
      }
      const rs = runs.get(d.path)!;
      let spot = -1;
      for (const [s, len] of rs) {
        for (let k = s; k < s + len && spot < 0; k++) if (!at.has(k)) spot = k;
        if (spot >= 0) break;
      }
      if (spot < 0) {
        const [s, len] = rs[rs.length - 1];
        const end = s + len;
        if (owner[end] === undefined) {
          // grow the last run in place while the curve beyond it is free
          owner[end] = d.path;
          rs[rs.length - 1] = [s, len + 1];
          spot = end;
        } else {
          const total = rs.reduce((t, [, l]) => t + l, 0);
          const grow = Math.max(4, Math.ceil(total / 2));
          spot = freeRun(end, grow);
          claim(d.path, spot, grow);
        }
      }
      at.set(spot, f);
      home.set(fkey(ctx, f), { dir: d.path, d: spot });
    }
    for (const [k, f] of at) {
      const [x, y] = d2xy(k);
      squareMark(scene, f, x, y);
    }
    // marks in file order, as the writer expects one per file (any order is fine, but keep it stable)
    scene.marks.sort((a, b) => a.f - b.f);
    return scene;
  };
}

export const FLAT: { name: string; title: string; blurb: string; make: () => FlatStepper }[] = [
  {
    name: 'homestead',
    title: 'Homestead',
    blurb: 'Each folder gets a seed square when it first appears, on free ground next to its parent’s seed. Every new file claims the free square nearest its folder’s seed and keeps it for life, so nothing ever moves; the price is that neighbours grow into each other’s gaps.',
    make: homestead,
  },
  {
    name: 'flat-cells',
    title: 'Flat cells',
    blurb: 'One flat cells diagram of every folder at once, no nesting. A new folder’s site is born on its parent’s site and then finds its own place; sites drift with inertia. Files sit on grid squares inside their folder’s cell and keep them while the cell still covers them.',
    make: flatCells,
  },
  {
    name: 'affinity',
    title: 'Affinity',
    blurb: 'Folders are discs placed by co-change, not ancestry: a new folder appears beside the folder it has most often been committed with so far, and springs keep its four strongest partners close. Each disc holds its spot with inertia; the root disc is pinned.',
    make: affinity,
  },
  {
    name: 'rings',
    title: 'Rings',
    blurb: 'Chronology only, like growth rings: folders take positions on a golden-angle spiral in the order they appeared, at the first free spot along their ray. A growing disc never moves; a younger disc it bumps into slides outward along its own ray and stays there.',
    make: rings,
  },
  {
    name: 'streets',
    title: 'Streets',
    blurb: 'Each folder is a block of two rows of lots along a street. A new folder joins its parent’s street while it has room, else the nearest street with room, else a new street. A growing block only pushes the blocks after it along the same street; a dead folder leaves a vacant lot for the next one.',
    make: streets,
  },
  {
    name: 'hilbert',
    title: 'Hilbert allocator',
    blurb: 'The city is one Hilbert curve, and folders allocate runs of it like a file system allocates disk blocks: a new folder takes the first free run after its parent’s, and a full folder grows its run in place or takes a new one further on. Files never move; folders fragment instead.',
    make: hilbert,
  },
];
