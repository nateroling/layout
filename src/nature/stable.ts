// Stable variants of the nature layouts (experiment). Three per layout, each trading some of the
// original's look for less movement as the repo changes. They may remember earlier frames (history)
// but never see later ones.
//
// A variant is a factory: make() returns a stepper that is called once per frame, in commit order, with
// that frame's Snapshot. The stepper keeps whatever memory it needs between calls. Files are named
// across frames by their identity (rename-following id, ctx.id), folders by path; ctx.seq gives each
// file and folder a birth number (the order they first appeared), used wherever the originals sort by
// name or size.

import { type CellsMemory, cellsWith } from './cells.ts';
import { Colony } from './coral.ts';
import { NATURE } from './index.ts';
import { type Disc, enclosing, fileRadius, GOLDEN_ANGLE, hash, rayFree, rng, type Scene, type SDir, type SFile, type Snapshot } from './model.ts';

export interface StepCtx {
  id: (f: SFile) => number; // identity across frames (follows renames)
  seq: (key: string) => number; // birth number of 'f:<id>' or 'd:<path>'
}
export type Stepper = (snap: Snapshot, ctx: StepCtx) => Scene;
export interface Variant {
  family: string; // the original layout's name
  name: string;
  title: string;
  blurb: string;
  make: () => Stepper;
}

const fkey = (ctx: StepCtx, f: SFile) => `f:${ctx.id(f)}`;
const dkey = (d: SDir) => `d:${d.path}`;

// ---------------------------------------------------------------- sunflower

const SF_GAP = 0.12;
const SF_PAD = 0.3;
const SF_LOOK = 12; // golden-angle slots a newcomer may choose from

/**
 * Sunflower with florets and heads on one spiral in birth order (not size order, not files-then-heads),
 * and no re-centring: the root head stays at the origin. A newcomer takes the best (innermost) of
 * the next 12 golden-angle slots. `sticky`: an item keeps last frame's spot
 * (pushed straight outward if something grew into it), and a newcomer takes the head's next unused
 * golden-angle slot. `ghosts`: a vanished item leaves its disc behind as an empty slot, which a later
 * newcomer that fits reuses, so heads never shrink.
 */
