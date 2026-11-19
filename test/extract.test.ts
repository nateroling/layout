// Extractor + tree replay correctness against real git.
// 1. A small temp repo built with real git commands (add/modify/delete, cross-dir rename,
//    first-parent merge, odd file names, blob sizes).
// 2. Every fixture in fixtures.json that exists on disk: replay the full first-parent history and
//    compare the final tree (paths and sizes) with `git ls-tree -r` at the pinned ref.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHistory } from '../src/git/extract.ts';
import { ancestors, applyCommit, emptyTree } from '../src/model/tree.ts';
import type { Change, History, TreeState } from '../src/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Isolated git for building test repos: no user/global config (e.g. commit signing), fixed identity.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, encoding: 'utf8', maxBuffer: 1 << 30 });
}

/** Files (no gitlinks) at a ref -> blob size, NUL-separated so no path quoting. */
function lsTree(repo: string, ref: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const rec of git(repo, 'ls-tree', '-r', '-l', '-z', ref).split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, , size] = rec.slice(0, tab).split(/ +/);
    if (mode === '160000' || type !== 'blob') continue;
    out.set(rec.slice(tab + 1), Number(size));
  }
  return out;
}

function replay(h: History, followRenames = true): TreeState {
  const t = emptyTree();
  for (const c of h.commits) applyCommit(t, c, followRenames);
  return t;
}

/** Final tree == ls-tree (paths and sizes) and dir bookkeeping is internally consistent. */
function assertTreeMatches(t: TreeState, repo: string, ref: string) {
  const want = lsTree(repo, ref);
  const got = new Map([...t.files.values()].map((f) => [f.path, f.size]));
  const missing = [...want.keys()].filter((p) => !got.has(p));
  const extra = [...got.keys()].filter((p) => !want.has(p));
  assert.deepEqual({ missing: missing.slice(0, 10), extra: extra.slice(0, 10) }, { missing: [], extra: [] }, 'file set');
  const badSize = [...want].filter(([p, s]) => got.get(p) !== s).map(([p, s]) => `${p}: git ${s}, tree ${got.get(p)}`);
  assert.deepEqual(badSize.slice(0, 10), [], 'blob sizes');

  const counts = new Map<string, number>([['', 0]]);
  for (const p of want.keys()) for (const d of ancestors(p)) counts.set(d, (counts.get(d) ?? 0) + 1);
  assert.deepEqual([...t.dirs.keys()].sort(), [...counts.keys()].sort(), 'dir set');
  for (const [d, n] of counts) assert.equal(t.dirs.get(d)!.count, n, `count of dir '${d}'`);
  const ids = new Set([...t.files.values()].map((f) => f.id));
  assert.equal(ids.size, t.files.size, 'file ids unique');
}

const sortCh = (cs: Change[]) =>
  cs.map((c) => `${c.type} ${c.oldPath ? c.oldPath + ' -> ' : ''}${c.path}`).sort();

function content(tag: string, bytes: number): string {
  let s = `# ${tag}\n`;
  for (let i = 0; s.length < bytes; i++) s += `${tag} line ${i} lorem ipsum dolor sit amet\n`;
  return s;
}

function write(repo: string, path: string, body: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function commit(repo: string, msg: string, when: number) {
  git(repo, 'add', '-A');
  const d = `${1_700_000_000 + when * 3600} +0000`;
  execFileSync('git', ['-C', repo, 'commit', '-q', '--no-gpg-sign', '-m', msg], {
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d },
  });
}

