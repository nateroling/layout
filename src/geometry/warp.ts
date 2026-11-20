// Organic warp: a Townscaper-style deformed grid laid over a placement.
//
// A square lattice (spacing `s`) covers the placement. Every lattice vertex keeps a displacement,
// and the picture is the placement pushed through the piecewise-bilinear map those vertices
// define: each lattice cell becomes an irregular quad, and so does everything drawn inside it.
// Cells that hold files want to keep their size; empty cells want to shrink to `min` of it.
// A spring relaxation (cell edges + diagonals, root vertex pinned) finds a shape that does both,
// so empty space collapses while the files stay full size, and the grid comes out squished and
// irregular instead of square.
//
// Stability: the displacements are state. Each commit starts from the previous mesh and runs a
// few relaxation sweeps, moving every vertex at most `rate` units (0 = relax to convergence).
// A sweep that would fold the mesh (any cell not a convex, consistently oriented quad) is
// rejected, so the map stays one-to-one: shapes that don't overlap in the placement never
// overlap after the warp.
//
// The map functions are plain JS once types are stripped; the HTML report embeds them with
// Function.prototype.toString().

export interface Mesh {
  s: number; // lattice spacing (layout units)
  i0: number; // lattice index of the first column / row of vertices
  j0: number;
  ni: number; // vertex count per row / column (>= 2)
  nj: number;
  d: number[]; // displacement per vertex, [dx, dy] row-major (j outer, i inner)
}

/** Map one point through the mesh (bilinear in its cell; extrapolated outside). */
export function meshMap(m: Mesh, x: number, y: number): number[] {
  const fi = x / m.s - m.i0, fj = y / m.s - m.j0;
  const ci = Math.max(0, Math.min(m.ni - 2, Math.floor(fi)));
  const cj = Math.max(0, Math.min(m.nj - 2, Math.floor(fj)));
  const u = fi - ci, v = fj - cj;
  const k00 = 2 * (cj * m.ni + ci), k10 = k00 + 2, k01 = k00 + 2 * m.ni, k11 = k01 + 2;
  const a = (1 - u) * (1 - v), b = u * (1 - v), c = (1 - u) * v, e = u * v;
  return [
    x + a * m.d[k00] + b * m.d[k10] + c * m.d[k01] + e * m.d[k11],
    y + a * m.d[k00 + 1] + b * m.d[k10 + 1] + c * m.d[k01 + 1] + e * m.d[k11 + 1],
  ];
}

/**
 * The exact image of an axis-aligned rect: its boundary, broken at every lattice line it
 * crosses (bilinear is linear along an axis-aligned segment inside one cell), as a flat
 * [x0, y0, x1, y1, ...] polygon, clockwise on screen.
 */
export function warpPoly(m: Mesh, x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  const cuts = (a: number, b: number) => {
    const r = [a];
    for (let k = Math.floor(a / m.s) + 1; k * m.s < b; k++) r.push(k * m.s);
    return r;
  };
  const xs = cuts(x, x + w), ys = cuts(y, y + h);
  const put = (px: number, py: number) => {
    const p = meshMap(m, px, py);
    out.push(p[0], p[1]);
  };
  for (const px of xs) put(px, y); // top, left to right
  for (const py of ys) put(x + w, py); // right, top to bottom
  put(x + w, y + h);
  for (let k = xs.length - 1; k >= 1; k--) put(xs[k], y + h); // bottom, right to left
  put(x, y + h);
  for (let k = ys.length - 1; k >= 1; k--) put(x, ys[k]); // left, bottom to top
  return out;
}

