#!/usr/bin/env node
// Sweep fixtures x configs -> out/report/{index.html, metrics.json, metrics.csv}.
//
//   node bin/sweep.ts                                  # every fixture in fixtures.json, every config in sweep.json
//   node bin/sweep.ts --fixtures chalk --max-commits 200 --configs "fsn classic,slack"
//   node bin/sweep.ts --jobs 1 --out out/quick
//   node bin/sweep.ts --report-only --fixtures chalk,express --configs "fsn classic,slack"
//
// Each fixture runs in its own child process (at most --jobs at once, default 2),
// which writes out/<report>/parts/<fixture>.json; the parent assembles the report.
// metrics.json / metrics.csv hold no timings or dates (byte-reproducible); those go
// to timings.json.

import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadHistory } from '../src/git/extract.ts';
import { COLUMNS } from '../src/report/columns.ts';
import { HORIZONS } from '../src/metrics/metrics.ts';
import { buildReport } from '../src/report/html.ts';
import { runFixture, type FixtureInfo, type FixtureResult, type SweepConfig } from '../src/report/run.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    configs: { type: 'string' },
    out: { type: 'string', default: 'out/report' },
    'max-commits': { type: 'string' },
    sweep: { type: 'string', default: join(ROOT, 'sweep.json') },
    jobs: { type: 'string', default: '2' },
    'no-svg': { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false }, // rebuild the report from existing parts/*.json
    worker: { type: 'string' }, // internal: run one fixture and write its part file
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`usage: sweep [--fixtures a,b] [--configs "label1,label2"] [--out DIR] [--max-commits N] [--jobs N] [--sweep FILE] [--no-svg] [--report-only]`);
  process.exit(0);
}

interface SweepFile {
  fixtures?: string[] | null;
  configs: SweepConfig[];
  playerFrames?: number;
  filmFrames?: number;
  budgetMB?: number;
}

const sweep = JSON.parse(readFileSync(values.sweep!, 'utf8')) as SweepFile;
const outDir = resolve(values.out!);
const partsDir = join(outDir, 'parts');
const maxCommits = values['max-commits'] ? Number(values['max-commits']) : Infinity;
const list = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);

function loadFixtures(): FixtureInfo[] {
  const file = join(ROOT, 'fixtures.json');
  let all: FixtureInfo[];
  if (existsSync(file)) all = JSON.parse(readFileSync(file, 'utf8')) as FixtureInfo[];
  else {
    console.warn('fixtures.json not found; falling back to ../fixtures/chalk');
    all = [{ name: 'chalk', path: '../fixtures/chalk' }];
  }
  const want = list(values.fixtures) ?? sweep.fixtures ?? null;
  if (want) {
    const missing = want.filter((w) => !all.some((f) => f.name === w));
    for (const m of missing) console.warn(`unknown fixture "${m}" (not in fixtures.json)`);
    all = all.filter((f) => want.includes(f.name));
  }
  return all;
}

function selectConfigs(): SweepConfig[] {
  const want = list(values.configs);
  if (!want) return sweep.configs;
  for (const w of want) if (!sweep.configs.some((c) => c.label === w)) console.warn(`unknown config "${w}"`);
  return sweep.configs.filter((c) => want.includes(c.label));
}

// ---------------- worker ----------------

function runWorker(name: string): void {
  const fx = loadFixtures().find((f) => f.name === name);
  if (!fx) throw new Error(`fixture ${name} not found`);
  const path = resolve(ROOT, fx.path);
  if (!existsSync(path)) {
    console.warn(`[${name}] path ${path} does not exist; skipping`);
    process.exit(3);
  }
  const t0 = Date.now();
  const full = loadHistory(path, { ref: fx.ref ?? undefined, cacheDir: join(ROOT, '.cache') });
  const history = full.commits.length > maxCommits ? { ...full, commits: full.commits.slice(0, maxCommits) } : full;
  console.error(`[${name}] history: ${full.commits.length} commits (using ${history.commits.length}), ${Date.now() - t0} ms`);
  const res = runFixture({ ...fx, commits: full.commits.length }, history, selectConfigs(), {
    playerFrames: sweep.playerFrames ?? 150,
    filmFrames: sweep.filmFrames ?? 8,
    svgDir: values['no-svg'] ? undefined : join(outDir, 'svg'),
    log: (s) => console.error(`[${name}] ${s.trim()}`),
  });
  mkdirSync(partsDir, { recursive: true });
  writeFileSync(join(partsDir, `${name}.json`), JSON.stringify(res));
  console.error(`[${name}] done in ${(res.ms / 1000).toFixed(1)} s`);
}