function sunflowerVariant(o: { sticky: boolean; ghosts: boolean }): () => Stepper {
  return () => {
    const mem = new Map<string, Map<string, Disc>>();
    const ghostMem = new Map<string, Disc[]>();
    const slots = new Map<string, number>();
    return (snap, ctx) => {
      const scene: Scene = { layout: 'sunflower', marks: [], shapes: [] };
      type Head = { dir: SDir; R: number; files: { f: number; d: Disc }[]; kids: { h: Head; d: Disc }[] };
      const grow = (dir: SDir): Head => {
        const hk = dkey(dir);
        const kids = dir.dirs.map(grow);
        type Item = { key: string; r: number; f?: number; h?: Head };
        const items: Item[] = [...dir.files.map((f) => ({ key: fkey(ctx, f), r: fileRadius(f.size), f: f.i })), ...kids.map((h) => ({ key: dkey(h.dir), r: h.R + 0.2, h }))];
        items.sort((a, b) => ctx.seq(a.key) - ctx.seq(b.key));
        const old = mem.get(hk) ?? new Map<string, Disc>();
        const here = new Set(items.map((i) => i.key));
        const ghosts = o.ghosts ? [...(ghostMem.get(hk) ?? [])] : [];
        if (o.ghosts) for (const [k, d] of old) if (!here.has(k)) ghosts.push(d);
        const placed: Disc[] = [...ghosts];
        const now = new Map<string, Disc>();
        const head: Head = { dir, R: 0, files: [], kids: [] };
        let n = o.sticky ? (slots.get(hk) ?? 0) : 0;
        for (const it of items) {
          let x: number;
          let y: number;
          const prev = o.sticky ? old.get(it.key) : undefined;
          const ghost = !prev && o.ghosts ? ghosts.findIndex((g) => g.r >= it.r * 0.9) : -1;
          if (prev || ghost >= 0) {
            const at = prev ?? ghosts[ghost];
            if (ghost >= 0) {
              placed.splice(placed.indexOf(ghosts[ghost]), 1);
              ghosts.splice(ghost, 1);
            }
            const len = Math.hypot(at.x, at.y);
            const dx = len > 1e-9 ? at.x / len : 1;
            const dy = len > 1e-9 ? at.y / len : 0;
            const t = rayFree(placed, 0, 0, dx, dy, it.r, SF_GAP, len);
            x = dx * t;
            y = dy * t;
          } else {
            // the next few golden-angle slots, take the one nearest the centre (so a big newcomer
            // doesn't have to clear the whole head along one fixed ray)
            let best = { t: Infinity, a: 0, j: 0 };
            for (let j = 0; j < (placed.length ? SF_LOOK : 1); j++) {
              const a = (n + j) * GOLDEN_ANGLE;
              const t = placed.length ? rayFree(placed, 0, 0, Math.cos(a), Math.sin(a), it.r, SF_GAP) : 0;
              if (t < best.t - 1e-9) best = { t, a, j };
            }
            x = Math.cos(best.a) * best.t;
            y = Math.sin(best.a) * best.t;
            n += 1;
          }
          const d = { x, y, r: it.r };
          placed.push(d);
          now.set(it.key, d);
          if (it.h) head.kids.push({ h: it.h, d });
          else head.files.push({ f: it.f!, d });
        }
        if (o.sticky) slots.set(hk, n);
        mem.set(hk, now);
        ghostMem.set(hk, ghosts);
        head.R = enclosing(placed) + SF_PAD;
        return head;
      };
      const emit = (h: Head, ox: number, oy: number) => {
        scene.shapes.push({ k: 'disc', d: h.dir.i, x: ox, y: oy, r: h.R });
        for (const f of h.files) scene.marks.push({ f: f.f, x: ox + f.d.x, y: oy + f.d.y, r: f.d.r });
        for (const k of h.kids) emit(k.h, ox + k.d.x, oy + k.d.y);
      };
      emit(grow(snap.root), 0, 0);
      return scene;
    };
  };
}

// ---------------------------------------------------------------- tree

const LEAF_STEP = 1.2;
const T_WIDTH = 0.22;
const SPREAD = (80 * Math.PI) / 180;
const NODE_STEP = 1.8; // apical: distance between nodes

/**
 * Tree in birth order, without the final leaf relaxation (which nudges every leaf in the crown).
 * Leaves sit at fixed distances from the branch base, so a new leaf goes at the end instead of
 * respacing the others; subfolders branch from the tip. `ratchet`: each folder's slice of the crown and
 * branch length only ever grow (max over history), so a shrinking sibling doesn't swing its neighbours.
 */
