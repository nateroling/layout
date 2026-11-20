// Flat cities, animated (experiment): the six hierarchy-free layouts of src/nature/flat.ts beside metro
// and cells-as-districts, replayed over a repo's first-parent history.
//
//   node bin/flat.ts [repoPath] [--name ripgrep] [--frames 100]
//     default repo: ../fixtures/ripgrep
//
// Metro steps through every commit; the others step through the sampled frames only. Co-change
// affinity (for the affinity layout) is counted over every commit up to the frame, never beyond.
// Writes out/flat/ in the nature player's format, one family.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeOptions } from '../src/engine.ts';
import { loadHistory } from '../src/git/extract.ts';
import { applyCommit, emptyTree } from '../src/model/tree.ts';
import { metrics, type Moves, track, Writer, writeCells } from '../src/nature/anim.ts';
import { CELL_CITIES, squeezed, type CityStepper, type MetroFrame, metroScene } from '../src/nature/cellcity.ts';
import { FLAT, type FlatCtx } from '../src/nature/flat.ts';
import { extGroups, folderGroups } from '../src/nature/groups.ts';
import { buildSnapshot, type SDir, type Snapshot } from '../src/nature/model.ts';
import { cmp } from '../src/model/tree.ts';
import { metro } from '../src/strategies/city.ts';
import type { LayoutNode } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const FRAMES = Number(flag('--frames', '80'));
const NAME = flag('--name', 'ripgrep');
const repo = join(ROOT, argv[0] ?? '../fixtures/ripgrep');
const DIR_RAYS = 24;

const history = loadHistory(repo, { name: NAME });
const N = history.commits.length;
const picks = new Set<number>();
for (let k = 0; k < FRAMES; k++) picks.add(Math.round(((N - 1) * k) / (FRAMES - 1)));

// ---- replay: metro on every commit, snapshots at the picks ----
const tree = emptyTree();
const mctx = { options: mergeOptions(metro, {}) };
const mstate = metro.init(mctx);
const snaps: { commit: number; snap: Snapshot; ids: number[]; metro: MetroFrame; affinity: Map<string, [string, number][]> }[] = [];
// co-change: commits touching each folder, and each pair of folders (commits touching 2..8 folders)
const touches = new Map<string, number>();
const pairs = new Map<string, Map<string, number>>();
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const bump = (a: string, b: string) => {
  let m = pairs.get(a);
  if (!m) pairs.set(a, (m = new Map()));
  m.set(b, (m.get(b) ?? 0) + 1);
};
const affinityNow = () => {
  const out = new Map<string, [string, number][]>();
  for (const [a, m] of pairs)
    out.set(a, [...m].map(([b, n]) => [b, n / Math.sqrt(touches.get(a)! * touches.get(b)!)] as [string, number]).sort((x, y) => y[1] - x[1] || cmp(x[0], y[0])));
  return out;
};
const lastPath = new Map<number, string>();
for (const c of history.commits) {
  const delta = applyCommit(tree, c, true);
  metro.step(mstate, tree, c, delta, mctx);
  const dirs = [...new Set(c.changes.flatMap((ch) => (ch.oldPath ? [ch.path, ch.oldPath] : [ch.path]).map(dirOf)))].sort(cmp);
  for (const d of dirs) touches.set(d, (touches.get(d) ?? 0) + 1);
  if (dirs.length >= 2 && dirs.length <= 8) for (const a of dirs) for (const b of dirs) if (a !== b) bump(a, b);
  if (!picks.has(c.index)) continue;
  const entries = [...tree.files.values()].map((f) => [f.path, f.size] as [string, number]);
  if (!entries.length) continue;
  const snap = buildSnapshot(NAME, entries, c.sha.slice(0, 7));
  const ids = snap.files.map((f) => tree.files.get(f.path)!.id);
  ids.forEach((id, i) => lastPath.set(id, snap.files[i].path));
  const m: MetroFrame = { file: new Map(), dir: new Map() };
  for (const n of metro.frame(mstate, tree, c, mctx) as LayoutNode[]) (n.kind === 'file' ? m.file : m.dir).set(n.path, n);
  snaps.push({ commit: c.index, snap, ids, metro: m, affinity: affinityNow() });
}

