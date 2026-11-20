// Demo: the four-folder case (a/ 1 file, b/ c/ d/ 16 files) one level down, in sub/, drawn from
// the real layout output of metro and metro-spiral side by side. Writes out/demo-nested.svg.
//   node scripts/demo-nested.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { Runner } from '../src/engine.ts';
import { strategies } from '../src/strategies/index.ts';
import type { Change, History, LayoutNode } from '../src/types.ts';

const add = (path: string): Change => ({ type: 'A', path, size: 10 });
const changes = [add('sub/a/f0.ts')];
for (const d of ['b', 'c', 'd']) for (let i = 0; i < 16; i++) changes.push(add(`sub/${d}/f${i}.ts`));
const history: History = { repo: 'demo', head: '0'.repeat(40), commits: [{ index: 0, sha: '0'.repeat(40), time: 0, author: 'demo', subject: 'demo', changes }] };

const colour: Record<string, string> = { 'sub/a': '#4cc38a', 'sub/b': '#3e9bd6', 'sub/c': '#c084fc', 'sub/d': '#f59e0b' };
const S = 34; // px per layout unit
const W = 1600, H = 900;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x: number, y: number, s: string, size: number, fill: string, weight = 400, anchor = 'start') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica,Arial,sans-serif">`;
svg += `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#e5484d" stroke-width="2.5" opacity="0.35"/></pattern></defs>`;
svg += `<rect width="100%" height="100%" fill="#0b1016"/>`;
svg += text(24, 40, 'The four-folder case one level down: root/ → sub/ → a/ (1), b/ (16), c/ (16), d/ (16)', 24, '#e6edf3', 700);
svg += text(24, 70, 'actual layout output · 1 grid unit = 1 file cell · gap = 1 · padding = 0.5 · hatched = empty · dashed = sub/\'s (empty) file lot', 15, '#8b9bb0');

const panels: [string, string, number][] = [
  ['metro', 'metro: subfolders use the mirrored "city" rule', 40],
  ['metro-spiral', 'metro-spiral: subfolders spiral like the root', 830],
];
for (const [name, title, px] of panels) {
  const f = new Runner(history, strategies[name]).at(0);
  const sub = f.nodes.find((n) => n.path === 'sub' && n.kind === 'dir')!;
  const ox = px + 20 - sub.x * S, oy = 170 - sub.y * S;
  const X = (v: number) => ox + v * S, Y = (v: number) => oy + v * S;
  const box = (n: LayoutNode, fill: string, stroke: string, sw: number, dash = '') =>
    `<rect x="${X(n.x)}" y="${Y(n.y)}" width="${n.w * S}" height="${n.h * S}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''} rx="${n.kind === 'file' ? 4 : 0}"/>`;
  svg += text(px + 20, 130, title, 19, '#e6edf3', 700);
  svg += box(sub, '#16212d', '#4f6a85', 2) + box(sub, 'url(#hatch)', 'none', 0);
  svg += text(X(sub.x) + 6, Y(sub.y) - 8, 'sub/', 16, '#a9c7ff', 700);
  const kids = f.nodes.filter((n) => n.parent === 'd:sub');
  for (const k of kids) {
    svg += box(k, '#1e3045', '#a9c7ff', 2);
    svg += text(X(k.x) + 5, Y(k.y) - 6, k.path.slice(4) + '/', 16, '#a9c7ff', 700);
    for (const fl of f.nodes.filter((n) => n.parent === k.id)) svg += box(fl, colour[k.path], 'none', 0);
  }
  const lot = lotOf(f.nodes, sub);
  svg += `<rect x="${X(lot.x)}" y="${Y(lot.y)}" width="${S}" height="${S}" fill="none" stroke="#f5c451" stroke-width="2" stroke-dasharray="5 4"/>`;
  svg += text(X(lot.x) + S / 2, Y(lot.y) + S / 2 + 4, 'lot', 11, '#f5c451', 400, 'middle');
  const files = f.nodes.filter((n) => n.kind === 'file').length;
  const area = sub.w * sub.h;
  svg += text(px + 20, Y(sub.y + sub.h) + 40, `sub/ is ${sub.w} × ${sub.h} = ${area} cells; ${files} files → ${Math.round((100 * files) / area)}% of the box is files.`, 16, '#e6edf3', 700);
  const where = kids.map((k) => `${k.path.slice(4)}/ at (${k.x - sub.x}, ${k.y - sub.y})`).join(' · ');
  svg += text(px + 20, Y(sub.y + sub.h) + 66, where + '  (offset inside sub/)', 13, '#8b9bb0');
}
svg += text(24, H - 60, 'At the root both strategies give the same 18 × 9 block. One level down, metro switches to its mirrored city rule (square-shell order, growing right and down), so the same four folders take 18 × 12;', 15, '#8b9bb0');
svg += text(24, H - 36, 'metro-spiral reuses the root\'s spiral, so sub/ comes out exactly like the root did: same cells, same 18 × 9 block.', 15, '#8b9bb0');
svg += '</svg>';

/**
 * sub/ has no files, so its lot is one empty cell at column 0, row 0 of sub/'s grid. In both
 * strategies c/ (cell 3) sits at column 0, row 1, directly below the lot, and sub/ grows right,
 * so the lot shares c/'s left edge and sits at the top, inset by the padding.
 */
function lotOf(nodes: LayoutNode[], sub: LayoutNode) {
  const c = nodes.find((n) => n.path === 'sub/c' && n.kind === 'dir')!;
  return { x: c.x, y: sub.y + 0.5 };
}

mkdirSync('out', { recursive: true });
writeFileSync('out/demo-nested.svg', svg);
console.log('wrote out/demo-nested.svg');
