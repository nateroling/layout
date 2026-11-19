import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommit, emptyTree } from '../src/model/tree.ts';
import { Runner } from '../src/engine.ts';
import { strategies } from '../src/strategies/index.ts';
import type { Change, Commit, Frame, History } from '../src/types.ts';

export function hist(steps: Change[][]): History {
  const commits: Commit[] = steps.map((changes, index) => ({
    index,
    sha: index.toString(16).padStart(40, '0'),
    time: 1_700_000_000 + index * 3600,
    author: 't',
    subject: `c${index}`,
    changes,
  }));
  return { repo: 'synthetic', head: commits.at(-1)!.sha, commits };
}

const A = (path: string, size = 10): Change => ({ type: 'A', path, size });
const D = (path: string): Change => ({ type: 'D', path, size: 0 });
const M = (path: string, size = 20): Change => ({ type: 'M', path, size });
const R = (oldPath: string, path: string, size = 10): Change => ({ type: 'R', oldPath, path, size });

export const sample = hist([
  [A('README.md'), A('src/a.ts'), A('src/b.ts')],
  [A('src/lib/x.ts'), M('src/a.ts')],
  [R('src/b.ts', 'src/lib/b.ts')],
  [D('src/lib/x.ts'), D('src/lib/b.ts'), A('docs/guide.md')],
  [A('src/lib/y.ts')],
  [D('src/a.ts'), A('src/c.ts'), A('aaa/first.ts')],
  [R('src/c.ts', 'src/d.ts', 30)],
]);

test('tree tracks files, dirs, and rename identity', () => {
  const t = emptyTree();
  for (const c of sample.commits.slice(0, 3)) applyCommit(t, c, true);
  assert.deepEqual([...t.files.keys()].sort(), ['README.md', 'src/a.ts', 'src/lib/b.ts', 'src/lib/x.ts']);
  const b = t.files.get('src/lib/b.ts')!;
  assert.equal(b.id, 3, 'rename keeps identity');
  assert.equal(b.born, 0);
  assert.equal(b.arrived, 2, 'moved dirs -> arrived updated');
  assert.equal(t.dirs.get('src')!.count, 3);
  const d = applyCommit(t, sample.commits[3], true);
  assert.deepEqual(d.dirsRemoved, ['src/lib']);
  assert.ok(!t.dirs.has('src/lib'));
  assert.ok(t.dirs.has('docs'));
});

test('rename without followRenames is delete+add', () => {
  const t = emptyTree();
  for (const c of sample.commits.slice(0, 3)) applyCommit(t, c, false);
  assert.equal(t.files.get('src/lib/b.ts')!.id, 5);
});

test('dir emptied and refilled in one commit keeps its arrival', () => {
  const t = emptyTree();
  applyCommit(t, hist([[A('p/q.ts')]]).commits[0], true);
  const c: Commit = { ...hist([[A('x')], [D('p/q.ts'), A('p/r.ts')]]).commits[1] };
  const d = applyCommit(t, c, true);
  assert.equal(t.dirs.get('p')!.arrived, 0);
  assert.deepEqual(d.dirsAdded, []);
  assert.deepEqual(d.dirsRemoved, []);
});

test('every strategy: at(n) via checkpoints equals a full replay, and file nodes match the tree', () => {
  for (const s of Object.values(strategies)) {
    const full: Frame[] = [];
    new Runner(sample, s, {}, 1000).run((f) => full.push(f));
    const r = new Runner(sample, s, {}, 2);
    r.run(() => {}, () => false); // build checkpoints
    for (let n = sample.commits.length - 1; n >= 0; n--) {
      assert.deepEqual(r.at(n), full[n], `${s.name} @${n}`);
    }
    const t = emptyTree();
    for (const c of sample.commits) {
      applyCommit(t, c, true);
      const live = full[c.index].nodes.filter((x) => x.kind === 'file' && !x.ghost).map((x) => x.path).sort();
      assert.deepEqual(live, [...t.files.keys()].sort(), `${s.name} live files @${c.index}`);
    }
  }
});
