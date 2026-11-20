// The code-map skill (skills/code-map): stable maps, the cache, the PR overlay, rendering and the CLI,
// on a small temp repo built with real git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapAt, type CodeMap } from '../skills/code-map/lib/layout.ts';
import { changeMap } from '../skills/code-map/lib/pr.ts';
import { renderHtml, renderSvg } from '../skills/code-map/lib/render.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'skills', 'code-map', 'codemap.ts');
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env: ENV, encoding: 'utf8' });

let day = 0;
/** Commit the working tree, one day after the previous commit. */
function commit(repo: string, msg: string) {
  day++;
  const date = new Date(Date.UTC(2024, 0, 1) + day * 86400000).toISOString();
  git(repo, 'add', '-A');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', msg], { env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return git(repo, 'rev-parse', 'HEAD').trim();
}
function put(repo: string, path: string, size: number) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  // distinct content per path, so git's rename detection only pairs real moves
  writeFileSync(join(repo, path), (path + ' ').repeat(Math.ceil(size / (path.length + 1))).slice(0, size));
}

/** ~40 commits over ~6 weeks: folders grow, a file moves folder, a folder is renamed, files are deleted. */
function buildRepo(): { repo: string; shas: string[] } {
  const repo = mkdtempSync(join(tmpdir(), 'codemap-'));
  git(repo, 'init', '-q', '-b', 'main');
  const shas: string[] = [];
  put(repo, 'README.md', 300);
  shas.push(commit(repo, 'init'));
  for (let k = 0; k < 36; k++) {
    put(repo, `src/core/f${k % 9}.ts`, 200 + k * 40);
    if (k % 3 === 0) put(repo, `src/ui/w${k}.ts`, 500 + k * 10);
    if (k % 4 === 0) put(repo, `docs/d${k}.md`, 900);
    if (k % 5 === 0) put(repo, `test/t${k}.test.ts`, 400);
    if (k === 20) git(repo, 'mv', 'src/ui/w3.ts', 'src/core/w3.ts');
    if (k === 25) git(repo, 'mv', 'docs', 'guide');
    if (k === 30) rmSync(join(repo, 'test', 't5.test.ts'));
    shas.push(commit(repo, `step ${k}`));
  }
  return { repo, shas };
}

const { repo, shas } = buildRepo();
const S = (m: CodeMap) => JSON.stringify(m);

test('a map is the same with or without the cache, and wherever the cache was left', () => {
  const cache = mkdtempSync(join(tmpdir(), 'codemap-cache-'));
  const cold = S(mapAt(repo, 'HEAD', { cacheDir: null }));
  mapAt(repo, shas[12], { cacheDir: cache }); // leaves a checkpoint mid-history
  assert.equal(S(mapAt(repo, 'HEAD', { cacheDir: cache })), cold);
  assert.equal(S(mapAt(repo, 'HEAD', { cacheDir: cache })), cold); // resumed from the latest checkpoint
  for (const every of ['day', 'commit'] as const) assert.equal(S(mapAt(repo, shas[30], { every, cacheDir: cache })), S(mapAt(repo, shas[30], { every, cacheDir: null })));
});

test('the map of a commit does not change when later commits arrive', () => {
  const before = S(mapAt(repo, shas[20], { cacheDir: null }));
  const r2 = mkdtempSync(join(tmpdir(), 'codemap-clone-'));
  execFileSync('git', ['clone', '-q', repo, r2], { env: ENV });
  put(r2, 'src/core/later.ts', 5000);
  commit(r2, 'later');
  assert.equal(S(mapAt(r2, shas[20], { cacheDir: null, name: mapAt(repo, shas[20], { cacheDir: null }).repo })), before);
});

test('files hold still from commit to commit, dots never overlap, and every folder outline holds its files', () => {
  const maps = shas.slice(1).map((s) => mapAt(repo, s, { cacheDir: null, every: 'commit' }));
  let moved = 0;
  let n = 0;
  for (let k = 1; k < maps.length; k++) {
    const prev = new Map(maps[k - 1].files.map((f) => [f.path, f]));
    for (const f of maps[k].files) {
      const p = prev.get(f.path);
      if (!p) continue;
      moved += Math.hypot(f.x - p.x, f.y - p.y);
      n++;
    }
  }
  assert.ok(moved / n < 0.3, `mean move per step ${(moved / n).toFixed(3)}`);
  const m = maps.at(-1)!;
  for (let i = 0; i < m.files.length; i++)
    for (let j = i + 1; j < m.files.length; j++) {
      const a = m.files[i];
      const b = m.files[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 0.05, `${a.path} overlaps ${b.path}`);
    }
  const inside = (rings: number[][], x: number, y: number) => {
    let c = false;
    for (const r of rings)
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2)
        if (r[i + 1] > y !== r[j + 1] > y && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c;
    return c;
  };
  for (const d of m.folders) {
    assert.ok(d.outline.length >= 1, `${d.path} has an outline`);
    for (const f of m.files) if (f.path.startsWith(d.path + '/')) assert.ok(inside(d.outline, f.x, f.y), `${f.path} inside ${d.path}/`);
  }
  assert.equal(m.files.find((f) => f.path === 'src/core/w3.ts') !== undefined, true);
});

