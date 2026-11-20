// The renderer: a code map as SVG (static, for embedding) or as a self-contained HTML page (pan, zoom,
// hover, folder names that appear as you zoom in). Extra properties go on top as an Overlay: a colour,
// label, badge or note per file, ghosts for files that are not on the map (say, deleted in a PR), and
// arcs between files. The base map never changes for an overlay; it only fades so the overlay stands out.

import { folderGroups } from './groups.ts';
import type { CodeMap } from './layout.ts';
import { buildSnapshot, cmp } from './snapshot.ts';

/** Named colours that follow the page's light/dark theme. Anything else is used as a CSS colour. */
export const TONES = ['added', 'modified', 'deleted', 'renamed', 'hot', 'warm', 'cool', 'muted'] as const;

export interface Paint {
  tone?: string; // one of TONES
  color?: string; // any CSS colour; wins over tone
}

export interface FileMark extends Paint {
  label?: string; // shown beside the dot when zoomed in (default: none)
  badge?: string; // short text in the list and tooltip, e.g. "+12 −3"
  note?: string; // tooltip line
  group?: string; // list heading (default: the tone's name)
}

export interface Ghost extends Paint {
  path: string;
  x: number;
  y: number;
  r: number;
  label?: string;
  badge?: string;
  note?: string;
  group?: string;
}

export interface Arc extends Paint {
  from: string | [number, number]; // a file path (on the map or a ghost) or a point
  to: string | [number, number];
  width?: number; // screen pixels (default 1.5)
  note?: string;
}