function treeVariant(o: { ratchet: boolean }): () => Stepper {
  return () => {
    const wMax = new Map<string, number>();
    const lenMax = new Map<string, number>();
    return (snap, ctx) => {
      const scene: Scene = { layout: 'tree', marks: [], shapes: [] };
      const weight = (d: SDir) => {
        const w = Math.sqrt(d.count);
        if (!o.ratchet) return w;
        const m = Math.max(w, wMax.get(dkey(d)) ?? 0);
        wMax.set(dkey(d), m);
        return m;
      };
      const grow = (d: SDir, bx: number, by: number, a0: number, a1: number, heading: number) => {
        const files = [...d.files].sort((a, b) => ctx.seq(fkey(ctx, a)) - ctx.seq(fkey(ctx, b)));
        let len = Math.max(3, Math.ceil(files.length / 2) * LEAF_STEP + 1.5) + 3.2 * Math.sqrt(d.count) * Math.pow(0.88, d.depth);
        if (o.ratchet) {
          len = Math.max(len, lenMax.get(dkey(d)) ?? 0);
          lenMax.set(dkey(d), len);
        }
        const dx = Math.sin(heading);
        const dy = -Math.cos(heading);
        const tx = bx + dx * len;
        const ty = by + dy * len;
        const w0 = T_WIDTH * Math.sqrt(d.count) + 0.15;
        const kidsW = d.dirs.length ? Math.sqrt(d.dirs.reduce((s, c) => s + c.count, 0)) * T_WIDTH + 0.15 : 0.15;
        scene.shapes.push({ k: 'line', d: d.i, pts: [bx, by, (bx + tx) / 2, (by + ty) / 2, tx, ty], w: [w0, (w0 + kidsW) / 2, kidsW] });
        files.forEach((f, n) => {
          const side = n % 2 ? -1 : 1;
          const along = 1.2 + Math.floor(n / 2) * LEAF_STEP;
          const r = fileRadius(f.size);
          const off = r + 0.25 + (T_WIDTH * Math.sqrt(d.count)) / 2;
          const la = heading + side * (Math.PI / 2 - 0.6);
          scene.marks.push({ f: f.i, x: bx + dx * along + Math.sin(la) * off, y: by + dy * along - Math.cos(la) * off, r });
        });
        const kids = [...d.dirs].sort((a, b) => ctx.seq(dkey(a)) - ctx.seq(dkey(b)));
        const ws = kids.map(weight);
        const total = ws.reduce((s, w) => s + w, 0);
        let a = a0;
        kids.forEach((c, k) => {
          const span = ((a1 - a0) * ws[k]) / total;
          const h = heading + (a + span / 2 - heading) * 0.75;
          grow(c, tx, ty, a, a + span, h);
          a += span;
        });
      };
      grow(snap.root, 0, 0, -SPREAD, SPREAD, 0);
      return scene;
    };
  };
}

/**
 * Apical growth: plants grow at the tip, and what has grown stays put. Each folder is a branch with a
 * row of nodes; every file or subfolder takes the next node up the branch when it first appears (a
 * leaf, or a side branch, alternating left and right), and keeps that node and its heading for good.
 * A vanished item leaves its node empty for the next newcomer. Nothing is weighed against its
 * siblings, so growth elsewhere never moves a branch; subtrees may cross instead.
 */
function apicalTree(): () => Stepper {
  return () => {
    const nodes = new Map<string, string[]>(); // folder -> item key per node ('' = empty)
    const heading = new Map<string, number>(); // folder -> heading, fixed at birth
    return (snap, ctx) => {
      const scene: Scene = { layout: 'tree', marks: [], shapes: [] };
      const grow = (d: SDir, bx: number, by: number, h: number) => {
        const row = nodes.get(dkey(d)) ?? [];
        const items = new Map<string, SFile | SDir>();
        for (const f of d.files) items.set(fkey(ctx, f), f);
        for (const c of d.dirs) items.set(dkey(c), c);
        for (let j = 0; j < row.length; j++) if (row[j] && !items.has(row[j])) row[j] = '';
        const fresh = [...items.keys()].filter((k) => !row.includes(k)).sort((a, b) => ctx.seq(a) - ctx.seq(b));
        for (const k of fresh) {
          const j = row.indexOf('');
          if (j >= 0) row[j] = k;
          else row.push(k);
        }
        nodes.set(dkey(d), row);
        const len = (row.length + 1) * NODE_STEP;
        const dx = Math.sin(h);
        const dy = -Math.cos(h);
        const w0 = T_WIDTH * Math.sqrt(d.count) + 0.15;
        scene.shapes.push({ k: 'line', d: d.i, pts: [bx, by, bx + (dx * len) / 2, by + (dy * len) / 2, bx + dx * len, by + dy * len], w: [w0, w0 * 0.6, 0.15] });
        row.forEach((k, j) => {
          if (!k) return;
          const side = j % 2 ? -1 : 1;
          const px = bx + dx * (j + 1) * NODE_STEP;
          const py = by + dy * (j + 1) * NODE_STEP;
          const it = items.get(k)!;
          if ('size' in it) {
            const r = fileRadius(it.size);
            const off = r + 0.25 + w0 / 2;
            const la = h + side * (Math.PI / 2 - 0.6);
            scene.marks.push({ f: it.i, x: px + Math.sin(la) * off, y: py - Math.cos(la) * off, r });
          } else {
            let ch = heading.get(k);
            if (ch === undefined) {
              ch = h + side * (0.9 - 0.08 * Math.min(d.depth, 5));
              ch = Math.max(-1.6, Math.min(1.6, ch)); // never grow downward
              heading.set(k, ch);
            }
            grow(it, px, py, ch);
          }
        });
      };
      grow(snap.root, 0, 0, 0);
      return scene;
    };
  };
}

