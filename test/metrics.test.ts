import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogHistogram, MetricsAccumulator, frameStats, orderStats } from '../src/metrics/metrics.ts';
import { bbox } from '../src/geometry/treev.ts';
import type { Frame, LayoutNode } from '../src/types.ts';

const dir = (path: string, x: number, y: number, parent: string | null = 'd:', w = 2, h = 2, ghost = false): LayoutNode => ({
  id: `d:${path}`, kind: 'dir', path, parent, x, y, w, h, ghost: ghost || undefined,
});
const file = (id: number, path: string, parent: string, x: number, y: number, ghost = false): LayoutNode => ({
  id: `f:${id}`, kind: 'file', path, parent, x, y, w: 1, h: 1, ghost: ghost || undefined,
});
const frame = (commit: number, nodes: LayoutNode[]): Frame => ({
  commit, sha: String(commit).padStart(40, '0'), time: commit, strategy: 't', nodes, bbox: bbox(nodes),
});
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('displacement: files and dirs separately, ghosts and newcomers excluded', () => {
  const acc = new MetricsAccumulator();
  const f0 = frame(0, [dir('', 0, 0, null, 4, 2), file(1, 'a', 'd:', 0, 0), file(2, 'b', 'd:', 1, 0), file(3, 'c', 'd:', 2, 0)]);
  // root moves 3-4-5 (=5); file 1 still, file 2 moves (3,4)->5, file 3 becomes a ghost and moves (ignored),
  // file 4 is new (ignored).
  const f1 = frame(1, [dir('', 3, 4, null, 4, 2), file(1, 'a', 'd:', 0, 0), file(2, 'b', 'd:', 4, 4), file(3, 'c', 'd:', 9, 9, true), file(4, 'd', 'd:', 3, 0)]);
  assert.equal(acc.push(f0), null);
  const s = acc.push(f1)!;
  assert.equal(s.files.survivors, 2);
  assert.equal(s.files.moved, 1);
  close(s.files.mean, 2.5);
  assert.equal(s.dirs.survivors, 1);
  close(s.dirs.mean, 5);
  close(s.all.mean, 10 / 3);
  assert.equal(s.structural, true);

  const r = acc.summary();
  assert.equal(r.transitions, 1);
  close(r.files.meanStepMean, 2.5);
  close(r.files.max, 5);
  close(r.all.disruption, 10);
  close(r.files.meanMovedFrac, 0.5);
  close(r.all.stepsWithMoveFrac, 1);
});

test('summary averages per-step means, counts quiet steps that still moved', () => {
  const acc = new MetricsAccumulator();
  const base = (dx: number, extra = false) => {
    const n = [dir('', 0, 0, null, 4, 2), file(1, 'a', 'd:', dx, 0), file(2, 'b', 'd:', 1, 0)];
    if (extra) n.push(file(3, 'c', 'd:', 2, 0));
    return n;
  };
  acc.push(frame(0, base(0)));
  acc.push(frame(1, base(0))); // quiet, still
  acc.push(frame(2, base(2))); // quiet, file 1 moves 2
  acc.push(frame(3, base(2, true))); // structural, nothing moves
  const r = acc.summary();
  assert.equal(r.transitions, 3);
  assert.equal(r.quiet.steps, 2);
  assert.equal(r.quiet.movedAnyway, 1);
  close(r.quiet.disruption, 2);
  // file means per step: 0, 1, 0 -> 1/3
  close(r.files.meanStepMean, 1 / 3);
  close(r.files.stepsWithMoveFrac, 1 / 3);
  close(r.files.meanMovedFrac, (0 + 0.5 + 0) / 3);
  close(r.dirs.meanStepMean, 0);
  // all: step 2 has 3 survivors, one moved by 2
  close(r.all.meanStepMean, 2 / 3 / 3);
});

