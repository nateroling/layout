import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, applyCommit, dirname, emptyTree } from '../src/model/tree.ts';
import { Runner, mergeOptions } from '../src/engine.ts';
import { getStrategy, strategies } from '../src/strategies/index.ts';
import type { Change, Frame, History, LayoutNode, Options } from '../src/types.ts';
import { A, D, M, R, hist, randomHistory, sample } from './helpers.ts';


export { randomHistory }; // re-exported for older importers; new code imports ./helpers.ts

const frames = (h: History, name: string, opts: Options = {}): Frame[] => {
  const out: Frame[] = [];
  new Runner(h, getStrategy(name), opts, 1000).run((f) => out.push(f));
  return out;
};

const byId = (f: Frame) => new Map(f.nodes.map((n) => [n.id, n]));

/** Checkpoint equivalence, live-file correctness, and unique node ids. */
function checkRun(h: History, name: string, opts: Options, followRenames = opts.followRenames !== false) {
  const full = frames(h, name, opts);
  const r = new Runner(h, getStrategy(name), opts, 7);
  r.run(() => {}, () => false);
  for (const n of [h.commits.length - 1, 50, 13, 7, 3, 0]) {
    if (n < h.commits.length) assert.deepEqual(r.at(n), full[n], `${name} ${JSON.stringify(opts)} @${n}`);
  }
  const t = emptyTree();
  for (const c of h.commits) {
    applyCommit(t, c, followRenames);
    const f = full[c.index];
    const live = f.nodes.filter((x) => x.kind === 'file' && !x.ghost).map((x) => x.path).sort();
    assert.deepEqual(live, [...t.files.keys()].sort(), `${name} ${JSON.stringify(opts)} live files @${c.index}`);
    const liveDirs = f.nodes.filter((x) => x.kind === 'dir' && !x.ghost).map((x) => x.path).sort();
    assert.deepEqual(liveDirs, [...t.dirs.keys()].sort(), `${name} ${JSON.stringify(opts)} live dirs @${c.index}`);
    const ids = new Set(f.nodes.map((x) => x.id));
    assert.equal(ids.size, f.nodes.length, `${name} ${JSON.stringify(opts)} unique ids @${c.index}`);
    for (const x of f.nodes) if (x.kind === 'file' && !x.ghost) assert.equal(x.id, `f:${t.files.get(x.path)!.id}`);
  }
}

const combos: Record<string, Options[]> = {
  recompute: [{}, { order: 'birth', align: 'left' }, { gridMode: 'fixed', gridCols: 3 }],
  hindsight: [{}, { order: 'name' }, { showGhosts: true }, { showGhosts: true, followRenames: false, align: 'center' }],
  slack: [
    {},
    { slack: 0 },
    { slack: 1, growth: 2, order: 'name' },
    { gridMode: 'fixed', gridCols: 4 },
    { followRenames: false },
    { growthMode: 'additive' },
    { growthMode: 'additive', slack: 0, growth: 2, align: 'center' },
  ],
  tombstone: [
    {},
    { reuse: false },
    { compactRatio: 1 },
    { compactRatio: 0.2, reuse: false },
    { slack: 0.25 },
    { slack: 0.5, growth: 2, compactRatio: 1, align: 'center' },
    { followRenames: false, gridMode: 'fixed', gridCols: 3 },
    { ghostTtl: 5 },
    { ghostTtl: 3, compactRatio: 1, reuse: false },
    { ghostTtl: 4, slack: 0.25, growthMode: 'additive' },
  ],
};

test('every strategy × option combos: checkpoints == replay, live files/dirs match, ids unique', () => {
  const rand = [randomHistory(1, 120), randomHistory(42, 90)];
  for (const name of Object.keys(strategies)) {
    for (const o of combos[name] ?? [{}]) {
      checkRun(sample, name, o);
      for (const h of rand) checkRun(h, name, o);
    }
  }
});