test('extractHistory on a hand-built repo: first-parent, renames, merges, odd names, sizes', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gl-extract-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');

  const SPACE = 'dir with space/naïve café.txt';
  const CJK = '中文/文件 名.md';
  write(repo, 'README.md', 'hello\n');
  write(repo, 'src/a.js', content('a', 300));
  write(repo, 'src/b.js', content('b', 2000));
  write(repo, SPACE, content('space', 777));
  write(repo, CJK, content('cjk', 123));
  commit(repo, 'c0 init', 0);

  write(repo, 'src/a.js', content('a', 5000)); // modify, size changes
  rmSync(join(repo, 'README.md')); // delete
  write(repo, 'lib/c.js', content('c', 400)); // add
  commit(repo, 'c1 modify/delete/add', 1);

  mkdirSync(join(repo, 'lib/sub'), { recursive: true });
  git(repo, 'mv', 'src/b.js', 'lib/sub/b.js');
  commit(repo, 'c2 rename src/b.js -> lib/sub/b.js', 2);

  // Side branch with two commits; must not appear on the first-parent timeline.
  git(repo, 'checkout', '-q', '-b', 'side');
  write(repo, 'feature/x.js', content('x', 900));
  commit(repo, 'side 1', 3);
  write(repo, 'lib/c.js', content('c2', 1500));
  write(repo, 'feature/y.js', content('y', 50));
  rmSync(join(repo, 'src/a.js'));
  commit(repo, 'side 2', 4);

  git(repo, 'checkout', '-q', 'main');
  write(repo, 'main-only.txt', content('m', 60));
  commit(repo, 'c3 main-only', 5);
  execFileSync('git', ['-C', repo, 'merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'c4 merge side', 'side'], {
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: `${1_700_000_000 + 6 * 3600} +0000`, GIT_COMMITTER_DATE: `${1_700_000_000 + 6 * 3600} +0000` },
  });

  mkdirSync(join(repo, 'docs'));
  git(repo, 'mv', CJK, 'docs/文件 名.md'); // unicode + space rename across dirs
  rmSync(join(repo, 'feature/y.js'));
  commit(repo, 'c5 move cjk, delete y', 7);

  const h = extractHistory(repo, { name: 'tmp' });
  const fp = git(repo, 'rev-list', '--first-parent', '--reverse', 'HEAD').trim().split('\n');
  assert.deepEqual(h.commits.map((c) => c.sha), fp, 'first-parent shas in order');
  assert.deepEqual(h.commits.map((c) => c.subject), ['c0 init', 'c1 modify/delete/add', 'c2 rename src/b.js -> lib/sub/b.js', 'c3 main-only', 'c4 merge side', 'c5 move cjk, delete y']);
  assert.deepEqual(h.commits.map((c) => c.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(h.head, fp.at(-1));
  assert.equal(h.commits[0].time, 1_700_000_000);

  assert.deepEqual(sortCh(h.commits[0].changes), ['A README.md', `A ${CJK}`, `A ${SPACE}`, 'A src/a.js', 'A src/b.js'].sort());
  assert.deepEqual(sortCh(h.commits[1].changes), ['A lib/c.js', 'D README.md', 'M src/a.js'].sort());
  assert.deepEqual(sortCh(h.commits[2].changes), ['R src/b.js -> lib/sub/b.js'].sort());
  // The merge carries both side commits' changes, diffed against its first parent.
  assert.deepEqual(sortCh(h.commits[4].changes), ['A feature/x.js', 'A feature/y.js', 'D src/a.js', 'M lib/c.js'].sort());
  assert.deepEqual(sortCh(h.commits[5].changes), [`R ${CJK} -> docs/文件 名.md`, 'D feature/y.js'].sort());

  // Every non-delete change carries the blob size at that commit.
  for (const c of h.commits) {
    const sizes = lsTree(repo, c.sha);
    for (const ch of c.changes) {
      if (ch.type === 'D') assert.equal(ch.size, 0);
      else assert.equal(ch.size, sizes.get(ch.path), `${c.subject}: size of ${ch.path}`);
    }
  }
  assert.equal(h.commits[1].changes.find((c) => c.path === 'src/a.js')!.size, Buffer.byteLength(content('a', 5000)));

  // Replay: final tree equals git, and identity survives renames.
  const tr = replay(h);
  assertTreeMatches(tr, repo, 'HEAD');
  const b = tr.files.get('lib/sub/b.js')!;
  assert.equal(b.born, 0, 'renamed file keeps its birth');
  assert.equal(b.arrived, 2, 'cross-dir rename updates arrival');
  assert.equal(tr.files.get('docs/文件 名.md')!.born, 0);
  assert.ok(!tr.dirs.has('中文') && !tr.dirs.has('src'), 'emptied dirs removed');
  assertTreeMatches(replay(h, false), repo, 'HEAD');
});