test('the PR overlay marks added, modified, deleted and moved files', () => {
  git(repo, 'checkout', '-q', '-b', 'feature');
  put(repo, 'src/ui/new.ts', 1200);
  put(repo, 'src/core/f1.ts', 7777);
  rmSync(join(repo, 'guide', 'd0.md'));
  git(repo, 'add', '-A');
  git(repo, 'mv', 'src/ui/w9.ts', 'test/w9.ts');
  commit(repo, 'feature work');
  git(repo, 'checkout', '-q', 'main');
  const r = changeMap(repo, 'main', 'feature', { cacheDir: null });
  assert.deepEqual(r.counts, { added: 1, modified: 1, deleted: 1, renamed: 1 });
  assert.equal(r.overlay.files!['src/ui/new.ts'].tone, 'added');
  assert.equal(r.overlay.files!['src/core/f1.ts'].tone, 'modified');
  assert.equal(r.overlay.ghosts![0].path, 'guide/d0.md');
  assert.equal(r.overlay.arcs!.length, 1);
  // the base map is the map of the merge base: unchanged files sit where they were
  const base = new Map(mapAt(repo, r.base, { cacheDir: null }).files.map((f) => [f.path, f]));
  let worst = 0;
  for (const f of r.map.files) {
    const b = base.get(f.path);
    if (b) worst = Math.max(worst, Math.hypot(f.x - b.x, f.y - b.y));
  }
  assert.ok(worst < 2, `worst move ${worst.toFixed(2)}`);
  const html = renderHtml(r.map, r.overlay);
  const svg = renderSvg(r.map, r.overlay);
  const page = html.slice(0, html.lastIndexOf('<script>')); // the page's own script says `undefined`
  for (const out of [page, svg]) assert.ok(!/NaN|undefined/.test(out), 'no NaN or undefined in the output');
  assert.match(html, /src\/ui\/<\/em><b>new\.ts<\/b>/);
  assert.match(svg, /^<svg xmlns/);
});

test('the CLI writes json, svg and html, and renders a saved map', () => {
  const out = mkdtempSync(join(tmpdir(), 'codemap-out-'));
  const run = (...a: string[]) => execFileSync(process.execPath, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('map', repo, '--no-cache', '--quiet', '--out', join(out, 'm.json'), '--out', join(out, 'm.svg'));
  const m = JSON.parse(readFileSync(join(out, 'm.json'), 'utf8')) as CodeMap;
  assert.equal(m.format, 'code-map/1');
  writeFileSync(join(out, 'o.json'), JSON.stringify({ title: 'Hot files', files: { 'README.md': { tone: 'hot', badge: '!' } }, arcs: [{ from: 'README.md', to: 'src/core/f1.ts' }] }));
  run('render', join(out, 'm.json'), '--overlay', join(out, 'o.json'), '--out', join(out, 'r.html'));
  const html = readFileSync(join(out, 'r.html'), 'utf8');
  assert.match(html, /<title>Hot files<\/title>/);
  assert.match(html, /class="arc"/);
  run('pr', repo, '--head', 'feature', '--base', 'main', '--no-cache', '--quiet', '--out', join(out, 'p.json'));
  const p = JSON.parse(readFileSync(join(out, 'p.json'), 'utf8'));
  assert.equal(p.counts.added, 1);
  run('pr', repo, '--head', 'feature', '--base', 'main', '--no-cache', '--quiet', '--artifact', '--out', join(out, 'a.html'));
  const art = readFileSync(join(out, 'a.html'), 'utf8');
  assert.match(art, /^<title>[^<]+ feature changes<\/title>/);
  assert.ok(!/<!doctype|<html|<head>|<body>|<\/body>|<\/html>/i.test(art), 'an artifact page has no document skeleton');
  assert.match(art, /<script>window\.CM_DATA = /);
  assert.throws(() => run('map', repo, '--bogus', '1'), /unknown option --bogus/);
});
