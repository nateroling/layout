import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCommit, cmp, emptyTree } from '../src/model/tree.ts';
import { Runner, mergeOptions, optionSchema, parseOptionValue } from '../src/engine.ts';
import { resolveCommitIndex } from '../src/git/extract.ts';
import { getStrategy, strategies } from '../src/strategies/index.ts';
import type { Commit, Frame } from '../src/types.ts';
import { A, D, hist, sample } from './helpers.ts';

export { hist, sample }; // re-exported for older importers; new code imports ./helpers.ts

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

// ---- option validation, CLI value parsing, commit refs, cmp ----

test('mergeOptions: defaults, normalisation, and rejection of unknown keys / bad values', () => {
  const slack = getStrategy('slack');
  const d = mergeOptions(slack);
  assert.equal(d.followRenames, true);
  assert.equal(d.growthMode, 'multiply');
  assert.equal(d.slack, 0.25);
  // Strings from JSON/CLI are normalised.
  const n = mergeOptions(slack, { followRenames: 'false', growth: '2', hgap: 0, vgap: 0, pad: 0 });
  assert.equal(n.followRenames, false);
  assert.equal(n.growth, 2);
  const bad: [string, Record<string, string | number | boolean>, RegExp][] = [
    ['slack', { growthmode: 'additive' }, /unknown option "growthmode" \(did you mean "growthMode"\?\)/],
    ['slack', { reuse: true }, /unknown option "reuse"/], // tombstone-only
    ['recompute', { showGhosts: true }, /unknown option "showGhosts"/],
    ['slack', { growthMode: 'add' }, /growthMode="add": expected one of multiply\|additive/],
    ['slack', { followRenames: 1 }, /expected true or false/],
    ['slack', { followRenames: 'yes' }, /expected true or false/],
    ['slack', { growth: 0.5 }, /must be >= 1/],
    ['slack', { slack: -0.1 }, /must be >= 0/],
    ['slack', { growth: '0x10' }, /expected a number/],
    ['slack', { growth: ' ' }, /expected a number/],
    ['slack', { cell: 0 }, /must be > 0/],
    ['slack', { pad: -1 }, /must be >= 0/],
    ['slack', { hgap: -1 }, /must be >= 0/],
    ['slack', { gridCols: 2.5 }, /expected an integer/],
    ['slack', { gridCols: 0 }, /must be >= 1/],
    ['slack', { align: 'right' }, /expected one of left\|center/],
    ['tombstone', { compactRatio: 1.5 }, /must be <= 1/],
    ['tombstone', { ghostTtl: 2.5 }, /expected an integer/],
    ['hindsight', { order: 'size' }, /expected one of birth\|name/],
  ];
  for (const [s, o, re] of bad) {
    assert.throws(() => mergeOptions(getStrategy(s), o), (e: Error) => re.test(e.message) && /valid options:/.test(e.message), `${s} ${JSON.stringify(o)}`);
  }
  // The Runner validates too.
  assert.throws(() => new Runner(sample, getStrategy('tombstone'), { ghostttl: 5 }), /did you mean "ghostTtl"/);
  // Every schema default validates against its own schema.
  for (const s of Object.values(strategies)) {
    const all = mergeOptions(s);
    assert.deepEqual(mergeOptions(s, all), all, s.name);
    assert.deepEqual(Object.keys(all).sort(), Object.keys(optionSchema(s)).sort());
  }
});

test('sweep.json configs all validate', () => {
  const sweep = JSON.parse(readFileSync(new URL('../sweep.json', import.meta.url), 'utf8'));
  for (const c of sweep.configs) mergeOptions(getStrategy(c.strategy), c.options ?? {});
});

test('parseOptionValue: only plain decimals become numbers', () => {
  assert.equal(parseOptionValue('true'), true);
  assert.equal(parseOptionValue('false'), false);
  assert.equal(parseOptionValue('12'), 12);
  assert.equal(parseOptionValue('-0.5'), -0.5);
  assert.equal(parseOptionValue('.25'), 0.25);
  for (const s of ['0x10', ' ', '', '1e3', 'Infinity', '1.2.3', ' 1', 'additive']) assert.equal(parseOptionValue(s), s);
});

test('resolveCommitIndex: #N is an index, a bare string is a sha prefix (>= 4 hex)', () => {
  const h = hist([[A('a')], [A('b')], [A('c')]]);
  h.commits[1].sha = 'abcd1234' + '0'.repeat(32);
  h.commits[2].sha = '1234ffff' + '0'.repeat(32);
  h.commits[0].sha = 'abcd5678' + '0'.repeat(32);
  assert.equal(resolveCommitIndex(h, undefined), 2);
  assert.equal(resolveCommitIndex(h, 'HEAD'), 2);
  assert.equal(resolveCommitIndex(h, '#0'), 0);
  assert.equal(resolveCommitIndex(h, '#2'), 2);
  assert.equal(resolveCommitIndex(h, 'abcd1'), 1);
  assert.equal(resolveCommitIndex(h, 'ABCD12'), 1);
  assert.equal(resolveCommitIndex(h, '1234'), 2, 'a bare number is a sha prefix, not index 1234');
  assert.throws(() => resolveCommitIndex(h, '#3'), /out of range/);
  assert.throws(() => resolveCommitIndex(h, '#-1'), /bad commit index/);
  assert.throws(() => resolveCommitIndex(h, '2'), /sha prefix of >= 4 hex/);
  assert.throws(() => resolveCommitIndex(h, 'abc'), /sha prefix of >= 4 hex/);
  assert.throws(() => resolveCommitIndex(h, 'main'), /sha prefix of >= 4 hex/);
  assert.throws(() => resolveCommitIndex(h, 'abcd'), /ambiguous/);
  assert.throws(() => resolveCommitIndex(h, 'beef'), /not on the first-parent timeline/);
});

test('cmp is Unicode codepoint order (astral chars sort after U+E000..FFFF)', () => {
  const cp = (a: string, b: string) => {
    const x = [...a].map((c) => c.codePointAt(0)!), y = [...b].map((c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return Math.sign(x.length - y.length);
  };
  const alpha = ['a', 'z', '/', '￿', '', '\u{1F600}', '\u{1D49C}', '中', '퟿'];
  let s = 7;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const word = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => alpha[Math.floor(rnd() * alpha.length)]).join('');
  for (let i = 0; i < 5000; i++) {
    const a = word(), b = word();
    assert.equal(cmp(a, b), cp(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  assert.equal(cmp('￿', '\u{1F600}'), -1); // UTF-16 `<` says the opposite
});
