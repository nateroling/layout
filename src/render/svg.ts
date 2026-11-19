// Top-down SVG of one Frame: platforms, wires, file boxes (colour = age, opacity = size).

import type { Frame, LayoutNode } from '../types.ts';

export interface SvgOptions {
  scale?: number; // px per layout unit
  maxPx?: number; // cap on the longer side
  title?: string;
  totalCommits?: number; // for age colouring
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Age 0..1 -> colour. New = warm, old = cool. */
function ageColour(t: number): string {
  const h = 210 - 180 * Math.max(0, Math.min(1, t));
  return `hsl(${h.toFixed(0)} 70% 55%)`;
}

export function renderSvg(f: Frame, o: SvgOptions = {}): string {
  const pad = 2;
  const b = f.bbox;
  const W = Math.max(1, b.w + pad * 2);
  const H = Math.max(1, b.h + pad * 2);
  let scale = o.scale ?? 6;
  const maxPx = o.maxPx ?? 2400;
  if (Math.max(W, H) * scale > maxPx) scale = maxPx / Math.max(W, H);
  const total = Math.max(1, o.totalCommits ?? f.commit + 1);
  const byId = new Map<string, LayoutNode>();
  for (const n of f.nodes) byId.set(n.id, n);

  const wires: string[] = [];
  const dirs: string[] = [];
  const files: string[] = [];
  for (const n of f.nodes) {
    if (n.kind === 'dir') {
      if (n.parent) {
        const p = byId.get(n.parent)!;
        const x1 = p.x + p.w / 2, y1 = p.y + p.h, x2 = n.x + n.w / 2, y2 = n.y;
        const ym = (y1 + y2) / 2;
        wires.push(`<path d="M${x1} ${y1}V${ym}H${x2}V${y2}"${n.ghost ? ' class="g"' : ''}/>`);
      }
      dirs.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}"${n.ghost ? ' class="g"' : ''}><title>${esc(n.path || '/')}</title></rect>`);
    } else {
      const age = (f.commit - (n.modified ?? 0)) / total;
      const op = Math.min(1, 0.35 + Math.log10(1 + (n.size ?? 0)) / 6);
      if (n.ghost) files.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" class="g"/>`);
      else files.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="${ageColour(1 - Math.min(1, age * 4))}" fill-opacity="${op.toFixed(2)}"><title>${esc(n.path)}</title></rect>`);
    }
  }
  const title = o.title ? `<text x="${b.x - pad + 0.5}" y="${b.y - pad + 1.5}" class="t">${esc(o.title)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad} ${W} ${H}" width="${(W * scale).toFixed(0)}" height="${(H * scale).toFixed(0)}">
<style>
.w path{fill:none;stroke:#5a6b80;stroke-width:.12}
.d rect{fill:#1d2733;stroke:#3d5168;stroke-width:.08}
.g{fill:none!important;stroke:#55606d!important;stroke-dasharray:.3 .2;stroke-width:.06}
.t{font:1.2px sans-serif;fill:#9fb3c8}
</style>
<rect x="${b.x - pad}" y="${b.y - pad}" width="${W}" height="${H}" fill="#0b1016"/>
${title}<g class="w">${wires.join('')}</g><g class="d">${dirs.join('')}</g><g>${files.join('')}</g>
</svg>`;
}
