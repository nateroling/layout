// Base colours: the biggest folders each get a colour (top-level folders, the biggest split until none
// holds over an eighth of the files), so the map reads as districts.

import { cmp, type SDir, type Snapshot } from './snapshot.ts';

export const MAX_GROUPS = 9;

export interface Groups {
  labels: string[]; // index = colour; the last may be 'everything else'
  ofPath: (path: string) => number; // -1: none
}

const parentOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

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
        bestLen = dir.length + 1;
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
