// Nature layouts (snapshot experiment): every file is placed exactly once, circles never overlap,
// cells tile their region, and the layouts are deterministic.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { area } from '../src/nature/cells.ts';
import { NATURE } from '../src/nature/index.ts';
import { buildSnapshot, rng } from '../src/nature/model.ts';

function synth(seed: number, n: number) {
  const r = rng(seed);
  const dirs = [''];
  const entries: [string, number][] = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.12) dirs.push(`${dirs[Math.floor(r() * dirs.length)]}d${i}/`.replace(/^\//, ''));
    const d = dirs[Math.floor(Math.pow(r(), 0.7) * dirs.length)];
    entries.push([`${d}f${i}.${['ts', 'rs', 'md'][i % 3]}`, Math.floor(Math.exp(r() * 12))]);
  }
  return buildSnapshot(`synth${seed}`, entries);
}

const snaps = [synth(1, 40), synth(2, 250), synth(3, 600), buildSnapshot('one', [['a.txt', 10]]), buildSnapshot('deep', [['a/b/c/d/e/f.txt', 10], ['a/b/x.txt', 5000]])];

for (const L of NATURE) {
  test(`nature/${L.name}: every file once, no overlaps, deterministic`, () => {
    for (const s of snaps) {
      const sc = L.run(s);
      assert.deepEqual(sc.marks.map((m) => m.f).sort((a, b) => a - b), s.files.map((f) => f.i), `${s.name}: files placed`);
      for (const m of sc.marks) assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y) && m.r > 0, `${s.name}: finite mark`);
      const circles = sc.marks.filter((m) => !m.poly);
      for (let i = 0; i < circles.length; i++)
        for (let j = i + 1; j < circles.length; j++) {
          const a = circles[i];
          const b = circles[j];
          assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 1e-6, `${s.name}: files ${a.f} and ${b.f} overlap`);
        }
      for (const m of sc.marks) if (m.poly) assert.ok(m.poly.length >= 6 && area(m.poly) > 0, `${s.name}: empty cell for file ${m.f}`);
      assert.deepEqual(L.run(s), sc, `${s.name}: deterministic`);
    }
  });
}

test('nature/cells: file cells tile the root and match their share of it within 10% (median)', () => {
  const L = NATURE.find((l) => l.name === 'cells')!;
  for (const s of snaps.slice(0, 3)) {
    const sc = L.run(s);
    const areas = sc.marks.map((m) => area(m.poly!));
    const total = areas.reduce((a, b) => a + b, 0);
    const want = sc.marks.map((m) => m.r);
    assert.ok(total > 0);
    const ratios = sc.marks.map((m, i) => areas[i] / (Math.PI * want[i] ** 2)).sort((a, b) => a - b);
    assert.ok(Math.abs(ratios[Math.floor(ratios.length / 2)] - 1) < 0.1, `${s.name}: median ratio ${ratios[Math.floor(ratios.length / 2)]}`);
  }
});

test('nature stable variants: every file once per frame, deterministic replay', async () => {
  const { VARIANTS } = await import('../src/nature/stable.ts');
  // a growing, churning tree: frame k has files 0..10k, minus every 7th once k > 3, one folder renamed at k = 5
  const frames = Array.from({ length: 8 }, (_, k) => {
    const entries: [string, number][] = [];
    for (let i = 0; i < 10 * (k + 1); i++) {
      if (k > 3 && i % 7 === 0) continue;
      const dir = i % 3 === 0 ? (k >= 5 ? 'lib2' : 'lib') : i % 3 === 1 ? 'src/a' : 'src/b/c';
      entries.push([`${dir}/f${i}.ts`, 100 + i * 37]);
    }
    return buildSnapshot('t', entries);
  });
  const idOf = (path: string) => Number(path.match(/f(\d+)\.ts$/)![1]);
  const run = (v: (typeof VARIANTS)[number]) => {
    const step = v.make();
    const seq = new Map<string, number>();
    return frames.map((snap) => {
      for (const d of snap.dirs) if (!seq.has(`d:${d.path}`)) seq.set(`d:${d.path}`, seq.size);
      for (const f of snap.files) if (!seq.has(`f:${idOf(f.path)}`)) seq.set(`f:${idOf(f.path)}`, seq.size);
      return step(snap, { id: (f) => idOf(f.path), seq: (k) => seq.get(k)! });
    });
  };
  for (const v of VARIANTS) {
    const a = run(v);
    a.forEach((sc, k) => {
      assert.deepEqual(sc.marks.map((m) => m.f).sort((x, y) => x - y), frames[k].files.map((f) => f.i), `${v.name} frame ${k}`);
      for (const m of sc.marks) assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y), `${v.name} frame ${k}: finite`);
    });
    assert.deepEqual(run(v), a, `${v.name}: deterministic`);
  }
});