test('hindsight: surviving nodes never move unless their path changed', () => {
  for (const h of [sample, randomHistory(7, 150)]) {
    const fs = frames(h, 'hindsight');
    for (let i = 1; i < fs.length; i++) {
      const prev = byId(fs[i - 1]);
      for (const n of fs[i].nodes) {
        const p = prev.get(n.id);
        if (!p || p.path !== n.path) continue;
        assert.deepEqual([n.x, n.y], [p.x, p.y], `${n.id} moved @${i}`);
      }
    }
  }
  // A renamed file jumps to its new path's slot.
  const fs = frames(sample, 'hindsight');
  const b1 = fs[1].nodes.find((n) => n.path === 'src/b.ts')!;
  const b2 = fs[2].nodes.find((n) => n.path === 'src/lib/b.ts')!;
  assert.equal(b1.id, b2.id);
  assert.notDeepEqual([b1.x, b1.y], [b2.x, b2.y]);
});

test('hindsight showGhosts: non-live slots are ghosts with non-colliding ids', () => {
  const fs = frames(sample, 'hindsight', { showGhosts: true });
  const last = fs.at(-1)!;
  const ghosts = last.nodes.filter((n) => n.ghost);
  assert.ok(ghosts.some((n) => n.id === 'g:src/a.ts'));
  assert.ok(ghosts.some((n) => n.id === 'd:src/lib' && n.kind === 'dir') === false); // src/lib is live again at the end
  assert.ok(fs[3].nodes.some((n) => n.id === 'd:src/lib' && n.ghost));
});

const moved = (a: Frame, b: Frame): LayoutNode[] => {
  const prev = byId(a);
  return b.nodes.filter((n) => {
    const p = prev.get(n.id);
    return p && !p.ghost && !n.ghost && (p.x !== n.x || p.y !== n.y);
  });
};

test('slack: a directory growing within its reservation moves nothing', () => {
  const h = hist([[A('a/1'), A('b/1'), A('c/1')], [A('a/2'), A('a/3')]]);
  assert.deepEqual(moved(...(frames(h, 'slack') as [Frame, Frame])), []);
  // Contrast: birth-order recompute pushes the siblings.
  const rc = frames(h, 'recompute', { order: 'birth', align: 'left' });
  assert.ok(moved(rc[0], rc[1]).some((n) => n.path === 'b'));
});

test('slack: exceeding a reservation grows it geometrically and never shrinks', () => {
  const steps: Change[][] = [[A('a/0'), A('b/0')]];
  for (let i = 1; i < 40; i++) steps.push([A(`a/${i}`)]);
  for (let i = 0; i < 39; i++) steps.push([D(`a/${i}`)]);
  const fs = frames(hist(steps), 'slack');
  const bx = fs.map((f) => f.nodes.find((n) => n.path === 'b')!.x);
  const changes = bx.filter((x, i) => i > 0 && x !== bx[i - 1]).length;
  assert.ok(changes > 0 && changes <= 4, `b moved ${changes} times`);
  for (let i = 1; i < bx.length; i++) assert.ok(bx[i] >= bx[i - 1], 'never shrinks');
});

test('tombstone: a deletion moves nothing and leaves a ghost in place', () => {
  const h = hist([[A('a/1'), A('a/2'), A('a/3'), A('b/1')], [D('a/2')]]);
  const [f0, f1] = frames(h, 'tombstone', { compactRatio: 1 });
  assert.deepEqual(moved(f0, f1), []);
  const g = f1.nodes.find((n) => n.path === 'a/2')!;
  const o = f0.nodes.find((n) => n.path === 'a/2')!;
  assert.ok(g.ghost);
  assert.deepEqual([g.x, g.y], [o.x, o.y]);
});

test('tombstone: reuse fills the earliest ghost slot; reuse=false appends', () => {
  const h = hist([[A('a/1'), A('a/2'), A('a/3'), A('a/4')], [D('a/3'), D('a/2')], [A('a/9')]]);
  const fs = frames(h, 'tombstone', { compactRatio: 1 });
  const at = (f: Frame, p: string) => f.nodes.find((n) => n.path === p)!;
  assert.deepEqual([at(fs[2], 'a/9').x, at(fs[2], 'a/9').y], [at(fs[0], 'a/2').x, at(fs[0], 'a/2').y]);
  assert.deepEqual(moved(fs[1], fs[2]), []);
  const nr = frames(h, 'tombstone', { compactRatio: 1, reuse: false });
  assert.equal(nr[2].nodes.filter((n) => n.ghost).length, 2);
});

