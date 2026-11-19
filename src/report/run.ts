// Run every config over one fixture: one Runner.run per config feeding the
// metrics accumulator, plus sampled frames for a filmstrip (SVG) and the player
// (compact deltas at several resolutions so the report can trade frames for size).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Runner, mergeOptions } from '../engine.ts';
import { MetricsAccumulator, type RunSummary } from '../metrics/metrics.ts';
import { MOVE_TIERS, moveDistances, renderSvg, unionViewport, type Rect } from '../render/svg.ts';
import { strategies } from '../strategies/index.ts';
import type { Frame, History, Options } from '../types.ts';
import { PlayerEncoder, StringTable, type PlayerData } from './encode.ts';

export interface SweepConfig {
  label: string;
  strategy: string;
  options?: Options;
}

export interface FixtureInfo {
  name: string;
  path: string;
  kind?: string;
  ref?: string | null;
  commits?: number;
  note?: string;
}

export interface FilmFrame {
  meta: number; // index into FixtureResult.metas
  moved: number; // nodes moved since the previous filmstrip frame
  far: number; // of those, moved >= the top MOVE_TIERS threshold
  liveFiles: number;
  svg: string; // inline SVG (no caption)
}

export interface ConfigResult {
  label: string;
  strategy: string;
  options: Options;
  ms: number;
  summary: RunSummary;
  film: { viewport: Rect; frames: FilmFrame[]; bytes: number };
  players: PlayerData[]; // resolution levels: [all samples, every 2nd, every 4th, every 8th]
  playerViewport: Rect;
}

export interface FixtureResult {
  name: string;
  kind?: string;
  note?: string;
  repo: string;
  head: string;
  totalCommits: number; // in the history
  used: number; // after --max-commits
  metas: [number, number, string, string][]; // [commit index, time, sha7, subject] for every player sample
  strings: string[];
  configs: ConfigResult[];
  skipped: { label: string; reason: string }[];
  ms: number;
}

export interface RunOptions {
  playerFrames: number;
  filmFrames: number;
  svgDir?: string; // also write captioned standalone SVGs here
  log?: (s: string) => void;
}

export const LEVELS = 4;

export function evenly(n: number, k: number): number[] {
  if (n <= 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < k; i++) out.add(Math.round((i * (n - 1)) / (k - 1)));
  return [...out].sort((a, b) => a - b);
}

export function runFixture(fx: FixtureInfo, history: History, configs: SweepConfig[], o: RunOptions): FixtureResult {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const n = history.commits.length;
  const samples = evenly(n, o.playerFrames); // commit indices
  const filmPos = evenly(samples.length, o.filmFrames).map((p) => samples[p]);
  const filmSet = new Set(filmPos);
  const samplePos = new Map(samples.map((c, i) => [c, i]));
  const metas: FixtureResult['metas'] = samples.map((c) => {
    const k = history.commits[c];
    return [c, k.time, k.sha.slice(0, 7), k.subject.length > 120 ? k.subject.slice(0, 119) + '…' : k.subject];
  });
  const strings = new StringTable();
  const res: FixtureResult = {
    name: fx.name, kind: fx.kind, note: fx.note, repo: history.repo, head: history.head,
    totalCommits: fx.commits ?? n, used: n, metas, strings: strings.list, configs: [], skipped: [], ms: 0,
  };

  for (const cfg of configs) {
    const strategy = strategies[cfg.strategy];
    if (!strategy) {
      res.skipped.push({ label: cfg.label, reason: `strategy "${cfg.strategy}" not registered` });
      log(`  skip ${cfg.label}: strategy "${cfg.strategy}" not registered`);
      continue;
    }
    const t1 = Date.now();
    const options = mergeOptions(strategy, cfg.options ?? {});
    const cell = typeof options.cell === 'number' ? options.cell : 1;
    const acc = new MetricsAccumulator({ cell, totalFrames: n, buckets: 120 });
    const encoders = Array.from({ length: LEVELS }, () => new PlayerEncoder(strings));
    const film: Frame[] = [];
    const bboxes: Rect[] = [];
    const runner = new Runner(history, strategy, cfg.options ?? {}, 1e9); // no checkpoints needed
    try {
      runner.run((f) => {
        acc.push(f);
        const pos = samplePos.get(f.commit);
        if (pos === undefined) return;
        bboxes.push(f.bbox);
        for (let L = 0; L < LEVELS; L++) {
          const step = 1 << L;
          if (pos % step === 0 || pos === samples.length - 1) encoders[L].add(f, pos);
        }
        if (filmSet.has(f.commit)) film.push(f);
      });
    } catch (e) {
      res.skipped.push({ label: cfg.label, reason: `error: ${(e as Error).message}` });
      log(`  FAIL ${cfg.label}: ${(e as Error).stack}`);
      continue;
    }
    const viewport = unionViewport(film.map((f) => f.bbox));
    const playerViewport = unionViewport(bboxes);
    const frames: FilmFrame[] = [];
    let prev: Frame | null = null;
    for (const f of film) {
      const moved = moveDistances(prev, f);
      const svg = renderSvg(f, { viewport, moved, width: null, titles: false, totalCommits: n });
      let far = 0;
      for (const d of moved.values()) if (d >= MOVE_TIERS[MOVE_TIERS.length - 1]) far++;
      frames.push({ meta: samplePos.get(f.commit)!, moved: moved.size, far, liveFiles: f.nodes.filter((x) => x.kind === 'file' && !x.ghost).length, svg });
      if (o.svgDir) {
        const dir = join(o.svgDir, fx.name);
        mkdirSync(dir, { recursive: true });
        const c = history.commits[f.commit];
        const file = join(dir, `${slug(cfg.label)}-${String(f.commit).padStart(6, '0')}.svg`);
        writeFileSync(file, renderSvg(f, {
          viewport, moved, scale: 8, maxPx: 3000, totalCommits: n,
          caption: { label: `${fx.name} · ${cfg.label}`, index: f.commit, total: n, time: c.time, sha: c.sha, subject: c.subject },
        }));
      }
      prev = f;
    }
    const players = encoders.map((e) => e.finish());
    const summary = acc.summary();
    const ms = Date.now() - t1;
    res.configs.push({
      label: cfg.label, strategy: cfg.strategy, options, ms, summary,
      film: { viewport, frames, bytes: frames.reduce((s, f) => s + f.svg.length, 0) },
      players, playerViewport,
    });
    log(`  ${fx.name} · ${cfg.label}: ${ms} ms, moved/step ${(summary.all.meanMovedFrac * 100).toFixed(1)}%, compact ${summary.compactness.mean.toFixed(3)}, player ${(players[0].data.length / 1024).toFixed(0)} KB`);
  }
  res.ms = Date.now() - t0;
  return res;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}
