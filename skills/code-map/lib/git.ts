// Reading a repo with the git command line. Nothing is checked out; nothing is written.

import { execFileSync } from 'node:child_process';

const RS = '\x1e';
const US = '\x1f';

export function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function tryGit(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

export const revParse = (repo: string, ref: string): string => git(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']).trim();

export type ChangeType = 'A' | 'M' | 'D' | 'R';

export interface Change {
  type: ChangeType;
  path: string;
  oldPath?: string; // renames only
  size: number; // blob size after the change (0 for deletions)
}

export interface Commit {
  sha: string;
  time: number; // committer time, unix seconds
  subject: string;
  changes: Change[];
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

/** The first-parent timeline ending at `sha`, oldest first: [sha, committer time]. */
export function timeline(repo: string, sha: string): [string, number][] {
  const out = git(repo, ['log', sha, '--first-parent', '--reverse', '--format=%H %ct']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [h, t] = l.split(' ');
      return [h, Number(t)];
    });
}

interface RawChange {
  type: string;
  path: string;
  oldPath?: string;
  blob: string;
}

/** Parse `--raw --no-abbrev` lines (submodules dropped: a file<->submodule change is a delete or an add). */
function parseRaw(lines: string[]): RawChange[] {
  const changes: RawChange[] = [];
  for (const line of lines) {
    if (!line.startsWith(':')) continue;
    const tab = line.indexOf('\t');
    const [srcMode, dstMode, , dstBlob, status] = line.slice(1, tab).split(' ');
    const p = line
      .slice(tab + 1)
      .split('\t')
      .map(unquote);
    let t = status[0];
    const srcLink = srcMode === '160000' || srcMode === '120000';
    const dstLink = dstMode === '160000' || dstMode === '120000';
    if (srcLink && dstLink) continue;
    if (dstLink) {
      if (t === 'A') continue;
      changes.push({ type: 'D', path: p[0], blob: dstBlob });
      continue;
    }
    if (srcLink) {
      if (t === 'D') continue;
      t = t === 'R' || t === 'C' ? 'C' : 'A';
    }
    if (t === 'R') changes.push({ type: 'R', oldPath: p[0], path: p[1], blob: dstBlob });
    else if (t === 'C') changes.push({ type: 'A', path: p.at(-1)!, blob: dstBlob });
    else if (t === 'A' || t === 'D') changes.push({ type: t, path: p.at(-1)!, blob: dstBlob });
    else changes.push({ type: 'M', path: p.at(-1)!, blob: dstBlob });
  }
  return changes;
}

function sized(repo: string, raw: RawChange[][]): Change[][] {
  const blobs = new Set<string>();
  for (const cs of raw) for (const ch of cs) if (ch.type !== 'D') blobs.add(ch.blob);
  const sizes = new Map<string, number>();
  if (blobs.size) {
    const res = git(repo, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], [...blobs].join('\n') + '\n');
    for (const line of res.split('\n')) {
      const [name, size] = line.split(' ');
      if (name && /^\d+$/.test(size ?? '')) sizes.set(name, Number(size));
    }
  }
  return raw.map((cs) =>
    cs.map((ch) => {
      const c: Change = { type: ch.type as ChangeType, path: ch.path, size: ch.type === 'D' ? 0 : (sizes.get(ch.blob) ?? 0) };
      if (ch.oldPath !== undefined) c.oldPath = ch.oldPath;
      return c;
    }),
  );
}

/**
 * The first-parent commits after `from` (exclusive; null = from the root) up to `to`, oldest first,
 * each diffed against its first parent, renames detected (-M).
 */
export function commits(repo: string, from: string | null, to: string): Commit[] {
  const out = git(repo, [
    'log',
    from ? `${from}..${to}` : to,
    '--first-parent',
    '--root',
    '--reverse',
    '--diff-merges=first-parent',
    '-M',
    '--raw',
    '--no-abbrev',
    `--format=${RS}%H${US}%ct${US}%s`,
  ]);
  const heads: { sha: string; time: number; subject: string }[] = [];
  const raws: RawChange[][] = [];
  for (const block of out.split(RS)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const [sha, ct, subject] = lines[0].split(US);
    heads.push({ sha, time: Number(ct), subject });
    raws.push(parseRaw(lines.slice(1)));
  }
  const ch = sized(repo, raws);
  return heads.map((h, k) => ({ ...h, changes: ch[k] }));
}

/** The changes from commit `a` to commit `b` (renames detected), with lines added/removed per path. */
export function diff(repo: string, a: string, b: string): { changes: Change[]; lines: Map<string, [number, number]> } {
  const raw = parseRaw(git(repo, ['diff', '--raw', '--no-abbrev', '-M', a, b]).split('\n'));
  const [changes] = sized(repo, [raw]);
  const lines = new Map<string, [number, number]>();
  const num = git(repo, ['diff', '--numstat', '-z', '-M', a, b]);
  // -z: "add\tdel\tpath\0" or, for a rename, "add\tdel\t\0old\0new\0"
  const parts = num.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const [ad, de, p] = rec.split('\t');
    const n: [number, number] = [ad === '-' ? 0 : Number(ad), de === '-' ? 0 : Number(de)];
    if (p) lines.set(p, n);
    else {
      lines.set(parts[i + 2], n);
      i += 2;
    }
  }
  return { changes, lines };
}

/** Commit metadata: [sha, committer time, ISO date, subject]. */
export function commitInfo(repo: string, ref: string): { sha: string; time: number; date: string; subject: string } {
  const [sha, t, date, ...rest] = git(repo, ['log', '-1', `--format=%H${US}%ct${US}%cs${US}%s`, ref]).trim().split(US);
  return { sha, time: Number(t), date, subject: rest.join(US) };
}