test('p95 from the histogram is close to the exact value and bounded by max', () => {
  const h = new LogHistogram();
  const vals: number[] = [];
  for (let i = 0; i < 1000; i++) vals.push(i < 900 ? 0 : (i - 899) * 0.5); // 900 zeros, then 0.5..50
  for (const v of vals) h.add(v);
  const sorted = vals.slice().sort((a, b) => a - b);
  const exact = sorted[Math.ceil(0.95 * sorted.length) - 1];
  const est = h.quantile(0.95);
  assert.ok(Math.abs(est - exact) / exact < 0.05, `p95 ${est} vs ${exact}`);
  assert.equal(h.quantile(0.5), 0);
  assert.ok(h.quantile(1) <= 50);
  assert.equal(new LogHistogram().quantile(0.95), 0);
});

test('compactness and ghost fraction', () => {
  // bbox 0..4 x 0..2 = 8; 3 live files -> 3/8. One ghost file of 4.
  const f = frame(0, [dir('', 0, 0, null, 4, 2), file(1, 'a', 'd:', 0, 0), file(2, 'b', 'd:', 1, 0), file(3, 'c', 'd:', 2, 0), file(4, 'd', 'd:', 3, 1, true)]);
  const s = frameStats(f);
  close(s.compactness, 3 / 8);
  assert.equal(s.ghostFiles, 1);
  close(frameStats(f, 0.5).compactness, (3 * 0.25) / 8);
  const acc = new MetricsAccumulator();
  acc.push(f);
  acc.push(frame(1, [dir('', 0, 0, null, 2, 1), file(1, 'a', 'd:', 0, 0)]));
  const r = acc.summary();
  close(r.compactness.final, 1 / 2);
  close(r.compactness.mean, (3 / 8 + 1 / 2) / 2);
  close(r.ghost.meanFileFrac, (0.25 + 0) / 2);
  assert.equal(r.ghost.finalFileFrac, 0);
  close(r.bbox.aspect, 2);
  assert.equal(r.maxBbox.w, 4);
});

test('order: dirs by x, files by row then column, ghosts ignored', () => {
  const nodes = [
    dir('', 0, 0, null, 10, 3),
    // child dirs in x order: b, a, c -> pairs (b,a) bad, (a,c) ok
    dir('b', 0, 5), dir('a', 3, 5), dir('c', 6, 5),
    // files of root in a 2-col grid: row0: x.ts y.ts ; row1: a.ts (ghost z skipped)
    file(1, 'x.ts', 'd:', 0, 0), file(2, 'y.ts', 'd:', 1, 0), file(3, 'a.ts', 'd:', 0, 1), file(4, 'z.ts', 'd:', 1, 1, true),
  ];
  const { pairs, bad } = orderStats(nodes);
  assert.equal(pairs, 4);
  assert.equal(bad, 2); // (b,a) and (y.ts,a.ts)
  close(frameStats(frame(0, nodes)).disorder, 0.5);
});

test('series buckets cover the run', () => {
  const acc = new MetricsAccumulator({ totalFrames: 10, buckets: 5 });
  for (let i = 0; i < 10; i++) acc.push(frame(i, [dir('', 0, 0, null, 1, 1), file(1, 'a', 'd:', i % 2, 0)]));
  const r = acc.summary();
  assert.equal(r.series.movedFrac.length, 5);
  assert.equal(r.series.liveFiles[4], 1);
});

test('a rename that keeps identity is a tree change, not a quiet step', () => {
  const acc = new MetricsAccumulator();
  acc.push(frame(0, [dir('', 0, 0, null, 2, 1), file(1, 'a', 'd:', 0, 0)]));
  const s = acc.push(frame(1, [dir('', 0, 0, null, 2, 1), file(1, 'b', 'd:', 1, 0)]))!;
  assert.equal(s.structural, true);
  assert.equal(acc.summary().quiet.steps, 0);
});

