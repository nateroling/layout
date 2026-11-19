// What exists at commit N. Plain data (Maps) so checkpoints are a structuredClone.

import type { Commit, Delta, DirEntry, FileEntry, TreeState } from '../types.ts';

export function emptyTree(): TreeState {
  const dirs = new Map<string, DirEntry>();
  dirs.set('', { path: '', arrived: 0, count: 0 });
  return { files: new Map(), dirs, nextId: 1 };
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Ancestors of a path, nearest first, ending with '' (root). */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  let d = dirname(path);
  while (true) {
    out.push(d);
    if (d === '') break;
    d = dirname(d);
  }
  return out;
}

function incDirs(t: TreeState, path: string, at: number, delta: Delta) {
  for (const d of ancestors(path)) {
    const e = t.dirs.get(d);
    if (e) e.count++;
    else {
      t.dirs.set(d, { path: d, arrived: at, count: 1 });
      delta.dirsAdded.push(d);
    }
  }
}

// Directories are only deleted at the end of a commit (see applyCommit), so a
// directory emptied and refilled within one commit keeps its identity.
function decDirs(t: TreeState, path: string, pending: Set<string>) {
  for (const d of ancestors(path)) {
    const e = t.dirs.get(d);
    if (!e) continue;
    e.count--;
    if (e.count <= 0 && d !== '') pending.add(d);
  }
}

export function applyCommit(t: TreeState, c: Commit, followRenames: boolean): Delta {
  const delta: Delta = { added: [], removed: [], modified: [], moved: [], dirsAdded: [], dirsRemoved: [] };
  const i = c.index;
  const pending = new Set<string>();

  const add = (path: string, size: number) => {
    const existing = t.files.get(path);
    if (existing) {
      existing.size = size;
      existing.modified = i;
      delta.modified.push(existing);
      return;
    }
    const e: FileEntry = { id: t.nextId++, path, size, born: i, arrived: i, modified: i };
    t.files.set(path, e);
    incDirs(t, path, i, delta);
    delta.added.push(e);
  };
  const remove = (path: string) => {
    const e = t.files.get(path);
    if (!e) return;
    t.files.delete(path);
    decDirs(t, path, pending);
    delta.removed.push(e);
  };

  // Deletions and rename sources first so a path freed in this commit can be reused.
  for (const ch of c.changes) {
    if (ch.type === 'D') remove(ch.path);
  }
  const renames: { e: FileEntry; to: string; size: number }[] = [];
  for (const ch of c.changes) {
    if (ch.type !== 'R') continue;
    const e = t.files.get(ch.oldPath!);
    if (!e) {
      continue; // source unknown (e.g. was a submodule); handled as add below
    }
    if (followRenames) {
      t.files.delete(e.path);
      decDirs(t, e.path, pending);
      renames.push({ e, to: ch.path, size: ch.size });
    } else {
      remove(ch.oldPath!);
    }
  }
  for (const ch of c.changes) {
    if (ch.type === 'A') add(ch.path, ch.size);
    else if (ch.type === 'M') add(ch.path, ch.size);
    else if (ch.type === 'R') {
      const r = renames.find((x) => x.to === ch.path);
      if (!r) {
        add(ch.path, ch.size);
        continue;
      }
      const from = r.e.path;
      const clash = t.files.get(ch.path);
      if (clash) remove(ch.path);
      r.e.path = ch.path;
      if (dirname(from) !== dirname(ch.path)) r.e.arrived = i;
      if (r.e.size !== ch.size) r.e.modified = i;
      r.e.size = ch.size;
      t.files.set(ch.path, r.e);
      incDirs(t, ch.path, i, delta);
      delta.moved.push({ from, entry: r.e });
    }
  }
  for (const d of pending) {
    const e = t.dirs.get(d);
    if (e && e.count <= 0) {
      t.dirs.delete(d);
      delta.dirsRemoved.push(d);
    }
  }
  return delta;
}

/** Child directory paths and file entries grouped by parent directory. */
export function groupTree(t: TreeState): { dirKids: Map<string, string[]>; fileKids: Map<string, FileEntry[]> } {
  const dirKids = new Map<string, string[]>();
  const fileKids = new Map<string, FileEntry[]>();
  for (const d of t.dirs.keys()) {
    if (d === '') continue;
    const p = dirname(d);
    let a = dirKids.get(p);
    if (!a) dirKids.set(p, (a = []));
    a.push(d);
  }
  for (const f of t.files.values()) {
    const p = dirname(f.path);
    let a = fileKids.get(p);
    if (!a) fileKids.set(p, (a = []));
    a.push(f);
  }
  return { dirKids, fileKids };
}

const SURROGATE = /[\ud800-\udfff]/;

/**
 * Deterministic Unicode codepoint comparison (no locale). JS `<` compares UTF-16 code units, which
 * agrees with codepoint order except when an astral character (a surrogate pair, U+D800..DFFF units)
 * meets a BMP character in U+E000..FFFF at the first difference. Fast path: no surrogates -> `<`.
 */
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
      if (sx !== sy) return sx ? 1 : -1; // the surrogate (astral codepoint) sorts after U+E000..FFFF
    }
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}