test('tombstone: compaction triggers only above compactRatio', () => {
  const h = hist([[A('a/1'), A('a/2'), A('a/3'), A('a/4')], [D('a/1'), D('a/2')], [D('a/3')]]);
  const fs = frames(h, 'tombstone', { reuse: false });
  assert.equal(fs[1].nodes.filter((n) => n.ghost).length, 2, '2/4 = 0.5 is not > 0.5');
  assert.equal(fs[2].nodes.filter((n) => n.ghost).length, 0, '3/4 > 0.5 -> compacted');
  const never = frames(h, 'tombstone', { compactRatio: 1 });
  assert.equal(never[2].nodes.filter((n) => n.ghost).length, 3);
});

test('tombstone: vanished directory stays as a ghost platform and revives in place', () => {
  const h = hist([[A('a/1'), A('b/1'), A('c/1')], [D('b/1')], [A('b/2')]]);
  const fs = frames(h, 'tombstone');
  const b = (f: Frame) => f.nodes.find((n) => n.id === 'd:b')!;
  assert.ok(b(fs[1]).ghost);
  assert.ok(!b(fs[2]).ghost);
  assert.deepEqual([b(fs[2]).x, b(fs[2]).y], [b(fs[0]).x, b(fs[0]).y]);
  assert.deepEqual(moved(fs[0], fs[1]), []);
  assert.deepEqual(moved(fs[1], fs[2]), []);
  // The root's ghost fraction (1 ghost dir of 3 kids) is under 0.5, so no compaction yet;
  // the new file reuses b's ghost slot.
  assert.deepEqual([fs[2].nodes.find((n) => n.path === 'b/2')!.x], [fs[0].nodes.find((n) => n.path === 'b/1')!.x]);
});

test('tombstone: cross-dir rename leaves a ghost with a distinct id; same-dir rename keeps the slot', () => {
  const h = hist([[A('a/1'), A('a/2'), A('b/1')], [R('a/1', 'b/9')], [R('a/2', 'a/3')]]);
  const fs = frames(h, 'tombstone', { compactRatio: 1 });
  const live = fs[1].nodes.find((n) => n.path === 'b/9')!;
  const ghost = fs[1].nodes.find((n) => n.path === 'a/1')!;
  assert.ok(ghost.ghost && !live.ghost);
  assert.notEqual(ghost.id, live.id);
  assert.equal(live.id, fs[0].nodes.find((n) => n.path === 'a/1')!.id);
  const a2 = fs[1].nodes.find((n) => n.path === 'a/2')!;
  const a3 = fs[2].nodes.find((n) => n.path === 'a/3')!;
  assert.equal(a2.id, a3.id);
  assert.deepEqual([a2.x, a2.y], [a3.x, a3.y]);
});