const fg = folderGroups(snaps.at(-1)!.snap);
const eg = extGroups([...lastPath.values()]);
const colour = new Uint8Array((Math.max(...lastPath.keys()) + 1) * 2).fill(255);
for (const [id, p] of lastPath) {
  colour[id * 2] = fg.ofPath(p) < 0 ? 255 : fg.ofPath(p);
  colour[id * 2 + 1] = eg.ofPath(p);
}

const paths: string[] = [];
const pathIdx = new Map<string, number>();
const pid = (p: string) => {
  let i = pathIdx.get(p);
  if (i === undefined) pathIdx.set(p, (i = paths.push(p) - 1));
  return i;
};
const seqOf = new Map<string, number>();
const seqFor = (snap: Snapshot, ids: number[]) => {
  const walk = (d: SDir) => {
    if (!seqOf.has(`d:${d.path}`)) seqOf.set(`d:${d.path}`, seqOf.size);
    for (const f of [...d.files].sort((x, y) => ids[x.i] - ids[y.i])) if (!seqOf.has(`f:${ids[f.i]}`)) seqOf.set(`f:${ids[f.i]}`, seqOf.size);
    d.dirs.forEach(walk);
  };
  walk(snap.root);
};

// ---- the line-up: metro and cells-as-districts as references, then the six flat layouts ----
const districts = CELL_CITIES.find((v) => v.name === 'districts')!;
const LINEUP: { name: string; title: string; blurb: string; make: () => (snap: Snapshot, ctx: FlatCtx) => ReturnType<CityStepper> }[] = [
  {
    name: 'metro',
    title: 'Metro',
    blurb: 'Reference: the city grid grown from the centre. Folders nest: each keeps its cell on a square spiral around its parent’s file lot, and columns and rows only widen.',
    make: () => (snap, ctx) => metroScene(snap, ctx.metro),
  },
  { name: 'districts', title: 'Cells as districts', blurb: 'Reference, from the cell cities page: ' + districts.blurb, make: districts.make },
  ...FLAT,
];