test('structural averages skip content-only commits', () => {
  const acc = new MetricsAccumulator();
  const fr = (c: number, n: LayoutNode[]) => frame(c, [dir('', 0, 0, null, 4, 1), ...n]);
  acc.push(fr(0, [file(1, 'a', 'd:', 0, 0)]));
  acc.push(fr(1, [file(1, 'a', 'd:', 0, 0)])); // quiet
  acc.push(fr(2, [file(1, 'a', 'd:', 1, 0), file(2, 'b', 'd:', 0, 0)])); // add b, a moves: 1 of 2 survivors moved
  const r = acc.summary();
  assert.equal(r.structural.steps, 1);
  close(r.structural.meanMovedFrac, 0.5);
  close(r.all.meanMovedFrac, 0.25);
});

test('player encoding round-trips positions and flags moved nodes', async () => {
  const { PlayerEncoder, StringTable, pdNew, pdFrame, pdChecksum } = await import('../src/report/encode.ts');
  const st = new StringTable();
  const enc = new PlayerEncoder(st);
  const f0 = frame(0, [dir('', 0, 0, null, 3.5, 1.5), file(1, 'a', 'd:', 0.6, 0.6), file(2, 'b', 'd:', 1.6, 0.6)]);
  const f1 = frame(1, [dir('', 0, 0, null, 3.5, 1.5), file(1, 'a', 'd:', 2.6, 0.6), file(3, 'c', 'd:', 1.6, 0.6, true)]);
  enc.add(f0, 0);
  enc.add(f1, 1);
  const p = enc.finish();
  const r = { b: new Uint8Array(Buffer.from(p.data, 'base64')), p: 0 };
  const s = pdNew(p.kinds.length);
  pdFrame(r, s, null);
  assert.equal(pdChecksum(s), p.sums[0], 'checksum frame 0');
  const moved: number[] = [], dist: number[] = [];
  pdFrame(r, s, moved, dist);
  assert.equal(pdChecksum(s), p.sums[1], 'checksum frame 1');
  close(dist[0], 2);
  assert.equal(r.p, r.b.length);
  assert.equal(p.kinds, 'dfff');
  assert.deepEqual(moved, [1]);
  assert.equal(s.f[0][1], 260);
  assert.equal(s.live[2], 0, 'b removed');
  assert.equal(s.f[4][3], 1, 'c is a ghost');
  assert.equal(st.list[s.f[7][3]], 'c');
});

test('player encoding of a warped run: base rects and meshes round-trip', async () => {
  const { PlayerEncoder, StringTable, pdNew, pdFrame, pdChecksum, pdMeshes } = await import('../src/report/encode.ts');
  const { Runner } = await import('../src/engine.ts');
  const { strategies } = await import('../src/strategies/index.ts');
  const { randomHistory } = await import('./helpers.ts');
  const enc = new PlayerEncoder(new StringTable());
  const frames: Frame[] = [];
  new Runner(randomHistory(3, 60), strategies.metro, { squeeze: 'organic' }, 1e9).run((f) => (frames.push(f), enc.add(f, frames.length - 1)));
  const p = enc.finish();
  assert.ok(p.mesh && p.meshCell === 4);
  const ms = pdMeshes(p.mesh!, p.meshCell!, frames.length);
  const r = { b: new Uint8Array(Buffer.from(p.data, 'base64')), p: 0 };
  const s = pdNew(p.kinds.length);
  frames.forEach((f, i) => {
    pdFrame(r, s, null);
    assert.equal(pdChecksum(s), p.sums[i], `checksum frame ${i}`);
    const m = f.mesh!, d = ms[i];
    assert.deepEqual([d.i0, d.j0, d.ni, d.nj], [m.i0, m.j0, m.ni, m.nj]);
    m.d.forEach((v, k) => assert.ok(Math.abs(v - d.d[k]) <= 0.025 + 1e-9, `frame ${i} vertex ${k}`));
  });
});

