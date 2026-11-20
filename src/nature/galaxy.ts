// Galaxy: a spiral galaxy. The root's own files are the central bulge. The rest of the tree is split
// into a few arms (2 to 4, by size); each arm is a logarithmic spiral r = r0 * e^(b*phi) wound out from
// the bulge, and every directory on it is a star cluster: its files packed as a small golden-angle
// cluster, the clusters strung along the arm in tree order, so sibling folders sit next to each other
// and a subtree is one stretch of arm. Clusters drift a little off the arm's centre line, and any that
// collide (across arms) are nudged apart.

import { type Disc, enclosing, fileRadius, hash, phyllotaxis, relax, rng, type Scene, type SDir, type Snapshot } from './model.ts';

const PITCH = (17 * Math.PI) / 180; // arm pitch angle
const B = Math.tan(PITCH);
const STAR_GAP = 0.1;

interface Cluster {
  d: SDir;
  stars: Disc[];
  R: number;
}

function cluster(d: SDir): Cluster {
  const files = [...d.files].sort((a, b) => b.size - a.size || a.i - b.i); // brightest at the core
  const stars = phyllotaxis(files.map((f) => fileRadius(f.size)), STAR_GAP);
  stars.forEach((s, n) => ((s as Disc & { f: number }).f = files[n].i));
  return { d, stars, R: enclosing(stars) };
}

/** Split the tree into `arms` runs of whole subtrees, in DFS order, with similar file counts. */
function armUnits(root: SDir, arms: number): SDir[][] {
  let units = [...root.dirs];
  const total = root.count - root.files.length;
  for (;;) {
    const big = units.reduce((m, u, i) => (u.count > units[m].count ? i : m), 0);
    if (!units.length || units[big].count <= total / (arms * 1.4) || !units[big].dirs.length) break;
    // replace the big unit with its own files (as a leaf-only stand-in) and its children
    const u = units[big];
    const stand: SDir = { ...u, dirs: [], count: u.files.length };
    units.splice(big, 1, ...(u.files.length ? [stand] : []), ...u.dirs);
  }
  // contiguous runs, greedy
  const out: SDir[][] = [];
  let acc = 0;
  let run: SDir[] = [];
  for (const u of units) {
    run.push(u);
    acc += u.count;
    if (acc >= (total * (out.length + 1)) / arms && out.length < arms - 1) {
      out.push(run);
      run = [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

export function galaxy(snap: Snapshot): Scene {
  const scene: Scene = { layout: 'galaxy', marks: [], shapes: [] };
  const rest = snap.root.count - snap.root.files.length;
  const arms = Math.max(2, Math.min(4, Math.round(Math.sqrt(rest) / 7)));
  const bulge = cluster(snap.root);
  const placed: { c: Cluster; x: number; y: number }[] = [{ c: bulge, x: 0, y: 0 }];
  const r0 = bulge.R + 2;
  const k = Math.sqrt(1 + B * B) / B;
  const runs = armUnits(snap.root, arms);
  runs.forEach((run, ai) => {
    const phi0 = (2 * Math.PI * ai) / runs.length;
    const rand = rng(hash(`arm${ai}`));
    const clusters: Cluster[] = [];
    const visit = (d: SDir) => {
      if (d.files.length) clusters.push(cluster(d));
      for (const c of d.dirs) visit(c);
    };
    run.forEach(visit);
    let s = 0;
    const trail: number[] = [];
    const widths: number[] = [];
    clusters.forEach((c, n) => {
      s += (n ? clusters[n - 1].R : 0) + c.R + 0.6;
      const phi = Math.log(1 + s / (r0 * k)) / B; // arc length -> angle on r = r0 e^(b phi)
      const r = r0 * Math.exp(B * phi);
      const th = phi0 + phi;
      const jitter = (rand() - 0.5) * c.R * 0.8;
      const x = Math.cos(th) * (r + jitter);
      const y = Math.sin(th) * (r + jitter);
      placed.push({ c, x, y });
      trail.push(Math.cos(th) * r, Math.sin(th) * r);
      widths.push(c.R * 1.6 + 1);
    });
    if (trail.length) {
      trail.unshift(Math.cos(phi0) * bulge.R, Math.sin(phi0) * bulge.R);
      widths.unshift(widths[0] ?? 1);
      scene.shapes.push({ k: 'line', d: run[0].i, pts: trail, w: widths });
    }
  });
  // clusters as discs, bulge pinned
  const discs = placed.map((p) => ({ x: p.x, y: p.y, r: p.c.R + 0.3 }));
  relax(discs, 0.2, 200, (i) => i === 0);
  placed.forEach((p, i) => {
    for (const s of p.c.stars) scene.marks.push({ f: (s as Disc & { f: number }).f, x: discs[i].x + s.x, y: discs[i].y + s.y, r: s.r });
  });
  return scene;
}