/** Bounding box of a flat polygon. */
export function polyBox(p: number[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) {
    if (p[k] < x0) x0 = p[k];
    if (p[k] > x1) x1 = p[k];
    if (p[k + 1] < y0) y0 = p[k + 1];
    if (p[k + 1] > y1) y1 = p[k + 1];
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---- state + relaxation (strategy side) ----

export interface WarpState {
  d: Map<string, [number, number]>; // "i,j" -> displacement
}
export const newWarp = (): WarpState => ({ d: new Map() });

export interface WarpOpts {
  s: number; // lattice spacing
  min: number; // target scale of an empty cell (0..1)
  rate: number; // max vertex move per commit (0 = unlimited)
}

const key = (i: number, j: number) => `${i},${j}`;
/** Vertices pulled by less than this (layout units) don't move. */
const SETTLE = 0.15;

/** Every cell is a convex quad with the lattice's orientation (no folds). */
export function meshValid(m: Mesh): boolean {
  const P = (i: number, j: number) => {
    const k = 2 * (j * m.ni + i);
    return [(m.i0 + i) * m.s + m.d[k], (m.j0 + j) * m.s + m.d[k + 1]];
  };
  for (let j = 0; j + 1 < m.nj; j++)
    for (let i = 0; i + 1 < m.ni; i++) {
      const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
      for (let a = 0; a < 4; a++) {
        const p0 = q[a], p1 = q[(a + 1) % 4], p2 = q[(a + 2) % 4];
        const cross = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
        if (!(cross > 1e-9)) return false;
      }
    }
  return true;
}

/**
 * One commit of the warp: grow the lattice to cover `box` (+1 cell), mark cells holding files,
 * relax from the previous displacements, and return the mesh for this commit.
 */
export function warpStep(st: WarpState, box: { x: number; y: number; w: number; h: number }, files: { x: number; y: number; w: number; h: number }[], o: WarpOpts): Mesh {
  const s = o.s;
  // The lattice only ever grows (its vertices are state); always include the origin.
  let i0 = Math.min(0, Math.floor(box.x / s) - 1), j0 = Math.min(0, Math.floor(box.y / s) - 1);
  let i1 = Math.max(1, Math.ceil((box.x + box.w) / s) + 1), j1 = Math.max(1, Math.ceil((box.y + box.h) / s) + 1);
  for (const k of st.d.keys()) {
    const [i, j] = k.split(',').map(Number);
    i0 = Math.min(i0, i), j0 = Math.min(j0, j), i1 = Math.max(i1, i), j1 = Math.max(j1, j);
  }
  const ni = i1 - i0 + 1, nj = j1 - j0 + 1;
  const X = new Float64Array(ni * nj), Y = new Float64Array(ni * nj);
  // New vertices copy the displacement of the nearest existing vertex in their row/column walk
  // toward the origin, so the lattice extends the current shape instead of snapping back.
  const near = (i: number, j: number): [number, number] => {
    for (let r = 0; r < Math.max(ni, nj); r++) {
      const ii = i - Math.sign(i) * Math.min(Math.abs(i), r), jj = j - Math.sign(j) * Math.min(Math.abs(j), r);
      const v = st.d.get(key(ii, jj));
      if (v) return v;
    }
    return [0, 0];
  };
  for (let j = 0; j < nj; j++)
    for (let i = 0; i < ni; i++) {
      const v = st.d.get(key(i0 + i, j0 + j)) ?? near(i0 + i, j0 + j);
      X[j * ni + i] = (i0 + i) * s + v[0];
      Y[j * ni + i] = (j0 + j) * s + v[1];
    }
  // New vertices (the lattice grew) can make a bent boundary cell fold. Push the new vertices
  // of a folded cell further out along the lattice axis until it is a proper quad; if that
  // fails, start over from the square lattice (a one-off jump, but never a fold).
  const isNew = (i: number, j: number) => !st.d.has(key(i0 + i, j0 + j));
  const bad = () => {
    const out: number[] = [];
    for (let b = 0; b + 1 < nj; b++)
      for (let a = 0; a + 1 < ni; a++) {
        const q = [b * ni + a, b * ni + a + 1, (b + 1) * ni + a + 1, (b + 1) * ni + a];
        for (let e = 0; e < 4; e++) {
          const p0 = q[e], p1 = q[(e + 1) % 4], p2 = q[(e + 2) % 4];
          if ((X[p1] - X[p0]) * (Y[p2] - Y[p1]) - (Y[p1] - Y[p0]) * (X[p2] - X[p1]) <= 1e-9) {
            out.push(a, b);
            break;
          }
        }
      }
    return out;
  };
  let folds = st.d.size ? bad() : [];
  for (let tries = 0; folds.length && tries < 20; tries++) {
    for (let f = 0; f < folds.length; f += 2)
      for (const [a, b] of [[folds[f], folds[f + 1]], [folds[f] + 1, folds[f + 1]], [folds[f], folds[f + 1] + 1], [folds[f] + 1, folds[f + 1] + 1]]) {
        if (!isNew(a, b)) continue;
        const gi = i0 + a, gj = j0 + b;
        const k = b * ni + a;
        if (gi < 0 || gi > 0) X[k] += Math.sign(gi) * s * 0.5;
        if (gj < 0 || gj > 0) Y[k] += Math.sign(gj) * s * 0.5;
      }
    folds = bad();
  }
  if (folds.length)
    for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) (X[j * ni + i] = (i0 + i) * s), (Y[j * ni + i] = (j0 + j) * s);
  // Target scale per cell: 1 where files are, `min` elsewhere, softened by one 3x3 blur so the
  // transition is a gentle squish rather than a crease.
  const ci = ni - 1, cj = nj - 1;
  const full = new Uint8Array(ci * cj);
  for (const f of files) {
    const a0 = Math.max(0, Math.floor(f.x / s) - i0), a1 = Math.min(ci - 1, Math.floor((f.x + f.w - 1e-9) / s) - i0);
    const b0 = Math.max(0, Math.floor(f.y / s) - j0), b1 = Math.min(cj - 1, Math.floor((f.y + f.h - 1e-9) / s) - j0);
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) full[b * ci + a] = 1;
  }
  const t = new Float64Array(ci * cj);
  for (let b = 0; b < cj; b++)
    for (let a = 0; a < ci; a++) {
      if (full[b * ci + a]) {
        t[b * ci + a] = 1;
        continue;
      }
      let sum = 0, n = 0;
      for (let db = -1; db <= 1; db++)
        for (let da = -1; da <= 1; da++) {
          const aa = a + da, bb = b + db;
          if (aa < 0 || bb < 0 || aa >= ci || bb >= cj) continue;
          sum += full[bb * ci + aa] ? 1 : o.min;
          n++;
        }
      t[b * ci + a] = Math.min(1, (sum / n + o.min) / 2);
    }
  // Springs: every cell's four edges and two diagonals, rest length = s * the cell's scale
  // (an edge shared by two cells gets a spring from each). Weak diagonals let cells shear.
  const springs: number[] = []; // [p, q, rest, stiffness]
  for (let b = 0; b < cj; b++)
    for (let a = 0; a < ci; a++) {
      const L = s * t[b * ci + a];
      const p00 = b * ni + a, p10 = p00 + 1, p01 = p00 + ni, p11 = p01 + 1;
      springs.push(p00, p10, L, 1, p01, p11, L, 1, p00, p01, L, 1, p10, p11, L, 1);
      springs.push(p00, p11, L * Math.SQRT2, 0.35, p10, p01, L * Math.SQRT2, 0.35);
    }
  const pin = -j0 * ni - i0; // vertex (0, 0): the root lot's corner
  const pin2 = pin + 1; // vertex (1, 0): stays on the x axis (no rotation)
  const X0 = X.slice(), Y0 = Y.slice();
  const mesh = (): Mesh => {
    const d: number[] = new Array(2 * ni * nj);
    for (let j = 0; j < nj; j++)
      for (let i = 0; i < ni; i++) {
        const k = j * ni + i;
        d[2 * k] = X[k] - (i0 + i) * s;
        d[2 * k + 1] = Y[k] - (j0 + j) * s;
      }
    return { s, i0, j0, ni, nj, d };
  };
  const budget = o.rate > 0 ? o.rate : Infinity;
  const iters = o.rate > 0 ? 12 : 300;
  // Gauss-Seidel: each vertex in turn moves toward its springs' rest lengths, but only if its
  // four cells stay convex and keep a minimum area (no slivers, no folds); else it tries a
  // smaller step, else it stays put. So the mesh is valid after every single move.
  const adj: number[][] = Array.from({ length: ni * nj }, () => []);
  for (let k = 0; k < springs.length; k += 4) adj[springs[k]].push(k), adj[springs[k + 1]].push(k);
  const minArea = 0.25 * (s * o.min) ** 2;
  const cellOk = (a: number, b: number) => {
    if (a < 0 || b < 0 || a >= ci || b >= cj) return true;
    const q = [b * ni + a, b * ni + a + 1, (b + 1) * ni + a + 1, (b + 1) * ni + a];
    for (let e = 0; e < 4; e++) {
      const p0 = q[e], p1 = q[(e + 1) % 4], p2 = q[(e + 2) % 4];
      const cross = (X[p1] - X[p0]) * (Y[p2] - Y[p1]) - (Y[p1] - Y[p0]) * (X[p2] - X[p1]);
      if (cross < minArea) return false;
    }
    return true;
  };
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let k = 0; k < X.length; k++) {
      if (k === pin) continue;
      let gx = 0, gy = 0, w = 0;
      for (const sp of adj[k]) {
        const p = springs[sp], q = springs[sp + 1], rest = springs[sp + 2], c = springs[sp + 3];
        const other = p === k ? q : p;
        const dx = X[other] - X[k], dy = Y[other] - Y[k];
        const len = Math.hypot(dx, dy) || 1e-9;
        const f = (c * (len - rest)) / len;
        gx += f * dx, gy += f * dy, w += c;
      }
      let tx = gx / w, ty = k === pin2 ? 0 : gy / w;
      // Dead zone: a vertex already close to rest stays exactly where it is, so a quiet commit
      // leaves the city still instead of creeping.
      if (Math.hypot(tx, ty) < SETTLE) continue;
      const i = k % ni, j = (k - i) / ni;
      const ox = X[k], oy = Y[k];
      for (let alpha = 0.8; alpha > 0.05; alpha /= 2) {
        let nx = ox + alpha * tx, ny = oy + alpha * ty;
        const dx = nx - X0[k], dy = ny - Y0[k], dl = Math.hypot(dx, dy);
        if (dl > budget) (nx = X0[k] + (dx * budget) / dl), (ny = Y0[k] + (dy * budget) / dl);
        X[k] = nx, Y[k] = ny;
        if (cellOk(i - 1, j - 1) && cellOk(i, j - 1) && cellOk(i - 1, j) && cellOk(i, j)) {
          moved = Math.max(moved, Math.hypot(nx - ox, ny - oy));
          break;
        }
        X[k] = ox, Y[k] = oy;
      }
    }
    if (moved < 1e-3) break;
  }
  const m = mesh();
  for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) st.d.set(key(i0 + i, j0 + j), [m.d[2 * (j * ni + i)], m.d[2 * (j * ni + i) + 1]]);
  return m;
}
