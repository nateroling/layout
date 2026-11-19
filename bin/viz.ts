#!/usr/bin/env node
// CLI: layout one commit (or a range) of a repo with a given strategy.
//
//   node bin/viz.ts --repo ../fixtures/chalk --strategy recompute --opt order=birth --at '#120' --out out/
//   node bin/viz.ts --repo ../fixtures/chalk --strategy recompute --every 50 --out out/   (a filmstrip)
//   node bin/viz.ts strategies                     (every strategy's options, types and defaults)
//
// --at: HEAD (default), #N = first-parent index N (0-based), anything else = a sha prefix
// (>= 4 hex chars) of a commit on the first-parent timeline. A bare number is a sha prefix.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Runner, describeOption, mergeOptions, optionSchema, parseOptionValue, type Strategy } from '../src/engine.ts';
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
    console.log(`${s.name}${s.usesFuture ? ' (uses future)' : ''}\n  ${s.description}\n  options:`);
    for (const [k, spec] of Object.entries(optionSchema(s)))
      console.log(`    ${describeOption(k, spec).padEnd(46)} ${spec.doc ?? ''}`.trimEnd());
    console.log();
  }
  process.exit(0);
}
if (values.help || !values.repo) {
  console.log(`usage: viz --repo PATH [--strategy NAME] [--opt k=v ...] [--at REF | --every K] [--out DIR] [--format json|svg|both]
       viz strategies        list strategies with their options (type, default)

  --at REF   HEAD (default) | #N  first-parent index N, 0-based (quote it: '#12')
             | SHA  prefix of >= 4 hex chars of a first-parent commit (a bare number is a sha prefix, not an index)
  --opt k=v  repeatable; unknown keys and bad values are rejected (see \`viz strategies\`)`);
  process.exit(values.help ? 0 : 1);
}

/** Print a user error (bad option, unknown strategy, bad --at) without a stack trace. */
function fail(e: unknown): never {
  console.error((e as Error).message);
  process.exit(2);
}

const options: Options = {};
for (const kv of values.opt as string[]) {
  const i = kv.indexOf('=');
  if (i < 0) fail(new Error(`--opt expects k=v, got ${kv}`));
  options[kv.slice(0, i)] = parseOptionValue(kv.slice(i + 1));
}
let strategy: Strategy<any>;
try {
  strategy = getStrategy(values.strategy!);
  mergeOptions(strategy, options); // validate before the (possibly slow) extraction
} catch (e) {
  fail(e);
}

const t0 = Date.now();
const history = loadHistory(values.repo);
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
  if (!/^[1-9]\d*$/.test(values.every)) fail(new Error(`--every expects a positive integer, got ${values.every}`));
  const k = Number(values.every);
  const last = history.commits.length - 1;
  runner.run(write, (i) => i % k === 0 || i === last);
} else {
  let at = 0;
  try {
    at = resolveCommitIndex(history, values.at);
  } catch (e) {
    fail(e);
  }
  write(runner.at(at));
}
console.error(`${history.commits.length} commits, ${Date.now() - t0} ms`);
