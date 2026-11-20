// Sunflower: phyllotaxis. Each directory is a flower head. Its files are the florets, set one per
// golden angle (137.5 deg) and pushed out along that ray only as far as they need to clear the florets
// already placed: Vogel's spiral, but for florets of different sizes. Small files go first, so they sit
// at the centre and the head grows bigger towards the rim, as a real head does.
//
// Subdirectories are whole heads, laid out first (bottom-up), then placed as big florets on the same
// spiral, after the parent's own files, biggest first: the big heads hug the parent's disc and the small
// ones fill the gaps further round. Nesting repeats all the way down, so the root is a head of heads.

import { GOLDEN_ANGLE, type Disc, enclosingCircle, fileRadius, rayFree, type Scene, type SDir, type Shape, type Snapshot } from './model.ts';

interface Head {
  dir: SDir;
  R: number;
  files: { f: number; x: number; y: number; r: number }[];
  kids: { head: Head; x: number; y: number }[];
}

const FILE_GAP = 0.12;
const HEAD_PAD = 0.3; // ring between a head's florets and its outline

function grow(dir: SDir): Head {
  const kids = dir.dirs.map(grow);
  type Item = { r: number; file?: number; head?: Head };
  const items: Item[] = [
    ...dir.files.map((f) => ({ r: fileRadius(f.size), file: f.i })).sort((a, b) => a.r - b.r || a.file - b.file),
    ...kids.map((h) => ({ r: h.R + 0.2, head: h })).sort((a, b) => b.r - a.r || a.head.dir.i - b.head.dir.i),
  ];
  const placed: Disc[] = [];
  const head: Head = { dir, R: 0, files: [], kids: [] };
  items.forEach((it, n) => {
    const a = n * GOLDEN_ANGLE;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const t = n === 0 ? 0 : rayFree(placed, 0, 0, dx, dy, it.r, FILE_GAP);
    const x = dx * t;
    const y = dy * t;
    placed.push({ x, y, r: it.r });
    if (it.head) head.kids.push({ head: it.head, x, y });
    else head.files.push({ f: it.file!, x, y, r: it.r });
  });
  // the head's outline is the smallest circle around everything, so one big subfolder does not leave
  // a half-empty disc: re-centre on it
  const c = enclosingCircle(placed);
  for (const f of head.files) {
    f.x -= c.x;
    f.y -= c.y;
  }
  for (const k of head.kids) {
    k.x -= c.x;
    k.y -= c.y;
  }
  head.R = c.r + HEAD_PAD;
  return head;
}

export function sunflower(snap: Snapshot): Scene {
  const scene: Scene = { layout: 'sunflower', marks: [], shapes: [] };
  const discs: Shape[] = [];
  const emit = (h: Head, ox: number, oy: number) => {
    discs.push({ k: 'disc', d: h.dir.i, x: ox, y: oy, r: h.R });
    for (const f of h.files) scene.marks.push({ f: f.f, x: ox + f.x, y: oy + f.y, r: f.r });
    for (const k of h.kids) emit(k.head, ox + k.x, oy + k.y);
  };
  emit(grow(snap.root), 0, 0);
  scene.shapes = discs;
  return scene;
}
