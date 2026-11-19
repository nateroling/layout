#!/usr/bin/env node
// Export every commit of one repo under one strategy as compact deltas for the 3D viewer
// (out/city3d/index.html). Default: ripgrep, metro.
//
//   node bin/city3d.ts [--fixture ripgrep] [--strategy metro] [--opt k=v ...] [--out out/city3d]
//
// Data format (JSON, embedded in the page):
//   keys:    [kind ('d'|'f'), ...] one per node identity (dirs by path, files by rename-following cid)
//   strings: path table
//   commits: [time, sha7, subject] per commit
//   frames:  per commit [updates, removals]; an update is the flat tuple
//            key, x, y, w, h, pathIdx, size, modified  (x..h in tenths of a layout unit)
// A node is only written when one of those values changed since the previous commit.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Runner, parseOptionValue } from '../src/engine.ts';
import { loadHistory } from '../src/git/extract.ts';
import { getStrategy } from '../src/strategies/index.ts';
import type { Options } from '../src/types.ts';

const { values } = parseArgs({
  options: {
    fixture: { type: 'string', default: 'ripgrep' },
    strategy: { type: 'string', default: 'metro' },
    opt: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: 'out/city3d' },
  },
});

const root = join(import.meta.dirname, '..');
const fixtures = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8')) as { name: string; path: string; ref?: string | null }[];
const fx = fixtures.find((f) => f.name === values.fixture);
if (!fx) throw new Error(`unknown fixture ${values.fixture}`);
const history = loadHistory(join(root, fx.path), { ref: fx.ref ?? undefined, name: fx.name });
const options: Options = {};
for (const kv of values.opt as string[]) {
  const i = kv.indexOf('=');
  options[kv.slice(0, i)] = parseOptionValue(kv.slice(i + 1));
}
const strategy = getStrategy(values.strategy!);
const runner = new Runner(history, strategy, options, 1e9);

const keyOf = new Map<string, number>();
const keys: string[] = [];
const strIdx = new Map<string, number>();
const strings: string[] = [];
const str = (s: string) => {
  let i = strIdx.get(s);
  if (i === undefined) strIdx.set(s, (i = strings.push(s) - 1));
  return i;
};
const q = (v: number) => Math.round(v * 10);
let prev = new Map<number, string>();
const frames: [number[], number[]][] = [];
let maxSize = 0;
let bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

runner.run((f) => {
  const cur = new Map<number, string>();
  const upd: number[] = [];
  for (const n of f.nodes) {
    if (n.ghost) continue;
    const id = n.kind === 'dir' ? n.id : (n.cid ?? n.id);
    let k = keyOf.get(id);
    if (k === undefined) {
      keyOf.set(id, (k = keys.length));
      keys.push(n.kind === 'dir' ? 'd' : 'f');
    }
    const rec = [k, q(n.x), q(n.y), q(n.w), q(n.h), str(n.path), n.size ?? 0, n.modified ?? 0];
    const sig = rec.join(',');
    cur.set(k, sig);
    if (prev.get(k) !== sig) upd.push(...rec);
    if (n.kind === 'file') maxSize = Math.max(maxSize, n.size ?? 0);
    bbox = { x0: Math.min(bbox.x0, n.x), y0: Math.min(bbox.y0, n.y), x1: Math.max(bbox.x1, n.x + n.w), y1: Math.max(bbox.y1, n.y + n.h) };
  }
  const rem: number[] = [];
  for (const k of prev.keys()) if (!cur.has(k)) rem.push(k);
  frames.push([upd, rem]);
  prev = cur;
});

const data = {
  repo: fx.name,
  head: history.head,
  strategy: strategy.name,
  options,
  maxSize,
  bbox,
  keys: keys.join(''),
  strings,
  commits: history.commits.map((c) => [c.time, c.sha.slice(0, 7), c.subject.length > 100 ? c.subject.slice(0, 99) + '…' : c.subject]),
  frames,
};
mkdirSync(values.out!, { recursive: true });
const json = JSON.stringify(data);
const tpl = readFileSync(join(root, 'src/render/city3d.html'), 'utf8');
// index.html: self-contained (open from disk). page/: the page plus data.json beside it (artifact).
writeFileSync(join(values.out!, 'index.html'), tpl.replace('/*DATA*/null', () => json.replace(/<\//g, '<\\/')));
mkdirSync(join(values.out!, 'page'), { recursive: true });
writeFileSync(join(values.out!, 'page', 'index.html'), tpl);
writeFileSync(join(values.out!, 'page', 'data.json'), json);
console.log(`${fx.name} · ${strategy.name}: ${history.commits.length} commits, ${keys.length} nodes, data ${(json.length / 1024).toFixed(0)} KB, max file ${maxSize} B`);
