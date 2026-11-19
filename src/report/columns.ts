// Metric columns shared by the HTML scoreboard, the cross-fixture summary and metrics.csv.

import type { RunSummary } from '../metrics/metrics.ts';

export type Better = 'low' | 'high' | null;

export interface Column {
  key: string;
  label: string;
  help: string;
  get(s: RunSummary): number;
  fmt(v: number, s: RunSummary): string;
  better: Better;
}

const pct = (v: number) => (v === 0 ? '0' : v < 0.001 ? '<0.1%' : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
const num = (v: number) => (v === 0 ? '0' : v < 0.001 ? '<0.001' : v < 0.01 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));

export const COLUMNS: Column[] = [
  { key: 'movedFrac', label: 'moved / commit', help: 'Average share of surviving nodes (files + platforms) that changed position from one commit to the next.', get: (s) => s.all.meanMovedFrac, fmt: pct, better: 'low' },
  { key: 'movedPerChange', label: 'moved / tree change', help: 'Like moved / commit, but averaged only over commits that added, deleted or renamed something. Most commits only edit files, which dilutes the per-commit average.', get: (s) => s.structural.meanMovedFrac, fmt: pct, better: 'low' },
  { key: 'filesMoved', label: 'files moved', help: 'Same, files only.', get: (s) => s.files.meanMovedFrac, fmt: pct, better: 'low' },
  { key: 'dirsMoved', label: 'platforms moved', help: 'Same, directory platforms only.', get: (s) => s.dirs.meanMovedFrac, fmt: pct, better: 'low' },
  { key: 'meanShift', label: 'mean shift', help: 'Average distance a surviving node moves per commit (layout units; 1 = one file cell), averaged over commits.', get: (s) => s.all.meanStepMean, fmt: num, better: 'low' },
  { key: 'p95Jump', label: 'p95 jump', help: '95th percentile distance among node moves that actually happened (how far things go when they do move). Approximate (log-binned, about ±3%).', get: (s) => s.all.p95Moved, fmt: num, better: 'low' },
  { key: 'maxJump', label: 'max jump', help: 'Largest single node move in the whole history.', get: (s) => s.all.max, fmt: num, better: 'low' },
  { key: 'stepsMoving', label: 'commits w/ motion', help: 'Share of commits in which at least one surviving node moved.', get: (s) => s.all.stepsWithMoveFrac, fmt: pct, better: 'low' },
  { key: 'disruption', label: 'disruption / commit', help: 'Total distance moved by all surviving nodes, per commit. Sums many small shifts and a few big ones alike.', get: (s) => s.all.disruptionPerStep, fmt: num, better: 'low' },
  { key: 'quietMotion', label: 'motion w/o change', help: 'Commits that did not add, remove or rename anything (content edits only) but moved the layout anyway, as a share of such commits. Should be 0.', get: (s) => (s.quiet.steps ? s.quiet.movedAnyway / s.quiet.steps : 0), fmt: (v, s) => `${s.quiet.movedAnyway}/${s.quiet.steps}`, better: 'low' },
  { key: 'compact', label: 'compactness', help: 'Live file cells divided by the bounding-box area, averaged over every commit. Higher = denser picture.', get: (s) => s.compactness.mean, fmt: (v) => v.toFixed(3), better: 'high' },
  { key: 'compactFinal', label: 'final compactness', help: 'Compactness at the last commit.', get: (s) => s.compactness.final, fmt: (v) => v.toFixed(3), better: 'high' },
  { key: 'size', label: 'final w × h', help: 'Bounding box at the last commit, layout units.', get: (s) => s.bbox.area, fmt: (v, s) => `${Math.round(s.bbox.w)}×${Math.round(s.bbox.h)}`, better: null },
  { key: 'aspect', label: 'aspect', help: 'Final width / height. TreeV layouts tend to be wide.', get: (s) => s.bbox.aspect, fmt: (v) => v.toFixed(1), better: null },
  { key: 'disorder', label: 'out of name order', help: 'Share of adjacent siblings (platforms left-to-right, files in slot order) that are not alphabetical, averaged over commits. A taste metric: 0 = fully alphabetical.', get: (s) => s.order.meanDisorder, fmt: pct, better: 'low' },
  { key: 'ghosts', label: 'ghost files', help: 'Share of file slots at the last commit that are tombstones of deleted files.', get: (s) => s.ghost.finalFileFrac, fmt: pct, better: 'low' },
];

/** Metrics that feed the cross-fixture summary scores, grouped. */
export const SCORE_GROUPS: { key: string; label: string; cols: string[] }[] = [
  { key: 'stability', label: 'stability', cols: ['movedPerChange', 'meanShift', 'disruption', 'p95Jump'] },
  { key: 'compact', label: 'compactness', cols: ['compact'] },
  { key: 'order', label: 'name order', cols: ['disorder'] },
];

export function column(key: string): Column {
  const c = COLUMNS.find((c) => c.key === key);
  if (!c) throw new Error(`no column ${key}`);
  return c;
}

/**
 * Normalized rank of each value among `values`: 0 = best, 1 = worst, ties share the
 * average rank. With one value the rank is 0.
 */
export function normRanks(values: number[], better: 'low' | 'high'): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0);
  const idx = values.map((v, i) => [better === 'low' ? v : -v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs(idx[j + 1][0] - idx[i][0]) <= 1e-12 * Math.max(1, Math.abs(idx[i][0]))) j++;
    const r = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}
