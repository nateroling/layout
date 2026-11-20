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
import { loadSnapshot, type Scene, type SDir, type Snapshot } from '../src/nature/model.ts';
import { cmp } from '../src/model/tree.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const repos = (args.length ? args : ['../fixtures/snap/ripgrep:ripgrep', '../fixtures/snap/vue-core:vue-core']).map((a) => {
  const [p, n] = a.split(':');
  return { path: join(ROOT, p), name: n ?? p.split('/').pop()! };
});

const MAX_GROUPS = 9;

/** Colour groups: start from the top-level folders and split the biggest until none holds over 1/8 of the files. */
function groups(s: Snapshot): { labels: string[]; ofDir: number[] } {
  type Unit = { label: string; dirs: SDir[]; count: number; own?: SDir };
  const whole = (d: SDir): Unit => ({ label: d.path + '/', dirs: [d], count: d.count });
  let units: Unit[] = [...(s.root.files.length ? [{ label: '(root files)', dirs: [], count: s.root.files.length, own: s.root }] : []), ...s.root.dirs.map(whole)];
  for (;;) {
    const big = units.reduce((m, u, i) => (u.count > units[m].count ? i : m), 0);
    const u = units[big];
    if (u.count <= s.files.length / 8 || u.dirs.length !== 1 || !u.dirs[0].dirs.length || units.length >= MAX_GROUPS + 2) break;
    const d = u.dirs[0];
    units.splice(big, 1, ...(d.files.length ? [{ label: d.path + '/ (files)', dirs: [], count: d.files.length, own: d }] : []), ...d.dirs.map(whole));
  }
  units.sort((a, b) => b.count - a.count || cmp(a.label, b.label));
  const ofDir = new Array(s.dirs.length).fill(-1);
  const labels: string[] = [];
  units.forEach((u, gi) => {
    const g = gi < MAX_GROUPS ? gi : MAX_GROUPS;
    if (gi < MAX_GROUPS) labels.push(u.label);
    else if (gi === MAX_GROUPS) labels.push('everything else');
    if (u.own) ofDir[u.own.i] = g;
    const mark = (d: SDir) => {
      ofDir[d.i] = g;
      d.dirs.forEach(mark);
    };
    u.dirs.forEach(mark);
  });
  // folders above the groups (the root, split folders) take the group of their first file, else -1
  return { labels, ofDir };
}

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

function extGroups(s: Snapshot): { labels: string[]; ofFile: number[] } {
  const ext = (n: string) => {
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(i + 1).toLowerCase() : '(none)';
  };
  const count = new Map<string, number>();
  for (const f of s.files) count.set(ext(f.name), (count.get(ext(f.name)) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, MAX_GROUPS - 1).map((e) => e[0]);
  const labels = [...top.map((e) => (e === '(none)' ? 'no extension' : '.' + e)), 'other'];
  return { labels, ofFile: s.files.map((f) => (top.includes(ext(f.name)) ? top.indexOf(ext(f.name)) : top.length)) };
}

const data = repos.map((r) => {
  const s = loadSnapshot(r.path, r.name);
  const g = groups(s);
  const e = extGroups(s);
  const t0 = Date.now();
  const scenes = NATURE.map((L) => encodeScene(L.run(s)));
  console.log(`${r.name} @ ${s.sha}: ${s.files.length} files, ${s.dirs.length} folders, laid out in ${Date.now() - t0} ms`);
  return {
    name: r.name,
    sha: s.sha,
    date: s.date,
    files: s.files.map((f) => [f.path, f.size, f.dir.i, e.ofFile[f.i]]),
    dirs: s.dirs.map((d) => [d.path, d.parent ? d.parent.i : -1, g.ofDir[d.i]]),
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