// ---------------------------------------------------------------- cells

function cellsVariant(o: { inertia?: number; smooth?: number }): () => Stepper {
  return () => {
    const mem: CellsMemory = { sites: new Map(), weights: new Map() };
    return (snap, ctx) => cellsWith(snap, { keyOf: (f) => fkey(ctx, f), mem, inertia: o.inertia, smooth: o.smooth });
  };
}

// ---------------------------------------------------------------- coral

/**
 * Coral that remembers: polyps stay where they settled. Each frame, polyps of vanished files die, and
 * new files settle by the original rule (on their folder's polyps, else the nearest ancestor's).
 * `keepMoved`: a file that moved to another folder keeps its polyp (zero movement, but the colony
 * no longer matches the tree); otherwise it dies and resettles in its new folder.
 */
function coralVariant(o: { keepMoved: boolean }): () => Stepper {
  return () => {
    const col = new Colony();
    const at = new Map<string, { i: number; dir: string; from: string }>(); // file key -> polyp
    return (snap, ctx) => {
      const scene: Scene = { layout: 'coral', marks: [], shapes: [] };
      const live = new Map(snap.files.map((f) => [fkey(ctx, f), f]));
      for (const [k, p] of at) {
        const f = live.get(k);
        if (!f || (!o.keepMoved && f.dir.path !== p.dir)) {
          col.remove(p.i);
          at.delete(k);
        } else p.dir = f.dir.path;
      }
      const owned = new Map<string, number[]>();
      for (const [, p] of at) {
        const a = owned.get(p.dir);
        if (a) a.push(p.i);
        else owned.set(p.dir, [p.i]);
      }
      const anchorsOf = (d: SDir | null): number[] => {
        for (let e = d; e; e = e.parent) {
          const a = owned.get(e.path);
          if (a?.length) return a;
        }
        return col.live();
      };
      const queue: SDir[] = [snap.root];
      while (queue.length) {
        const d = queue.shift()!;
        const fresh = d.files.filter((f) => !at.has(fkey(ctx, f))).sort((a, b) => ctx.seq(fkey(ctx, a)) - ctx.seq(fkey(ctx, b)));
        for (const f of fresh) {
          const k = fkey(ctx, f);
          const rand = rng(hash(k));
          const mine = owned.get(d.path) ?? [];
          const parent = anchorsOf(d.parent);
          const sets = mine.length ? [mine, parent] : [parent.slice(-12), parent];
          const r = fileRadius(f.size);
          const s = col.settle(r, [...sets, col.live()], rand);
          const i = col.add({ f: -1, x: s.x, y: s.y, r });
          const from = s.from >= 0 ? ([...at].find(([, p]) => p.i === s.from)?.[0] ?? '') : '';
          at.set(k, { i, dir: d.path, from });
          mine.push(i);
          owned.set(d.path, mine);
        }
        queue.push(...d.dirs);
      }
      for (const f of snap.files) {
        const p = at.get(fkey(ctx, f))!;
        const q = col.polyps[p.i]!;
        scene.marks.push({ f: f.i, x: q.x, y: q.y, r: q.r });
        const anchor = p.from ? at.get(p.from) : undefined;
        if (anchor) {
          const a = col.polyps[anchor.i]!;
          const af = live.get(p.from)!;
          scene.shapes.push({ k: 'line', d: f.dir.i, pts: [a.x, a.y, q.x, q.y], w: [Math.min(a.r, q.r) * 0.5, Math.min(a.r, q.r) * 0.5], a: af.i, b: f.i });
        }
      }
      return scene;
    };
  };
}

