// Nature layouts, animated (experiment): replay a repo's first-parent history, lay out sampled commits
// with all five nature layouts (each frame from scratch: no state, no stability), and write a player
// that tweens between frames.
//
//   node bin/nature-anim.ts [repoPath] [--name ripgrep] [--frames 160]
//     default repo: ../fixtures/ripgrep
//
// Writes out/nature-anim/index.html + meta.json + frames.txt (publish all three).
//
// frames.txt is base64 of a run of little-endian frame records (offsets in meta.json). Coordinates are int16 in
// 1/20 unit; a file's colour comes from its identity (rename-following id), so it keeps its colour
// through moves. Record layout:
//   u16 nf, u16 nd
//   files  nf x { u16 id, u16 path, u32 size }        (path: index into meta.paths)
//   dirs   nd x { u16 path, u16 parent }              (parent: frame-local dir index, 0xffff for the root)
//   sunflower  nf x mark, nd x { i16 x, i16 y, u16 R }
//   tree       nf x mark, nd x { i16 bx, by, tx, ty, u8 w0, u8 w1 }   (widths in 1/20)
//   cells      nf x cell, nd x { i16 x, i16 y, u16 R, u8 ray[24] }    (folder walls)
//   coral      nf x mark, nf x u16 anchor (frame-local file index, 0xffff none)
//   galaxy     nf x mark, u8 arms, arms x { 24 x (i16 x, i16 y), 24 x u8 width (1/10) }
//   mark = { i16 x, i16 y, u8 r (1/50) } ; cell = { i16 x, i16 y, u8 r (1/50), u8 ray[16] }
// A cell is drawn as rays from (x,y) at 16 (folders: 24) evenly spaced angles, length ray/64 * r: a
// convex polygon resampled to a fixed shape so frames can be tweened vertex by vertex.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistory } from '../src/git/extract.ts';
import { applyCommit, emptyTree } from '../src/model/tree.ts';
import { extGroups, folderGroups } from '../src/nature/groups.ts';
import { NATURE } from '../src/nature/index.ts';
import { buildSnapshot, type Scene, type Snapshot } from '../src/nature/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const FRAMES = Number(flag('--frames', '160'));
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

class Writer {
  buf = Buffer.alloc(1 << 16);
  n = 0;
  private room(k: number) {
    if (this.n + k > this.buf.length) {
      const b = Buffer.alloc(this.buf.length * 2 + k);
      this.buf.copy(b);
      this.buf = b;
    }
  }
  u8(v: number) {
    this.room(1);
    this.buf.writeUInt8(Math.max(0, Math.min(255, Math.round(v))), this.n++);
  }
  u16(v: number) {
    this.room(2);
    this.buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(v))), this.n);
    this.n += 2;
  }
  u32(v: number) {
    this.room(4);
    this.buf.writeUInt32LE(Math.min(0xffffffff, v), this.n);
    this.n += 4;
  }
  xy(v: number) {
    this.room(2);
    this.buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 20))), this.n);
    this.n += 2;
  }
}

/** Distances from (cx,cy) to a convex polygon's boundary at k evenly spaced angles. */
function rays(poly: number[], cx: number, cy: number, k: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < k; j++) {
    const a = (2 * Math.PI * j) / k;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let best = 0;
    for (let i = 0; i < poly.length; i += 2) {
      const ax = poly[i] - cx;
      const ay = poly[i + 1] - cy;
      const bx = poly[(i + 2) % poly.length] - cx;
      const by = poly[(i + 3) % poly.length] - cy;
      // ray t*(dx,dy) meets segment a + s*(b-a)
      const ex = bx - ax;
      const ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;
      const s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
    }
    out.push(best);
  }
  return out;
}

function polyCentroid(p: number[]): [number, number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    const c = p[i] * p[j + 1] - p[j] * p[i + 1];
    a += c;
    cx += (p[i] + p[j]) * c;
    cy += (p[i + 1] + p[j + 1]) * c;
  }
  if (Math.abs(a) < 1e-12) return [p[0] ?? 0, p[1] ?? 0, 0];
  return [cx / (3 * a), cy / (3 * a), Math.abs(a / 2)];
}

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