test('cell cities: every file once per frame with a real cell, no overlapping lots, deterministic replay', async () => {
  const { CELL_CITIES } = await import('../src/nature/cellcity.ts');
  const { metro } = await import('../src/strategies/city.ts');
  const { mergeOptions } = await import('../src/engine.ts');
  const { applyCommit, emptyTree } = await import('../src/model/tree.ts');
  // growing and churning, with a container folder (crates/) whose subfolders become districts
  const lists = Array.from({ length: 8 }, (_, k) => {
    const out: string[] = [];
    for (let i = 0; i < 12 * (k + 1); i++) {
      if (k > 3 && i % 7 === 0) continue;
      const dir = ['', 'crates/a', 'crates/b/x', 'crates/c', 'docs', k >= 5 ? 'lib2' : 'lib'][i % 6];
      out.push(`${dir ? dir + '/' : ''}f${i}.ts`);
    }
    return out;
  });
  const run = (v: (typeof CELL_CITIES)[number]) => {
    const step = v.make();
    const tree = emptyTree();
    const mctx = { options: mergeOptions(metro, {}) };
    const ms = metro.init(mctx);
    const seq = new Map<string, number>();
    let prev = new Set<string>();
    return lists.map((paths, k) => {
      const now = new Set(paths);
      const changes = [...[...prev].filter((p) => !now.has(p)).map((path) => ({ type: 'D' as const, path, size: 0 })), ...paths.filter((p) => !prev.has(p)).map((path) => ({ type: 'A' as const, path, size: 100 }))];
      const c = { index: k, sha: `s${k}`, time: k, author: 'a', subject: '', changes };
      metro.step(ms, tree, c, applyCommit(tree, c, true), mctx);
      prev = now;
      const snap = buildSnapshot('t', paths.map((p) => [p, 100] as [string, number]));
      const ids = snap.files.map((f) => tree.files.get(f.path)!.id);
      for (const id of ids) if (!seq.has(`f:${id}`)) seq.set(`f:${id}`, seq.size);
      const m = { file: new Map(), dir: new Map() };
      for (const n of metro.frame(ms, tree, c, mctx)) (n.kind === 'file' ? m.file : m.dir).set(n.path, n);
      return { snap, sc: step(snap, { id: (f) => ids[f.i], seq: (key) => seq.get(key) ?? Infinity, metro: m }) };
    });
  };
  for (const v of CELL_CITIES) {
    const a = run(v);
    a.forEach(({ snap, sc }, k) => {
      assert.deepEqual(sc.marks.map((m) => m.f).sort((x, y) => x - y), snap.files.map((f) => f.i), `${v.name} frame ${k}: files placed`);
      for (const m of sc.marks) assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y) && m.poly && area(m.poly) > 1e-6, `${v.name} frame ${k}: real cell for file ${m.f}`);
      if (v.name === 'districts') {
        const sq = sc.marks.map((m) => `${Math.floor(m.x)},${Math.floor(m.y)}`);
        assert.equal(new Set(sq).size, sq.length, `districts frame ${k}: two files on one grid square`);
      }
    });
    assert.deepEqual(run(v).map((r) => r.sc), a.map((r) => r.sc), `${v.name}: deterministic`);
  }
});
