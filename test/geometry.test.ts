// Geometry invariants of every strategy's frames, over randomized histories × aggressive option
// combos (zero gaps/pad, fixed 1-col grids, tiny growth, big slack, short ghost TTLs) and the
// synthetic fixtures in ../fixtures (sampled; skipped when missing):
//   - node ids unique; every parent exists and is a directory
//   - no two file boxes overlap (live or ghost); no two platforms overlap (touching is fine)
//   - every file lies inside its platform; every directory lies below its parent platform
//   - nothing live under a ghost directory; all coordinates finite; bbox covers all nodes
// Per arrangement (Frame.wires): treev/wrap put every directory below its parent platform;
// nested puts it inside its parent district instead, so platforms overlap only by nesting: there
// the check is that a district's own files and child districts do not overlap each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner } from '../src/engine.ts';
import { bbox } from '../src/geometry/treev.ts';
import { loadHistory } from '../src/git/extract.ts';
import { strategies } from '../src/strategies/index.ts';
import { meshValid } from '../src/geometry/warp.ts';
import type { Change, Frame, History, LayoutNode, Options } from '../src/types.ts';
import { A, D, M, R, hist, randomHistory, sample } from './helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E = 1e-9;

const overlap = (a: LayoutNode, b: LayoutNode) =>
  a.x < b.x + b.w - E && b.x < a.x + a.w - E && a.y < b.y + b.h - E && b.y < a.y + a.h - E;

/** First overlapping pair among boxes (sweep over x), or undefined. */
function findOverlap(boxes: LayoutNode[]): [LayoutNode, LayoutNode] | undefined {
  const s = [...boxes].sort((a, b) => a.x - b.x);
  const active: LayoutNode[] = [];
  for (const n of s) {
    let k = 0;
    for (const a of active) if (a.x + a.w > n.x + E) active[k++] = a; // drop boxes ending left of n
    active.length = k;
    for (const a of active) if (overlap(a, n)) return [a, n];
    active.push(n);
  }
  return undefined;
}

const show = (n: LayoutNode) => `${n.id}${n.ghost ? '(ghost)' : ''} ${n.path} [${n.x},${n.y},${n.w},${n.h}]`;

/** All violated invariants of one frame (empty = fine). */
export function geometryErrors(f: Frame): string[] {
  if (f.mesh) {
    // Warped frame: the warp is one-to-one when every mesh cell is a convex quad with the
    // lattice's orientation, so the unwarped rects (base) carry every invariant over.
    const errs = meshValid(f.mesh) ? [] : ['warp mesh folds'];
    for (const n of f.nodes) if (!n.base) errs.push(`warped ${show(n)} has no base rect`);
    if (errs.length) return errs;
    const plain = f.nodes.map((n) => ({ ...n, x: n.base![0], y: n.base![1], w: n.base![2], h: n.base![3] }));
    assert.deepEqual(f.bbox, bbox(f.nodes), 'frame bbox');
    return geometryErrors({ ...f, mesh: undefined, nodes: plain, bbox: bbox(plain) });
  }
  const errs: string[] = [];
  const byId = new Map<string, LayoutNode>();
  for (const n of f.nodes) {
    if (byId.has(n.id)) errs.push(`duplicate id ${n.id}`);
    byId.set(n.id, n);
    if (![n.x, n.y, n.w, n.h].every(Number.isFinite) || n.w <= 0 || n.h <= 0) errs.push(`bad box ${show(n)}`);
  }
  const files = f.nodes.filter((n) => n.kind === 'file');
  const dirs = f.nodes.filter((n) => n.kind === 'dir');
  const fo = findOverlap(files);
  if (fo) errs.push(`file overlap ${show(fo[0])} / ${show(fo[1])}`);
  const nested = f.wires === 'none';
  const below = !f.wires || f.wires === 'elbow' || f.wires === 'bus';
  if (!nested) {
    const po = findOverlap(dirs);
    if (po) errs.push(`platform overlap ${show(po[0])} / ${show(po[1])}`);
  } else {
    const kids = new Map<string, LayoutNode[]>();
    for (const n of f.nodes) if (n.parent !== null) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
    for (const k of kids.values()) {
      const po = findOverlap(k);
      if (po) errs.push(`district overlap ${show(po[0])} / ${show(po[1])}`);
    }
  }
  for (const n of f.nodes) {
    if (n.parent === null) {
      if (n.kind !== 'dir' || n.path !== '') errs.push(`orphan ${show(n)}`);
      continue;
    }
    const p = byId.get(n.parent);
    if (!p || p.kind !== 'dir') {
      errs.push(`${show(n)}: parent ${n.parent} missing or not a dir`);
      continue;
    }
    if (p.ghost && !n.ghost) errs.push(`live ${show(n)} under ghost ${show(p)}`);
    if (n.kind === 'file') {
      if (n.x < p.x - E || n.y < p.y - E || n.x + n.w > p.x + p.w + E || n.y + n.h > p.y + p.h + E)
        errs.push(`file ${show(n)} outside platform ${show(p)}`);
    } else if (nested) {
      if (n.x < p.x - E || n.y < p.y - E || n.x + n.w > p.x + p.w + E || n.y + n.h > p.y + p.h + E)
        errs.push(`district ${show(n)} outside parent ${show(p)}`);
    } else if (below && n.y < p.y + p.h - E) errs.push(`dir ${show(n)} not below parent ${show(p)}`);
  }
  const b = bbox(f.nodes);
  assert.deepEqual(f.bbox, b, 'frame bbox');
  return errs;
}