test('incremental reservations equal a full measure() with growing hooks', async () => {
  const { measure, geoFromOptions } = await import('../src/geometry/treev.ts');
  const { growingHooks, reserveOptions, dropReservations } = await import('../src/strategies/reserve.ts');
  const { liveTree } = await import('../src/strategies/recompute.ts');
  const { buildLDir } = await import('../src/strategies/tombstone.ts');
  const cases: [string, Options][] = [
    ['slack', {}],
    ['slack', { order: 'name', slack: 0.1, growth: 1.2, gridMode: 'fixed', gridCols: 3 }],
    ['slack', { slack: 0, growth: 2, cell: 1.3, pad: 0.35, hgap: 0.7 }],
    ['tombstone', { slack: 0.25 }],
    ['tombstone', { slack: 0.5, reuse: false, compactRatio: 0.3 }],
    ['tombstone', { slack: 0.25, compactRatio: 1, followRenames: false }],
    ['slack', { growthMode: 'additive' }],
    ['slack', { growthMode: 'additive', slack: 0, growth: 2, cell: 1.3, pad: 0.35, hgap: 0.7 }],
    ['tombstone', { slack: 0.25, growthMode: 'additive', ghostTtl: 6 }],
  ];
  for (const h of [sample, randomHistory(3, 150), randomHistory(99, 150)]) {
    for (const [name, given] of cases) {
      const s = getStrategy(name);
      const ctx = { options: mergeOptions(s, given) };
      const g = geoFromOptions(ctx.options);
      const ro = reserveOptions(ctx.options, { slack: name === 'slack' ? 0.25 : 0, growth: 1.5 });
      const t = emptyTree();
      const st = s.init(ctx);
      const ref = new Map();
      for (const c of h.commits) {
        const d = applyCommit(t, c, ctx.options.followRenames !== false);
        const before = name === 'tombstone' ? new Map(st.dirs) : null; // TDir object identity
        s.step(st, t, c, d, ctx);
        if (name === 'slack') {
          dropReservations(ref, (p) => t.dirs.has(p));
          measure(liveTree(t, ctx.options.order === 'name' ? 'name' : 'birth'), g, growingHooks(ref, ro, g));
        } else {
          // A directory entry replaced by a fresh one (reuse=false) starts a fresh reservation.
          dropReservations(ref, (p) => st.dirs.has(p) && (!before!.has(p) || before!.get(p) === st.dirs.get(p)));
          measure(buildLDir(st, t), g, growingHooks(ref, ro, g));
        }
        assert.deepEqual(st.res, ref, `${name} ${JSON.stringify(given)} @${c.index}`);
      }
    }
  }
});

/**
 * Drive a strategy by hand so the test can see its reservations. One leaf
 * (a/b/c) gains a file per commit inside a 4-deep tree with siblings on both
 * sides at every level.
 */
function leafGrowth(name: string, opts: Options, commits = 120) {
  const steps: Change[][] = [[
    A('r.txt'),
    A('a/b/a0/f'), A('a/b/c/f0'), A('a/b/z/f'), // left sibling, leaf, right sibling
    A('a/b/k/f'), A('a/y/f'), A('q/f'), A('q/w/f'),
  ]];
  for (let i = 1; i < commits; i++) steps.push([A(`a/b/c/f${i}`)]);
  const h = hist(steps);
  const s = getStrategy(name);
  const ctx = { options: mergeOptions(s, opts) };
  const t = emptyTree();
  const st = s.init(ctx);
  const out: { frame: LayoutNode[]; width: Map<string, number> }[] = [];
  for (const c of h.commits) {
    const d = applyCommit(t, c, true);
    s.step(st, t, c, d, ctx);
    const res = (st as { res: Map<string, { width: number }> }).res;
    out.push({ frame: s.frame(st, t, c, ctx), width: new Map([...res].map(([k, v]) => [k, v.width])) });
  }
  return out;
}

export let overflowStats = { overflows: 0, absorbed: 0, moved: 0 };

