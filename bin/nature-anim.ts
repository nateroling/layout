// Nature layouts, animated (experiment): replay a repo's first-parent history, lay out sampled commits
// with all five nature layouts and their stable variants, and write a player
// that tweens between frames.
//
//   node bin/nature-anim.ts [repoPath] [--name ripgrep] [--frames 120]
//     default repo: ../fixtures/ripgrep
//
// Every original layout runs with its stable variants (src/nature/stable.ts), each stepped through the
// frames in order so it can remember earlier frames (never later ones). Stateful variants only see the
// sampled commits, as a player that checks in every ~N commits would.
//
// Writes out/nature-anim/: index.html, meta.json (paths, frames, per-variant movement metrics),
// frames.txt (per frame: files and folders) and one <layout>.txt per family (per frame: each of the
// family's variants in turn). The .txt files are base64 of little-endian binary records:
//   frames.txt, per frame:
//     u16 nf, u16 nd
//     files  nf x { u16 id, u16 path, u32 size }        (path: index into meta.paths)
//     dirs   nd x { u16 path, u16 parent }              (parent: frame-local dir index, 0xffff for the root)
//   <family>.txt, per frame (offsets in meta.families[].offsets), per variant:
//     sunflower  nf x mark, nd x { i16 x, i16 y, u16 R }
//     tree       nf x mark, nd x { i16 bx, by, tx, ty, u8 w0, u8 w1 }   (widths in 1/20)
//     cells      nf x cell, nd x { i16 x, i16 y, u16 R, u8 ray[24] }    (folder walls; R = 0: none)
//     coral      nf x mark, nf x u16 anchor (frame-local file index, 0xffff none)
//     galaxy     nf x mark, u8 arms, arms x { 24 x (i16 x, i16 y), 24 x u8 width (1/10) }
//   mark = { i16 x, i16 y, u8 r (1/50) } ; cell = { i16 x, i16 y, u8 r (1/50), u8 ray[16] }
// Coordinates are int16 in 1/20 unit. A cell is drawn as rays from (x,y) at 16 (folders: 24) evenly
// spaced angles, length ray/64 * r: a convex polygon resampled to a fixed shape so it can be tweened.
// A file's colour comes from its identity, so it keeps its colour through moves.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistory } from '../src/git/extract.ts';
import { applyCommit, emptyTree } from '../src/model/tree.ts';
import { extGroups, folderGroups } from '../src/nature/groups.ts';
import { NATURE } from '../src/nature/index.ts';
import { buildSnapshot, type Scene, type SDir, type Snapshot } from '../src/nature/model.ts';
import { type StepCtx, VARIANTS } from '../src/nature/stable.ts';
import { metrics, type Moves, track, Writer, writeCells } from '../src/nature/anim.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const FRAMES = Number(flag('--frames', '120'));
const NAME = flag('--name', 'ripgrep');
const repo = join(ROOT, argv[0] ?? '../fixtures/ripgrep');

const history = loadHistory(repo, { name: NAME });
const N = history.commits.length;
const picks = new Set<number>();
for (let k = 0; k < FRAMES; k++) picks.add(Math.round(((N - 1) * k) / (FRAMES - 1)));

// ---- replay ----
const tree = emptyTree();
const snaps: { commit: number; snap: Snapshot; ids: number[] }[] = [];
const lastPath = new Map<number, string>();
for (const c of history.commits) {
  applyCommit(tree, c, true);
  if (!picks.has(c.index)) continue;
  const entries = [...tree.files.values()].map((f) => [f.path, f.size] as [string, number]);
  if (!entries.length) continue;
  const snap = buildSnapshot(NAME, entries, c.sha.slice(0, 7));
  const ids = snap.files.map((f) => tree.files.get(f.path)!.id);
  ids.forEach((id, i) => lastPath.set(id, snap.files[i].path));
  snaps.push({ commit: c.index, snap, ids });
}

