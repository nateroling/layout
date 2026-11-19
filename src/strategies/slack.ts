// "slack": online, stateful. The live tree (as in recompute, default birth order)
// laid out with per-directory reservations for cols, rows and band width
// (see reserve.ts). A directory growing inside its reservation moves nothing;
// exceeding it grows the reservation geometrically (ceil(required * growth)),
// which amortises the pushes. Reservations never shrink; a directory that
// disappears drops its reservation (a re-appearing path starts fresh).

import { defaultsOf, type Strategy } from '../engine.ts';
import { geoFromOptions, geoSchema, measure, place } from '../geometry/treev.ts';
import { cmp, dirname } from '../model/tree.ts';
import type { Delta, LayoutNode, OptionSchema, TreeState } from '../types.ts';
import { liveTree, type Order } from './recompute.ts';
import { fixedHooks, reserveOptions, reserveSchema, updateReservations, type DirShape, type Reservations } from './reserve.ts';

export interface SlackState {
  res: Reservations;
  kids: Map<string, string[]>; // live child directories per directory (unordered); kept in step()
}

const order = (o: Record<string, unknown>): Order => (o.order === 'name' ? 'name' : 'birth');

/** Directories whose own file count or child list changed in this commit. */
export function dirtyDirs(delta: Delta): Set<string> {
  const s = new Set<string>();
  for (const e of delta.added) s.add(dirname(e.path));
  for (const e of delta.removed) s.add(dirname(e.path));
  for (const m of delta.moved) {
    s.add(dirname(m.from));
    s.add(dirname(m.entry.path));
  }
  for (const p of delta.dirsAdded) s.add(p);
  for (const p of delta.dirsRemoved) s.add(dirname(p));
  return s;
}

/** Keep the child-directory index in step with the tree: O(dirs added + removed). */
function updateKids(kids: Map<string, string[]>, delta: Delta) {
  for (const p of delta.dirsAdded) {
    if (p === '') continue;
    const parent = dirname(p);
    let a = kids.get(parent);
    if (!a) kids.set(parent, (a = []));
    if (!a.includes(p)) a.push(p);
  }
  for (const p of delta.dirsRemoved) {
    kids.delete(p);
    const parent = dirname(p);
    const a = kids.get(parent);
    if (!a) continue;
    const i = a.indexOf(p);
    if (i >= 0) a.splice(i, 1);
    if (!a.length) kids.delete(parent);
  }
}

/** Shapes of the live tree as liveTree() would build it (direct file count, ordered kids). */
function liveShapes(t: TreeState, kids: Map<string, string[]>, ord: Order): (path: string) => DirShape | undefined {
  const byDir = (a: string, b: string) =>
    ord === 'birth' ? t.dirs.get(a)!.arrived - t.dirs.get(b)!.arrived || cmp(a, b) : cmp(a, b);
  return (path) => {
    const d = t.dirs.get(path);
    if (!d) return undefined;
    const k = [...(kids.get(path) ?? [])].sort(byDir);
    let files = d.count;
    for (const c of k) files -= t.dirs.get(c)!.count;
    return { files, kids: k };
  };
}

const schema: OptionSchema = {
  order: { type: 'enum', values: ['birth', 'name'], default: 'birth', doc: 'sibling order: arrival in the directory, or name' },
  ...reserveSchema({ slack: 0.25 }),
  ...geoSchema(),
};

export const slack: Strategy<SlackState> = {
  name: 'slack',
  description:
    'Online: live tree with per-directory reservations (cols, rows, band width) that grow when exceeded (growthMode=multiply: ceil(required*growth); additive: headroom only where growth originates) and never shrink. order, slack, growth, growthMode, gridMode.',
  usesFuture: false,
  schema,
  defaults: defaultsOf(schema),
  init: () => ({ res: new Map(), kids: new Map() }),
  // Proportional to the dirty directories (and their ancestors), not to the tree.
  step(state, tree, _c, delta, ctx) {
    updateKids(state.kids, delta);
    // Every vanished directory (subdirectories included) is listed in dirsRemoved.
    for (const p of delta.dirsRemoved) state.res.delete(p);
    const g = geoFromOptions(ctx.options);
    const ro = reserveOptions(ctx.options, { slack: 0.25, growth: 1.5 });
    updateReservations(state.res, ro, g, dirtyDirs(delta), liveShapes(tree, state.kids, order(ctx.options)));
  },
  frame(state, tree, _c, ctx): LayoutNode[] {
    const g = geoFromOptions(ctx.options);
    const root = liveTree(tree, order(ctx.options));
    return place(root, g, measure(root, g, fixedHooks(state.res)));
  },
};
