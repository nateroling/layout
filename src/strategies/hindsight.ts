// "hindsight": uses the future. One fixed layout of the union of every file and
// directory path that ever existed on the timeline; commit N just shows the live
// subset at its fixed slots. Nothing ever moves except a file whose path changes
// (a rename jumps to the new path's slot). Upper bound on stability, lower bound
// on compactness.
//
// Options: order=name|birth (birth = first appearance of the path, default),
// showGhosts (emit non-live union slots as ghosts; default false), geometry.

import { defaultsOf, type Strategy, type StrategyContext } from '../engine.ts';
import { geoFromOptions, geoSchema, measure, place, type LDir } from '../geometry/treev.ts';
import { applyCommit, cmp, dirname, emptyTree } from '../model/tree.ts';
import type { LayoutNode, OptionSchema, TreeState } from '../types.ts';

interface Slot {
  kind: 'dir' | 'file';
  path: string;
  parent: string | null; // parent node id
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HindsightState {
  slots: Slot[]; // placement order of the union layout (dir, its files, its subtrees)
  fileAt: Map<string, number>; // file path -> index in slots
  dirAt: Map<string, number>; // dir path -> index in slots
}

function build(ctx: StrategyContext): HindsightState {
  const h = ctx.history;
  if (!h) throw new Error('hindsight needs the History (usesFuture)');
  const follow = ctx.options.followRenames !== false;
  const order = ctx.options.order === 'name' ? 'name' : 'birth';

  // First appearance of every file path and directory path.
  const fileFirst = new Map<string, number>();
  const dirFirst = new Map<string, number>([['', 0]]);
  const t = emptyTree();
  for (const c of h.commits) {
    const d = applyCommit(t, c, follow);
    for (const e of d.added) if (!fileFirst.has(e.path)) fileFirst.set(e.path, c.index);
    for (const m of d.moved) if (!fileFirst.has(m.entry.path)) fileFirst.set(m.entry.path, c.index);
    for (const p of d.dirsAdded) if (!dirFirst.has(p)) dirFirst.set(p, c.index);
  }

  const dirKids = new Map<string, string[]>();
  const fileKids = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    a.push(v);
  };
  for (const d of dirFirst.keys()) if (d !== '') push(dirKids, dirname(d), d);
  for (const f of fileFirst.keys()) push(fileKids, dirname(f), f);
  const by = (first: Map<string, number>) => (a: string, b: string) =>
    order === 'birth' ? first.get(a)! - first.get(b)! || cmp(a, b) : cmp(a, b);

  // LFile ids here are placeholders keyed by path; frame() maps them to live ids.
  const mk = (path: string): LDir => ({
    id: `d:${path}`,
    path,
    slots: (fileKids.get(path) ?? []).sort(by(fileFirst)).map((p) => ({ id: `p:${p}`, path: p, size: 0, born: 0, modified: 0 })),
    dirs: (dirKids.get(path) ?? []).sort(by(dirFirst)).map(mk),
  });
  const root = mk('');
  const g = geoFromOptions(ctx.options);
  const nodes = place(root, g, measure(root, g));
  const slots: Slot[] = nodes.map((n) => ({ kind: n.kind, path: n.path, parent: n.parent, x: n.x, y: n.y, w: n.w, h: n.h }));
  const fileAt = new Map<string, number>();
  const dirAt = new Map<string, number>();
  slots.forEach((x, i) => (x.kind === 'dir' ? dirAt : fileAt).set(x.path, i));
  return { slots, fileAt, dirAt };
}

const schema: OptionSchema = {
  order: { type: 'enum', values: ['birth', 'name'], default: 'birth', doc: 'sibling order: first appearance of the path, or name' },
  showGhosts: { type: 'boolean', default: false, doc: 'also emit the non-live union slots, as ghosts' },
  ...geoSchema(),
};

export const hindsight: Strategy<HindsightState> = {
  name: 'hindsight',
  description:
    'Uses the future: one fixed layout of every path that ever existed; commit N shows the live subset. order=name|birth, showGhosts.',
  usesFuture: true,
  schema,
  defaults: defaultsOf(schema),
  init: (ctx) => build(ctx),
  step: () => {},
  frame(state, tree: TreeState, _c, ctx): LayoutNode[] {
    const ghosts = ctx.options.showGhosts === true;
    const out: LayoutNode[] = [];
    // Without ghosts, visit only the live subset (in placement order): O(live log live), not O(union).
    let order: Iterable<Slot> = state.slots;
    if (!ghosts) {
      const ix = new Int32Array(tree.dirs.size + tree.files.size);
      let k = 0;
      for (const p of tree.dirs.keys()) ix[k++] = state.dirAt.get(p)!;
      for (const p of tree.files.keys()) ix[k++] = state.fileAt.get(p)!;
      ix.sort();
      order = Array.from(ix, (i) => state.slots[i]);
    }
    for (const s of order) {
      const parent = s.parent;
      if (s.kind === 'dir') {
        const live = tree.dirs.has(s.path);
        if (live || ghosts)
          out.push({ id: `d:${s.path}`, kind: 'dir', path: s.path, parent, x: s.x, y: s.y, w: s.w, h: s.h, ghost: live ? undefined : true });
        continue;
      }
      const f = tree.files.get(s.path);
      if (f)
        out.push({
          id: `f:${f.id}`,
          kind: 'file',
          path: s.path,
          parent,
          x: s.x,
          y: s.y,
          w: s.w,
          h: s.h,
          size: f.size,
          born: f.born,
          modified: f.modified,
        });
      else if (ghosts)
        out.push({ id: `g:${s.path}`, kind: 'file', path: s.path, parent, x: s.x, y: s.y, w: s.w, h: s.h, ghost: true });
    }
    return out;
  },
};