// colours by identity: folder groups from the final tree, applied to each file's last path
const fg = folderGroups(snaps.at(-1)!.snap);
const eg = extGroups([...lastPath.values()]);
const maxId = Math.max(...lastPath.keys());
const colour = new Uint8Array((maxId + 1) * 2).fill(255);
for (const [id, p] of lastPath) {
  colour[id * 2] = fg.ofPath(p) < 0 ? 255 : fg.ofPath(p);
  colour[id * 2 + 1] = eg.ofPath(p);
}

// ---- encoding ----
const paths: string[] = [];
const pathIdx = new Map<string, number>();
const pid = (p: string) => {
  let i = pathIdx.get(p);
  if (i === undefined) {
    i = paths.length;
    paths.push(p);
    pathIdx.set(p, i);
  }
  return i;
};

function resample(pts: number[], w: number[], k: number): { pts: number[]; w: number[] } {
  // by arc length
  const n = pts.length / 2;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]));
  const L = cum[n - 1] || 1;
  const op: number[] = [];
  const ow: number[] = [];
  let seg = 0;
  for (let j = 0; j < k; j++) {
    const s = (L * j) / (k - 1);
    while (seg < n - 2 && cum[seg + 1] < s) seg++;
    const t = n < 2 ? 0 : Math.min(1, Math.max(0, (s - cum[seg]) / (cum[seg + 1] - cum[seg] || 1)));
    const i0 = seg;
    const i1 = Math.min(seg + 1, n - 1);
    op.push(pts[2 * i0] + (pts[2 * i1] - pts[2 * i0]) * t, pts[2 * i0 + 1] + (pts[2 * i1 + 1] - pts[2 * i0 + 1]) * t);
    ow.push(w[i0] + (w[i1] - w[i0]) * t);
  }
  return { pts: op, w: ow };
}

// ---- birth order: every file and folder numbered by first appearance ----
const seqOf = new Map<string, number>();
const seqFor = (snap: Snapshot, ids: number[]) => {
  const walk = (d: SDir) => {
    const dk = `d:${d.path}`;
    if (!seqOf.has(dk)) seqOf.set(dk, seqOf.size);
    for (const f of [...d.files].sort((x, y) => ids[x.i] - ids[y.i])) {
      const k = `f:${ids[f.i]}`;
      if (!seqOf.has(k)) seqOf.set(k, seqOf.size);
    }
    d.dirs.forEach(walk);
  };
  walk(snap.root);
};

// ---- per-family record writers ----
function writeMarks(W: Writer, sc: Scene, nf: number) {
  const byF = new Array(nf);
  for (const m of sc.marks) byF[m.f] = m;
  for (const m of byF) {
    W.xy(m.x);
    W.xy(m.y);
    W.u8(m.r * 50);
  }
}
const WRITE: Record<string, (W: Writer, sc: Scene, snap: Snapshot) => void> = {
  sunflower(W, sc, snap) {
    writeMarks(W, sc, snap.files.length);
    const discs = new Array(snap.dirs.length).fill(null);
    for (const s of sc.shapes) if (s.k === 'disc') discs[s.d] = s;
    for (const s of discs) {
      W.xy(s?.x ?? 0);
      W.xy(s?.y ?? 0);
      W.u16((s?.r ?? 0) * 20);
    }
  },
  tree(W, sc, snap) {
    writeMarks(W, sc, snap.files.length);
    const br = new Array(snap.dirs.length).fill(null);
    for (const s of sc.shapes) if (s.k === 'line') br[s.d] = s;
    for (const s of br) {
      const p = s?.pts ?? [0, 0, 0, 0, 0, 0];
      W.xy(p[0]);
      W.xy(p[1]);
      W.xy(p[p.length - 2]);
      W.xy(p[p.length - 1]);
      W.u8((s?.w[0] ?? 0) * 20);
      W.u8((s?.w[s.w.length - 1] ?? 0) * 20);
    }
  },
  cells(W, sc, snap) {
    writeCells(W, sc, snap);
  },
  coral(W, sc, snap) {
    writeMarks(W, sc, snap.files.length);
    const anchor = new Array(snap.files.length).fill(0xffff);
    for (const s of sc.shapes) if (s.k === 'line' && s.b !== undefined) anchor[s.b] = s.a;
    for (const a of anchor) W.u16(a);
  },
  galaxy(W, sc, snap) {
    writeMarks(W, sc, snap.files.length);
    const arms = sc.shapes.filter((s) => s.k === 'line');
    W.u8(arms.length);
    for (const s of arms) {
      if (s.k !== 'line') continue;
      const r = resample(s.pts, s.w, 24);
      for (let k = 0; k < 24; k++) {
        W.xy(r.pts[2 * k]);
        W.xy(r.pts[2 * k + 1]);
      }
      for (const w of r.w) W.u8(w * 10);
    }
  },
};

