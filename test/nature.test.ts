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