/** Run the strategy over the whole history; check the frames `want` selects. */
function checkGeometry(h: History, name: string, opts: Options, want: (i: number) => boolean = () => true): number {
  let checked = 0;
  new Runner(h, strategies[name], opts, 1e9).run((f) => {
    checked++;
    const errs = geometryErrors(f);
    if (errs.length) assert.fail(`${h.repo} ${name} ${JSON.stringify(opts)} @${f.commit}:\n  ${errs.slice(0, 5).join('\n  ')}`);
  }, want);
  return checked;
}

/** Wider random histories than randomHistory: random deep paths, unicode names, whole-dir moves. */
function wildHistory(seed: number, commits: number): History {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const names = ['a', 'b', 'Z', 'é', '中', '\u{1F600}', 'x y', 'lib', 'src'];
  const dirs = [''];
  const live = new Set<string>();
  let n = 0;
  const steps: Change[][] = [];
  for (let i = 0; i < commits; i++) {
    const used = new Set<string>();
    const ch: Change[] = [];
    if (rnd() < 0.15 && dirs.length < 40) {
      const parent = pick(dirs);
      dirs.push((parent ? parent + '/' : '') + pick(names) + (n++ % 7));
    }
    const burst = rnd() < 0.05 ? 25 : 1 + Math.floor(rnd() * 6);
    for (let j = 0; j < burst; j++) {
      const files = [...live].filter((p) => !used.has(p));
      const r = rnd();
      if (r < 0.5 || files.length < 4) {
        const d = pick(dirs);
        const p = `${d ? d + '/' : ''}${pick(names)}${n++}`;
        ch.push(A(p, 1 + Math.floor(rnd() * 5000)));
        live.add(p);
        used.add(p);
      } else if (r < 0.75) {
        const p = pick(files);
        ch.push(D(p));
        live.delete(p);
        used.add(p);
      } else if (r < 0.85) {
        const p = pick(files);
        ch.push(M(p, 1 + Math.floor(rnd() * 5000)));
        used.add(p);
      } else {
        const p = pick(files);
        const d = pick(dirs);
        const to = `${d ? d + '/' : ''}${pick(names)}${n++}`;
        ch.push(R(p, to));
        live.delete(p);
        live.add(to);
        used.add(p);
        used.add(to);
      }
    }
    // Occasionally move a whole directory's direct files elsewhere (mass move).
    if (rnd() < 0.04) {
      const from = pick(dirs);
      const to = pick(dirs);
      if (from !== to)
        for (const p of [...live]) {
          if (used.has(p) || (from ? !p.startsWith(from + '/') : false) || p.slice(from ? from.length + 1 : 0).includes('/')) continue;
          const q = `${to ? to + '/' : ''}mv${n++}`;
          ch.push(R(p, q));
          live.delete(p);
          live.add(q);
          used.add(p);
          used.add(q);
        }
    }
    steps.push(ch);
  }
  const h = hist(steps);
  h.repo = `wild-${seed}`;
  return h;
}