// ---- known extractor bugs (todo: fail today, keep the suite green) ----

function tinyRepo(t: { after: (fn: () => void) => void }): string {
  const repo = mkdtempSync(join(tmpdir(), 'gl-extract-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  return repo;
}

test('paths git C-quotes even with core.quotePath=false (" \\ tab) are unquoted', (t) => {
  const repo = tinyRepo(t);
  write(repo, 'q"uote.txt', 'x\n');
  write(repo, 'back\\slash.txt', 'y\n');
  write(repo, 'tab\there.txt', 'z\n');
  commit(repo, 'odd names', 0);
  const h = extractHistory(repo);
  assert.deepEqual(sortCh(h.commits[0].changes), ['A back\\slash.txt', 'A q"uote.txt', 'A tab\there.txt'].sort());
  assertTreeMatches(replay(h), repo, 'HEAD');
});

test('file replaced by a submodule (type change to gitlink) leaves the tree', (t) => {
  const repo = tinyRepo(t);
  write(repo, 'keep.txt', 'k\n');
  write(repo, 'vendor', 'was a file\n');
  commit(repo, 'c0', 0);
  git(repo, 'rm', '-q', '--cached', 'vendor');
  rmSync(join(repo, 'vendor'));
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${git(repo, 'rev-parse', 'HEAD').trim()},vendor`);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--no-gpg-sign', '-m', 'c1 file -> submodule'], { env: GIT_ENV });
  assertTreeMatches(replay(extractHistory(repo)), repo, 'HEAD');
});

test('root commit is diffed regardless of user config (log.showRoot=false)', (t) => {
  const repo = tinyRepo(t);
  write(repo, 'a.txt', 'a\n');
  commit(repo, 'root', 0);
  write(repo, 'b.txt', 'b\n');
  commit(repo, 'second', 1);
  const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'log.showRoot';
  process.env.GIT_CONFIG_VALUE_0 = 'false';
  let h: History;
  try {
    h = extractHistory(repo);
  } finally {
    for (const [k, v] of [['GIT_CONFIG_COUNT', saved.c], ['GIT_CONFIG_KEY_0', saved.k], ['GIT_CONFIG_VALUE_0', saved.v]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assertTreeMatches(replay(h), repo, 'HEAD');
});

// ---- real and synthetic fixtures ----

interface Fixture {
  name: string;
  path: string;
  kind: 'public' | 'synthetic';
  ref: string | null;
  commits: number;
  note: string;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(join(ROOT, 'fixtures.json'), 'utf8'));

for (const f of fixtures) {
  const repo = resolve(ROOT, f.path);
  const present = existsSync(join(repo, '.git')) || existsSync(join(repo, 'HEAD'));
  test(`fixture ${f.name}: replayed history == git ls-tree at ${f.ref?.slice(0, 12) ?? 'HEAD'}`, { skip: present ? false : `${f.path} missing (run scripts/fixtures.sh / node scripts/synth.ts)` }, (t) => {
    const ref = f.ref ?? 'HEAD';
    const t0 = performance.now();
    const h = extractHistory(repo, { ref, name: f.name });
    const t1 = performance.now();
    const tree = replay(h);
    const t2 = performance.now();
    assert.equal(h.commits.length, Number(git(repo, 'rev-list', '--first-parent', '--count', ref).trim()));
    assert.equal(h.commits.length, f.commits, 'fixtures.json commit count is current');
    assertTreeMatches(tree, repo, ref);
    const changes = h.commits.reduce((n, c) => n + c.changes.length, 0);
    const renames = h.commits.reduce((n, c) => n + c.changes.filter((x) => x.type === 'R').length, 0);
    t.diagnostic(
      `${f.name}: ${h.commits.length} commits, ${changes} changes (${renames} renames), ` +
        `${tree.files.size} files / ${tree.dirs.size} dirs at head; extract ${(t1 - t0).toFixed(0)} ms, replay ${(t2 - t1).toFixed(0)} ms`,
    );
  });
}
