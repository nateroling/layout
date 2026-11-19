#!/usr/bin/env node
// CLI: layout one commit (or a range) of a repo with a given strategy.
//
//   node bin/viz.ts --repo ../fixtures/chalk --strategy recompute --opt order=birth --at '#120' --out out/
//   node bin/viz.ts --repo ../fixtures/chalk --strategy recompute --every 50 --out out/   (a filmstrip)
//   node bin/viz.ts strategies

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Runner, mergeOptions, parseOptionValue } from '../src/engine.ts';
import { loadHistory, resolveCommitIndex } from '../src/git/extract.ts';
import { renderSvg } from '../src/render/svg.ts';
import { getStrategy, strategies } from '../src/strategies/index.ts';
import type { Frame, Options } from '../src/types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    strategy: { type: 'string', default: 'recompute' },
    opt: { type: 'string', multiple: true, default: [] },
    at: { type: 'string' },
    every: { type: 'string' },
    out: { type: 'string', default: 'out' },
    format: { type: 'string', default: 'both' }, // json | svg | both
    help: { type: 'boolean', short: 'h' },
  },
});

if (positionals[0] === 'strategies') {
  for (const s of Object.values(strategies)) {
    console.log(`${s.name}${s.usesFuture ? ' (hindsight)' : ''}\n  ${s.description}\n  defaults: ${JSON.stringify(mergeOptions(s))}`);
  }
  process.exit(0);
}
if (values.help || !values.repo) {
  console.log('usage: viz --repo PATH [--strategy NAME] [--opt k=v ...] [--at SHA|#N|HEAD | --every K] [--out DIR] [--format json|svg|both]\n       viz strategies');
  process.exit(values.help ? 0 : 1);
}

const options: Options = {};
for (const kv of values.opt as string[]) {
  const i = kv.indexOf('=');
  if (i < 0) throw new Error(`--opt expects k=v, got ${kv}`);
  options[kv.slice(0, i)] = parseOptionValue(kv.slice(i + 1));
}

const t0 = Date.now();
const history = loadHistory(values.repo);
const strategy = getStrategy(values.strategy!);
const runner = new Runner(history, strategy, options);
mkdirSync(values.out!, { recursive: true });

const write = (f: Frame) => {
  const base = join(values.out!, `${history.repo}-${strategy.name}-${String(f.commit).padStart(6, '0')}`);
  if (values.format !== 'svg') writeFileSync(base + '.json', JSON.stringify(f));
  if (values.format !== 'json')
    writeFileSync(
      base + '.svg',
      renderSvg(f, { title: `${history.repo} · ${strategy.name} · #${f.commit} ${f.sha.slice(0, 8)}`, totalCommits: history.commits.length }),
    );
  console.log(`${base}  (${f.nodes.length} nodes)`);
};

if (values.every) {
  const k = Math.max(1, Number(values.every));
  const last = history.commits.length - 1;
  runner.run(write, (i) => i % k === 0 || i === last);
} else {
  write(runner.at(resolveCommitIndex(history, values.at)));
}
console.error(`${history.commits.length} commits, ${Date.now() - t0} ms`);
