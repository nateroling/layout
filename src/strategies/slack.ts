// "slack": online, stateful. The live tree (as in recompute, default birth order)
// laid out with per-directory reservations for cols, rows and band width
// (see reserve.ts). A directory growing inside its reservation moves nothing;
// exceeding it grows the reservation geometrically (ceil(required * growth)),
// which amortises the pushes. Reservations never shrink; a directory that
// disappears drops its reservation (a re-appearing path starts fresh).

import type { Strategy } from '../engine.ts';
import { geoFromOptions, measure, place } from '../geometry/treev.ts';
import { cmp, dirname } from '../model/tree.ts';
import type { Delta, LayoutNode, TreeState } from '../types.ts';
import { liveTree, type Order } from './recompute.ts';
import { dropReservations, fixedHooks, reserveOptions, updateReservations, type DirShape, type Reservations } from './reserve.ts';

export interface SlackState {
  res: Reservations;
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

/** Shapes of the live tree as liveTree() would build it (direct file count, ordered kids). */
function liveShapes(t: TreeState, ord: Order): (path: string) => DirShape | undefined {
  const kids = new Map<string, string[]>();
  for (const d of t.dirs.keys()) {
    if (d === '') continue;
    const p = dirname(d);
    let a = kids.get(p);
    if (!a) kids.set(p, (a = []));
    a.push(d);
  }
  const byDir = (a: string, b: string) =>
    ord === 'birth' ? t.dirs.get(a)!.arrived - t.dirs.get(b)!.arrived || cmp(a, b) : cmp(a, b);
  return (path) => {
    const d = t.dirs.get(path);
    if (!d) return undefined;
    const k = (kids.get(path) ?? []).sort(byDir);
    let files = d.count;
    for (const c of k) files -= t.dirs.get(c)!.count;
    return { files, kids: k };
  };
}

export const slack: Strategy<SlackState> = {
  name: 'slack',
  description:
    'Online: live tree with per-directory reservations (cols, rows, band width) that grow by `growth` when exceeded and never shrink. order, slack, growth, gridMode.',
  usesFuture: false,
  defaults: { order: 'birth', slack: 0.25, growth: 1.5, align: 'left', gridMode: 'sqrt', gridCols: 8 },
  init: () => ({ res: new Map() }),
  step(state, tree, _c, delta, ctx) {
    if (delta.dirsRemoved.length) dropReservations(state.res, (p) => tree.dirs.has(p));
    const g = geoFromOptions(ctx.options);
    const ro = reserveOptions(ctx.options, { slack: 0.25, growth: 1.5 });
    updateReservations(state.res, ro, g, dirtyDirs(delta), liveShapes(tree, order(ctx.options)));
  },
  frame(state, tree, _c, ctx): LayoutNode[] {
    const g = geoFromOptions(ctx.options);
    const root = liveTree(tree, order(ctx.options));
    return place(root, g, measure(root, g, fixedHooks(state.res)));
  },
};