/** Coral replayed in birth order: every frame regrows the colony from scratch, oldest file first, each with its own random stream. */
function coralBirth(): () => Stepper {
  return () => (snap, ctx) => {
    const scene: Scene = { layout: 'coral', marks: [], shapes: [] };
    const col = new Colony();
    const owned = new Map<string, number[]>();
    const fileAt: number[] = [];
    const files = [...snap.files].sort((a, b) => ctx.seq(fkey(ctx, a)) - ctx.seq(fkey(ctx, b)));
    for (const f of files) {
      let anchors: number[] = [];
      for (let e: SDir | null = f.dir; e; e = e.parent) {
        const a = owned.get(e.path);
        if (a?.length) {
          anchors = e === f.dir ? a : a.slice(-12);
          break;
        }
      }
      const r = fileRadius(f.size);
      const s = col.settle(r, [anchors, col.live()], rng(hash(fkey(ctx, f))));
      const i = col.add({ f: f.i, x: s.x, y: s.y, r });
      fileAt[i] = f.i;
      const mine = owned.get(f.dir.path) ?? [];
      mine.push(i);
      owned.set(f.dir.path, mine);
      scene.marks.push({ f: f.i, x: s.x, y: s.y, r });
      if (s.from >= 0) {
        const q = col.polyps[s.from]!;
        scene.shapes.push({ k: 'line', d: f.dir.i, pts: [q.x, q.y, s.x, s.y], w: [Math.min(q.r, r) * 0.5, Math.min(q.r, r) * 0.5], a: fileAt[s.from], b: f.i });
      }
    }
    return scene;
  };
}

// ---------------------------------------------------------------- galaxy

const G_ARMS = 3;
const G_B = Math.tan((17 * Math.PI) / 180);
const G_K = Math.sqrt(1 + G_B * G_B) / G_B;

/**
 * Galaxy with a fixed number of arms (3). Each top-level folder is assigned an arm by birth (1st, 2nd,
 * 3rd, 4th → arm 1...), and its folders' star clusters are strung along that arm in birth order, so a
 * new folder joins at the arm's outer end. Stars inside a cluster go in birth order too. No relaxation
 * between clusters.
 *   mode 'birth'   stateless: spacing along the arm follows the clusters' current sizes.
 *   mode 'ratchet' a cluster's spacing is the largest it has ever been, and the bulge never shrinks, so
 *                  clusters only move when an older cluster on their arm outgrows its record.
 *   mode 'orbit'   a cluster's spot on its arm is fixed when it first appears (after the arm's last
 *                  cluster) and never changes; a vanished cluster leaves a gap.
 */
