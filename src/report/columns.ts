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

const pct = (v: number) => (Number.isNaN(v) ? '–' : v === 0 ? '0' : v < 0.001 ? '<0.1%' : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
const num = (v: number) => (Number.isNaN(v) ? '–' : v === 0 ? '0' : v < 0.001 ? '<0.001' : v < 0.01 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));

/** Horizon summary for gap k, or undefined when the run was too short (or predates the metric). */
export const horizon = (s: RunSummary, k: number) => s.horizon?.find((h) => h.k === k);

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
  { key: 'quietMotion', label: 'motion w/o change', help: 'Commits that did not add, remove or rename anything (content edits only) but moved the layout anyway, as a share of such commits. Not necessarily a bug: tombstone with ghostTtl expires ghosts on whatever commit their time runs out, quiet or not, and the resulting compaction moves things.', get: (s) => (s.quiet.steps ? s.quiet.movedAnyway / s.quiet.steps : 0), fmt: (v, s) => `${s.quiet.movedAnyway}/${s.quiet.steps}`, better: 'low' },
  ...[100, 500].flatMap((k): Column[] => [
    { key: `h${k}Moved`, label: `moved after ${k}`, help: `Horizon: frames ${k} commits apart (commit 0 vs ${k}, ${k} vs ${2 * k}, …) compared directly. Share of nodes alive in both that are somewhere else, averaged over those pairs. Whether your mental map survives a gap of ${k} commits. – = history shorter than ${2 * k + 1} commits.`, get: (s) => horizon(s, k)?.meanMovedFrac ?? NaN, fmt: pct, better: 'low' },
    { key: `h${k}Shift`, label: `shift after ${k}`, help: `Horizon: mean distance (layout units) moved by nodes alive in both frames ${k} commits apart, averaged over those pairs.`, get: (s) => horizon(s, k)?.meanShift ?? NaN, fmt: num, better: 'low' },
  ]),
  { key: 'compact', label: 'compactness', help: 'Live file cells divided by the bounding-box area, averaged over every commit. Higher = denser picture.', get: (s) => s.compactness.mean, fmt: (v) => v.toFixed(3), better: 'high' },
  { key: 'compactFinal', label: 'final compactness', help: 'Compactness at the last commit.', get: (s) => s.compactness.final, fmt: (v) => v.toFixed(3), better: 'high' },
  { key: 'size', label: 'final w × h', help: 'Bounding box at the last commit, layout units.', get: (s) => s.bbox.area, fmt: (v, s) => `${Math.round(s.bbox.w)}×${Math.round(s.bbox.h)}`, better: null },
  { key: 'aspect', label: 'aspect', help: 'Final width / height. TreeV layouts tend to be wide.', get: (s) => s.bbox.aspect, fmt: (v) => v.toFixed(1), better: null },
  { key: 'disorder', label: 'out of name order', help: 'Share of adjacent siblings (platforms left-to-right, files in slot order) that are not alphabetical, averaged over commits. A taste metric: 0 = fully alphabetical.', get: (s) => s.order.meanDisorder, fmt: pct, better: 'low' },
  { key: 'ghosts', label: 'ghost files', help: 'Share of file slots at the last commit that are ghosts: tombstones of deleted files, and (tombstone) the slot a file left behind when it moved to another directory.', get: (s) => s.ghost.finalFileFrac, fmt: pct, better: 'low' },
];

/**
 * Cross-repo composite. Per repo, each config gets a rank score per ingredient (100 = best
 * config on that repo, 0 = worst); an ingredient with several columns averages their scores
 * over the columns available on that repo; a group averages its ingredients; the group
 * score is then averaged over repos. Distance-type metrics are near-duplicates of each other
 * (mean shift, disruption, p95 jump all scale with how far things go), so stability keeps
 * one "how often" (moved / tree change), one "how far on average" (mean shift), one "how far
 * at worst" (p95 jump) and the horizon share.
 */
export const SCORE_GROUPS: { key: string; label: string; ingredients: { label: string; cols: string[] }[] }[] = [
  {
    key: 'stability', label: 'stability',
    ingredients: [
      { label: 'moved / tree change', cols: ['movedPerChange'] },
      { label: 'mean shift', cols: ['meanShift'] },
      { label: 'p95 jump', cols: ['p95Jump'] },
      { label: 'moved after 100/500', cols: ['h100Moved', 'h500Moved'] },
    ],
  },
  { key: 'compact', label: 'compactness', ingredients: [{ label: 'compactness', cols: ['compact'] }] },
  { key: 'order', label: 'name order', ingredients: [{ label: 'out of name order', cols: ['disorder'] }] },
];

export function column(key: string): Column {
  const c = COLUMNS.find((c) => c.key === key);
  if (!c) throw new Error(`no column ${key}`);
  return c;
}

/**
 * Normalized rank of each value among `values`: 0 = best, 1 = worst, ties share the
 * average rank. With one value the rank is 0. NaN values (metric unavailable) get NaN
 * and are left out of the ranking.
 */
export function normRanks(values: number[], better: 'low' | 'high'): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const idx = values
    .map((v, i) => [better === 'low' ? v : -v, i] as [number, number])
    .filter((p) => !Number.isNaN(p[0]))
    .sort((a, b) => a[0] - b[0]);
  const n = idx.length;
  if (n === 1) out[idx[0][1]] = 0;
  if (n <= 1) return out;
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
