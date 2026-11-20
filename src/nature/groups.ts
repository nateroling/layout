// Colour groups for the nature pages: by folder (the biggest folders) or by file extension.

import { cmp } from '../model/tree.ts';
import type { SDir, Snapshot } from './model.ts';

export const MAX_GROUPS = 9;

export interface Groups {
  labels: string[]; // index = colour; the last may be 'everything else' / 'other'
  ofPath: (path: string) => number; // group of a file path (-1: none)
}

const parentOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** Start from the top-level folders and split the biggest until none holds over 1/8 of the files. */
export function folderGroups(s: Snapshot): Groups {
  type Unit = { label: string; tree?: string; own?: string; count: number; dir?: SDir };
  const whole = (d: SDir): Unit => ({ label: d.path + '/', tree: d.path, count: d.count, dir: d });
  const units: Unit[] = [...(s.root.files.length ? [{ label: '(root files)', own: '', count: s.root.files.length }] : []), ...s.root.dirs.map(whole)];
  for (;;) {
    const big = units.reduce((m, u, i) => (u.count > units[m].count ? i : m), 0);
    const u = units[big];
    if (!u || u.count <= s.files.length / 8 || !u.dir || !u.dir.dirs.length || units.length >= MAX_GROUPS + 2) break;
    const d = u.dir;
    units.splice(big, 1, ...(d.files.length ? [{ label: d.path + '/ (files)', own: d.path, count: d.files.length }] : []), ...d.dirs.map(whole));
  }
  units.sort((a, b) => b.count - a.count || cmp(a.label, b.label));
  const labels = units.slice(0, MAX_GROUPS).map((u) => u.label);
  if (units.length > MAX_GROUPS) labels.push('everything else');
  const ofPath = (path: string): number => {
    const dir = parentOf(path);
    let best = -1;
    let bestLen = -1;
    units.forEach((u, gi) => {
      const g = Math.min(gi, MAX_GROUPS);
      if (u.own !== undefined && u.own === dir && dir.length + 1 > bestLen) {
        best = g;
        bestLen = dir.length + 1; // own files beat any subtree that contains them
      }
      if (u.tree !== undefined && (dir === u.tree || dir.startsWith(u.tree + '/')) && u.tree.length > bestLen) {
        best = g;
        bestLen = u.tree.length;
      }
    });
    return best;
  };
  return { labels, ofPath };
}

export function extOf(path: string): string {
  const n = path.slice(path.lastIndexOf('/') + 1);
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1).toLowerCase() : '(none)';
}

export function extGroups(paths: string[]): Groups {
  const count = new Map<string, number>();
  for (const p of paths) count.set(extOf(p), (count.get(extOf(p)) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, MAX_GROUPS - 1).map((e) => e[0]);
  const labels = [...top.map((e) => (e === '(none)' ? 'no extension' : '.' + e)), 'other'];
  return { labels, ofPath: (p) => (top.includes(extOf(p)) ? top.indexOf(extOf(p)) : top.length) };
}
