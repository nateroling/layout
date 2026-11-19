// Streaming stability / compactness / order metrics over consecutive Frames.
//
// Feed every frame of a run, in commit order, to MetricsAccumulator.push().
// Only the previous frame's positions are retained (O(nodes) memory), plus a
// fixed-size histogram for percentiles and a fixed number of time buckets for
// sparklines. Definitions follow SPEC.md "Metrics":
//
//   displacement  for nodes non-ghost in both frames (matched by id), Euclidean
//                 distance between top-left corners, in layout units.
//   compactness   live file cells (non-ghost files x cell^2) / bbox area.
//   order         fraction of adjacent sibling pairs not in codepoint name order.

import { cmp } from '../model/tree.ts';
import type { Frame, LayoutNode } from '../types.ts';

/** Moves smaller than this are treated as no movement (float noise). */
export const EPS = 1e-6;

// ---- log-binned histogram (bounded memory percentiles) ----
// Bin 0 holds exact zeros (<= EPS). Remaining bins are log-spaced from LO to HI
// with BPD bins per decade; values outside are clamped to the end bins.
// A percentile is returned as the geometric midpoint of its bin, so it is
// accurate to within ~half a bin (BPD=40 -> about +/-3%).
const LO = 1e-3;
const HI = 1e6;
const BPD = 40;
const NBINS = 1 + Math.ceil(Math.log10(HI / LO) * BPD);

export class LogHistogram {
  bins = new Float64Array(NBINS);
  n = 0;
  max = 0;
  add(v: number, weight = 1): void {
    this.n += weight;
    if (v > this.max) this.max = v;
    this.bins[binOf(v)] += weight;
  }
  /** q in [0,1]. Returns 0 when empty. Never exceeds the observed max. */
  quantile(q: number): number {
    if (this.n === 0) return 0;
    const target = q * this.n;
    let acc = 0;
    for (let i = 0; i < NBINS; i++) {
      acc += this.bins[i];
      if (acc >= target && this.bins[i] > 0) return Math.min(this.max, binMid(i));
    }
    return this.max;
  }
}

function binOf(v: number): number {
  if (!(v > EPS)) return 0;
  const k = Math.floor(Math.log10(Math.max(v, LO) / LO) * BPD);
  return 1 + Math.min(NBINS - 2, Math.max(0, k));
}
function binMid(i: number): number {
  if (i === 0) return 0;
  return LO * Math.pow(10, (i - 1 + 0.5) / BPD);
}

// ---- per-kind displacement accumulator ----

class MoveStats {
  hist = new LogHistogram(); // all survivor moves, including zeros
  movedHist = new LogHistogram(); // moves > EPS only
  sumStepMean = 0; // sum over steps (with >=1 survivor) of the step's mean move
  sumStepMovedFrac = 0; // sum over steps of moved/survivors
  stepsWithSurvivors = 0;
  stepsWithMove = 0;
  total = 0; // disruption: sum of all moves
  movedCount = 0; // node-steps that moved
  survivorCount = 0; // node-steps observed
  max = 0;
  // per-step scratch
  private s = 0;
  private c = 0;
  private m = 0;
  begin(): void {
    this.s = this.c = this.m = 0;
  }
  add(d: number): void {
    this.c++;
    this.hist.add(d);
    if (d > EPS) {
      this.s += d;
      this.m++;
      this.movedHist.add(d);
      if (d > this.max) this.max = d;
    }
  }
  end(): { mean: number; moved: number; survivors: number; sum: number } {
    const r = { mean: this.c ? this.s / this.c : 0, moved: this.m, survivors: this.c, sum: this.s };
    if (this.c > 0) {
      this.stepsWithSurvivors++;
      this.sumStepMean += r.mean;
      this.sumStepMovedFrac += this.m / this.c;
      if (this.m > 0) this.stepsWithMove++;
    }
    this.total += this.s;
    this.movedCount += this.m;
    this.survivorCount += this.c;
    return r;
  }
  summary(transitions: number): DisplacementSummary {
    const k = this.stepsWithSurvivors;
    return {
      meanStepMean: k ? this.sumStepMean / k : 0,
      p95: this.hist.quantile(0.95),
      p95Moved: this.movedHist.quantile(0.95),
      max: this.max,
      stepsWithMoveFrac: transitions ? this.stepsWithMove / transitions : 0,
      meanMovedFrac: k ? this.sumStepMovedFrac / k : 0,
      disruption: this.total,
      disruptionPerStep: transitions ? this.total / transitions : 0,
      movedNodeSteps: this.movedCount,
      survivorNodeSteps: this.survivorCount,
    };
  }
}

