// Nested dot cells viewer (experiment): one layout, src/nature/dots.ts, replayed over a repo's
// first-parent history and written as a standalone pan/zoom page.
//
//   node bin/dots.ts [repoPath] [--name NAME] [--ref REF] [--frames 150] [--sim 2] [--out DIR]
//     repoPath: any local git clone (absolute, or relative to where you run this); default ../fixtures/ripgrep
//     --name: label on the page (default: the repo folder's name); --ref: branch or commit (default HEAD)
//     --out: output folder (default out/dots/<name>)
//
// The layout runs on `frames * sim` evenly spaced commits (more steps = smaller moves per step) and the
// page shows `frames` of them. Writes out/dots/: index.html, meta.json, frames.txt (base64 binary).
//
// frames.txt, per frame: u16 file count, then per file { u16 id, u16 path index, u32 size, i16 x*20, i16 y*20 }.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistory } from '../src/git/extract.ts';
import { applyCommit, emptyTree } from '../src/model/tree.ts';
import { metrics, type Moves, track, Writer } from '../src/nature/anim.ts';
import { DotCells, dotRadius } from '../src/nature/dots.ts';
import { extGroups, folderGroups } from '../src/nature/groups.ts';
import { buildSnapshot, type Snapshot } from '../src/nature/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const FRAMES = Number(flag('--frames', '150'));
const SIM = Number(flag('--sim', '2'));
const REF = flag('--ref', 'HEAD');
const repo = argv[0] ? resolve(argv[0]) : join(ROOT, '..', 'fixtures', 'ripgrep');
const NAME = flag('--name', basename(repo));
const OUT = flag('--out', '');

const history = loadHistory(repo, { name: NAME, ref: REF });
const N = history.commits.length;
const pick = (k: number, of: number) => Math.round(((N - 1) * k) / (of - 1));
const simAt = new Set<number>();
const showAt = new Set<number>();
for (let k = 0; k < FRAMES * SIM; k++) simAt.add(pick(k, FRAMES * SIM));
for (let k = 0; k < FRAMES; k++) showAt.add(pick(k, FRAMES));
for (const c of showAt) simAt.add(c);

const tree = emptyTree();
const layout = new DotCells(process.env.DOTS_PARAMS ? JSON.parse(process.env.DOTS_PARAMS) : {});
const moves: Moves = { steps: [], all: [], density: [] };
let prev: Map<number, [number, number]> | null = null;
const lastPath = new Map<number, string>();
const seenIn: [number, string][][] = []; // per shown frame: [id, folder]
const paths: string[] = [];
const pathIdx = new Map<string, number>();
const pid = (p: string) => {
  let i = pathIdx.get(p);
  if (i === undefined) pathIdx.set(p, (i = paths.push(p) - 1));
  if (i > 65535) throw new Error('dots: more than 65,535 distinct paths over the history; try a later --ref or fewer --frames');
  return i;
};
const B = new Writer();
const frames: { commit: number; sha: string; date: string; subject: string; files: number; offset: number }[] = [];
let last: Snapshot | null = null;
let ms = 0;
for (const c of history.commits) {
  applyCommit(tree, c, true);
  if (!simAt.has(c.index)) continue;
  const entries = [...tree.files.values()].map((f) => [f.path, f.size] as [string, number]);
  if (!entries.length) continue;
  const snap = buildSnapshot(NAME, entries, c.sha.slice(0, 7));
  const ids = snap.files.map((f) => tree.files.get(f.path)!.id);
  const t = Date.now();
  const sc = layout.step(snap, ids);
  ms += Date.now() - t;
  if (!showAt.has(c.index)) continue;
  last = snap;
  ids.forEach((id, i) => lastPath.set(id, snap.files[i].path));
  seenIn.push(snap.files.map((f, i) => [ids[i], f.dir.path]));
  prev = track(moves, sc, ids, snap.files.length, prev);
  const offset = B.n;
  if (snap.files.length > 65535 || tree.nextId > 65535) throw new Error('dots: more than 65,535 files; the frame format stores ids and counts as 16-bit');
  B.u16(snap.files.length);
  for (const m of sc.marks) {
    const f = snap.files[m.f];
    B.u16(ids[m.f]);
    B.u16(pid(f.path));
    B.u32(f.size);
    B.xy(m.x);
    B.xy(m.y);
  }
  frames.push({ commit: c.index, sha: c.sha.slice(0, 7), date: new Date(c.time * 1000).toISOString().slice(0, 10), subject: c.subject.slice(0, 90), files: snap.files.length, offset });
}

