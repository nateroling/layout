// The file tree at one commit, as nested folders. Pure data; no git here.

export interface SFile {
  i: number; // index into Snapshot.files
  path: string;
  name: string;
  size: number;
  dir: SDir;
}

export interface SDir {
  i: number; // index into Snapshot.dirs (root = 0)
  path: string; // '' for the root
  name: string;
  parent: SDir | null;
  depth: number;
  files: SFile[]; // sorted by name
  dirs: SDir[]; // sorted by name
  count: number; // files in the subtree
}

export interface Snapshot {
  name: string;
  sha: string;
  date: string;
  root: SDir;
  files: SFile[]; // DFS order: a directory's files, then its subdirectories
  dirs: SDir[]; // DFS pre-order
}

const SURROGATE = /[\ud800-\udfff]/;

/** Deterministic Unicode codepoint comparison (no locale). */
export function cmp(a: string, b: string): number {
  if (a === b) return 0;
  if (!SURROGATE.test(a) && !SURROGATE.test(b)) return a < b ? -1 : 1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      const sx = x <= 0xdfff;
      const sy = y <= 0xdfff;
      if (sx !== sy) return sx ? 1 : -1;
    }
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/** FNV-1a string hash. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Build a Snapshot from [path, size] pairs. */
export function buildSnapshot(name: string, entries: [string, number][], sha = '', date = ''): Snapshot {
  const root: SDir = { i: 0, path: '', name: '', parent: null, depth: 0, files: [], dirs: [], count: 0 };
  const byPath = new Map<string, SDir>([['', root]]);
  const dirOf = (p: string): SDir => {
    let d = byPath.get(p);
    if (d) return d;
    const cut = p.lastIndexOf('/');
    const parent = dirOf(cut < 0 ? '' : p.slice(0, cut));
    d = { i: 0, path: p, name: p.slice(cut + 1), parent, depth: parent.depth + 1, files: [], dirs: [], count: 0 };
    parent.dirs.push(d);
    byPath.set(p, d);
    return d;
  };
  for (const [path, size] of entries) {
    const cut = path.lastIndexOf('/');
    const dir = dirOf(cut < 0 ? '' : path.slice(0, cut));
    dir.files.push({ i: 0, path, name: path.slice(cut + 1), size, dir });
  }
  const files: SFile[] = [];
  const dirs: SDir[] = [];
  const walk = (d: SDir): number => {
    d.i = dirs.length;
    dirs.push(d);
    d.files.sort((a, b) => cmp(a.name, b.name));
    d.dirs.sort((a, b) => cmp(a.name, b.name));
    for (const f of d.files) {
      f.i = files.length;
      files.push(f);
    }
    d.count = d.files.length;
    for (const c of d.dirs) d.count += walk(c);
    return d.count;
  };
  walk(root);
  return { name, sha, date, root, files, dirs };
}