export interface DisplacementSummary {
  /** Mean over transitions of (sum of moves / survivors). Steps with no survivors are skipped. */
  meanStepMean: number;
  /** 95th percentile of per-node moves over every survivor node-step (zeros included). */
  p95: number;
  /** 95th percentile of per-node moves, counting only node-steps that moved. */
  p95Moved: number;
  /** Largest single node move. */
  max: number;
  /** Fraction of transitions in which at least one survivor moved. */
  stepsWithMoveFrac: number;
  /** Mean over transitions of moved / survivors. */
  meanMovedFrac: number;
  /** Sum of every move over the run (layout units). */
  disruption: number;
  disruptionPerStep: number;
  movedNodeSteps: number;
  survivorNodeSteps: number;
}

export interface StepResult {
  commit: number;
  structural: boolean; // the set of live node ids changed, or a surviving node was renamed
  files: { mean: number; moved: number; survivors: number; sum: number };
  dirs: { mean: number; moved: number; survivors: number; sum: number };
  all: { mean: number; moved: number; survivors: number; sum: number };
}

export interface FrameStats {
  liveFiles: number;
  ghostFiles: number;
  ghostNodes: number;
  nodes: number;
  bboxArea: number;
  compactness: number; // liveFiles * cell^2 / bboxArea (0 for empty frames)
  orderPairs: number;
  orderBad: number;
  disorder: number; // orderBad / orderPairs (0 when no pairs)
}

export interface RunSummary {
  frames: number;
  transitions: number;
  files: DisplacementSummary;
  dirs: DisplacementSummary;
  all: DisplacementSummary;
  compactness: { mean: number; final: number };
  bbox: { w: number; h: number; aspect: number; area: number }; // final frame
  maxBbox: { w: number; h: number }; // largest w and h seen over the run
  ghost: { meanFileFrac: number; finalFileFrac: number; finalNodeFrac: number };
  order: { meanDisorder: number; finalDisorder: number };
  quiet: {
    /** transitions where the set of live nodes and their paths did not change (content edits only) */
    steps: number;
    /** of those, how many moved something anyway */
    movedAnyway: number;
    /** sum of moves during quiet steps */
    disruption: number;
  };
  /**
   * Transitions that changed the tree (add/delete/rename, with >= 1 survivor). Most commits only
   * edit content, so per-commit averages are diluted; these averages are over tree changes only.
   */
  structural: { steps: number; meanMovedFrac: number; meanStepMean: number };
  finalLiveFiles: number;
  finalNodes: number;
  /** Bucketed per-transition series for sparklines (bucket = contiguous run of transitions). */
  series: { buckets: number; movedFrac: number[]; disruption: number[]; compactness: number[]; liveFiles: number[] };
}

interface Prev {
  x: number;
  y: number;
  file: boolean;
  path: string;
}

export interface AccumulatorOptions {
  cell?: number; // layout units per file cell (default 1)
  totalFrames?: number; // expected frames, for series bucketing (default: series disabled)
  buckets?: number; // number of series buckets (default 120)
}