// ---------------- parent ----------------

function childArgs(name: string): string[] {
  const a = ['--worker', name, '--out', outDir, '--sweep', values.sweep!];
  if (values.fixtures) a.push('--fixtures', values.fixtures);
  if (values.configs) a.push('--configs', values.configs);
  if (values['max-commits']) a.push('--max-commits', values['max-commits']);
  if (values['no-svg']) a.push('--no-svg');
  return a;
}

function runChild(name: string): Promise<boolean> {
  return new Promise((done) => {
    const cp = fork(fileURLToPath(import.meta.url), childArgs(name), {
      execArgv: [...process.execArgv, '--max-old-space-size=2800'],
      stdio: 'inherit',
    });
    cp.on('exit', (code) => {
      if (code !== 0) console.warn(`[${name}] worker exited with code ${code}`);
      done(code === 0);
    });
  });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const fixtures = loadFixtures();
  if (!fixtures.length) throw new Error('no fixtures selected');
  const configs = selectConfigs();
  console.error(`sweep: ${fixtures.length} fixtures × ${configs.length} configs → ${outDir}`);
  mkdirSync(partsDir, { recursive: true });

  const jobs = Math.max(1, Number(values.jobs) || 2);
  const queue = [...fixtures];
  const ok = new Set<string>();
  if (values['report-only']) {
    for (const f of fixtures) if (existsSync(join(partsDir, `${f.name}.json`))) ok.add(f.name);
    queue.length = 0;
  }
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let fx = queue.shift(); fx; fx = queue.shift()) if (await runChild(fx.name)) ok.add(fx.name);
    }),
  );

  let results: FixtureResult[] = fixtures
    .filter((f) => ok.has(f.name))
    .map((f) => JSON.parse(readFileSync(join(partsDir, `${f.name}.json`), 'utf8')) as FixtureResult);
  if (values['report-only']) results = filterParts(results, fixtures);
  if (!results.length) throw new Error('no fixture produced results');

  const command = `node bin/sweep.ts ${process.argv.slice(2).join(' ')}`.trim();
  const rep = buildReport(results, { budgetBytes: (sweep.budgetMB ?? 15) * 1e6, generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', command });
  writeFileSync(join(outDir, 'index.html'), rep.html);
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(metricsJson(results, rep.levels), null, 1));
  writeFileSync(join(outDir, 'metrics.csv'), metricsCsv(results));
  writeFileSync(join(outDir, 'timings.json'), JSON.stringify(timingsJson(results), null, 1));
  for (const n of rep.notes) console.error(`note: ${n}`);
  console.error(
    `report: ${join(outDir, 'index.html')} ${(rep.bytes.total / 1e6).toFixed(2)} MB (player data ${(rep.bytes.player / 1e6).toFixed(2)} MB, inline filmstrips ${(rep.bytes.film / 1e6).toFixed(2)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}

/**
 * --report-only: keep only the parts and configs asked for. Missing parts or configs are an
 * error (a silent partial report would look like a complete one).
 */
function filterParts(results: FixtureResult[], fixtures: FixtureInfo[]): FixtureResult[] {
  const missingParts = fixtures.filter((f) => !results.some((r) => r.name === f.name)).map((f) => f.name);
  if (missingParts.length && values.fixtures) throw new Error(`--report-only: no part file for ${missingParts.join(', ')} in ${partsDir}; run the sweep for them first`);
  for (const m of missingParts) console.warn(`--report-only: no part file for ${m}; left out`);
  const want = list(values.configs);
  if (!want) return results;
  const unknown = want.filter((w) => !sweep.configs.some((c) => c.label === w));
  if (unknown.length) throw new Error(`--report-only: unknown config(s) ${unknown.map((u) => `"${u}"`).join(', ')} (not in ${values.sweep})`);
  return results.map((r) => {
    const absent = want.filter((w) => !r.configs.some((c) => c.label === w) && !r.skipped.some((s) => s.label === w));
    if (absent.length) throw new Error(`--report-only: part ${r.name} has no results for ${absent.map((a) => `"${a}"`).join(', ')}; rerun the sweep for it`);
    return { ...r, configs: r.configs.filter((c) => want.includes(c.label)), skipped: r.skipped.filter((s) => want.includes(s.label)) };
  });
}

function timingsJson(results: FixtureResult[]) {
  return {
    generated: new Date().toISOString(),
    fixtures: results.map((f) => ({ name: f.name, ms: f.ms, configs: f.configs.map((c) => ({ label: c.label, ms: c.ms })) })),
  };
}

function metricsJson(results: FixtureResult[], levels: Record<string, number>) {
  return {
    horizons: HORIZONS,
    fixtures: results.map((f) => ({
      name: f.name, kind: f.kind, head: f.head, totalCommits: f.totalCommits, used: f.used, skipped: f.skipped,
      configs: f.configs.map((c) => ({
        label: c.label, strategy: c.strategy, options: c.options, playerLevel: levels[`${f.name}/${c.label}`] ?? 0,
        playerFrames: c.players.map((p) => p.frames.length), summary: c.summary,
      })),
    })),
  };
}

function metricsCsv(results: FixtureResult[]): string {
  const extra: [string, (s: FixtureResult['configs'][number]['summary']) => number][] = [
    ['transitions', (s) => s.transitions],
    ['files_meanStepMean', (s) => s.files.meanStepMean],
    ['dirs_meanStepMean', (s) => s.dirs.meanStepMean],
    ['all_p95', (s) => s.all.p95],
    ['files_p95Moved', (s) => s.files.p95Moved],
    ['dirs_p95Moved', (s) => s.dirs.p95Moved],
    ['files_max', (s) => s.files.max],
    ['dirs_max', (s) => s.dirs.max],
    ['all_disruption', (s) => s.all.disruption],
    ['quiet_steps', (s) => s.quiet.steps],
    ['quiet_movedAnyway', (s) => s.quiet.movedAnyway],
    ['bbox_w', (s) => s.bbox.w],
    ['bbox_h', (s) => s.bbox.h],
    ['order_finalDisorder', (s) => s.order.finalDisorder],
    ['ghost_meanFileFrac', (s) => s.ghost.meanFileFrac],
    ['finalLiveFiles', (s) => s.finalLiveFiles],
    ...HORIZONS.map((k): [string, (s: FixtureResult['configs'][number]['summary']) => number] => [`h${k}_pairs`, (s) => s.horizon?.find((h) => h.k === k)?.pairs ?? NaN]),
  ];
  const n = (v: number) => (Number.isNaN(v) ? '' : String(+v.toPrecision(6)));
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ['fixture', 'kind', 'config', 'strategy', 'options', ...COLUMNS.map((c) => c.key), ...extra.map((e) => e[0])];
  const rows = [head.join(',')];
  for (const f of results)
    for (const c of f.configs)
      rows.push(
        [f.name, f.kind ?? '', c.label, c.strategy, JSON.stringify(c.options), ...COLUMNS.map((k) => n(k.get(c.summary))), ...extra.map((e) => n(e[1](c.summary)))]
          .map(q)
          .join(','),
      );
  return rows.join('\n') + '\n';
}

if (values.worker) runWorker(values.worker);
else main().catch((e) => {
  console.error(e);
  process.exit(1);
});