// Geometry stressors, crossed with every strategy's own stressors.
const geo: Options[] = [
  {},
  { hgap: 0, vgap: 0, pad: 0 },
  { hgap: 0, vgap: 0, pad: 0, align: 'center', gridMode: 'fixed', gridCols: 1 },
  { cell: 0.5, pad: 0, vgap: 0, hgap: 0.25, gridMode: 'fixed', gridCols: 3, align: 'center' },
  { cell: 2.5, pad: 0.1, hgap: 0.3, vgap: 0.1 },
];
// Every arrangement, crossed with a subset of the geometry stressors (all of them would ×4 the run).
const arranges: Options[] = [{}, { arrange: 'wrap' }, { arrange: 'nested' }, { arrange: 'radial' }, { arrange: 'spiral' }];
// Strategies that arrange themselves (no `arrange` option, e.g. city) get one pass with the
// geometry keys they accept.
const arrangesFor = (name: string): Options[] => ('arrange' in strategies[name].schema ? arranges : [{}]);
const geoFor = (a: Options, name: string): Options[] => {
  const keys = Object.keys(strategies[name].schema);
  const fit = (o: Options) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
  return (Object.keys(a).length ? [geo[0], geo[2], geo[3]] : geo).map(fit);
};
const own: Record<string, Options[]> = {
  recompute: [{ order: 'name' }, { order: 'birth', followRenames: false }],
  hindsight: [{ showGhosts: true }, { showGhosts: true, order: 'name', followRenames: false }, { showGhosts: false }],
  slack: [
    { slack: 0, growth: 1 },
    { slack: 0, growth: 1.01, growthMode: 'additive' },
    { slack: 3, growth: 4, order: 'name' },
    { growthMode: 'additive', followRenames: false },
  ],
  city: [{}, { followRenames: false }, { squeeze: 'pack', squeezeRate: 0 }, { squeeze: 'slide' }, { squeeze: 'organic' }],
  metro: [{}, { followRenames: false }, { squeeze: 'slide', squeezeRate: 0 }, { squeeze: 'pack', squeezeRate: 0.5 }, { squeeze: 'slide', squeezeRate: 3, followRenames: false }, { squeeze: 'organic' }, { squeeze: 'organic', squeezeRate: 0, warpCell: 2, warpMin: 0.1 }],
  'metro-spiral': [{}, { followRenames: false }, { squeeze: 'organic' }],
  'metro-pack': [{}, { followRenames: false }],
  'metro-warp': [{}, { followRenames: false }],
  'metro-hex': [{}, { followRenames: false }],
  'metro-seams': [{}, { followRenames: false }],
  tombstone: [
    {},
    { reuse: false, compactRatio: 1 },
    { compactRatio: 0, ghostTtl: 1 },
    { ghostTtl: 2, slack: 0.3, growth: 1.01, growthMode: 'additive' },
    { reuse: false, compactRatio: 0.3, ghostTtl: 5, slack: 1, growth: 1, followRenames: false },
    { slack: 0.5, growth: 3, compactRatio: 1 },
  ],
};

test('geometry: own option grid covers every registered strategy', () => {
  for (const name of Object.keys(strategies)) assert.ok(own[name], `add ${name} to the geometry test's option grid`);
});

test('geometry invariants: random histories × every strategy × aggressive options', () => {
  const hs = [sample, randomHistory(5, 160), randomHistory(77, 160), wildHistory(1, 160), wildHistory(2024, 160), wildHistory(9, 220)];
  let frames = 0;
  for (const name of Object.keys(strategies))
    for (const o of own[name] ?? [{}])
      for (const a of arrangesFor(name)) for (const g of geoFor(a, name)) for (const h of hs) frames += checkGeometry(h, name, { ...o, ...g, ...a });
  assert.ok(frames > 10_000, `checked ${frames} frames`);
});

