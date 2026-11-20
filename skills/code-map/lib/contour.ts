// Folder outlines. A folder's cell is the ground within reach of its files' dots: every dot of the folder
// grown by one margin per level from the dot's own folder up to this one (so a subfolder's cell sits inside
// its parent's with a margin of the parent around it), with the narrow gaps between neighbouring dots of
// the folder filled in. The outline is traced with marching squares on that shape's signed distance and
// simplified, so it is a handful of points, not a pile of circles.

export interface Dot {
  x: number;
  y: number;
  r: number;
  dirs: string[]; // folder chain, outermost first: ['src', 'src/a'] for src/a/x.ts; [] for a root file
}

export interface Outline {
  rings: number[][]; // each ring [x0, y0, x1, y1, ...], closed implicitly; draw with the even-odd rule
  bbox: [number, number, number, number];
  top: [number, number]; // the outline's topmost point (a place for the folder's name)
}

/** Outlines for every folder (depth >= 1), keyed by folder path. */
export function outlines(dots: Dot[], margin: number): Map<string, Outline> {
  const members = new Map<string, { depth: number; idx: number[] }>();
  dots.forEach((d, i) => {
    d.dirs.forEach((p, k) => {
      let m = members.get(p);
      if (!m) members.set(p, (m = { depth: k + 1, idx: [] }));
      m.idx.push(i);
    });
  });
  const out = new Map<string, Outline>();
  for (const [path, m] of members) out.set(path, trace(dots, m.idx, m.depth, margin));
  return out;
}

