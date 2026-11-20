// Demo: the four-folder case (a/ 1 file, b/ c/ d/ 16 files) one level down, in sub/, drawn from
// the real layout output, one panel per strategy.
//   node scripts/demo-nested.ts                 # sub/ is the root's 1st folder (right of the root lot)
//   node scripts/demo-nested.ts --scene upleft  # five 1-file folders first, so sub/ lands up-left
// Writes out/demo-nested-<scene>.svg.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Runner } from '../src/engine.ts';
import { strategies } from '../src/strategies/index.ts';
import type { Change, Commit, History, LayoutNode } from '../src/types.ts';

const { values } = parseArgs({ options: { scene: { type: 'string', default: 'right' }, strategies: { type: 'string' } } });
const scene = values.scene!;
const names = (values.strategies ?? (scene === 'upleft' ? 'metro,metro-spiral,metro-spiral-flip' : 'metro,metro-spiral')).split(',');

const add = (path: string): Change => ({ type: 'A', path, size: 10 });
const four = [add('sub/a/f0.ts')];
for (const d of ['b', 'c', 'd']) for (let i = 0; i < 16; i++) four.push(add(`sub/${d}/f${i}.ts`));
const steps = scene === 'upleft' ? [['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => add(`${p}/x.ts`)), four] : [four];
const commits: Commit[] = steps.map((changes, index) => ({ index, sha: String(index).padStart(40, '0'), time: index, author: 'demo', subject: 'demo', changes }));
const history: History = { repo: 'demo', head: commits.at(-1)!.sha, commits };

const colour: Record<string, string> = { 'sub/a': '#4cc38a', 'sub/b': '#3e9bd6', 'sub/c': '#c084fc', 'sub/d': '#f59e0b' };
const W = 1600, H = 900;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x: number, y: number, s: string, size: number, fill: string, weight = 400, anchor = 'start') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;
const blurb: Record<string, string> = {
  metro: 'metro: subfolders use the mirrored city rule',
  'metro-spiral': 'metro-spiral: the root\'s spiral, unmirrored',
  'metro-spiral-flip': 'metro-spiral-flip: the spiral, mirrored away',
};

const frames = names.map((n) => new Runner(history, strategies[n]).at(history.commits.length - 1));
const pw = (W - 48) / names.length;
const maxW = Math.max(...frames.map((f) => f.bbox.w)), maxH = Math.max(...frames.map((f) => f.bbox.h));
const S = Math.floor(Math.min((pw - 40) / maxW, 560 / maxH)); // px per layout unit, same in every panel

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica,Arial,sans-serif">`;
svg += `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#e5484d" stroke-width="2.5" opacity="0.35"/></pattern></defs>`;
svg += `<rect width="100%" height="100%" fill="#0b1016"/>`;
svg += text(24, 40, `The four-folder case in a subfolder: root/ → sub/ → a/ (1), b/ (16), c/ (16), d/ (16)${scene === 'upleft' ? ', with sub/ up-left of the root' : ''}`, 22, '#e6edf3', 700);
svg += text(24, 68, 'actual layout output · 1 grid unit = 1 file cell · gap = 1 · padding = 0.5 · hatched = empty · dashed = a folder\'s (empty) file lot' + (scene === 'upleft' ? ' · grey = p1–p5, one file each' : ''), 14, '#8b9bb0');

frames.forEach((f, i) => {
  const px = 24 + i * pw;
  const root = f.nodes.find((n) => n.path === '' && n.kind === 'dir')!;
  const sub = f.nodes.find((n) => n.path === 'sub' && n.kind === 'dir')!;
  const ox = px + 10 - root.x * S, oy = 160 - root.y * S;
  const X = (v: number) => ox + v * S, Y = (v: number) => oy + v * S;
  const rect = (x: number, y: number, w: number, h: number, fill: string, stroke = 'none', sw = 0, extra = '') =>
    `<rect x="${X(x)}" y="${Y(y)}" width="${w * S}" height="${h * S}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${extra}/>`;
  const box = (n: LayoutNode, fill: string, stroke = 'none', sw = 0) => rect(n.x, n.y, n.w, n.h, fill, stroke, sw, n.kind === 'file' ? ' rx="2"' : '');
  svg += text(px + 10, 112, blurb[names[i]] ?? names[i], 16, '#e6edf3', 700);
  svg += box(root, '#16212d', '#4f6a85', 1.5) + box(root, 'url(#hatch)');
  for (const n of f.nodes) {
    if (n.kind !== 'dir' || n.path === '') continue;
    const inSub = n.path.startsWith('sub/');
    svg += box(n, n.path === 'sub' ? '#16212d' : '#1e3045', n.path === 'sub' ? '#e6edf3' : '#a9c7ff', n.path === 'sub' ? 2 : 1.5);
    if (n.path === 'sub') svg += box(n, 'url(#hatch)');
    if (n.path === 'sub') svg += text(X(n.x) + 3, Y(n.y) - 4, 'sub/', 12, '#e6edf3', 700);
    else if (inSub) svg += text(X(n.x) + 2, Y(n.y) + 10, n.path.slice(4) + '/', 10, '#a9c7ff', 700);
  }
  for (const n of f.nodes) if (n.kind === 'file') svg += box(n, colour[n.path.split('/').slice(0, 2).join('/')] ?? '#6b7a8c');
  const lot = (x: number, y: number) =>
    rect(x, y, 1, 1, 'none', '#f5c451', 1.5, ' stroke-dasharray="4 3"') + text(X(x + 0.5), Y(y + 0.5) + 3, 'lot', 8, '#f5c451', 400, 'middle');
  svg += lot(0, 0); // the root's lot is pinned at the origin
  const sl = subLot(f.nodes, sub);
  svg += lot(sl.x, sl.y);
  const files = f.nodes.filter((n) => n.kind === 'file' && n.path.startsWith('sub/')).length;
  const base = Y(root.y + maxH) + 30;
  svg += text(px + 10, base, `sub/ ${sub.w} × ${sub.h} = ${sub.w * sub.h} cells; ${files} files → ${Math.round((100 * files) / (sub.w * sub.h))}%`, 14, '#e6edf3', 700);
  svg += text(px + 10, base + 22, `whole city ${root.w} × ${root.h}`, 13, '#8b9bb0');
});
svg += text(24, H - 56, scene === 'upleft'
  ? 'sub/ sits up-left of the root lot, so it should grow up and left. metro does (its mirrored grid); metro-spiral\'s unmirrored spiral sends a/ right and b/ c/ d/ down, back toward the root;'
  : 'At the root, metro and metro-spiral give the same 18 × 9 block. One level down, metro switches to its mirrored city rule, so the same four folders take 18 × 12;', 14, '#8b9bb0');
svg += text(24, H - 34, scene === 'upleft'
  ? 'metro-spiral-flip mirrors the spiral, so a/ goes left and b/ c/ d/ go up: away from the root, with sub/\'s lot in its corner nearest the root.'
  : 'metro-spiral reuses the root\'s spiral, so sub/ comes out exactly like the root did.', 14, '#8b9bb0');
svg += '</svg>';

/**
 * sub/ has no files, so its lot is one empty cell at column 0, row 0 of its grid. In every
 * strategy here a/ (cell 1) shares row 0 and c/ (cell 3) column 0, and both hug the side of their
 * cell facing the root, as the lot does; sub/'s orientation is the side of the root it is on.
 */
function subLot(nodes: LayoutNode[], sub: LayoutNode) {
  const a = nodes.find((n) => n.path === 'sub/a')!, c = nodes.find((n) => n.path === 'sub/c')!;
  const ox = sub.x + sub.w / 2 < 0 ? -1 : 1, oy = sub.y + sub.h / 2 < 0 ? -1 : 1;
  return { x: ox < 0 ? c.x + c.w - 1 : c.x, y: oy < 0 ? a.y + a.h - 1 : a.y };
}

mkdirSync('out', { recursive: true });
writeFileSync(`out/demo-nested-${scene}.svg`, svg);
console.log(`wrote out/demo-nested-${scene}.svg`);
