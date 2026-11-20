// Cell cities, animated (experiment): metro, the steadiest cells variant and the three cells + metro
// hybrids of src/nature/cellcity.ts, replayed over a repo's first-parent history side by side.
//
//   node bin/cellcity.ts [repoPath] [--name ripgrep] [--frames 100]
//     default repo: ../fixtures/ripgrep
//
// Metro steps through every commit, as the strategy does in the main report; the cell layouts step
// through the sampled frames only, like the stable nature variants (see bin/nature-anim.ts). Writes
// out/cellcity/ in the nature player's format with a single 'cells' family (folders as 40 rays, so
// metro's rectangles keep their corners).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeOptions } from '../src/engine.ts';
import { loadHistory } from '../src/git/extract.ts';
import { applyCommit, emptyTree } from '../src/model/tree.ts';
import { metrics, type Moves, track, Writer, writeCells } from '../src/nature/anim.ts';
import { CELL_CITIES, squeezed, type CityCtx, type CityStepper, type MetroFrame, metroScene } from '../src/nature/cellcity.ts';
import { extGroups, folderGroups } from '../src/nature/groups.ts';
import { buildSnapshot, type SDir, type Snapshot } from '../src/nature/model.ts';
import { VARIANTS } from '../src/nature/stable.ts';
import { metro } from '../src/strategies/city.ts';
import type { LayoutNode } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const FRAMES = Number(flag('--frames', '100'));
const NAME = flag('--name', 'ripgrep');
const repo = join(ROOT, argv[0] ?? '../fixtures/ripgrep');
const DIR_RAYS = 40;

const history = loadHistory(repo, { name: NAME });
const N = history.commits.length;
const picks = new Set<number>();
for (let k = 0; k < FRAMES; k++) picks.add(Math.round(((N - 1) * k) / (FRAMES - 1)));

// ---- replay: metro on every commit, snapshots at the picks ----
const tree = emptyTree();
const mctx = { options: mergeOptions(metro, {}) };
const mstate = metro.init(mctx);
const snaps: { commit: number; snap: Snapshot; ids: number[]; metro: MetroFrame }[] = [];
const lastPath = new Map<number, string>();
for (const c of history.commits) {
  const delta = applyCommit(tree, c, true);
  metro.step(mstate, tree, c, delta, mctx);
  if (!picks.has(c.index)) continue;
  const entries = [...tree.files.values()].map((f) => [f.path, f.size] as [string, number]);
  if (!entries.length) continue;
  const snap = buildSnapshot(NAME, entries, c.sha.slice(0, 7));
  const ids = snap.files.map((f) => tree.files.get(f.path)!.id);
  ids.forEach((id, i) => lastPath.set(id, snap.files[i].path));
  const m: MetroFrame = { file: new Map(), dir: new Map() };
  for (const n of metro.frame(mstate, tree, c, mctx) as LayoutNode[]) (n.kind === 'file' ? m.file : m.dir).set(n.path, n);
  snaps.push({ commit: c.index, snap, ids, metro: m });
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

// ---- the line-up: metro, cells (steadiest variant), the three hybrids ----
const cellsInertia = VARIANTS.find((v) => v.name === 'cells-inertia')!;
const LINEUP: { name: string; title: string; blurb: string; make: () => CityStepper }[] = [
  {
    name: 'metro',
    title: 'Metro',
    blurb: 'The reference: the city grid grown from the centre, as in the main comparison. Each folder keeps its cell on a square spiral around its file lot; columns and rows only widen.',
    make: () => (snap, ctx) => metroScene(snap, ctx.metro),
  },
  { name: 'cells', title: 'Cells (warm + inertia)', blurb: 'The reference: the steadiest cells variant from the nature page. A Voronoi treemap down to one cell per file, sized by file size, warm-started from last frame.', make: () => cellsInertia.make() },
  ...CELL_CITIES,
];

const H = new Writer();
const F = new Writer();
const offsets: number[] = [];
const runs = LINEUP.map((v) => ({ v, step: v.make(), prev: null as Map<number, [number, number]> | null, moves: { steps: [], all: [], density: [] } as Moves, ms: 0, sq: 0 }));
const frames: { commit: number; sha: string; date: string; subject: string; files: number; offset: number }[] = [];
for (const { commit, snap, ids, metro: m } of snaps) {
  seqFor(snap, ids);
  const ctx: CityCtx = { id: (f) => ids[f.i], seq: (k) => seqOf.get(k) ?? Infinity, metro: m };
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
  }
  const c = history.commits[commit];
  frames.push({ commit, sha: c.sha.slice(0, 7), date: new Date(c.time * 1000).toISOString().slice(0, 10), subject: c.subject.slice(0, 90), files: snap.files.length, offset });
}

const out = join(ROOT, 'out', 'cellcity');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'frames.txt'), H.buf.subarray(0, H.n).toString('base64'));
writeFileSync(join(out, 'cells.txt'), F.buf.subarray(0, F.n).toString('base64'));
const meta = {
  repo: NAME,
  commits: N,
  title: 'Cell cities',
  intro: `Three ways to combine the cells layout with the metro city, replayed over ${NAME}’s history beside metro and the steadiest cells variant: ${frames.length} frames across ${N.toLocaleString('en')} commits. All of them may remember earlier frames but never peek at later ones. Hover a file to light up its folder.`,
  dirRays: DIR_RAYS,
  footer: 'Frames are evenly spaced commits on the first-parent history. Metro steps through every commit; the cell layouts only see the sampled frames. Files keep their identity (and colour) through renames; folders are matched by path. Folder colours come from the final tree. Source: <code>src/nature/cellcity.ts</code>, regenerate with <code>node bin/cellcity.ts</code>.',
  baseline: 'metro',
  families: [
    {
      name: 'cells',
      title: 'Cell cities',
      blurb: LINEUP[0].blurb,
      offsets,
      variants: runs.map((r) => ({ name: r.v.name, title: r.v.title, blurb: r.v.blurb, metrics: metrics(r.moves) })),
    },
  ],
  groups: fg.labels,
  exts: eg.labels,
  colour: Buffer.from(colour).toString('base64'),
  paths,
  frames,
};
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta));
writeFileSync(join(out, 'index.html'), readFileSync(join(ROOT, 'src', 'nature', 'player.html'), 'utf8').replace(/<title>.*<\/title>/, '<title>Cell Cities</title>'));
for (const r of runs) console.log(`  ${r.v.name.padEnd(12)} ${JSON.stringify(metrics(r.moves))} ${(r.ms / 1000).toFixed(1)} s, ${r.sq} squeezed-out file-frames`);
console.log(`wrote ${out}: ${((H.n + F.n) / 1024).toFixed(0)} KB binary (${(((H.n + F.n) * 4) / 3 / 1024).toFixed(0)} KB as base64), meta.json ${(JSON.stringify(meta).length / 1024).toFixed(0)} KB`);
