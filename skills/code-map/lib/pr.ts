// The first overlay: what a pull request (or any branch, or any range of commits) changes.
//
// The base map is the stable map at the merge base. The branch's changes are then applied to it as one
// more layout step, so added files appear at the free spot nearest their folder and everything else
// stays put. Deleted files stay on the map as ghosts where they were; a file renamed into another
// folder gets an arc from its old spot to its new one.

import { replay, type CodeMap, type LayoutOptions, snapshotOf, toMap } from './layout.ts';
import { commitInfo, diff, git, revParse, tryGit } from './git.ts';
import type { FileMark, Ghost, Arc, Overlay } from './render.ts';
import { applyChanges, cloneTree } from './tree.ts';

export interface ChangeOptions extends LayoutOptions {
  title?: string;
  link?: string;
}

export interface ChangeMap {
  map: CodeMap; // the map at the branch's head
  overlay: Overlay;
  base: string; // merge base sha
  head: string;
  counts: Record<'added' | 'modified' | 'deleted' | 'renamed', number>;
}

/** The default branch to compare against: origin's HEAD, else main or master. */
export function defaultBase(repo: string): string {
  const sym = tryGit(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  if (sym) return sym.replace(/^refs\/remotes\//, '');
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) if (tryGit(repo, ['rev-parse', '--verify', '--quiet', b + '^{commit}'])) return b;
  throw new Error('code-map: no base branch found; pass --base');
}

/** Fetch a GitHub pull request's head into refs/code-map/pr/N (works for any GitHub remote, no gh needed). */
export function fetchPr(repo: string, pr: number, remote = 'origin'): string {
  const ref = `refs/code-map/pr/${pr}`;
  git(repo, ['fetch', '--quiet', '--no-tags', remote, `+refs/pull/${pr}/head:${ref}`]);
  return ref;
}

export function changeMap(repo: string, baseRef: string, headRef: string, opts: ChangeOptions = {}): ChangeMap {
  const head = revParse(repo, headRef);
  const base = git(repo, ['merge-base', revParse(repo, baseRef), head]).trim();
  const e = replay(repo, base, opts);
  const before = new Map<number, { x: number; y: number; r: number }>();
  e.scene.marks.forEach((m) => before.set(e.ids[m.f], m));
  const pathBefore = new Map([...e.tree.files].map(([p, f]) => [p, f.id]));

  const { changes, lines } = diff(e.repo, base, head);
  const tree = cloneTree(e.tree);
  applyChanges(tree, changes);
  const { snap, ids } = snapshotOf(tree, e.name);
  const scene = e.dots.step(snap, ids);
  const info = commitInfo(e.repo, head);
  const map = toMap({ snap, scene, dots: e.dots, name: e.name }, info, e.opts.every!);

  const files: Record<string, FileMark> = {};
  const ghosts: Ghost[] = [];
  const arcs: Arc[] = [];
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  const badge = (p: string) => {
    const l = lines.get(p);
    return l ? `+${l[0]} −${l[1]}` : '';
  };
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const at = new Map(map.files.map((f) => [f.path, f]));
  for (const ch of changes) {
    if (ch.type === 'D') {
      const id = pathBefore.get(ch.path);
      const b = id !== undefined ? before.get(id) : undefined;
      counts.deleted++;
      if (b) ghosts.push({ path: ch.path, x: b.x, y: b.y, r: b.r, tone: 'deleted', label: name(ch.path), badge: badge(ch.path), note: 'deleted' });
      continue;
    }
    if (!at.has(ch.path)) continue;
    if (ch.type === 'A') {
      counts.added++;
      files[ch.path] = { tone: 'added', label: name(ch.path), badge: badge(ch.path), note: 'added' };
    } else if (ch.type === 'M') {
      counts.modified++;
      files[ch.path] = { tone: 'modified', label: name(ch.path), badge: badge(ch.path), note: 'modified' };
    } else {
      counts.renamed++;
      const l = lines.get(ch.path);
      const edited = l && l[0] + l[1] > 0;
      files[ch.path] = { tone: 'renamed', label: name(ch.path), badge: badge(ch.path), note: `renamed from ${ch.oldPath}${edited ? ' and edited' : ''}` };
      const id = pathBefore.get(ch.oldPath!);
      const b = id !== undefined ? before.get(id) : undefined;
      const now = at.get(ch.path)!;
      if (b && Math.hypot(b.x - now.x, b.y - now.y) > 1) arcs.push({ from: [b.x, b.y], to: ch.path, tone: 'renamed', note: `${ch.oldPath} → ${ch.path}` });
    }
  }
  const parts = (Object.keys(counts) as (keyof typeof counts)[]).filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
  const overlay: Overlay = {
    title: opts.title ?? info.subject,
    subtitle: `${parts.join(', ') || 'no file changes'} against ${baseRef} (merge base ${base.slice(0, 7)}).`,
    link: opts.link,
    files,
    ghosts,
    arcs,
  };
  return { map, overlay, base, head, counts };
}
