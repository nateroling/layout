// What exists at a commit: path -> { id, size }. A file's id survives renames, so the layout can keep
// a renamed file (or a moved folder's files) where they were.

import type { Change } from './git.ts';

export interface Tree {
  files: Map<string, { id: number; size: number }>;
  nextId: number;
}

export const emptyTree = (): Tree => ({ files: new Map(), nextId: 1 });

export const cloneTree = (t: Tree): Tree => ({ files: new Map([...t.files].map(([p, e]) => [p, { ...e }])), nextId: t.nextId });

/** Apply one commit's changes: deletions and rename sources first, so a path freed in this commit can be reused. */
export function applyChanges(t: Tree, changes: Change[]): void {
  for (const ch of changes) if (ch.type === 'D') t.files.delete(ch.path);
  const moving = new Map<string, number>(); // rename target -> id
  for (const ch of changes) {
    if (ch.type !== 'R') continue;
    const e = t.files.get(ch.oldPath!);
    if (!e) continue;
    t.files.delete(ch.oldPath!);
    moving.set(ch.path, e.id);
  }
  for (const ch of changes) {
    if (ch.type === 'D') continue;
    const id = ch.type === 'R' ? moving.get(ch.path) : undefined;
    if (id !== undefined) t.files.set(ch.path, { id, size: ch.size });
    else {
      const e = t.files.get(ch.path);
      if (e) e.size = ch.size;
      else t.files.set(ch.path, { id: t.nextId++, size: ch.size });
    }
  }
}

export interface SavedTree {
  files: [string, number, number][]; // path, id, size
  nextId: number;
}

export const saveTree = (t: Tree): SavedTree => ({ files: [...t.files].map(([p, e]) => [p, e.id, e.size]), nextId: t.nextId });
export const loadTree = (s: SavedTree): Tree => ({ files: new Map(s.files.map(([p, id, size]) => [p, { id, size }])), nextId: s.nextId });
