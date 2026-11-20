// The layout core: a repo and a commit in, a stable map out.
//
// The map at a commit is the Dot Cells layout replayed over the repo's first-parent history: the layout
// steps once per checkpoint (by default the last commit of each calendar week, UTC) and then once more on
// the commit asked for. Each step keeps every file and folder where the previous step left it, so the map
// holds still as the repo grows. The checkpoints depend only on commits up to the one asked for, so the
// map of a commit is the same whenever and however it is computed.
//
// Replaying is cheap but not free, so the state at the last checkpoint is cached (by default in the repo's
// git directory, under code-map/). A cached state is exactly what a full replay would produce there.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { outlines, round } from './contour.ts';
import { DotCells, type DotParams, type DotScene, type DotState } from './dots.ts';
import { commitInfo, commits, git, revParse, timeline } from './git.ts';
import { buildSnapshot, cmp, hash, type Snapshot } from './snapshot.ts';
import { applyChanges, emptyTree, loadTree, type SavedTree, saveTree, type Tree } from './tree.ts';

/** Part of the cache key: bump whenever the layout of a given history changes. */
export const LAYOUT_VERSION = 1;

export type Every = 'week' | 'day' | 'commit';

export interface LayoutOptions {
  every?: Every; // checkpoint spacing (default week)
  params?: Partial<DotParams>;
  cacheDir?: string | null; // null: no cache; default <git dir>/code-map
  name?: string; // repo label (default: the work tree's folder name)
  log?: (msg: string) => void;
}

/** One file on the map. Coordinates are in layout units, y pointing down; the root is pinned at (0, 0). */
export interface MapFile {
  path: string;
  x: number;
  y: number;
  r: number; // dot radius (dot volume ~ file size)
  size: number; // bytes
}

/** One folder: the cell around its files. */
export interface MapFolder {
  path: string;
  depth: number; // 1 = top-level folder
  files: number; // files anywhere beneath it
  outline: number[][]; // rings [x0, y0, x1, y1, ...]; fill with the even-odd rule
  bbox: [number, number, number, number];
  label: [number, number]; // the cell's topmost point
}

export interface CodeMap {
  format: 'code-map/1';
  repo: string;
  commit: string;
  date: string; // committer date, YYYY-MM-DD
  subject: string;
  every: Every;
  params: DotParams;
  bounds: [number, number, number, number];
  files: MapFile[]; // sorted by path
  folders: MapFolder[]; // parents before children
}

/** The replay state after laying out a commit; `pr.ts` steps it once more for a branch's head. */
export interface Engine {
  repo: string;
  name: string;
  tree: Tree;
  dots: DotCells;
  snap: Snapshot;
  ids: number[]; // file identity per snapshot file
  scene: DotScene;
  opts: LayoutOptions;
}

const DAY = 86400;
const bucket = (every: Every, t: number, i: number) => (every === 'commit' ? i : every === 'day' ? Math.floor(t / DAY) : Math.floor((t - 4 * DAY) / (7 * DAY))); // weeks start on Monday (1970-01-05)

interface Saved {
  sha: string;
  tree: SavedTree;
  dots: DotState;
}

export function snapshotOf(tree: Tree, name: string): { snap: Snapshot; ids: number[] } {
  const snap = buildSnapshot(name, [...tree.files].map(([p, e]) => [p, e.size]));
  return { snap, ids: snap.files.map((f) => tree.files.get(f.path)!.id) };
}

function cacheDirOf(repo: string, opts: LayoutOptions): string | null {
  if (opts.cacheDir === null) return null;
  if (opts.cacheDir) return resolve(opts.cacheDir);
  return join(resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim()), 'code-map');
}