// ---- grouping: how tight each folder's own files sit, 1 = a round blob, higher = strung out or split ----
function spread(sc: ReturnType<CityStepper>, snap: Snapshot): number {
  const at = new Array(snap.files.length);
  for (const m of sc.marks) at[m.f] = [m.x, m.y];
  // the layout's spacing: median distance to the nearest other file
  const nn: number[] = [];
  for (let i = 0; i < at.length; i++) {
    let b = Infinity;
    for (let j = 0; j < at.length; j++) if (i !== j) b = Math.min(b, (at[i][0] - at[j][0]) ** 2 + (at[i][1] - at[j][1]) ** 2);
    nn.push(b);
  }
  nn.sort((x, y) => x - y);
  const cellArea = nn[Math.floor(nn.length / 2)] || 1;
  let sum = 0;
  let wsum = 0;
  for (const d of snap.dirs) {
    const n = d.files.length;
    if (n < 3) continue;
    const ps = d.files.map((f) => at[f.i]);
    const cx = ps.reduce((t, p) => t + p[0], 0) / n;
    const cy = ps.reduce((t, p) => t + p[1], 0) / n;
    const mean = ps.reduce((t, p) => t + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
    sum += (mean / ((2 / 3) * Math.sqrt((n * cellArea) / Math.PI))) * n;
    wsum += n;
  }
  return wsum ? sum / wsum : 1;
}

const H = new Writer();
const F = new Writer();
const offsets: number[] = [];
const runs = LINEUP.map((v) => ({ v, step: v.make(), prev: null as Map<number, [number, number]> | null, spread: [] as number[], moves: { steps: [], all: [], density: [] } as Moves, ms: 0, sq: 0 }));
const frames: { commit: number; sha: string; date: string; subject: string; files: number; offset: number }[] = [];
for (const { commit, snap, ids, metro: m, affinity } of snaps) {
  seqFor(snap, ids);
  const ctx: FlatCtx = { id: (f) => ids[f.i], seq: (k) => seqOf.get(k) ?? Infinity, metro: m, affinity: (d) => affinity.get(d) ?? [] };
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
  offsets.push(F.n);
  for (const r of runs) {
    const t = Date.now();
    const s0 = squeezed;
    const sc = r.step(snap, ctx);
    r.ms += Date.now() - t;
    r.sq += squeezed - s0;
    if (sc.marks.length !== snap.files.length) throw new Error(`${r.v.name}: ${sc.marks.length} marks for ${snap.files.length} files`);
    writeCells(F, sc, snap, DIR_RAYS);
    r.prev = track(r.moves, sc, ids, snap.files.length, r.prev);
    r.spread.push(spread(sc, snap));
  }
  const c = history.commits[commit];
  frames.push({ commit, sha: c.sha.slice(0, 7), date: new Date(c.time * 1000).toISOString().slice(0, 10), subject: c.subject.slice(0, 90), files: snap.files.length, offset });
}

const out = join(ROOT, 'out', 'flat');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'frames.txt'), H.buf.subarray(0, H.n).toString('base64'));
writeFileSync(join(out, 'flat.txt'), F.buf.subarray(0, F.n).toString('base64'));
const scores = (r: (typeof runs)[number]) => ({ ...metrics(r.moves), spread: +(r.spread.reduce((t, v) => t + v, 0) / r.spread.length).toFixed(2) });
const meta = {
  repo: NAME,
  commits: N,
  title: 'Flat cities',
  intro: `Six layouts where folders only group files: each folder’s own files are one flat cluster, and nothing has to enclose anything. Replayed over ${NAME}’s history beside metro and cells-as-districts: ${frames.length} frames across ${N.toLocaleString('en')} commits. All of them may remember earlier frames but never peek at later ones. Hover a file to light up its folder.`,
  dirRays: DIR_RAYS,
  footer: 'Frames are evenly spaced commits on the first-parent history. Metro steps through every commit; the cell layouts only see the sampled frames. Files keep their identity (and colour) through renames; folders are matched by path. Folder colours come from the final tree. Affinity counts co-change over every commit up to the frame. <b>Spread</b> measures grouping: how far a folder’s own files sit from their centre, against a round blob of the same files (1 = a tight blob, higher = strung out or split up), averaged over folders with 3 or more files. Source: <code>src/nature/flat.ts</code>, regenerate with <code>node bin/flat.ts</code>.',
  baseline: 'metro',
  families: [
    {
      name: 'flat',
      kind: 'cells',
      walls: 'under',
      title: 'Flat cities',
      blurb: LINEUP[0].blurb,
      offsets,
      variants: runs.map((r) => ({ name: r.v.name, title: r.v.title, blurb: r.v.blurb, metrics: scores(r) })),
    },
  ],
  groups: fg.labels,
  exts: eg.labels,
  colour: Buffer.from(colour).toString('base64'),
  paths,
  frames,
};
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta));
writeFileSync(join(out, 'index.html'), readFileSync(join(ROOT, 'src', 'nature', 'player.html'), 'utf8').replace(/<title>.*<\/title>/, '<title>Flat Cities</title>'));
for (const r of runs) console.log(`  ${r.v.name.padEnd(12)} ${JSON.stringify(scores(r))} ${(r.ms / 1000).toFixed(1)} s, ${r.sq} squeezed-out file-frames`);
console.log(`wrote ${out}: ${((H.n + F.n) / 1024).toFixed(0)} KB binary (${(((H.n + F.n) * 4) / 3 / 1024).toFixed(0)} KB as base64), meta.json ${(JSON.stringify(meta).length / 1024).toFixed(0)} KB`);