/** Per-frame statistics that do not depend on the previous frame. Exported for tests. */
export function frameStats(f: Frame, cell = 1): FrameStats {
  let liveFiles = 0, ghostFiles = 0, ghostNodes = 0;
  for (const n of f.nodes) {
    if (n.ghost) ghostNodes++;
    if (n.kind === 'file') n.ghost ? ghostFiles++ : liveFiles++;
  }
  const area = f.bbox.w * f.bbox.h;
  const { pairs, bad } = orderStats(f.nodes);
  return {
    liveFiles,
    ghostFiles,
    ghostNodes,
    nodes: f.nodes.length,
    bboxArea: area,
    compactness: area > 0 ? (liveFiles * cell * cell) / area : 0,
    orderPairs: pairs,
    orderBad: bad,
    disorder: pairs ? bad / pairs : 0,
  };
}

/**
 * Adjacent-sibling order check over live (non-ghost) nodes.
 * Child dirs of a dir: sorted by x (then y). Files of a platform: slot order, by y then x
 * (rows are compared with a small tolerance). A pair is "bad" when the earlier
 * sibling's path compares greater than the later one's (codepoint order). Siblings
 * share a parent prefix, so comparing full paths equals comparing names.
 */
export function orderStats(nodes: LayoutNode[]): { pairs: number; bad: number } {
  const dirKids = new Map<string, LayoutNode[]>();
  const fileKids = new Map<string, LayoutNode[]>();
  for (const n of nodes) {
    if (n.ghost || n.parent === null) continue;
    const m = n.kind === 'dir' ? dirKids : fileKids;
    let a = m.get(n.parent);
    if (!a) m.set(n.parent, (a = []));
    a.push(n);
  }
  let pairs = 0, bad = 0;
  const tol = 1e-6;
  const count = (a: LayoutNode[]) => {
    for (let i = 1; i < a.length; i++) {
      pairs++;
      if (cmp(a[i - 1].path, a[i].path) > 0) bad++;
    }
  };
  for (const a of dirKids.values()) {
    a.sort((p, q) => p.x - q.x || p.y - q.y);
    count(a);
  }
  for (const a of fileKids.values()) {
    a.sort((p, q) => (Math.abs(p.y - q.y) > tol ? p.y - q.y : p.x - q.x));
    count(a);
  }
  return { pairs, bad };
}

export class MetricsAccumulator {
  readonly cell: number;
  private prev: Map<string, Prev> | null = null;
  private files = new MoveStats();
  private dirs = new MoveStats();
  private all = new MoveStats();
  private frames = 0;
  private transitions = 0;
  private sumCompact = 0;
  private sumGhostFileFrac = 0;
  private sumDisorder = 0;
  private last: FrameStats | null = null;
  private lastBbox = { w: 0, h: 0 };
  private maxW = 0;
  private maxH = 0;
  private quietSteps = 0;
  private quietMoved = 0;
  private quietDisruption = 0;
  private structSteps = 0;
  private structMovedFrac = 0;
  private structMean = 0;
  // series
  private totalFrames: number;
  private nb: number;
  private sMoved: Float64Array;
  private sDisr: Float64Array;
  private sCompact: Float64Array;
  private sLive: Float64Array;
  private sCount: Float64Array;

  constructor(o: AccumulatorOptions = {}) {
    this.cell = o.cell ?? 1;
    this.totalFrames = o.totalFrames ?? 0;
    this.nb = this.totalFrames > 0 ? Math.max(1, Math.min(o.buckets ?? 120, this.totalFrames)) : 0;
    this.sMoved = new Float64Array(this.nb);
    this.sDisr = new Float64Array(this.nb);
    this.sCompact = new Float64Array(this.nb);
    this.sLive = new Float64Array(this.nb);
    this.sCount = new Float64Array(this.nb);
  }