test('geometry invariants: the checker catches overlaps', () => {
  const box = (id: string, kind: 'dir' | 'file', x: number, y: number, w: number, parent: string | null): LayoutNode =>
    ({ id, kind, path: id === 'd:' ? '' : id, parent, x, y, w, h: w });
  const frame = (nodes: LayoutNode[]): Frame => ({ commit: 0, sha: '', time: 0, strategy: 't', nodes, bbox: bbox(nodes) });
  const root = box('d:', 'dir', 0, 0, 4, null);
  assert.deepEqual(geometryErrors(frame([root, box('d:a', 'dir', 0, 4, 2, 'd:'), box('d:b', 'dir', 2, 4, 2, 'd:')])), [], 'touching is fine');
  assert.match(geometryErrors(frame([root, box('d:a', 'dir', 0, 4, 2, 'd:'), box('d:b', 'dir', 1.5, 4, 2, 'd:')]))[0], /platform overlap/);
  assert.match(geometryErrors(frame([root, box('f:1', 'file', 0, 0, 1, 'd:'), box('f:2', 'file', 0.5, 0.5, 1, 'd:')]))[0], /file overlap/);
  assert.match(geometryErrors(frame([root, box('f:1', 'file', 3.5, 0, 1, 'd:')]))[0], /outside platform/);
  assert.match(geometryErrors(frame([root, box('d:a', 'dir', 0, 4, 1, 'd:'), box('d:a', 'dir', 2, 4, 1, 'd:')]))[0], /duplicate id/);
  assert.ok(geometryErrors(frame([root, box('d:a', 'dir', 0, 3, 2, 'd:')])).some((e) => /not below parent/.test(e)));
});

interface Fixture {
  name: string;
  path: string;
  kind: 'public' | 'synthetic';
  ref: string | null;
}
const fixtures: Fixture[] = JSON.parse(readFileSync(join(ROOT, 'fixtures.json'), 'utf8'));
const fixtureOpts: Record<string, Options[]> = {
  recompute: [{ order: 'name', align: 'center' }, { order: 'birth', hgap: 0, vgap: 0, pad: 0 }],
  hindsight: [{ showGhosts: true, hgap: 0, vgap: 0, pad: 0, align: 'center' }],
  slack: [{ growthMode: 'additive', hgap: 0, vgap: 0, pad: 0 }, { slack: 0, growth: 1.01, gridMode: 'fixed', gridCols: 2, align: 'center' }],
  city: [{ hgap: 0, pad: 0 }, {}, { squeeze: 'slide', squeezeRate: 0 }, { squeeze: 'organic', hgap: 0, pad: 0 }],
  metro: [{ hgap: 0, pad: 0 }, {}, { squeeze: 'slide', hgap: 0, pad: 0 }, { squeeze: 'pack', squeezeRate: 0 }, { squeeze: 'organic', squeezeRate: 0 }],
  'metro-spiral': [{ hgap: 0, pad: 0 }, {}],
  'metro-pack': [{ hgap: 0, pad: 0 }, {}],
  'metro-warp': [{ hgap: 0, pad: 0 }, {}],
  'metro-hex': [{ hgap: 0, pad: 0 }, {}],
  'metro-seams': [{ hgap: 0, pad: 0 }, {}],
  tombstone: [{ ghostTtl: 10, slack: 0.25, hgap: 0, vgap: 0, pad: 0 }, { reuse: false, compactRatio: 1, gridMode: 'fixed', gridCols: 1, align: 'center' }],
};

for (const f of fixtures.filter((x) => x.kind === 'synthetic')) {
  const repo = resolve(ROOT, f.path);
  const present = existsSync(join(repo, '.git')) || existsSync(join(repo, 'HEAD'));
  test(`geometry invariants: fixture ${f.name} (sampled)`, { skip: present ? false : `${f.path} missing` }, () => {
    const h = loadHistory(repo, { ref: f.ref ?? undefined, name: f.name });
    const last = h.commits.length - 1;
    const stride = Math.max(1, Math.floor(h.commits.length / 25));
    for (const name of Object.keys(strategies))
      for (const o of fixtureOpts[name] ?? [{}])
        for (const a of arrangesFor(name)) checkGeometry(h, name, { ...o, ...a }, (i) => i % stride === 0 || i === last);
  });
}