const W = new Writer();
const frames: { commit: number; sha: string; date: string; subject: string; files: number; offset: number }[] = [];
const t0 = Date.now();
for (const { commit, snap, ids } of snaps) {
  const offset = W.n;
  const nf = snap.files.length;
  const nd = snap.dirs.length;
  W.u16(nf);
  W.u16(nd);
  snap.files.forEach((f, i) => {
    W.u16(ids[i]);
    W.u16(pid(f.path));
    W.u32(f.size);
  });
  for (const d of snap.dirs) {
    W.u16(pid(d.path));
    W.u16(d.parent ? d.parent.i : 0xffff);
  }
  const scenes = new Map<string, Scene>(NATURE.map((L) => [L.name, L.run(snap)]));
  const marks = (sc: Scene) => {
    const byF = new Array(nf);
    for (const m of sc.marks) byF[m.f] = m;
    return byF;
  };
  const writeMarks = (sc: Scene) => {
    for (const m of marks(sc)) {
      W.xy(m.x);
      W.xy(m.y);
      W.u8(m.r * 50);
    }
  };
  // sunflower
  const sf = scenes.get('sunflower')!;
  writeMarks(sf);
  const discs = new Array(nd).fill(null);
  for (const s of sf.shapes) if (s.k === 'disc') discs[s.d] = s;
  for (const s of discs) {
    W.xy(s?.x ?? 0);
    W.xy(s?.y ?? 0);
    W.u16((s?.r ?? 0) * 20);
  }
  // tree
  const tr = scenes.get('tree')!;
  writeMarks(tr);
  const br = new Array(nd).fill(null);
  for (const s of tr.shapes) if (s.k === 'line') br[s.d] = s;
  for (const s of br) {
    const p = s?.pts ?? [0, 0, 0, 0, 0, 0];
    W.xy(p[0]);
    W.xy(p[1]);
    W.xy(p[p.length - 2]);
    W.xy(p[p.length - 1]);
    W.u8((s?.w[0] ?? 0) * 20);
    W.u8((s?.w[s.w.length - 1] ?? 0) * 20);
  }
  // cells
  const ce = scenes.get('cells')!;
  for (const m of marks(ce)) {
    const [cx, cy, a] = polyCentroid(m.poly);
    const r = Math.sqrt(a / Math.PI);
    W.xy(cx);
    W.xy(cy);
    W.u8(r * 50);
    for (const d of rays(m.poly, cx, cy, 16)) W.u8(r > 0 ? (d / r) * 64 : 0);
  }
  const walls = new Array(nd).fill(null);
  for (const s of ce.shapes) if (s.k === 'poly') walls[s.d] = s;
  for (const s of walls) {
    if (!s) {
      // the root: no wall of its own
      W.xy(0);
      W.xy(0);
      W.u16(0);
      for (let k = 0; k < 24; k++) W.u8(0);
      continue;
    }
    const [cx, cy, a] = polyCentroid(s.pts);
    const r = Math.sqrt(a / Math.PI);
    W.xy(cx);
    W.xy(cy);
    W.u16(r * 20);
    for (const d of rays(s.pts, cx, cy, 24)) W.u8(r > 0 ? (d / r) * 64 : 0);
  }
  // coral
  const co = scenes.get('coral')!;
  writeMarks(co);
  const anchor = new Array(nf).fill(0xffff);
  for (const s of co.shapes) if (s.k === 'line' && s.b !== undefined) anchor[s.b] = s.a;
  for (const a of anchor) W.u16(a);
  // galaxy
  const ga = scenes.get('galaxy')!;
  writeMarks(ga);
  const arms = ga.shapes.filter((s) => s.k === 'line');
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
  const c = history.commits[commit];
  frames.push({ commit, sha: c.sha.slice(0, 7), date: new Date(c.time * 1000).toISOString().slice(0, 10), subject: c.subject.slice(0, 90), files: nf, offset });
}
console.log(`${NAME}: ${frames.length} frames over ${N} commits, laid out in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const out = join(ROOT, 'out', 'nature-anim');
mkdirSync(out, { recursive: true });
// artifacts only serve text and media types, so the binary goes out as base64 text
writeFileSync(join(out, 'frames.txt'), W.buf.subarray(0, W.n).toString('base64'));
const meta = {
  repo: NAME,
  commits: N,
  layouts: NATURE.map((L) => ({ name: L.name, title: L.title, blurb: L.blurb })),
  groups: fg.labels,
  exts: eg.labels,
  colour: Buffer.from(colour).toString('base64'), // id*2: folder group, id*2+1: ext group (255 = none)
  paths,
  frames,
};
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta));
writeFileSync(join(out, 'index.html'), readFileSync(join(ROOT, 'src', 'nature', 'player.html'), 'utf8'));
console.log(`wrote ${out}: frames ${(W.n / 1024).toFixed(0)} KB binary (${((W.n * 4) / 3 / 1024).toFixed(0)} KB as base64), meta.json ${(JSON.stringify(meta).length / 1024).toFixed(0)} KB`);
