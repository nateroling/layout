// Tree: botanical branching. The root is the trunk, rising from the ground; every directory is a
// branch springing from the tip of its parent's branch. Files are leaves set along their directory's
// branch, alternating left and right as leaves do on a twig.
//
//   angles     each subtree owns a slice of the crown (a fan of +-80 deg around vertical), sized by
//              the square root of its file count; a branch points at the middle of its slice, so
//              sibling subtrees grow apart instead of through each other.
//   length     long enough for its own leaves (two per step), plus a little more for big subtrees,
//              shrinking with depth.
//   thickness  da Vinci's rule: a branch's cross-section equals the sum of what it carries, so the
//              width is proportional to sqrt(files in the subtree).
//
// Leaves that land on each other (or on another branch's leaves) are pushed apart at the end.

import { type Disc, fileRadius, relax, type Scene, type SDir, type Snapshot } from './model.ts';

const SPREAD = (80 * Math.PI) / 180;
const LEAF_STEP = 1.2; // along-branch spacing of a leaf pair
const WIDTH = 0.22; // branch width per sqrt(file)

export function branch(snap: Snapshot): Scene {
  const scene: Scene = { layout: 'tree', marks: [], shapes: [] };
  const weight = (d: SDir) => Math.sqrt(d.count);
  const leaves: (Disc & { f: number })[] = [];

  const grow = (d: SDir, bx: number, by: number, a0: number, a1: number, heading: number) => {
    // heading: angle from vertical (0 = straight up, + = right)
    const own = d.files.length;
    const len = Math.max(3, Math.ceil(own / 2) * LEAF_STEP + 1.5) + 3.2 * Math.sqrt(d.count) * Math.pow(0.88, d.depth);
    const dx = Math.sin(heading);
    const dy = -Math.cos(heading);
    // a slight bow towards the slice's middle: control point off the straight line
    const tx = bx + dx * len;
    const ty = by + dy * len;
    const w0 = WIDTH * Math.sqrt(d.count) + 0.15;
    const kidsW = d.dirs.length ? Math.sqrt(d.dirs.reduce((s, c) => s + c.count, 0)) * WIDTH + 0.15 : 0.15;
    scene.shapes.push({ k: 'line', d: d.i, pts: [bx, by, (bx + tx) / 2, (by + ty) / 2, tx, ty], w: [w0, (w0 + kidsW) / 2, kidsW] });
    // leaves: alternate sides, from 15% of the branch to its tip, leaning outward
    d.files.forEach((f, n) => {
      const pair = Math.floor(n / 2);
      const side = n % 2 ? -1 : 1;
      const t = own <= 2 ? 0.85 : 0.15 + (0.85 * (pair + 0.5)) / Math.ceil(own / 2);
      const r = fileRadius(f.size);
      const px = bx + dx * len * t;
      const py = by + dy * len * t;
      const off = r + 0.25 + (WIDTH * Math.sqrt(d.count)) / 2;
      // leaf sits off the branch, angled forward 35 deg
      const la = heading + side * (Math.PI / 2 - 0.6);
      leaves.push({ f: f.i, x: px + Math.sin(la) * off, y: py - Math.cos(la) * off, r });
    });
    // children split the slice. They spring from the upper part of the branch, spaced along it (the
    // biggest at the tip, as a leader), not all from one point.
    const total = d.dirs.reduce((s, c) => s + weight(c), 0);
    const m = d.dirs.length;
    const lead = d.dirs.reduce((b, c, k) => (c.count > d.dirs[b].count ? k : b), 0);
    const order = d.dirs.map((_, k) => k).filter((k) => k !== lead);
    // side branches alternate up the stem: outermost slices lowest
    order.sort((p, q) => Math.abs(q - lead) - Math.abs(p - lead) || p - q);
    const at = new Array(m).fill(1);
    order.forEach((k, j) => (at[k] = 0.4 + (0.55 * (j + 1)) / (order.length + 1)));
    let a = a0;
    d.dirs.forEach((c, k) => {
      const span = ((a1 - a0) * weight(c)) / total;
      const mid = a + span / 2;
      // blend towards the slice middle: deeper branches bend less sharply away from their parent
      const h = heading + (mid - heading) * 0.75;
      grow(c, bx + dx * len * at[k], by + dy * len * at[k], a, a + span, h);
      a += span;
    });
  };
  grow(snap.root, 0, 0, -SPREAD, SPREAD, 0);
  relax(leaves, 0.08, 400);
  for (const l of leaves) scene.marks.push({ f: l.f, x: l.x, y: l.y, r: l.r });
  return scene;
}
