#!/usr/bin/env node
// code-map: a stable, spatial map of a git repository, with overlays.
//
//   node codemap.ts map    [repo] [--ref REF] [--overlay FILE] [--out FILE]
//   node codemap.ts pr     [repo] (--pr N | --head REF) [--base REF] [--title T] [--link URL] [--out FILE]
//   node codemap.ts render MAP.json [--overlay FILE] [--out FILE]
//
// --out picks the format from its extension: .html (interactive page, the default), .svg (static
// picture) or .json (the map, plus the overlay for `pr`). Repeat --out for several outputs.
// Common options: --every week|day|commit (checkpoint spacing, default week), --no-cache, --cache DIR,
// --name LABEL, --quiet. Needs Node 22.18+ and git; nothing to install.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { mapAt, type CodeMap, type Every, type LayoutOptions } from './lib/layout.ts';
import { changeMap, defaultBase, fetchPr } from './lib/pr.ts';
import { renderHtml, renderSvg, type Overlay } from './lib/render.ts';

const USAGE = `usage:
  node codemap.ts map    [repo] [--ref REF] [--overlay FILE] [--out FILE]...
  node codemap.ts pr     [repo] (--pr N | --head REF) [--base REF] [--title T] [--link URL] [--out FILE]...
  node codemap.ts render MAP.json [--overlay FILE] [--out FILE]...
options: --every week|day|commit  --no-cache  --cache DIR  --name LABEL  --quiet
--out: .html (default), .svg or .json; repeat for several.`;

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = new Map<string, string[]>();
const pos: string[] = [];
const BOOL = new Set(['--no-cache', '--quiet', '--help']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : BOOL.has(k) ? 'true' : argv[++i];
    if (v === undefined) fail(`${k} needs a value`);
    opts.set(k, [...(opts.get(k) ?? []), v]);
  } else pos.push(a);
}
const one = (k: string) => opts.get(k)?.at(-1);
function fail(msg: string): never {
  console.error(`code-map: ${msg}\n\n${USAGE}`);
  process.exit(2);
}
if (!cmd || cmd === '--help' || cmd === 'help' || opts.has('--help')) {
  console.log(USAGE);
  process.exit(0);
}
const known = new Set(['--ref', '--overlay', '--out', '--pr', '--head', '--base', '--title', '--link', '--every', '--no-cache', '--cache', '--name', '--quiet', '--remote']);
for (const k of opts.keys()) if (!known.has(k)) fail(`unknown option ${k}`);
const every = (one('--every') ?? 'week') as Every;
if (!['week', 'day', 'commit'].includes(every)) fail('--every must be week, day or commit');
const quiet = opts.has('--quiet');
const lopts: LayoutOptions = {
  every,
  cacheDir: opts.has('--no-cache') ? null : one('--cache'),
  name: one('--name'),
  log: quiet ? undefined : (m) => console.error(`code-map: ${m}`),
};
const readOverlay = (): Overlay => (one('--overlay') ? (JSON.parse(readFileSync(resolve(one('--overlay')!), 'utf8')) as Overlay) : {});

function write(map: CodeMap, overlay: Overlay, stem: string, extra?: object) {
  const outs = opts.get('--out') ?? [`${stem}.html`];
  for (const o of outs) {
    const file = resolve(o);
    mkdirSync(dirname(file), { recursive: true });
    const ext = extname(file).toLowerCase();
    if (ext === '.svg') writeFileSync(file, renderSvg(map, overlay));
    else if (ext === '.json') writeFileSync(file, JSON.stringify(extra ? { map, overlay, ...extra } : Object.keys(overlay).length ? { map, overlay } : map));
    else writeFileSync(file, renderHtml(map, overlay));
    console.log(file);
  }
}

try {
  if (cmd === 'map') {
    const repo = resolve(pos[0] ?? '.');
    const map = mapAt(repo, one('--ref') ?? 'HEAD', lopts);
    write(map, readOverlay(), `code-map-${map.repo}-${map.commit.slice(0, 7)}`);
  } else if (cmd === 'pr') {
    const repo = resolve(pos[0] ?? '.');
    const pr = one('--pr');
    let head = one('--head');
    if (pr) {
      if (!/^\d+$/.test(pr)) fail('--pr takes a pull request number');
      head = fetchPr(repo, Number(pr), one('--remote') ?? 'origin');
    }
    if (!head) fail('pr needs --pr N or --head REF');
    const base = one('--base') ?? defaultBase(repo);
    const r = changeMap(repo, base, head, { ...lopts, title: one('--title'), link: one('--link') });
    const extra = readOverlay();
    const overlay: Overlay = { ...r.overlay, ...extra, files: { ...r.overlay.files, ...extra.files }, ghosts: [...(r.overlay.ghosts ?? []), ...(extra.ghosts ?? [])], arcs: [...(r.overlay.arcs ?? []), ...(extra.arcs ?? [])] };
    write(r.map, overlay, `code-map-${r.map.repo}-${pr ? 'pr' + pr : r.head.slice(0, 7)}`, { base: r.base, head: r.head, counts: r.counts });
  } else if (cmd === 'render') {
    if (!pos[0]) fail('render needs a map .json file');
    const raw = JSON.parse(readFileSync(resolve(pos[0]), 'utf8'));
    const map: CodeMap = raw.format ? raw : raw.map;
    if (map?.format !== 'code-map/1') fail(`${pos[0]} is not a code-map/1 file`);
    const base: Overlay = raw.format ? {} : (raw.overlay ?? {});
    const extra = readOverlay();
    const overlay: Overlay = { ...base, ...extra, files: { ...base.files, ...extra.files }, ghosts: [...(base.ghosts ?? []), ...(extra.ghosts ?? [])], arcs: [...(base.arcs ?? []), ...(extra.arcs ?? [])] };
    write(map, overlay, basename(pos[0], extname(pos[0])));
  } else fail(`unknown command ${cmd}`);
} catch (e) {
  const err = e as Error & { stderr?: Buffer | string };
  console.error(`code-map: ${err.message.split('\n')[0]}${err.stderr ? '\n' + String(err.stderr).trim() : ''}`);
  process.exit(1);
}