/** Returns the largest (displacement / leaf width growth) seen on overflow steps. */
export function checkConfinement(name: string, opts: Options): number {
  const run = leafGrowth(name, opts);
  const leaf = 'a/b/c';
  let worst = 0;
  overflowStats = { overflows: 0, absorbed: 0, moved: 0 };
  for (let i = 2; i < run.length; i++) {
    const before = run[i - 1], after = run[i];
    const prev = new Map(before.frame.map((n) => [n.id, n]));
    const L = prev.get(`d:${leaf}`)!;
    const movedNodes = after.frame.filter((n) => {
      const p = prev.get(n.id);
      return p && (p.x !== n.x || p.y !== n.y) && n.parent !== `d:${leaf}`; // the leaf's own files may reflow
    });
    const dL = after.width.get(leaf)! - before.width.get(leaf)!;
    if (dL === 0) {
      assert.deepEqual(movedNodes.map((n) => n.id), [], `${name} ${JSON.stringify(opts)} @${i}: no overflow, nothing moves`);
      continue;
    }
    // Nearest ancestor that absorbed the growth (its band did not grow).
    const absorber = ancestors(leaf + '/x').slice(1).find((a) => after.width.get(a) === before.width.get(a));
    const A = absorber === undefined ? undefined : prev.get(`d:${absorber}`)!;
    overflowStats.overflows++;
    if (A) overflowStats.absorbed++;
    overflowStats.moved += movedNodes.length;
    for (const n of movedNodes) {
      const p = prev.get(n.id)!;
      assert.ok(p.x > L.x, `${name} @${i}: ${n.path} left of the leaf moved`);
      if (A) assert.ok(p.x < A.x + before.width.get(absorber!)!, `${name} @${i}: ${n.path} outside ${absorber}'s band moved`);
      worst = Math.max(worst, Math.hypot(n.x - p.x, n.y - p.y) / dL);
    }
  }
  return worst;
}

test('reservations: a leaf overflow only moves nodes right of it inside the nearest absorbing band', () => {
  for (const name of ['slack', 'tombstone']) {
    for (const growth of [1.5, 1.2]) {
      const base: Options = name === 'tombstone' ? { slack: 0.25, growth } : { growth };
      checkConfinement(name, { ...base, growthMode: 'multiply' });
      const additive = checkConfinement(name, { ...base, growthMode: 'additive' });
      assert.ok(overflowStats.overflows >= 3);
      assert.ok(additive <= 1 + 1e-9, `${name} additive: nothing moves further than the leaf grew (ratio ${additive})`);
    }
  }
  // The spec rule amplifies: ancestors re-multiply their whole width.
  assert.ok(checkConfinement('slack', { growthMode: 'multiply' }) > 1);
});

test('additive growth: ancestors grow exactly by the overflow, the originating platform carries the headroom', () => {
  const run = leafGrowth('slack', { growthMode: 'additive' });
  for (let i = 2; i < run.length; i++) {
    const b = run[i - 1].width, a = run[i].width;
    for (const anc of ['a/b', 'a', '']) {
      const grew = a.get(anc)! - b.get(anc)!;
      const child = anc === 'a/b' ? 'a/b/c' : anc === 'a' ? 'a/b' : 'a';
      assert.ok(grew <= a.get(child)! - b.get(child)! + 1e-9, `@${i} ${anc || '/'} grew ${grew}, more than its child`);
    }
  }
});

test('tombstone ghostTtl: an expired ghost triggers local compaction even if its directory is untouched', () => {
  const steps: Change[][] = [[...Array.from({ length: 10 }, (_, i) => A(`a/f${i}`)), A('b/x'), A('c/x')], [D('a/f3'), D('b/x')]];
  for (let i = 2; i < 10; i++) steps.push([M('c/x', i)]);
  const h = hist(steps);
  const ghosts = (opts: Options) => frames(h, 'tombstone', opts).map((f) => f.nodes.filter((n) => n.ghost).map((n) => n.path).sort().join(','));
  // b/x lives in the ghost dir b; the root has 1 ghost kid of 3 (< 0.5), a has 1 ghost of 10.
  assert.deepEqual(ghosts({ ghostTtl: 3 }), ['', 'a/f3,b,b/x', 'a/f3,b,b/x', 'a/f3,b,b/x', 'a/f3,b,b/x', '', '', '', '', '']);
  assert.ok(ghosts({}).every((g, i) => i === 0 || g === 'a/f3,b,b/x'), 'ghostTtl=0 keeps ghosts forever');
  // Compaction moves only the directory's own later slots and the bands to its right.
  const fs = frames(h, 'tombstone', { ghostTtl: 3 });
  const x = (f: Frame, p: string) => f.nodes.find((n) => n.path === p && !n.ghost)!;
  assert.deepEqual([x(fs[5], 'a/f0').x, x(fs[5], 'a/f0').y], [x(fs[4], 'a/f0').x, x(fs[4], 'a/f0').y]);
});