/** Replay the layout up to `ref` (any commit-ish) and lay out that commit. */
export function replay(repoPath: string, ref = 'HEAD', opts: LayoutOptions = {}): Engine {
  const repo = resolve(repoPath);
  const every = opts.every ?? 'week';
  const name = opts.name ?? basename(git(repo, ['rev-parse', '--show-toplevel']).trim());
  const log = opts.log ?? (() => {});
  const target = revParse(repo, ref);
  const line = timeline(repo, target);
  const n = line.length - 1;
  const dots = new DotCells(opts.params);
  const key = `v${LAYOUT_VERSION}-${every}-${hash(JSON.stringify(dots.p)).toString(16)}`;
  const isCheckpoint = (i: number) => i < n && bucket(every, line[i][1], i) !== bucket(every, line[i + 1][1], i + 1);

  // resume from the latest cached checkpoint on this timeline
  const dir = cacheDirOf(repo, opts);
  let tree = emptyTree();
  let from = -1;
  if (dir && existsSync(dir)) {
    const have = new Set(readdirSync(dir).filter((f) => f.startsWith(key + '-')).map((f) => f.slice(key.length + 1, -5)));
    for (let i = n - 1; i >= 0; i--)
      if (have.has(line[i][0]) && isCheckpoint(i)) {
        try {
          const s = JSON.parse(readFileSync(join(dir, `${key}-${line[i][0]}.json`), 'utf8')) as Saved;
          tree = loadTree(s.tree);
          dots.load(s.dots);
          from = i;
        } catch {
          // unreadable cache entry: ignore it
        }
        break;
      }
  }
  const todo = commits(repo, from >= 0 ? line[from][0] : null, target);
  if (todo.length !== n - from) throw new Error(`code-map: expected ${n - from} first-parent commits after the checkpoint, got ${todo.length}`);
  log(from >= 0 ? `resuming from the cached checkpoint at ${line[from][0].slice(0, 7)}, ${todo.length} commits to go` : `replaying ${todo.length} commits`);

  let lastSaved: Saved | null = null;
  let steps = 0;
  const t0 = Date.now();
  const step = () => {
    if (!tree.files.size) return null;
    const { snap, ids } = snapshotOf(tree, name);
    steps++;
    return { snap, ids, scene: dots.step(snap, ids) };
  };
  for (let k = 0; k < todo.length; k++) {
    const i = from + 1 + k;
    applyChanges(tree, todo[k].changes);
    if (i === n) break;
    if (!isCheckpoint(i)) continue;
    step();
    lastSaved = { sha: line[i][0], tree: saveTree(tree), dots: dots.save() };
  }
  if (dir && lastSaved) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}-${lastSaved.sha}.json`), JSON.stringify(lastSaved));
    // keep the newest few
    const mine = readdirSync(dir)
      .filter((f) => f.startsWith('v') && f.endsWith('.json'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of mine.slice(12)) unlinkSync(join(dir, f));
  }
  const last = step();
  if (!last) throw new Error(`code-map: ${ref} has no files`);
  log(`laid out ${steps} steps in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { repo, name, tree, dots, ...last, opts: { ...opts, every } };
}

/** Turn a laid-out snapshot into the map file. */
export function toMap(e: Pick<Engine, 'snap' | 'scene' | 'dots' | 'name'>, info: { sha: string; date: string; subject: string }, every: Every): CodeMap {
  const { snap, scene } = e;
  const files: MapFile[] = scene.marks.map((m) => ({ path: snap.files[m.f].path, x: round(m.x), y: round(m.y), r: round(m.r), size: snap.files[m.f].size }));
  const chains = scene.marks.map((m) => {
    const c: string[] = [];
    for (let d = snap.files[m.f].dir; d.parent; d = d.parent) c.unshift(d.path);
    return c;
  });
  const shapes = outlines(
    scene.marks.map((m, k) => ({ x: m.x, y: m.y, r: m.r, dirs: chains[k] })),
    e.dots.p.margin,
  );
  const folders: MapFolder[] = snap.dirs
    .filter((d) => d.parent)
    .map((d) => {
      const o = shapes.get(d.path)!;
      return { path: d.path, depth: d.depth, files: d.count, outline: o.rings, bbox: o.bbox.map(round) as MapFolder['bbox'], label: o.top.map(round) as [number, number] };
    });
  let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of files) b = [Math.min(b[0], f.x - f.r), Math.min(b[1], f.y - f.r), Math.max(b[2], f.x + f.r), Math.max(b[3], f.y + f.r)];
  for (const f of folders) if (f.depth === 1) b = [Math.min(b[0], f.bbox[0]), Math.min(b[1], f.bbox[1]), Math.max(b[2], f.bbox[2]), Math.max(b[3], f.bbox[3])];
  files.sort((p, q) => cmp(p.path, q.path));
  return { format: 'code-map/1', repo: e.name, commit: info.sha, date: info.date, subject: info.subject, every, params: e.dots.p, bounds: b, files, folders };
}

/** The stable map of a repo at a commit. */
export function mapAt(repo: string, ref = 'HEAD', opts: LayoutOptions = {}): CodeMap {
  const e = replay(repo, ref, opts);
  return toMap(e, commitInfo(e.repo, ref), opts.every ?? 'week');
}
