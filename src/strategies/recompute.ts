// "recompute": stateless — the layout is a pure function of the tree at commit N.
// With order=name + align=center + gridMode=sqrt this is the classic fsn layout
// (the instability baseline). With order=birth + align=left it is the
// EvoStreets-flavoured birth-order layout: new things append at the end, so
// existing siblings never reorder, but a widening band still pushes neighbours.

import type { Strategy } from '../engine.ts';
import { geoFromOptions, measure, place, type LDir } from '../geometry/treev.ts';
import { cmp, groupTree } from '../model/tree.ts';
import type { FileEntry, LayoutNode, TreeState } from '../types.ts';

export type Order = 'name' | 'birth';

/** Build an LDir tree from the live tree state, ordering children by name or by arrival. */
export function liveTree(t: TreeState, order: Order): LDir {
  const { dirKids, fileKids } = groupTree(t);
  const byFile = (a: FileEntry, b: FileEntry) =>
    order === 'birth' ? a.arrived - b.arrived || cmp(a.path, b.path) : cmp(a.path, b.path);
  const byDir = (a: string, b: string) =>
    order === 'birth' ? t.dirs.get(a)!.arrived - t.dirs.get(b)!.arrived || cmp(a, b) : cmp(a, b);
  const build = (path: string): LDir => ({
    id: `d:${path}`,
    path,
    slots: (fileKids.get(path) ?? []).sort(byFile).map((f) => ({
      id: `f:${f.id}`,
      path: f.path,
      size: f.size,
      born: f.born,
      modified: f.modified,
    })),
    dirs: (dirKids.get(path) ?? []).sort(byDir).map(build),
  });
  return build('');
}

export const recompute: Strategy<null> = {
  name: 'recompute',
  description: 'Stateless: lay out the tree at commit N from scratch. order=name|birth, align=left|center, gridMode=sqrt|fixed.',
  usesFuture: false,
  defaults: { order: 'name', align: 'center', gridMode: 'sqrt', gridCols: 8 },
  init: () => null,
  step: () => {},
  frame(_s, tree, _c, ctx): LayoutNode[] {
    const g = geoFromOptions(ctx.options);
    const root = liveTree(tree, ctx.options.order === 'birth' ? 'birth' : 'name');
    return place(root, g, measure(root, g));
  },
};