export interface Overlay {
  title?: string;
  subtitle?: string;
  link?: string; // e.g. the PR's URL, shown under the title
  dim?: boolean; // fade the base map (default: true when the overlay marks anything)
  files?: Record<string, FileMark>;
  ghosts?: Ghost[];
  arcs?: Arc[];
  legend?: ({ label: string } & Paint)[];
  list?: boolean; // list the marked files beside the map (default true)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v: number) => String(Math.round(v * 100) / 100);
const paint = (p: Paint, fallback = 'var(--hot)') => (p.color ? esc(p.color) : p.tone && (TONES as readonly string[]).includes(p.tone) ? `var(--${p.tone})` : fallback);
export const fmtSize = (b: number) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB');

// ---- theme ----

const LIGHT =
  '--bg:#eef1ec;--panel:#f8faf6;--ink:#1d2a22;--muted:#5b6a60;--rule:#d3dbd2;--accent:#2f7d55;--neutral:#8b978e;' +
  '--g0:#d1495b;--g1:#edae49;--g2:#00798c;--g3:#6a4c93;--g4:#3c8d2f;--g5:#e07a3f;--g6:#4d8fd6;--g7:#b5527f;--g8:#8d7b2a;--g9:#9aa39c;' +
  '--added:#2b8a3e;--modified:#e8590c;--deleted:#c2255c;--renamed:#1971c2;--hot:#e03131;--warm:#f08c00;--cool:#1c7ed6;--muted-tone:#868e96;';
const DARK =
  '--bg:#0f1512;--panel:#151d18;--ink:#e3ebe4;--muted:#95a59a;--rule:#26332b;--accent:#6cc293;--neutral:#6f7c73;' +
  '--g0:#ef6f7f;--g1:#f2bf62;--g2:#2cb3c4;--g3:#a183cf;--g4:#6dc05c;--g5:#f09a5f;--g6:#78adf0;--g7:#d77ba4;--g8:#c4b058;--g9:#6f7a72;' +
  '--added:#69db7c;--modified:#ffa94d;--deleted:#f783ac;--renamed:#74c0fc;--hot:#ff6b6b;--warm:#ffd43b;--cool:#4dabf7;--muted-tone:#adb5bd;';

/** Theme tokens: light on :root, dark under the OS setting and under an explicit data-theme. */
export const THEME_CSS = `:root{${LIGHT}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${DARK}color-scheme:dark}}
:root[data-theme="dark"]{${DARK}color-scheme:dark}`;

const MAP_CSS = `.cm-map{display:block;background:var(--panel)}
.cm-map .cell{stroke:none}
.cm-map .dot{stroke:none}
.cm-map .ring{fill:none;stroke-width:2px;vector-effect:non-scaling-stroke}
.cm-map .ghost{stroke-width:1.5px;stroke-dasharray:3 2;vector-effect:non-scaling-stroke}
.cm-map .arc{fill:none;vector-effect:non-scaling-stroke;stroke-linecap:round;opacity:.85}
.cm-map text{font-family:Inter,system-ui,-apple-system,sans-serif;fill:var(--muted);paint-order:stroke;stroke:var(--panel);stroke-linejoin:round}
.cm-map text.flab{fill:var(--ink)}
.cm-map .hot{stroke:var(--ink);stroke-width:2px;vector-effect:non-scaling-stroke}
.cm-map .cell.hot{stroke-width:1.5px}`;

// ---- the SVG ----

export interface SvgOptions {
  standalone?: boolean; // a complete .svg file with its own styles (default true)
  width?: number; // standalone only: the drawing's width in px (default 1200)
}

interface Prepared {
  svg: string;
  data: PageData;
}

/** Data the page's script needs, in compact arrays. */
interface PageData {
  bounds: [number, number, number, number];
  files: [string, number, number, number, number][]; // path, size, x, y, r
  marks: Record<number, [string, string, string, string, string]>; // file index -> label, badge, note, group, colour
  ghosts: [string, number, number, number, string, string, string, string, string][]; // path, x, y, r, label, badge, note, group, colour
  folders: [string, number, number][]; // path, depth, files
}

function prepare(map: CodeMap, ov: Overlay, opt: SvgOptions): Prepared {
  const marks = ov.files ?? {};
  const ghosts = ov.ghosts ?? [];
  const arcs = ov.arcs ?? [];
  const dim = ov.dim ?? (Object.keys(marks).length > 0 || ghosts.length > 0 || arcs.length > 0);
  const snap = buildSnapshot(map.repo, map.files.map((f) => [f.path, f.size]));
  const groups = folderGroups(snap);
  const gOf = map.files.map((f) => {
    const g = groups.ofPath(f.path);
    return g < 0 ? 9 : g;
  });
  const index = new Map(map.files.map((f, i) => [f.path, i]));

  // a folder takes its files' colour when they share one, else grey
  const fgroup = new Map<string, number>();
  map.files.forEach((f, i) => {
    for (let d = f.path; d.includes('/'); ) {
      d = d.slice(0, d.lastIndexOf('/'));
      const g = fgroup.get(d);
      fgroup.set(d, g === undefined ? gOf[i] : g === gOf[i] ? g : -1);
    }
  });

  const [x0, y0, x1, y1] = map.bounds;
  const pad = Math.max(x1 - x0, y1 - y0) * 0.03;
  const vb = [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
  const standalone = opt.standalone ?? true;
  const W = opt.width ?? 1200;
  const out: string[] = [];
  out.push(
    standalone
      ? `<svg xmlns="http://www.w3.org/2000/svg" class="cm-map" viewBox="${vb.map(n2).join(' ')}" width="${W}" height="${Math.round((W * vb[3]) / vb[2])}" role="img" aria-label="${esc(`Code map of ${map.repo}`)}">`
      : `<svg class="cm-map" id="cm-map" viewBox="${vb.map(n2).join(' ')}" style="aspect-ratio:${n2(Math.max(0.6, Math.min(2.2, vb[2] / vb[3])))}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(`Code map of ${map.repo}`)}">`,
  );
  if (standalone) out.push(`<style>${THEME_CSS}\n${MAP_CSS}</style><rect x="${n2(vb[0])}" y="${n2(vb[1])}" width="${n2(vb[2])}" height="${n2(vb[3])}" fill="var(--panel)"/>`);

  // folder cells, shallow first so each subfolder sits on its parent
  out.push('<g class="cells">');
  const folders = [...map.folders].sort((a, b) => a.depth - b.depth || cmp(a.path, b.path));
  for (const f of folders) {
    const g = fgroup.get(f.path) ?? -1;
    const pct = Math.min(70, 16 + 9 * (f.depth - 1)) * (dim ? 0.6 : 1);
    const col = g < 0 ? 'var(--neutral)' : `var(--g${g})`;
    const d = f.outline.map((r) => 'M' + r.map(n2).join(' ').replace(/^(\S+ \S+)/, '$1L') + 'Z').join('');
    out.push(`<path class="cell" data-d="${esc(f.path)}" fill-rule="evenodd" style="fill:color-mix(in srgb,${col} ${pct.toFixed(0)}%,var(--panel))" d="${d}"/>`);
  }
  out.push('</g>');

  // dots
  out.push('<g class="dots">');
  map.files.forEach((f, i) => {
    if (marks[f.path]) return;
    const col = `var(--g${gOf[i]})`;
    const fill = dim ? `color-mix(in srgb,${col} 38%,var(--panel))` : col;
    out.push(`<circle class="dot" data-i="${i}" cx="${n2(f.x)}" cy="${n2(f.y)}" r="${n2(f.r)}" style="fill:${fill}"/>`);
  });
  out.push('</g>');

  // ghosts
  const ghostAt = new Map<string, [number, number]>();
  if (ghosts.length) {
    out.push('<g class="ghosts">');
    ghosts.forEach((g, k) => {
      const c = paint(g, 'var(--deleted)');
      ghostAt.set(g.path, [g.x, g.y]);
      out.push(`<circle class="ghost" data-g="${k}" cx="${n2(g.x)}" cy="${n2(g.y)}" r="${n2(g.r)}" style="stroke:${c};fill:color-mix(in srgb,${c} 18%,transparent)"/>`);
    });
    out.push('</g>');
  }

  // arcs: a gentle curve bending to the left of travel, a small dot at the end
  if (arcs.length) {
    out.push('<g class="arcs">');
    const pos = (e: string | [number, number]): [number, number] | null => {
      if (Array.isArray(e)) return e;
      const i = index.get(e);
      return i !== undefined ? [map.files[i].x, map.files[i].y] : (ghostAt.get(e) ?? null);
    };
    for (const a of arcs) {
      const p = pos(a.from);
      const q = pos(a.to);
      if (!p || !q) continue;
      const c = paint(a, 'var(--accent)');
      const mx = (p[0] + q[0]) / 2;
      const my = (p[1] + q[1]) / 2;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const k = 0.22;
      out.push(
        `<path class="arc" style="stroke:${c};stroke-width:${a.width ?? 1.5}px" d="M${n2(p[0])} ${n2(p[1])}Q${n2(mx + dy * k)} ${n2(my - dx * k)} ${n2(q[0])} ${n2(q[1])}"><title>${esc(a.note ?? '')}</title></path>`,
        `<circle cx="${n2(q[0])}" cy="${n2(q[1])}" r="0.3" style="fill:${c}"/>`,
      );
    }
    out.push('</g>');
  }

  // marked files on top, each with a ring so a small file is still easy to spot
  const markData: PageData['marks'] = {};
  const marked = Object.keys(marks)
    .filter((p) => index.has(p))
    .sort(cmp);
  if (marked.length) {
    out.push('<g class="marks">');
    for (const p of marked) {
      const i = index.get(p)!;
      const f = map.files[i];
      const m = marks[p];
      const c = paint(m);
      markData[i] = [m.label ?? '', m.badge ?? '', m.note ?? '', m.group ?? m.tone ?? '', c];
      out.push(`<circle class="ring" cx="${n2(f.x)}" cy="${n2(f.y)}" r="${n2(f.r + 0.45)}" style="stroke:${c}"/>`);
      out.push(`<circle class="dot" data-i="${i}" cx="${n2(f.x)}" cy="${n2(f.y)}" r="${n2(f.r)}" style="fill:${c}"/>`);
    }
    out.push('</g>');
  }

  // folder names; the page script shows them as there is room, a standalone SVG shows the top level
  const size = Math.max(x1 - x0, y1 - y0) / 70;
  out.push('<g class="labels">');
  for (const f of folders) {
    const name = f.path.slice(f.path.lastIndexOf('/') + 1) + '/';
    if (standalone) {
      if (f.depth > 1 || f.bbox[2] - f.bbox[0] < name.length * size * 0.6) continue;
      out.push(`<text x="${n2(f.label[0])}" y="${n2(f.label[1] + size * 1.1)}" font-size="${n2(size)}" stroke-width="${n2(size * 0.25)}" text-anchor="middle" font-weight="600">${esc(name)}</text>`);
    } else
      out.push(
        `<text data-k="d" data-x="${n2(f.label[0])}" data-y="${n2(f.label[1])}" data-w="${n2(f.bbox[2] - f.bbox[0])}" data-h="${n2(f.bbox[3] - f.bbox[1])}" data-depth="${f.depth}" text-anchor="middle" font-weight="600" visibility="hidden">${esc(name)}</text>`,
      );
  }
  if (!standalone) {
    for (const p of marked) {
      const m = marks[p];
      if (!m.label) continue;
      const f = map.files[index.get(p)!];
      out.push(`<text class="flab" data-k="f" data-x="${n2(f.x)}" data-y="${n2(f.y)}" data-r="${n2(f.r)}" visibility="hidden">${esc(m.label)}</text>`);
    }
    for (const g of ghosts) {
      if (!g.label) continue;
      out.push(`<text class="flab" data-k="f" data-x="${n2(g.x)}" data-y="${n2(g.y)}" data-r="${n2(g.r)}" visibility="hidden">${esc(g.label)}</text>`);
    }
  }
  out.push('</g></svg>');

  return {
    svg: out.join('\n'),
    data: {
      bounds: vb as PageData['bounds'],
      files: map.files.map((f) => [f.path, f.size, f.x, f.y, f.r]),
      marks: markData,
      ghosts: ghosts.map((g) => [g.path, g.x, g.y, g.r, g.label ?? '', g.badge ?? '', g.note ?? '', g.group ?? g.tone ?? '', paint(g, 'var(--deleted)')]),
      folders: map.folders.map((f) => [f.path, f.depth, f.files]),
    },
  };
}

/** A static SVG file. */
export function renderSvg(map: CodeMap, overlay: Overlay = {}, opt: SvgOptions = {}): string {
  return prepare(map, overlay, { ...opt, standalone: true }).svg + '\n';
}

// ---- the page ----

const PAGE_CSS = `*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,-apple-system,sans-serif}
.wrap{max-width:1500px;margin:0 auto;padding-block:24px 40px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:14px}
.wrap>*{min-width:0}
header{display:grid;gap:4px;max-width:80ch}
.eyebrow{font:12px "JetBrains Mono",ui-monospace,Menlo,monospace;color:var(--muted);letter-spacing:.02em;overflow-wrap:anywhere}
h1{font-family:"Bricolage Grotesque","Avenir Next",system-ui,sans-serif;font-weight:700;font-size:clamp(26px,4vw,40px);line-height:1.08;margin:0;letter-spacing:-.01em;text-wrap:balance}
header p{margin:0;color:var(--muted)}
header a{color:var(--accent)}
.bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font:12px "JetBrains Mono",ui-monospace,Menlo,monospace;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
.tools{display:flex;gap:8px}
.tools button{font:500 13px Inter,system-ui,sans-serif;color:var(--muted);background:var(--panel);border:1px solid var(--rule);border-radius:999px;padding:4px 12px;cursor:pointer}
.tools button:hover{color:var(--ink);border-color:var(--muted)}
.tools button[aria-pressed="false"]{opacity:.6}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.body{display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}
.body.has-list{grid-template-columns:minmax(0,1fr)}
@media (min-width:1000px){.body.has-list{grid-template-columns:minmax(0,1fr) 340px}}
.plate{position:relative;background:var(--panel);border:1px solid var(--rule);border-radius:6px;overflow:hidden;min-width:0}
#cm-map{width:100%;height:auto;max-height:min(78vh,960px);min-height:280px;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}
#cm-map.dragging{cursor:grabbing}
.hint{position:absolute;left:12px;bottom:10px;font-size:12px;color:var(--muted);pointer-events:none;background:color-mix(in srgb,var(--panel) 80%,transparent);padding:2px 8px;border-radius:4px}
aside{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:12px 0;max-height:min(78vh,960px);overflow:auto;min-width:0}
aside h2{font:600 11px Inter,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:10px 14px 4px}
aside h2:first-child{margin-top:0}
aside ul{list-style:none;margin:0;padding:0}
aside li button{all:unset;box-sizing:border-box;display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;padding:3px 14px;cursor:pointer;font-size:13px}
aside li button:hover,aside li button:focus-visible{background:color-mix(in srgb,var(--ink) 7%,transparent)}
aside li i{width:10px;height:10px;border-radius:50%}
aside .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
aside .p span{direction:ltr;unicode-bidi:embed}
aside .p b{font-weight:600}
aside .p em{font-style:normal;color:var(--muted)}
aside .b{font:12px "JetBrains Mono",ui-monospace,Menlo,monospace;color:var(--muted);font-variant-numeric:tabular-nums}
#tip{position:fixed;pointer-events:none;z-index:20;background:var(--ink);color:var(--panel);font:12px "JetBrains Mono",ui-monospace,Menlo,monospace;padding:6px 9px;border-radius:4px;max-width:min(440px,80vw);overflow-wrap:anywhere}
footer{color:var(--muted);font-size:13px;max-width:84ch}
footer code{font:12px "JetBrains Mono",ui-monospace,Menlo,monospace}`;

const PAGE_JS = String.raw`(() => {
const D = window.CM_DATA, svg = document.getElementById('cm-map'), tip = document.getElementById('tip');
const labels = [...svg.querySelectorAll('.labels text')];
let v = null, showLabels = true;
function aspect() { return svg.clientWidth / Math.max(1, svg.clientHeight); }
function fit() {
  const [x, y, w, h] = D.bounds, a = aspect();
  if (w / h > a) v = { x, y: y + h / 2 - w / a / 2, w, h: w / a }; else v = { x: x + w / 2 - h * a / 2, y, w: h * a, h };
  apply();
}
function apply() {
  svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
  place();
}
const scale = () => svg.clientWidth / v.w;
function place() {
  const s = scale(), boxes = [];
  for (const t of labels) {
    let show = false;
    if (showLabels) {
      const k = t.dataset.k, x = +t.dataset.x, y = +t.dataset.y;
      const px = k === 'd' ? Math.max(10, 15 - +t.dataset.depth) : 11.5;
      const tw = t.textContent.length * px * 0.58;
      let sx = (x - v.x) * s, sy = (y - v.y) * s, box;
      if (k === 'd') {
        const w = +t.dataset.w * s, h = +t.dataset.h * s;
        if (Math.min(w, h) >= 70 && tw <= w * 0.9) { sy += px * 0.95; box = [sx - tw / 2 - 3, sy - px / 2 - 2, sx + tw / 2 + 3, sy + px / 2 + 2]; }
      } else if (+t.dataset.r * s >= 2.5) { sx += +t.dataset.r * s + 5; box = [sx - 2, sy - px / 2 - 2, sx + tw + 2, sy + px / 2 + 2]; }
      if (box && box[2] > 0 && box[0] < svg.clientWidth && box[3] > 0 && box[1] < svg.clientHeight && !boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) {
        boxes.push(box); show = true;
        t.setAttribute('x', v.x + sx / s); t.setAttribute('y', v.y + sy / s);
        t.setAttribute('font-size', px / s); t.setAttribute('stroke-width', 3 / s);
        t.setAttribute('dominant-baseline', 'central');
      }
    }
    t.setAttribute('visibility', show ? 'visible' : 'hidden');
  }
}
// file labels first so the overlay's names win over folder names
labels.sort((a, b) => (a.dataset.k === b.dataset.k ? (+(a.dataset.depth || 0)) - (+(b.dataset.depth || 0)) : a.dataset.k === 'f' ? -1 : 1));

function zoomAt(cx, cy, f) {
  const r = svg.getBoundingClientRect(), s = scale();
  const wx = v.x + (cx - r.left) / s, wy = v.y + (cy - r.top) / s;
  const nw = Math.min(Math.max(v.w / f, 2), D.bounds[2] * 4), k = nw / v.w;
  v = { x: wx - (wx - v.x) * k, y: wy - (wy - v.y) * k, w: nw, h: v.h * k };
  apply();
}
function centreOn(x, y, w) { const a = aspect(); v = { x: x - w / 2, y: y - w / a / 2, w, h: w / a }; apply(); }

const ptrs = new Map(); let pinch = 0, moved = false;
svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))); }, { passive: false });
svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); } svg.classList.add('dragging'); });
svg.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) { if (e.pointerType === 'mouse') hover(e); return; }
  if (ptrs.size === 1) { const s = scale(), dx = e.clientX - p.x, dy = e.clientY - p.y; if (dx || dy) { moved = true; v.x -= dx / s; v.y -= dy / s; apply(); } }
  p.x = e.clientX; p.y = e.clientY;
  if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y); zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch); pinch = d; moved = true; }
  hideTip();
});
const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = 0; if (!ptrs.size) svg.classList.remove('dragging'); if (e.pointerType !== 'mouse' && !moved) hover(e); };
svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
svg.addEventListener('pointerleave', hideTip);
svg.addEventListener('dblclick', (e) => zoomAt(e.clientX, e.clientY, e.shiftKey ? 0.5 : 2));
new ResizeObserver(() => { if (!v) return fit(); const a = aspect(), cx = v.x + v.w / 2, cy = v.y + v.h / 2; v.h = v.w / a; v.y = cy - v.h / 2; v.x = cx - v.w / 2; apply(); }).observe(svg);

const size = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
let hot = null;
function setHot(el) { if (hot === el) return; if (hot) hot.classList.remove('hot'); hot = el; if (el) el.classList.add('hot'); }
function hideTip() { tip.hidden = true; setHot(null); }
function describe(el) {
  if (el.dataset.i !== undefined) {
    const i = +el.dataset.i, f = D.files[i], m = D.marks[i];
    return [f[0] + ' · ' + size(f[1]) + (m && m[1] ? ' · ' + m[1] : ''), m && m[2]].filter(Boolean).join('\n');
  }
  if (el.dataset.g !== undefined) { const g = D.ghosts[+el.dataset.g]; return [g[0] + (g[5] ? ' · ' + g[5] : ''), g[6]].filter(Boolean).join('\n'); }
  if (el.dataset.d !== undefined) { const f = D.folders.find((x) => x[0] === el.dataset.d); return f[0] + '/ · ' + f[2] + ' file' + (f[2] === 1 ? '' : 's'); }
  return null;
}
function showTip(text, x, y) {
  tip.hidden = false; tip.textContent = text; tip.style.whiteSpace = 'pre-line';
  tip.style.left = Math.min(x + 14, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = Math.min(y + 16, innerHeight - tip.offsetHeight - 8) + 'px';
}
function hover(e) {
  const el = e.target.closest && e.target.closest('[data-i],[data-g],[data-d]');
  const text = el && describe(el);
  if (!text) return hideTip();
  setHot(el); showTip(text, e.clientX, e.clientY);
}

document.getElementById('fit').addEventListener('click', fit);
const lb = document.getElementById('names');
lb.addEventListener('click', () => { showLabels = !showLabels; lb.setAttribute('aria-pressed', showLabels); place(); });
for (const b of document.querySelectorAll('aside button[data-i],aside button[data-g]')) {
  const el = () => svg.querySelector(b.dataset.i !== undefined ? '.marks [data-i="' + b.dataset.i + '"]' : '[data-g="' + b.dataset.g + '"]');
  b.addEventListener('mouseenter', () => setHot(el()));
  b.addEventListener('mouseleave', () => setHot(null));
  b.addEventListener('focus', () => setHot(el()));
  b.addEventListener('blur', () => setHot(null));
  b.addEventListener('click', () => {
    const f = b.dataset.i !== undefined ? D.files[+b.dataset.i] : D.ghosts[+b.dataset.g];
    const x = b.dataset.i !== undefined ? f[2] : f[1], y = b.dataset.i !== undefined ? f[3] : f[2];
    centreOn(x, y, Math.max(24, D.bounds[2] / 6)); setHot(el());
  });
}
fit();
})();`;

const ORDER = ['added', 'modified', 'renamed', 'deleted'];
const sortGroups = <T,>(e: [string, T][]) => e.sort((a, b) => (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99));

/** A self-contained HTML page (opens from disk; fonts from Google Fonts when online). */
export function renderHtml(map: CodeMap, overlay: Overlay = {}): string {
  const { svg, data } = prepare(map, overlay, { standalone: false });
  const title = overlay.title ?? `${map.repo} code map`;
  const marks = overlay.files ?? {};
  const index = new Map(map.files.map((f, i) => [f.path, i]));

  // legend: the overlay's own, else the tones it uses (with counts), else the base map's folder colours
  let legend = '';
  const item = (c: string, l: string) => `<span><i style="background:${c}"></i>${esc(l)}</span>`;
  if (overlay.legend) legend = overlay.legend.map((l) => item(paint(l), l.label)).join('');
  else if (Object.keys(marks).length || overlay.ghosts?.length) {
    const count = new Map<string, [string, number]>();
    const tally = (m: Paint & { group?: string }, fallbackGroup: string, fallbackColour: string) => {
      const k = m.group ?? m.tone ?? fallbackGroup;
      const e = count.get(k) ?? [paint(m, fallbackColour), 0];
      e[1]++;
      count.set(k, e);
    };
    for (const p of Object.keys(marks)) if (index.has(p)) tally(marks[p], 'marked', 'var(--hot)');
    for (const g of overlay.ghosts ?? []) tally(g, 'not on the map', 'var(--deleted)');
    legend = sortGroups([...count]).map(([k, [c, n]]) => item(c, `${k} ${n}`)).join('');
  } else {
    const groups = folderGroups(buildSnapshot(map.repo, map.files.map((f) => [f.path, f.size])));
    legend = groups.labels.map((l, i) => item(`var(--g${i === groups.labels.length - 1 && l === 'everything else' ? 9 : i})`, l)).join('');
  }

  // the list of marked files, grouped
  let list = '';
  const rows = new Map<string, string[]>();
  const addRow = (groupName: string, attr: string, c: string, path: string, badge: string) => {
    const cut = path.lastIndexOf('/');
    const p = `<span><em>${esc(path.slice(0, cut + 1))}</em><b>${esc(path.slice(cut + 1))}</b></span>`;
    let r = rows.get(groupName);
    if (!r) rows.set(groupName, (r = []));
    r.push(`<li><button type="button" ${attr}><i style="background:${c}"></i><span class="p">${p}</span><span class="b">${esc(badge)}</span></button></li>`);
  };
  for (const p of Object.keys(marks).sort(cmp)) {
    const i = index.get(p);
    if (i === undefined) continue;
    const m = marks[p];
    addRow(m.group ?? m.tone ?? 'marked', `data-i="${i}"`, paint(m), p, m.badge ?? '');
  }
  (overlay.ghosts ?? []).forEach((g, k) => addRow(g.group ?? g.tone ?? 'not on the map', `data-g="${k}"`, paint(g, 'var(--deleted)'), g.path, g.badge ?? ''));
  const showList = (overlay.list ?? true) && rows.size > 0;
  if (showList) list = `<aside aria-label="Marked files">${sortGroups([...rows]).map(([g, r]) => `<h2>${esc(g)} · ${r.length}</h2><ul>${r.join('')}</ul>`).join('')}</aside>`;

  const eyebrow = `${map.repo} · ${map.commit.slice(0, 7)} · ${map.date} · ${map.files.length.toLocaleString('en')} files`;
  const sub = overlay.subtitle ?? (Object.keys(marks).length ? '' : map.subject);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap">
<style>
${THEME_CSS}
${PAGE_CSS}
${MAP_CSS}
</style>
</head>
<body>
<div class="wrap">
<header>
<div class="eyebrow">${esc(eyebrow)}</div>
<h1>${esc(title)}</h1>
${sub ? `<p>${esc(sub)}</p>` : ''}
${overlay.link ? `<p><a href="${esc(overlay.link)}" target="_blank" rel="noopener">${esc(overlay.link)}</a></p>` : ''}
</header>
<div class="bar"><div class="legend">${legend}</div><div class="tools"><button type="button" id="names" aria-pressed="true">Names</button><button type="button" id="fit">Fit</button></div></div>
<div class="body${showList ? ' has-list' : ''}">
<div class="plate">
${svg}
<div class="hint">Drag to pan · scroll or pinch to zoom · hover for names</div>
</div>
${list}
</div>
<footer>Every file is a dot, bigger for bigger files; every folder is the cell grown around its files, so subfolders sit inside their parents. The map is replayed from the repository's history and holds still as the code grows: files keep their places, and new files take the nearest free spot in their folder. Made with the code-map skill.</footer>
</div>
<div id="tip" hidden></div>
<script>window.CM_DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
<script>${PAGE_JS}</script>
</body>
</html>
`;
}