test('survivors are matched by cid: a delete+add rename still pays for its jump', () => {
  // followRenames=false: the strategy gives the renamed file a new id (f:2), the Runner's cid keeps f:1
  const acc = new MetricsAccumulator();
  const root = dir('', 0, 0, null, 4, 1);
  root.cid = root.id;
  const a = { ...file(1, 'a', 'd:', 0, 0), cid: 'f:1' };
  const b = { ...file(2, 'b', 'd:', 3, 0), cid: 'f:1' };
  const ghost = file(1, 'a', 'd:', 0, 0, true); // no cid
  acc.push(frame(0, [root, a]));
  const s = acc.push(frame(1, [root, ghost, b]))!;
  assert.equal(s.files.survivors, 1);
  assert.equal(s.files.moved, 1);
  close(s.files.mean, 3);
  assert.equal(s.structural, true, 'path changed under the same identity');
});

test('moveDistances matches by cid and reports distance keyed by the current id', async () => {
  const { moveDistances, moveTier, MOVE_TIERS } = await import('../src/render/svg.ts');
  const f0 = frame(0, [{ ...file(1, 'a', 'd:', 0, 0), cid: 'f:1' }, { ...file(5, 'x', 'd:', 0, 1), cid: 'f:5' }]);
  const f1 = frame(1, [{ ...file(2, 'b', 'd:', 3, 4), cid: 'f:1' }, { ...file(5, 'x', 'd:', 0, 1), cid: 'f:5' }]);
  const m = moveDistances(f0, f1);
  assert.deepEqual([...m.entries()], [['f:2', 5]]);
  assert.equal(moveTier(0.5), 0);
  assert.equal(moveTier(MOVE_TIERS[0]), 1);
  assert.equal(moveTier(1e9), MOVE_TIERS.length);
});

test('horizon compares frames K apart and needs at least two pairs', () => {
  const run = (n: number) => {
    const acc = new MetricsAccumulator();
    // the file moves one cell at frames 150 and 300; the root never moves
    for (let i = 0; i < n; i++) acc.push(frame(i, [dir('', 0, 0, null, 4, 1), file(1, 'a', 'd:', Math.floor(i / 150), 0)]));
    return acc.summary();
  };
  const r = run(301);
  assert.deepEqual(r.horizon.map((h) => h.k), [100]);
  const h = r.horizon[0];
  assert.equal(h.pairs, 3); // 0-100 (still), 100-200 (moved), 200-300 (moved)
  close(h.meanMovedFrac, (0 + 0.5 + 0.5) / 3);
  close(h.meanShift, (0 + 0.5 + 0.5) / 3);
  assert.deepEqual(run(200).horizon, [], 'one pair only: omitted');
  assert.equal(run(201).horizon[0].pairs, 2);
});

test('normRanks leaves NaN out of the ranking', async () => {
  const { normRanks } = await import('../src/report/columns.ts');
  const r = normRanks([3, NaN, 1, 2], 'low');
  assert.ok(Number.isNaN(r[1]));
  assert.deepEqual([r[0], r[2], r[3]], [1, 0, 0.5]);
  assert.deepEqual(normRanks([NaN, 7], 'high'), [NaN, 0]);
});

test('followRenames=false pays for a cross-directory rename like followRenames=true (Runner cid)', async () => {
  const { Runner } = await import('../src/engine.ts');
  const { getStrategy } = await import('../src/strategies/index.ts');
  const { A, R, hist } = await import('./helpers.ts');
  // a/x.ts moves to b/x.ts: a real relocation in every strategy
  const h = hist([[A('a/x.ts'), A('a/y.ts'), A('b/z.ts')], [R('a/x.ts', 'b/x.ts')]]);
  const run = (followRenames: boolean) => {
    const acc = new MetricsAccumulator();
    new Runner(h, getStrategy('tombstone'), { followRenames }, 1000).run((f) => acc.push(f));
    return acc.summary();
  };
  const on = run(true), off = run(false);
  assert.ok(on.files.max > 0, 'the renamed file moved');
  assert.equal(off.files.movedNodeSteps, on.files.movedNodeSteps);
  close(off.files.max, on.files.max);
});