function trace(dots: Dot[], idx: number[], D: number, margin: number): Outline {
  // the shape: discs, plus a band between every two overlapping discs
  const cx: number[] = [];
  const cy: number[] = [];
  const R: number[] = [];
  let maxR = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of idx) {
    const d = dots[i];
    const r = d.r + margin * (d.dirs.length - D + 1);
    cx.push(d.x);
    cy.push(d.y);
    R.push(r);
    maxR = Math.max(maxR, r);
    x0 = Math.min(x0, d.x - r);
    y0 = Math.min(y0, d.y - r);
    x1 = Math.max(x1, d.x + r);
    y1 = Math.max(y1, d.y + r);
  }
  const n = cx.length;
  const bands: [number, number, number][] = []; // a, b, half width
  const cell = 2 * maxR;
  const grid = new Map<string, number[]>();
  for (let a = 0; a < n; a++) {
    const gx = Math.floor(cx[a] / cell);
    const gy = Math.floor(cy[a] / cell);
    for (let u = gx - 1; u <= gx + 1; u++)
      for (let v = gy - 1; v <= gy + 1; v++)
        for (const b of grid.get(u + ',' + v) ?? []) {
          const dist = Math.hypot(cx[b] - cx[a], cy[b] - cy[a]);
          if (dist > 1e-6 && dist <= (R[a] + R[b]) * 0.98) bands.push([b, a, Math.min(R[a], R[b]) * 0.9]);
        }
    const key = gx + ',' + gy;
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(a);
  }

  // sample the signed distance (positive inside) on a grid, a few steps beyond the shape
  const step = Math.max(0.12, Math.max(x1 - x0, y1 - y0) / 400);
  const pad = 2 * step;
  const ox = x0 - pad;
  const oy = y0 - pad;
  const nx = Math.ceil((x1 - x0 + 2 * pad) / step) + 1;
  const ny = Math.ceil((y1 - y0 + 2 * pad) / step) + 1;
  const F = new Float64Array(nx * ny).fill(-pad);
  const range = (lo: number, hi: number, o: number, lim: number): [number, number] => [Math.max(0, Math.floor((lo - pad - o) / step)), Math.min(lim - 1, Math.ceil((hi + pad - o) / step))];
  for (let a = 0; a < n; a++) {
    const [i0, i1] = range(cx[a] - R[a], cx[a] + R[a], ox, nx);
    const [j0, j1] = range(cy[a] - R[a], cy[a] + R[a], oy, ny);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const v = R[a] - Math.hypot(ox + i * step - cx[a], oy + j * step - cy[a]);
        if (v > F[j * nx + i]) F[j * nx + i] = v;
      }
  }
  for (const [a, b, h] of bands) {
    const dx = cx[b] - cx[a];
    const dy = cy[b] - cy[a];
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const [i0, i1] = range(Math.min(cx[a], cx[b]) - h, Math.max(cx[a], cx[b]) + h, ox, nx);
    const [j0, j1] = range(Math.min(cy[a], cy[b]) - h, Math.max(cy[a], cy[b]) + h, oy, ny);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = ox + i * step - cx[a];
        const py = oy + j * step - cy[a];
        const t = px * ux + py * uy;
        if (t < 0 || t > len) continue;
        const v = h - Math.abs(px * uy - py * ux);
        if (v > F[j * nx + i]) F[j * nx + i] = v;
      }
  }

  // marching squares: crossing points on grid edges, linked into rings
  const pts = new Map<number, [number, number]>();
  const link = new Map<number, number[]>();
  const hKey = (i: number, j: number) => (j * nx + i) * 2;
  const vKey = (i: number, j: number) => (j * nx + i) * 2 + 1;
  const at = (i: number, j: number) => F[j * nx + i];
  const cross = (key: number, ia: number, ja: number, ib: number, jb: number) => {
    if (!pts.has(key)) {
      const fa = at(ia, ja);
      const fb = at(ib, jb);
      const t = fa / (fa - fb);
      pts.set(key, [ox + (ia + (ib - ia) * t) * step, oy + (ja + (jb - ja) * t) * step]);
    }
    return key;
  };
  const join = (p: number, q: number) => {
    let a = link.get(p);
    if (!a) link.set(p, (a = []));
    a.push(q);
    let b = link.get(q);
    if (!b) link.set(q, (b = []));
    b.push(p);
  };
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = at(i, j) > 0;
      const b = at(i + 1, j) > 0;
      const c = at(i + 1, j + 1) > 0;
      const d = at(i, j + 1) > 0;
      if (a === b && b === c && c === d) continue;
      const top = a !== b ? cross(hKey(i, j), i, j, i + 1, j) : -1;
      const right = b !== c ? cross(vKey(i + 1, j), i + 1, j, i + 1, j + 1) : -1;
      const bottom = d !== c ? cross(hKey(i, j + 1), i, j + 1, i + 1, j + 1) : -1;
      const left = a !== d ? cross(vKey(i, j), i, j, i, j + 1) : -1;
      const es = [top, right, bottom, left].filter((e) => e >= 0);
      if (es.length === 2) join(es[0], es[1]);
      else {
        // saddle: the centre decides which corners are cut off
        const centre = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 > 0;
        if (centre === a) {
          join(top, right);
          join(bottom, left);
        } else {
          join(left, top);
          join(right, bottom);
        }
      }
    }
  const rings: number[][] = [];
  const seen = new Set<number>();
  for (const start of [...pts.keys()].sort((p, q) => p - q)) {
    if (seen.has(start)) continue;
    const ring: [number, number][] = [];
    let prev = -1;
    let cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      ring.push(pts.get(cur)!);
      const nb = link.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = next;
    }
    if (ring.length < 3) continue;
    rings.push(simplify(ring, step * 0.3));
  }
  let top: [number, number] = [x0, y0];
  let ty = Infinity;
  for (const r of rings)
    for (let k = 0; k < r.length; k += 2)
      if (r[k + 1] < ty) {
        ty = r[k + 1];
        top = [r[k], r[k + 1]];
      }
  return { rings, bbox: [x0, y0, x1, y1], top };
}

/** Ramer-Douglas-Peucker on a closed ring, flattened to [x0, y0, ...]. */
function simplify(ring: [number, number][], eps: number): number[] {
  const pts = [...ring, ring[0]];
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  // split at the point farthest from the start so the closed ring has two real halves
  let far = 0;
  let fd = -1;
  for (let k = 1; k < pts.length - 1; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = k;
    }
  }
  keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, pts.length - 1],
  ];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = pts[s];
    const [bx, by] = pts[e];
    const L = Math.hypot(bx - ax, by - ay) || 1e-12;
    let best = -1;
    let bd = eps;
    for (let k = s + 1; k < e; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / L;
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < pts.length - 1; k++) if (keep[k]) out.push(round(pts[k][0]), round(pts[k][1]));
  return out;
}

export const round = (v: number) => Math.round(v * 100) / 100;