function galaxyVariant(mode: 'birth' | 'ratchet' | 'orbit'): () => Stepper {
  return () => {
    const armOf = new Map<string, number>();
    const Rmax = new Map<string, number>();
    const fixed = new Map<string, { arm: number; s: number }>();
    const armEnd = new Array(G_ARMS).fill(0);
    let bulgeMax = 0;
    return (snap, ctx) => {
      const scene: Scene = { layout: 'galaxy', marks: [], shapes: [] };
      const stars = (d: SDir) => {
        const files = [...d.files].sort((a, b) => ctx.seq(fkey(ctx, a)) - ctx.seq(fkey(ctx, b)));
        const placed: Disc[] = [];
        files.forEach((f, n) => {
          const r = fileRadius(f.size);
          const a = n * GOLDEN_ANGLE;
          const t = n ? rayFree(placed, 0, 0, Math.cos(a), Math.sin(a), r, 0.1) : 0;
          placed.push({ x: Math.cos(a) * t, y: Math.sin(a) * t, r });
        });
        return { files, placed, R: enclosing(placed) };
      };
      const put = (d: SDir, cx: number, cy: number) => {
        const s = stars(d);
        s.files.forEach((f, n) => scene.marks.push({ f: f.i, x: cx + s.placed[n].x, y: cy + s.placed[n].y, r: s.placed[n].r }));
      };
      const bulge = stars(snap.root);
      bulgeMax = mode === 'birth' ? bulge.R : Math.max(bulgeMax, bulge.R);
      put(snap.root, 0, 0);
      const r0 = bulgeMax + 2;
      // arms by top-level folder birth
      const tops = [...snap.root.dirs].sort((a, b) => ctx.seq(dkey(a)) - ctx.seq(dkey(b)));
      tops.forEach((t, k) => {
        if (mode === 'birth') armOf.set(t.path, k % G_ARMS);
        else if (!armOf.has(t.path)) armOf.set(t.path, armOf.size % G_ARMS);
      });
      const arms: SDir[][] = Array.from({ length: G_ARMS }, () => []);
      const visit = (d: SDir, arm: number) => {
        if (d.files.length) arms[arm].push(d);
        d.dirs.forEach((c) => visit(c, arm));
      };
      for (const t of tops) visit(t, armOf.get(t.path)!);
      const spot = (arm: number, s: number) => {
        const phi = Math.log(1 + s / (r0 * G_K)) / G_B;
        const r = r0 * Math.exp(G_B * phi);
        const th = (2 * Math.PI * arm) / G_ARMS + phi;
        return { th, r };
      };
      arms.forEach((list, arm) => {
        list.sort((a, b) => ctx.seq(dkey(a)) - ctx.seq(dkey(b)));
        const trail: number[] = [Math.cos((2 * Math.PI * arm) / G_ARMS) * bulgeMax, Math.sin((2 * Math.PI * arm) / G_ARMS) * bulgeMax];
        const widths: number[] = [1];
        let s = 0;
        let prevR = 0;
        const along: { s: number; x: number; y: number; w: number }[] = [];
        for (const d of list) {
          const R = stars(d).R;
          let at: number;
          if (mode === 'orbit') {
            let f = fixed.get(d.path);
            if (!f || f.arm !== arm) {
              f = { arm, s: armEnd[arm] + R + 0.6 };
              armEnd[arm] = f.s + R;
              fixed.set(d.path, f);
            }
            at = f.s;
          } else {
            const Rs = mode === 'ratchet' ? Math.max(R, Rmax.get(d.path) ?? 0) : R;
            if (mode === 'ratchet') Rmax.set(d.path, Rs);
            s += prevR + Rs + 0.6;
            prevR = Rs;
            at = s;
          }
          const { th, r } = spot(arm, at);
          const jitter = ((hash(d.path) % 1000) / 1000 - 0.5) * R * 0.8;
          put(d, Math.cos(th) * (r + jitter), Math.sin(th) * (r + jitter));
          along.push({ s: at, x: Math.cos(th) * r, y: Math.sin(th) * r, w: R * 1.6 + 1 });
        }
        along.sort((a, b) => a.s - b.s);
        for (const p of along) {
          trail.push(p.x, p.y);
          widths.push(p.w);
        }
        if (trail.length > 2) scene.shapes.push({ k: 'line', d: 0, pts: trail, w: widths });
      });
      return scene;
    };
  };
}

// ---------------------------------------------------------------- registry

const original = (name: string): (() => Stepper) => {
  const L = NATURE.find((l) => l.name === name)!;
  return () => (snap) => L.run(snap);
};