  /** Feed the next frame. Returns the transition stats (null for the first frame). */
  push(f: Frame): StepResult | null {
    const fs = frameStats(f, this.cell);
    this.frames++;
    this.sumCompact += fs.compactness;
    const fileNodes = fs.liveFiles + fs.ghostFiles;
    this.sumGhostFileFrac += fileNodes ? fs.ghostFiles / fileNodes : 0;
    this.sumDisorder += fs.disorder;
    this.last = fs;
    this.lastBbox = { w: f.bbox.w, h: f.bbox.h };
    if (f.bbox.w > this.maxW) this.maxW = f.bbox.w;
    if (f.bbox.h > this.maxH) this.maxH = f.bbox.h;

    const cur = new Map<string, Prev>();
    for (const n of f.nodes) if (!n.ghost) cur.set(n.id, { x: n.x, y: n.y, file: n.kind === 'file', path: n.path });

    let step: StepResult | null = null;
    if (this.prev) {
      this.transitions++;
      this.files.begin();
      this.dirs.begin();
      this.all.begin();
      let structural = cur.size !== this.prev.size;
      for (const [id, p] of cur) {
        const q = this.prev.get(id);
        if (!q) {
          structural = true;
          continue;
        }
        if (p.path !== q.path) structural = true; // rename keeps identity but is a tree change
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        (p.file ? this.files : this.dirs).add(d);
        this.all.add(d);
      }
      const fr = this.files.end();
      const dr = this.dirs.end();
      const ar = this.all.end();
      step = { commit: f.commit, structural, files: fr, dirs: dr, all: ar };
      if (structural && ar.survivors > 0) {
        this.structSteps++;
        this.structMovedFrac += ar.moved / ar.survivors;
        this.structMean += ar.mean;
      }
      if (!structural) {
        this.quietSteps++;
        if (ar.moved > 0) this.quietMoved++;
        this.quietDisruption += ar.sum;
      }
    }
    if (this.nb > 0) {
      const b = Math.min(this.nb - 1, Math.floor(((this.frames - 1) * this.nb) / this.totalFrames));
      this.sCount[b]++;
      this.sCompact[b] += fs.compactness;
      this.sLive[b] = fs.liveFiles; // last value in bucket
      if (step) {
        this.sMoved[b] += step.all.survivors ? step.all.moved / step.all.survivors : 0;
        this.sDisr[b] += step.all.sum;
      }
    }
    this.prev = cur;
    return step;
  }

  summary(): RunSummary {
    const t = this.transitions;
    const last = this.last;
    const bw = this.lastBbox.w, bh = this.lastBbox.h;
    const fileNodes = last ? last.liveFiles + last.ghostFiles : 0;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const series = { buckets: this.nb, movedFrac: [] as number[], disruption: [] as number[], compactness: [] as number[], liveFiles: [] as number[] };
    for (let i = 0; i < this.nb; i++) {
      const c = this.sCount[i] || 1;
      series.movedFrac.push(r3(this.sMoved[i] / c));
      series.disruption.push(r3(this.sDisr[i]));
      series.compactness.push(r3(this.sCompact[i] / c));
      series.liveFiles.push(this.sLive[i]);
    }
    return {
      frames: this.frames,
      transitions: t,
      files: this.files.summary(t),
      dirs: this.dirs.summary(t),
      all: this.all.summary(t),
      compactness: { mean: this.frames ? this.sumCompact / this.frames : 0, final: last?.compactness ?? 0 },
      bbox: { w: bw, h: bh, aspect: bh > 0 ? bw / bh : 0, area: bw * bh },
      maxBbox: { w: this.maxW, h: this.maxH },
      ghost: {
        meanFileFrac: this.frames ? this.sumGhostFileFrac / this.frames : 0,
        finalFileFrac: fileNodes ? last!.ghostFiles / fileNodes : 0,
        finalNodeFrac: last && last.nodes ? last.ghostNodes / last.nodes : 0,
      },
      order: { meanDisorder: this.frames ? this.sumDisorder / this.frames : 0, finalDisorder: last?.disorder ?? 0 },
      quiet: { steps: this.quietSteps, movedAnyway: this.quietMoved, disruption: this.quietDisruption },
      structural: {
        steps: this.structSteps,
        meanMovedFrac: this.structSteps ? this.structMovedFrac / this.structSteps : 0,
        meanStepMean: this.structSteps ? this.structMean / this.structSteps : 0,
      },
      finalLiveFiles: last?.liveFiles ?? 0,
      finalNodes: last?.nodes ?? 0,
      series,
    };
  }
}