// ---- run ----
const H = new Writer();
const famW = new Map<string, Writer>(NATURE.map((L) => [L.name, new Writer()]));
const famOffsets = new Map<string, number[]>(NATURE.map((L) => [L.name, []]));
const steppers = VARIANTS.map((v) => ({ v, step: v.make(), prev: null as Map<number, [number, number]> | null, moves: { steps: [], all: [], density: [] } as Moves }));
const frames: { commit: number; sha: string; date: string; subject: string; files: number; offset: number }[] = [];
const t0 = Date.now();
for (const { commit, snap, ids } of snaps) {
  seqFor(snap, ids);
  const ctx: StepCtx = { id: (f) => ids[f.i], seq: (k) => seqOf.get(k) ?? Infinity };
  const offset = H.n;
  H.u16(snap.files.length);
  H.u16(snap.dirs.length);
  snap.files.forEach((f, i) => {
    H.u16(ids[i]);
    H.u16(pid(f.path));
    H.u32(f.size);
  });
  for (const d of snap.dirs) {
    H.u16(pid(d.path));
    H.u16(d.parent ? d.parent.i : 0xffff);
  }
  for (const L of NATURE) famOffsets.get(L.name)!.push(famW.get(L.name)!.n);
  for (const s of steppers) {
    const sc = s.step(snap, ctx);
    WRITE[s.v.family](famW.get(s.v.family)!, sc, snap);
    s.prev = track(s.moves, sc, ids, snap.files.length, s.prev);
  }
  const c = history.commits[commit];
  frames.push({ commit, sha: c.sha.slice(0, 7), date: new Date(c.time * 1000).toISOString().slice(0, 10), subject: c.subject.slice(0, 90), files: snap.files.length, offset });
}
console.log(`${NAME}: ${frames.length} frames over ${N} commits, ${steppers.length} layouts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);


const out = join(ROOT, 'out', 'nature-anim');
mkdirSync(out, { recursive: true });
// artifacts only serve text and media types, so the binaries go out as base64 text
writeFileSync(join(out, 'frames.txt'), H.buf.subarray(0, H.n).toString('base64'));
let bytes = H.n;
for (const L of NATURE) {
  const W = famW.get(L.name)!;
  writeFileSync(join(out, `${L.name}.txt`), W.buf.subarray(0, W.n).toString('base64'));
  bytes += W.n;
}
const meta = {
  repo: NAME,
  commits: N,
  families: NATURE.map((L) => ({
    name: L.name,
    title: L.title,
    blurb: L.blurb,
    offsets: famOffsets.get(L.name),
    variants: steppers.filter((s) => s.v.family === L.name).map((s) => ({ name: s.v.name, title: s.v.title, blurb: s.v.blurb, metrics: metrics(s.moves) })),
  })),
  groups: fg.labels,
  exts: eg.labels,
  colour: Buffer.from(colour).toString('base64'), // id*2: folder group, id*2+1: ext group (255 = none)
  paths,
  frames,
};
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta));
writeFileSync(join(out, 'index.html'), readFileSync(join(ROOT, 'src', 'nature', 'player.html'), 'utf8'));
for (const f of meta.families) for (const v of f.variants) console.log(`  ${v.name.padEnd(20)} ${JSON.stringify(v.metrics)}`);
console.log(`wrote ${out}: ${(bytes / 1024).toFixed(0)} KB binary (${((bytes * 4) / 3 / 1024).toFixed(0)} KB as base64), meta.json ${(JSON.stringify(meta).length / 1024).toFixed(0)} KB`);
