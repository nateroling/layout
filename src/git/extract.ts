// git history -> event stream.
// One `git log` pass over the first-parent timeline (merges diffed against their
// first parent) plus one `git cat-file --batch-check` pass for blob sizes.
// Nothing is checked out; cost is proportional to the number of changes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Change, Commit, History } from '../types.ts';

const RS = '\x1e';
const US = '\x1f';
const MAXBUF = 1024 * 1024 * 1024;

function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: MAXBUF,
    input,
  });
}

export function resolveRef(repo: string, ref = 'HEAD'): string {
  return git(repo, ['rev-parse', ref]).trim();
}

const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undo git's C-style path quoting (applied even with core.quotePath=false for " \ tab newline). */
export function unquote(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const n = body[i + 1];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(ESC[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

interface RawChange {
  type: string;
  path: string;
  oldPath?: string;
  blob: string;
  mode: string;
}

export function extractHistory(repoPath: string, opts: { ref?: string; name?: string } = {}): History {
  const repo = resolve(repoPath);
  const head = resolveRef(repo, opts.ref ?? 'HEAD');
  const out = git(repo, [
    'log',
    head,
    '--first-parent',
    '--root',
    '--reverse',
    '--diff-merges=first-parent',
    '-M',
    '--raw',
    '--no-abbrev',
    `--format=${RS}%H${US}%ct${US}%an${US}%s`,
  ]);

  const raw: { sha: string; time: number; author: string; subject: string; changes: RawChange[] }[] = [];
  for (const block of out.split(RS)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const [sha, ct, author, subject] = lines[0].split(US);
    const changes: RawChange[] = [];
    for (const line of lines.slice(1)) {
      if (!line.startsWith(':')) continue;
      const tab = line.indexOf('\t');
      const meta = line.slice(1, tab).split(' ');
      const paths = line.slice(tab + 1).split('\t');
      const [srcMode, dstMode, , dstBlob, status] = meta;
      let t = status[0];
      const p = paths.map(unquote);
      // Submodules (gitlinks) are not files. A file<->submodule type change is a delete/add.
      const srcLink = srcMode === '160000';
      const dstLink = dstMode === '160000';
      if (srcLink && dstLink) continue;
      if (dstLink) {
        if (t === 'A') continue;
        changes.push({ type: 'D', path: p[0], blob: dstBlob, mode: srcMode });
        continue;
      }
      if (srcLink) {
        if (t === 'D') continue;
        t = 'A';
      }
      if (t === 'R' || t === 'C') {
        changes.push({ type: t, oldPath: p[0], path: p[1], blob: dstBlob, mode: dstMode });
      } else {
        changes.push({ type: t, path: p.at(-1)!, blob: dstBlob, mode: dstMode });
      }
    }
    raw.push({ sha, time: Number(ct), author, subject, changes });
  }

  // Blob sizes in one batch.
  const blobs = new Set<string>();
  for (const c of raw) for (const ch of c.changes) if (ch.type !== 'D') blobs.add(ch.blob);
  const sizes = new Map<string, number>();
  if (blobs.size) {
    const res = git(repo, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], [...blobs].join('\n') + '\n');
    for (const line of res.split('\n')) {
      const [name, size] = line.split(' ');
      if (name && size && /^\d+$/.test(size)) sizes.set(name, Number(size));
    }
  }

  const commits: Commit[] = raw.map((c, index) => ({
    index,
    sha: c.sha,
    time: c.time,
    author: c.author,
    subject: c.subject,
    changes: c.changes.map((ch): Change => {
      const size = ch.type === 'D' ? 0 : (sizes.get(ch.blob) ?? 0);
      // C (copy) is an add; T (type change) is a modify.
      if (ch.type === 'C') return { type: 'A', path: ch.path, size };
      if (ch.type === 'R') return { type: 'R', path: ch.path, oldPath: ch.oldPath, size };
      if (ch.type === 'A' || ch.type === 'D') return { type: ch.type, path: ch.path, size };
      return { type: 'M', path: ch.path, size };
    }),
  }));

  return { repo: opts.name ?? basename(repo), head, commits };
}

/** Extract with an on-disk cache keyed by repo name + head sha. */
export function loadHistory(repoPath: string, opts: { ref?: string; cacheDir?: string; name?: string } = {}): History {
  const repo = resolve(repoPath);
  const name = opts.name ?? basename(repo);
  const head = resolveRef(repo, opts.ref ?? 'HEAD');
  const dir = opts.cacheDir ?? join(process.cwd(), '.cache');
  const file = join(dir, `${name}-${head.slice(0, 12)}.history.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as History;
  const h = extractHistory(repo, { ref: head, name });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(h));
  return h;
}

/** Resolve a user-supplied commit reference to a first-parent index. */
export function resolveCommitIndex(history: History, at: string | undefined): number {
  const last = history.commits.length - 1;
  if (at === undefined || at === 'HEAD' || at === '') return last;
  if (/^#?\d+$/.test(at) && (at.startsWith('#') || at.length < 7)) {
    const n = Number(at.replace('#', ''));
    if (n < 0 || n > last) throw new Error(`commit index ${n} out of range 0..${last}`);
    return n;
  }
  const hits = history.commits.filter((c) => c.sha.startsWith(at));
  if (hits.length === 1) return hits[0].index;
  if (hits.length > 1) throw new Error(`ambiguous sha prefix ${at}`);
  throw new Error(`${at} is not on the first-parent timeline of ${history.repo}; pass an index (#N) or a first-parent sha`);
}
