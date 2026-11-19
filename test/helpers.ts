// Shared test helpers (not a test file: importing a *.test.ts would re-run its tests).
import { dirname } from '../src/model/tree.ts';
import type { Change, Commit, History } from '../src/types.ts';

export const A = (path: string, size = 10): Change => ({ type: 'A', path, size });
export const D = (path: string): Change => ({ type: 'D', path, size: 0 });
export const M = (path: string, size = 20): Change => ({ type: 'M', path, size });
export const R = (oldPath: string, path: string, size = 10): Change => ({ type: 'R', oldPath, path, size });

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

export const sample = hist([
  [A('README.md'), A('src/a.ts'), A('src/b.ts')],
  [A('src/lib/x.ts'), M('src/a.ts')],
  [R('src/b.ts', 'src/lib/b.ts')],
  [D('src/lib/x.ts'), D('src/lib/b.ts'), A('docs/guide.md')],
  [A('src/lib/y.ts')],
  [D('src/a.ts'), A('src/c.ts'), A('aaa/first.ts')],
  [R('src/c.ts', 'src/d.ts', 30)],
]);

/** Deterministic random history: adds, deletes, modifies, same-dir and cross-dir renames, dirs that die and return. */
export function randomHistory(seed: number, commits: number): History {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const dirs = ['', 'src', 'src/lib', 'src/lib/deep', 'docs', 'test', 'test/fx', 'z', 'a/b/c'];
  const live = new Set<string>();
  let n = 0;
  const steps: Change[][] = [];
  for (let i = 0; i < commits; i++) {
    const used = new Set<string>();
    const ch: Change[] = [];
    const k = 1 + Math.floor(rnd() * 5);
    for (let j = 0; j < k; j++) {
      const r = rnd();
      const files = [...live].filter((p) => !used.has(p));
      if (r < 0.45 || files.length < 3) {
        const p = `${pick(dirs)}/f${n++}.ts`.replace(/^\//, '');
        ch.push(A(p, 1 + Math.floor(rnd() * 999)));
        live.add(p);
        used.add(p);
      } else if (r < 0.65) {
        const p = pick(files);
        ch.push(D(p));
        live.delete(p);
        used.add(p);
      } else if (r < 0.8) {
        const p = pick(files);
        ch.push(M(p, 1 + Math.floor(rnd() * 999)));
        used.add(p);
      } else {
        const p = pick(files);
        const to = rnd() < 0.5 ? `${dirname(p) ? dirname(p) + '/' : ''}r${n++}.ts` : `${pick(dirs)}/m${n++}.ts`.replace(/^\//, '');
        ch.push(R(p, to));
        live.delete(p);
        live.add(to);
        used.add(p);
        used.add(to);
      }
    }
    // Occasionally wipe a whole directory so it dies (and may come back later).
    if (rnd() < 0.08) {
      const d = pick(dirs.filter((x) => x));
      for (const p of [...live]) if (!used.has(p) && dirname(p) === d) {
        ch.push(D(p));
        live.delete(p);
      }
    }
    steps.push(ch);
  }
  return hist(steps);
}

