// Nature layouts (experiment): lay out one snapshot of each repo with the five layouts in
// src/nature/ and write a self-contained comparison page.
//
//   node bin/nature.ts [repoPath:name ...]     default: ../fixtures/snap/ripgrep and ../fixtures/snap/vue-core
//
// Writes out/nature/index.html + out/nature/data.json (publish both; the page fetches the JSON).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATURE } from '../src/nature/index.ts';
import { extGroups, folderGroups } from '../src/nature/groups.ts';
import { loadSnapshot, type Scene } from '../src/nature/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const repos = (args.length ? args : ['../fixtures/snap/ripgrep:ripgrep', '../fixtures/snap/vue-core:vue-core']).map((a) => {
  const [p, n] = a.split(':');
  return { path: join(ROOT, p), name: n ?? p.split('/').pop()! };
});

const r2 = (v: number) => Math.round(v * 100) / 100;

function encodeScene(sc: Scene) {
  return {
    layout: sc.layout,
    marks: sc.marks.map((m) => (m.poly ? [m.f, r2(m.x), r2(m.y), r2(m.r), m.poly.map(r2)] : [m.f, r2(m.x), r2(m.y), r2(m.r)])),
    shapes: sc.shapes.map((s) =>
      s.k === 'disc' ? ['d', s.d, r2(s.x), r2(s.y), r2(s.r)] : s.k === 'poly' ? ['p', s.d, s.pts.map(r2)] : ['l', s.d, s.pts.map(r2), s.w.map(r2)],
    ),
  };
}

const data = repos.map((r) => {
  const s = loadSnapshot(r.path, r.name);
  const g = folderGroups(s);
  const e = extGroups(s.files.map((f) => f.path));
  const t0 = Date.now();
  const scenes = NATURE.map((L) => encodeScene(L.run(s)));
  console.log(`${r.name} @ ${s.sha}: ${s.files.length} files, ${s.dirs.length} folders, laid out in ${Date.now() - t0} ms`);
  return {
    name: r.name,
    sha: s.sha,
    date: s.date,
    files: s.files.map((f) => [f.path, f.size, f.dir.i, e.ofPath(f.path)]),
    dirs: s.dirs.map((d) => [d.path, d.parent ? d.parent.i : -1, g.ofPath(d.path + '/x')]),
    groups: g.labels,
    exts: e.labels,
    scenes,
  };
});

const out = join(ROOT, 'out', 'nature');
mkdirSync(out, { recursive: true });
const json = JSON.stringify({ layouts: NATURE.map((L) => ({ name: L.name, title: L.title, blurb: L.blurb })), repos: data });
writeFileSync(join(out, 'data.json'), json);
writeFileSync(join(out, 'index.html'), readFileSync(join(ROOT, 'src', 'nature', 'page.html'), 'utf8'));
console.log(`wrote ${join(out, 'index.html')} + data.json (${(json.length / 1024).toFixed(0)} KB)`);