const fg = folderGroups(last!);
const eg = extGroups([...lastPath.values()]);
// Colours. A file alive at the end takes its folder group from its final path. A folder takes the
// commonest group of the end-alive files it ever held; a file that died takes its last folder's group
// (or the nearest ancestor's), so early files that were later deleted are not all left grey.
const alive = new Set(last!.files.map((f) => tree.files.get(f.path)!.id));
const group = new Map<number, number>();
for (const id of alive) group.set(id, fg.ofPath(lastPath.get(id)!));
const tally = new Map<string, Map<number, number>>();
for (const fr of seenIn)
  for (const [id, dir] of fr) {
    if (!alive.has(id) || group.get(id)! < 0) continue;
    const parts = dir.split('/');
    for (let k = 1; k <= parts.length; k++) {
      const d = dir ? parts.slice(0, k).join('/') : '';
      let t = tally.get(d);
      if (!t) tally.set(d, (t = new Map()));
      t.set(group.get(id)!, (t.get(group.get(id)!) ?? 0) + 1);
      if (!dir) break;
    }
  }
const dirGroup = (dir: string): number => {
  for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
    const t = tally.get(d);
    if (t && d !== '') return [...t].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    if (d === '') return -1;
  }
};
const colour = new Uint8Array((Math.max(...lastPath.keys()) + 1) * 2).fill(255);
for (const [id, p] of lastPath) {
  const g = alive.has(id) ? group.get(id)! : dirGroup(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  colour[id * 2] = g < 0 ? 255 : g;
  colour[id * 2 + 1] = eg.ofPath(p);
}
const score = metrics(moves);
const out = OUT ? resolve(OUT) : join(ROOT, 'out', 'dots', NAME);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'frames.txt'), B.buf.subarray(0, B.n).toString('base64'));
const meta = {
  repo: NAME,
  commits: N,
  params: layout.p,
  radius: { k: 0.085, min: dotRadius(1) },
  metrics: score,
  groups: fg.labels,
  exts: eg.labels,
  colour: Buffer.from(colour).toString('base64'),
  paths,
  frames,
};
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta));
const page = readFileSync(join(ROOT, 'src', 'nature', 'dots.html'), 'utf8');
const head = '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n';
writeFileSync(join(out, 'index.html'), head + page);
// one self-contained file that opens straight from disk (no server needed)
const inline = `<script>window.DOTS_DATA = ${JSON.stringify({ meta, frames: B.buf.subarray(0, B.n).toString('base64') }).replace(/</g, '\\u003c')};</script>\n`;
writeFileSync(join(out, 'standalone.html'), head + inline + page);
// the same frames, dug into the ground (three.js from a CDN, so this one needs a network connection)
const page3d = readFileSync(join(ROOT, 'src', 'nature', 'dots3d.html'), 'utf8');
writeFileSync(join(out, '3d.html'), head + page3d);
writeFileSync(join(out, 'standalone-3d.html'), head + inline + page3d);
console.log(`dots: ${JSON.stringify(score)} ${(ms / 1000).toFixed(1)} s over ${simAt.size} steps`);
console.log(`open ${join(out, 'standalone.html')}  (3D: ${join(out, 'standalone-3d.html')})`);
console.log(`wrote ${out}: ${((B.n * 4) / 3 / 1024).toFixed(0)} KB frames, meta.json ${(JSON.stringify(meta).length / 1024).toFixed(0)} KB`);
if (process.env.DOTS_DEBUG) moves.steps.forEach((v, i) => v > 0.6 && console.log(`step ${i}->${i + 1} ${v.toFixed(2)} ${frames[i + 1].sha} ${frames[i + 1].files} ${frames[i + 1].subject}`));