export const VARIANTS: Variant[] = [
  ...NATURE.map((L) => ({ family: L.name, name: L.name, title: L.title, blurb: 'The original: laid out from scratch every frame.', make: original(L.name) })),
  {
    family: 'sunflower',
    name: 'sunflower-birth',
    title: 'Birth order',
    blurb: 'Files and subfolder heads share one spiral in the order they appeared (each taking the innermost of the next few golden-angle slots), and heads are not re-centred. A newcomer lands after everything older, so it only nudges things born after it.',
    make: sunflowerVariant({ sticky: false, ghosts: false }),
  },
  {
    family: 'sunflower',
    name: 'sunflower-sticky',
    title: 'Sticky',
    blurb: 'Every floret and head keeps last frame’s spot; if something grew into it, it is pushed straight outward. A newcomer takes the innermost of the head’s next few golden-angle slots.',
    make: sunflowerVariant({ sticky: true, ghosts: false }),
  },
  {
    family: 'sunflower',
    name: 'sunflower-ghosts',
    title: 'Sticky + seed gaps',
    blurb: 'Sticky, and a deleted file or folder leaves its empty seat behind. Newcomers that fit take an empty seat first, so heads never shrink and neighbours never close the gap.',
    make: sunflowerVariant({ sticky: true, ghosts: true }),
  },
  {
    family: 'tree',
    name: 'tree-birth',
    title: 'Birth order',
    blurb: 'Branches and leaves in the order they appeared, leaves at fixed spacing from the branch base, and no leaf shuffling at the end. New growth goes on the end of the row.',
    make: treeVariant({ ratchet: false }),
  },
  {
    family: 'tree',
    name: 'tree-ratchet',
    title: 'Ratchet',
    blurb: 'Birth order, and each folder’s slice of the crown and branch length only ever grow, so a shrinking sibling no longer swings its neighbours around.',
    make: treeVariant({ ratchet: true }),
  },
  {
    family: 'tree',
    name: 'tree-apical',
    title: 'Apical growth',
    blurb: 'Growth only at the tip. Each file or subfolder takes the next node up its branch when it first appears and keeps it, with a fixed heading. Gaps are refilled. Subtrees can cross.',
    make: apicalTree(),
  },
  {
    family: 'cells',
    name: 'cells-warm',
    title: 'Warm start',
    blurb: 'Each division starts from last frame’s cell centres and weights instead of fresh seeds, then relaxes as before. Cells drift only as far as the new areas require.',
    make: cellsVariant({}),
  },
  {
    family: 'cells',
    name: 'cells-inertia',
    title: 'Warm + inertia',
    blurb: 'Warm start, and cell centres move only a quarter of the way towards their target per step, so the tissue changes shape slowly. Areas are a little less exact.',
    make: cellsVariant({ inertia: 0.25 }),
  },
  {
    family: 'cells',
    name: 'cells-smooth',
    title: 'Warm + slow growth',
    blurb: 'Warm start, and each cell’s target size eases a third of the way towards its new size per frame, so a folder that suddenly doubles grows over several frames instead of shoving its neighbours at once.',
    make: cellsVariant({ smooth: 0.35 }),
  },
  {
    family: 'coral',
    name: 'coral-birth',
    title: 'Birth replay',
    blurb: 'Regrown from scratch each frame, but oldest file first, each with its own random stream. The old colony comes out the same unless something older was deleted.',
    make: coralBirth(),
  },
  {
    family: 'coral',
    name: 'coral-persistent',
    title: 'Living colony',
    blurb: 'Polyps never move. Deleted files’ polyps die, and new ones settle on their folder’s branch. A file that moves folder dies and resettles in the new folder.',
    make: coralVariant({ keepMoved: false }),
  },
  {
    family: 'coral',
    name: 'coral-fossil',
    title: 'Living colony, moves stay',
    blurb: 'As Living colony, but a file that moves to another folder keeps its polyp. Nothing ever moves; after a big reorganisation the coral no longer matches the folders.',
    make: coralVariant({ keepMoved: true }),
  },
  {
    family: 'galaxy',
    name: 'galaxy-birth',
    title: 'Birth order',
    blurb: 'Three fixed arms. Each top-level folder gets an arm by birth, and its folders join the outer end of that arm as they appear. Stars in birth order.',
    make: galaxyVariant('birth'),
  },
  {
    family: 'galaxy',
    name: 'galaxy-ratchet',
    title: 'Ratchet',
    blurb: 'Birth order, with every cluster spaced by the largest it has ever been, the bulge never shrinking, and arm assignments kept for good.',
    make: galaxyVariant('ratchet'),
  },
  {
    family: 'galaxy',
    name: 'galaxy-orbit',
    title: 'Fixed orbits',
    blurb: 'A cluster’s spot on its arm is fixed when it first appears and never changes; a vanished folder leaves a gap. Growing clusters may overlap their neighbours.',
    make: galaxyVariant('orbit'),
  },
];
