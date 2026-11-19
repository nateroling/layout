// One self-contained HTML report: intro, cross-fixture summary, player, and per
// fixture a scoreboard, a stability-vs-compactness scatter and filmstrips.
// No external requests; all CSS/JS/SVG inline. Tables, scatter plots and
// (within budget) filmstrips are static markup, so the report reads without JS;
// JS adds sorting, the player, and canvas filmstrips for fixtures over budget.

import { COLUMNS, SCORE_GROUPS, column, normRanks } from './columns.ts';
import { decoderSource } from './encode.ts';
import { LEVELS, evenly, type ConfigResult, type FixtureResult } from './run.ts';
import { FILE_COLOURS, MOVE_COLOURS, MOVE_TIERS, MOVE_WIDTHS, PALETTE, RECENCY_BUCKETS, SIZE_BUCKETS, recencyBucket } from '../render/svg.ts';
import { HORIZONS } from '../metrics/metrics.ts';

export interface ReportOptions {
  budgetBytes: number;
  generated: string; // ISO date
  command?: string;
  title?: string; // replaces "layout stability report" in the heading and <title>
  about?: string; // extra HTML paragraph(s) at the top of the about section
  compare?: CompareGroup[]; // side-by-side groups: configs drawn next to each other on one slider
}

/** Configs (by label) shown next to each other in the "side by side" section. */
export interface CompareGroup {
  label: string;
  configs: string[];
}

export interface ReportResult {
  html: string;
  notes: string[];
  bytes: { total: number; film: number; player: number };
  levels: Record<string, number>; // "fixture/config" -> chosen player level
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const r2 = (v: number) => Math.round(v * 100) / 100;
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Strategy family -> colour slot (dark-mode categorical palette, fixed order). */
const FAMILY_COLOURS: Record<string, string> = { recompute: '#3987e5', hindsight: '#d95926', slack: '#199e70', tombstone: '#c98500' };
const familyColour = (s: string) => FAMILY_COLOURS[s] ?? '#9085e9';

function optText(c: ConfigResult): string {
  const skip = new Set(['cell', 'pad', 'hgap', 'vgap']);
  return Object.entries(c.options)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

// ---------- budget ----------

interface Plan {
  canvasFilm: Set<string>; // fixture names whose filmstrips are drawn from player data
  level: Map<ConfigResult, number>;
  notes: string[];
  film: number;
  player: number;
}

function playerCost(c: ConfigResult, L: number): number {
  const p = c.players[L];
  return p.data.length + p.kinds.length + p.dirPath.length * 4 + p.dirParent.length * 4 + p.frames.length * 4;
}

function plan(fixtures: FixtureResult[], budget: number): Plan {
  const notes: string[] = [];
  const overhead = 200_000 + fixtures.reduce((s, f) => s + JSON.stringify(f.strings).length + JSON.stringify(f.metas).length, 0);
  const filmOf = (f: FixtureResult) => f.configs.reduce((s, c) => s + c.film.bytes, 0);
  let film = fixtures.reduce((s, f) => s + filmOf(f), 0);
  const canvasFilm = new Set<string>();
  const filmBudget = budget * 0.35;
  for (const f of [...fixtures].sort((a, b) => filmOf(b) - filmOf(a))) {
    if (film <= filmBudget) break;
    canvasFilm.add(f.name);
    film -= filmOf(f);
    notes.push(`Filmstrips for ${f.name} are drawn on canvas from player data (inline SVG would add ${(filmOf(f) / 1e6).toFixed(1)} MB).`);
  }
  const level = new Map<ConfigResult, number>();
  const all = fixtures.flatMap((f) => f.configs);
  for (const c of all) level.set(c, 0);
  let player = all.reduce((s, c) => s + playerCost(c, 0), 0);
  const playerBudget = budget - film - overhead;
  while (player > playerBudget) {
    let worst: ConfigResult | null = null;
    for (const c of all) if (level.get(c)! < LEVELS - 1 && (!worst || playerCost(c, level.get(c)!) > playerCost(worst, level.get(worst)!))) worst = c;
    if (!worst) break;
    const L = level.get(worst)!;
    player += playerCost(worst, L + 1) - playerCost(worst, L);
    level.set(worst, L + 1);
  }
  const reduced = all.filter((c) => level.get(c)! > 0);
  if (reduced.length) {
    const byFx = new Map<string, string[]>();
    for (const f of fixtures) for (const c of f.configs) if (level.get(c)! > 0) {
      if (!byFx.has(f.name)) byFx.set(f.name, []);
      byFx.get(f.name)!.push(`${c.label} (${c.players[level.get(c)!].frames.length} frames)`);
    }
    for (const [fx, list] of byFx) notes.push(`Player frames reduced to fit the ${(budget / 1e6).toFixed(0)} MB budget for ${fx}: ${list.join(', ')}.`);
  }
  if (player > playerBudget) notes.push(`Over budget even at the coarsest player level: ${((film + player + overhead) / 1e6).toFixed(1)} MB.`);
  return { canvasFilm, level, notes, film, player };
}

// ---------- static pieces ----------

function legend(): string {
  const sw = (fill: string, extra = '') => `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="11" height="11" fill="${fill}" ${extra}/></svg>`;
  const rec = ['this commit', 'recent', '', '', '', 'long ago'];
  const recency = FILE_COLOURS.map((row, i) => `<span class="sw" title="recency bucket ${i}">${sw(row[1])}${rec[i] ? `<small>${rec[i]}</small>` : ''}</span>`).join('');
  const size = FILE_COLOURS[3].map((c, i) => `<span class="sw">${sw(c)}<small>${['<1 KB', '<16 KB', 'larger'][i]}</small></span>`).join('');
  return `<div class="legend">
<div><b>file colour = last modified</b> ${recency}</div>
<div><b>lightness = size</b> ${size}</div>
<div><span class="sw">${sw(PALETTE.platform, `stroke="${PALETTE.platformEdge}"`)}<small>directory platform</small></span>
<span class="sw">${sw('none', `stroke="${PALETTE.ghost}" stroke-dasharray="2 1.5"`)}<small>ghost (deleted, slot kept)</small></span>
</div>
<div><b>outline = moved since the previous frame shown</b> ${MOVE_COLOURS.map((c, t) => `<span class="sw">${sw('none', `stroke="${c}" stroke-width="${MOVE_WIDTHS[t] * 1.6}"`)}<small>${moveTierText(t)}</small></span>`).join('')}</div>
</div>`;
}

/** "< 2 cells", "2–10 cells", "≥ 10 cells" */
function moveTierText(t: number): string {
  if (t === 0) return `< ${MOVE_TIERS[0]} cells`;
  if (t === MOVE_TIERS.length) return `≥ ${MOVE_TIERS[t - 1]} cells`;
  return `${MOVE_TIERS[t - 1]}–${MOVE_TIERS[t]} cells`;
}

function intro(about = ''): string {
  const items = COLUMNS.map((c) => `<dt>${esc(c.label)}${c.better ? ` <span class="dir">${c.better === 'low' ? 'lower is better' : 'higher is better'}</span>` : ''}</dt><dd>${esc(c.help)}</dd>`).join('');
  return `<section id="about">${about}
<p>Each repo's file tree is drawn fsn-style from above: a directory is a <b>platform</b> with its files in a grid; subdirectories hang in the row below, joined by wires. A <b>layout strategy</b> decides where things go as the repo evolves commit by commit (first-parent history). This report replays every commit of each repo under each strategy and asks:</p>
<ul>
<li><b>Smoothness</b> (consecutive commits) — when you play the history as an animation, how much jumps around from one commit to the next? Measured on nodes that exist in both of two consecutive commits: how many moved, how far on average, how far at worst. Most commits only edit files, so the headline is <i>moved / tree change</i>, averaged over commits that add, delete or rename something.</li>
<li><b>Horizon</b> (${HORIZONS.join(' and ')} commits apart) — come back after a gap: is what you remember still where you left it? Frames ${HORIZONS[0]} commits apart (0 vs ${HORIZONS[0]}, ${HORIZONS[0]} vs ${2 * HORIZONS[0]}, …) are compared directly. Small per-commit nudges that never undo themselves add up here; a strategy can be smooth and still lose your mental map.</li>
<li><b>Compactness</b> — how much of the picture is actual files rather than empty space and reserved slots.</li>
<li><b>Name order</b> — how alphabetical siblings still are (a findability/taste trade-off, not a goal).</li>
</ul>
<p>Survivors are matched by file identity under git's rename detection, for every config: a renamed file that jumps counts as a move even when the strategy itself treats the rename as delete + add. Stability and compactness pull against each other: leaving room so nothing has to move costs space. The scatter plots show where each strategy lands on that trade-off.</p>
<details><summary>Metric definitions</summary><dl class="defs">${items}
<dt>score (summary)</dt><dd>${esc(scoreDefinition())}</dd></dl></details>
${legend()}
</section>`;
}

function scoreDefinition(): string {
  const st = SCORE_GROUPS[0];
  return `Per repo, configs are ranked on each ingredient; the rank is normalized to 100 (best config on that repo) … 0 (worst), and a group is the mean of its ingredients. Group scores are then averaged over repos. ${st.label[0].toUpperCase() + st.label.slice(1)} = mean of ${st.ingredients.map((i) => i.label).join(', ')}${st.ingredients.some((i) => i.cols.length > 1) ? ' (the horizon ingredient averages whichever horizons the repo is long enough for)' : ''}. Disruption and shift after K are left out: they measure distance again, like mean shift.`;
}

function scoreboard(f: FixtureResult): string {
  const cs = f.configs;
  if (!cs.length) return '<p class="muted">No configs ran.</p>';
  const best = new Map<string, number>();
  for (const col of COLUMNS) {
    if (!col.better) continue;
    const vals = cs.map((c) => col.get(c.summary)).filter((v) => !Number.isNaN(v));
    if (!vals.length) continue;
    const b = col.better === 'low' ? Math.min(...vals) : Math.max(...vals);
    const w = col.better === 'low' ? Math.max(...vals) : Math.min(...vals);
    if (b !== w) best.set(col.key, b);
  }
  const head = `<tr><th class="lbl" data-k="label">config</th>${COLUMNS.map((c) => `<th title="${esc(c.help)}">${esc(c.label)}${c.better ? `<i>${c.better === 'low' ? '↓' : '↑'}</i>` : ''}</th>`).join('')}<th title="Wall time for the full replay incl. metrics and sampling">run</th></tr>`;
  const rows = cs.map((c) => {
    const tds = COLUMNS.map((col) => {
      const v = col.get(c.summary);
      const isBest = best.has(col.key) && Math.abs(v - best.get(col.key)!) <= 1e-12 * Math.max(1, Math.abs(v));
      return `<td data-v="${Number.isNaN(v) ? '' : v}"${isBest ? ' class="best"' : ''}>${esc(col.fmt(v, c.summary))}</td>`;
    }).join('');
    return `<tr><th class="lbl" data-v="${esc(c.label)}"><span class="dot" style="background:${familyColour(c.strategy)}"></span>${esc(c.label)}</th>${tds}<td data-v="${c.ms}" class="muted">${(c.ms / 1000).toFixed(1)}s</td></tr>`;
  }).join('');
  return `<div class="tw"><table class="sb sortable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * Greedy label placement: try spots around the point at growing distances; keep the
 * first that collides with no point or earlier label. Far spots get a leader line.
 */
function placeLabels(pts: { x: number; y: number; text: string }[], X0: number, W: number, H: number, fs: number) {
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const R = 7;
  const boxes: Box[] = pts.map((p) => ({ x0: p.x - R, y0: p.y - R, x1: p.x + R, y1: p.y + R }));
  const hit = (b: Box) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  return pts.map((p) => {
    const w = p.text.length * fs * 0.56, h = fs * 1.15;
    for (const d of [1, 2, 3, 4.5]) {
      const dx = 10 * d, dy = 10 * d;
      const cands = [
        { x: p.x + dx, y: p.y + fs * 0.35, a: 'start' }, { x: p.x - dx, y: p.y + fs * 0.35, a: 'end' },
        { x: p.x, y: p.y - dy, a: 'middle' }, { x: p.x, y: p.y + dy + fs * 0.7, a: 'middle' },
        { x: p.x + dx * 0.8, y: p.y - dy * 0.8, a: 'start' }, { x: p.x + dx * 0.8, y: p.y + dy * 0.8 + fs * 0.7, a: 'start' },
        { x: p.x - dx * 0.8, y: p.y - dy * 0.8, a: 'end' }, { x: p.x - dx * 0.8, y: p.y + dy * 0.8 + fs * 0.7, a: 'end' },
      ];
      for (const c of cands) {
        const x0 = c.a === 'start' ? c.x : c.a === 'end' ? c.x - w : c.x - w / 2;
        const b = { x0: x0 - 2, y0: c.y - h * 0.85, x1: x0 + w + 2, y1: c.y + h * 0.15 };
        if (b.x0 < X0 || b.x1 > W || b.y0 < 0 || b.y1 > H) continue;
        if (!hit(b)) {
          boxes.push(b);
          // leader end: nearest point of the label box to the dot
          const lx = Math.max(b.x0, Math.min(p.x, b.x1)), ly = Math.max(b.y0, Math.min(p.y, b.y1));
          return { ...c, leader: d > 1 ? { x: lx, y: ly } : null };
        }
      }
    }
    return null; // no room: tooltip only
  });
}

function scatter(f: FixtureResult): string {
  const cs = f.configs;
  if (cs.length < 2) return '';
  const W = 640, H = 340, m = { l: 52, r: 16, t: 14, b: 40 };
  const xs = cs.map((c) => c.summary.compactness.mean);
  const ys = cs.map((c) => c.summary.structural.meanMovedFrac);
  const xmax = Math.max(...xs) * 1.08 || 1;
  const xmin = Math.max(0, Math.min(...xs) - (Math.max(...xs) - Math.min(...xs)) * 0.15);
  const ymax = Math.max(0.01, Math.max(...ys) * 1.1);
  const X = (v: number) => m.l + ((v - xmin) / (xmax - xmin || 1)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const ticks = (lo: number, hi: number, n: number) => {
    const step = niceStep((hi - lo) / n);
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  };
  let g = '';
  for (const t of ticks(0, ymax, 4)) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${r2(Y(t))}" y2="${r2(Y(t))}" class="grid"/><text x="${m.l - 6}" y="${r2(Y(t) + 4)}" text-anchor="end">${(t * 100).toFixed(t < 0.1 && t > 0 ? 1 : 0)}%</text>`;
  for (const t of ticks(xmin, xmax, 5)) g += `<line y1="${m.t}" y2="${H - m.b}" x1="${r2(X(t))}" x2="${r2(X(t))}" class="grid"/><text x="${r2(X(t))}" y="${H - m.b + 16}" text-anchor="middle">${t.toFixed(2)}</text>`;
  g += `<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" class="axis"/>`;
  g += `<text x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle" class="at">compactness (time-averaged) →  denser</text>`;
  g += `<text transform="translate(13 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" class="at">moved / tree change  (lower = steadier)</text>`;
  g += `<text x="${W - m.r - 4}" y="${H - m.b - 8}" text-anchor="end" class="better">better ↘</text>`;
  const pts = cs.map((c, i) => ({ x: X(xs[i]), y: Y(ys[i]), text: c.label }));
  // configs that land on (nearly) the same spot share one label: "a / b / c"
  const owner = pts.map((p, i) => pts.findIndex((q) => Math.hypot(p.x - q.x, p.y - q.y) < 3) === i);
  const merged = pts.map((p, i) => ({ ...p, text: owner[i] ? pts.filter((q) => Math.hypot(p.x - q.x, p.y - q.y) < 3).map((q) => q.text).join(' / ') : '' }));
  const placed = placeLabels(merged.filter((_, i) => owner[i]), m.l + 2, W, H - m.b - 2, 11);
  let pi = 0;
  const labels = merged.map((_, i) => (owner[i] ? placed[pi++] : null));
  let dots = '';
  cs.forEach((c, i) => {
    const p = pts[i];
    dots += `<g class="pt"><circle cx="${r2(p.x)}" cy="${r2(p.y)}" r="5" fill="${familyColour(c.strategy)}"/><circle cx="${r2(p.x)}" cy="${r2(p.y)}" r="12" fill="transparent" class="hit"><title>${esc(c.label)} — compactness ${xs[i].toFixed(3)}, moved per tree change ${(ys[i] * 100).toFixed(2)}%</title></circle></g>`;
    const l = labels[i];
    if (l) {
      if (l.leader) g += `<line x1="${r2(p.x)}" y1="${r2(p.y)}" x2="${r2(l.leader.x)}" y2="${r2(l.leader.y)}" class="ld"/>`;
      g += `<text x="${r2(l.x)}" y="${r2(l.y)}" text-anchor="${l.a}" class="pl">${esc(merged[i].text)}</text>`;
    }
  });
  g += dots;
  const fams = [...new Set(cs.map((c) => c.strategy))];
  const leg = fams.map((s) => `<span><span class="dot" style="background:${familyColour(s)}"></span>${esc(s)}</span>`).join(' ');
  return `<figure class="scatter"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="stability vs compactness for ${esc(f.name)}">${g}</svg><figcaption>${leg}</figcaption></figure>`;
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const r = raw / p;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * p;
}

function sparkline(vals: number[], w = 120, h = 22): string {
  if (vals.length < 2) return '';
  const mx = Math.max(...vals) || 1;
  const pts = vals.map((v, i) => `${r2((i / (vals.length - 1)) * w)},${r2(h - 1 - (v / mx) * (h - 2))}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="share moved over time"><polyline points="${pts}"/></svg>`;
}

/** Wide layouts (TreeV bands get very wide) read better as stacked full-width rows than as a thumbnail row. */
const STACK_ASPECT = 2.5;
function isStacked(f: FixtureResult): boolean {
  const a = f.configs.map((c) => c.film.viewport.w / c.film.viewport.h).sort((x, y) => x - y);
  return a.length > 0 && a[Math.floor(a.length / 2)] > STACK_ASPECT;
}

function filmstrips(f: FixtureResult, fi: number, canvas: boolean): string {
  const maxW = Math.max(1, ...f.configs.map((c) => c.film.viewport.w));
  const stacked = isStacked(f);
  return f.configs.map((c, ci) => {
    const ratio = c.film.viewport.w / maxW;
    const aspect = c.film.viewport.h / c.film.viewport.w;
    const figs = c.film.frames.map((fr, k) => {
      const m = f.metas[fr.meta];
      const style = stacked ? `width:min(100%, ${Math.round(220 / aspect)}px)` : `width:calc(var(--film) * ${r2(ratio)})`;
      const figStyle = stacked ? '' : ` style="width:max(100px, calc(var(--film) * ${r2(ratio)}))"`;
      const pic = canvas
        ? `<canvas class="fc" data-fc="${fi},${ci},${fr.meta}" style="${style};aspect-ratio:${r2(1 / aspect)}"></canvas>`
        : fr.svg.replace('<svg ', `<svg style="${style}" `);
      const far = fr.far ?? 0;
      const cap = `#${m[0]} · ${date(m[1])}${stacked ? ' · ' : '<br>'}${k ? `<span class="${far ? 'mv' : ''}" title="${far} moved ≥ ${MOVE_TIERS[MOVE_TIERS.length - 1]} cells">${fr.moved} moved${far ? ` · ${far} far` : ''}</span>` : 'start'}`;
      return stacked ? `<figure><figcaption>${cap}</figcaption>${pic}</figure>` : `<figure${figStyle}>${pic}<figcaption>${cap}</figcaption></figure>`;
    }).join('');
    return `<div class="film" id="film-${fi}-${ci}">
<div class="fh"><span class="dot" style="background:${familyColour(c.strategy)}"></span><b>${esc(c.label)}</b> <code>${esc(c.strategy)} ${esc(optText(c))}</code>
${stacked ? `<span class="rel" title="stacked filmstrips are scaled to fill the width; this bar shows the config's viewport width relative to the widest config of this repo"><span style="width:${r2(Math.max(2, ratio * 100))}%"></span></span><small class="muted">${Math.round(c.film.viewport.w)}×${Math.round(c.film.viewport.h)} u</small>` : ''}
<span class="sp" title="share of nodes moved per commit, over the history">${sparkline(c.summary.series.movedFrac)}</span>
<button class="play" data-play="${fi},${ci}">▶ player</button></div>
<div class="${stacked ? 'stack' : 'strip'}"><div>${figs}</div></div></div>`;
  }).join('');
}

interface ScoreRow {
  label: string;
  strategy: string;
  repos: number;
  groups: number[]; // per SCORE_GROUPS entry, mean over repos (NaN = never available)
  ingredients: number[]; // per stability ingredient, mean over repos
}

const meanOf = (a: number[]) => {
  const v = a.filter((x) => !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};

/** Cross-repo composite scores (see SCORE_GROUPS and scoreDefinition). Sorted by the first group. */
export function crossRepoScores(fixtures: FixtureResult[]): ScoreRow[] {
  const labels: string[] = [];
  const strat = new Map<string, string>();
  for (const f of fixtures) for (const c of f.configs) if (!strat.has(c.label)) {
    labels.push(c.label);
    strat.set(c.label, c.strategy);
  }
  const stab = SCORE_GROUPS[0];
  // label -> per group / per stability ingredient: list of per-repo scores
  const acc = new Map(labels.map((l) => [l, { repos: 0, groups: SCORE_GROUPS.map(() => [] as number[]), ingr: stab.ingredients.map(() => [] as number[]) }]));
  for (const f of fixtures) {
    const colScore = new Map<string, number[]>();
    const cols = [...new Set(SCORE_GROUPS.flatMap((g) => g.ingredients.flatMap((i) => i.cols)))];
    for (const k of cols) {
      const col = column(k);
      colScore.set(k, normRanks(f.configs.map((c) => col.get(c.summary)), col.better as 'low' | 'high').map((r) => 100 * (1 - r)));
    }
    f.configs.forEach((c, ci) => {
      const a = acc.get(c.label)!;
      a.repos++;
      SCORE_GROUPS.forEach((g, gi) => {
        const ing = g.ingredients.map((i) => meanOf(i.cols.map((k) => colScore.get(k)![ci])));
        a.groups[gi].push(meanOf(ing));
        if (gi === 0) ing.forEach((v, ii) => a.ingr[ii].push(v));
      });
    });
  }
  return labels
    .map((l) => {
      const a = acc.get(l)!;
      return { label: l, strategy: strat.get(l)!, repos: a.repos, groups: a.groups.map(meanOf), ingredients: a.ingr.map(meanOf) };
    })
    .sort((x, y) => (Number.isNaN(y.groups[0]) ? -1 : y.groups[0]) - (Number.isNaN(x.groups[0]) ? -1 : x.groups[0]) || (x.label < y.label ? -1 : 1));
}

function summaryTable(fixtures: FixtureResult[]): string {
  const rows = crossRepoScores(fixtures);
  if (!rows.length) return '';
  const stab = SCORE_GROUPS[0];
  const cell = (v: number) => (Number.isNaN(v) ? '<td data-v="">–</td>' : `<td data-v="${r2(v)}" style="--s:${r2(v / 100)}" class="heat">${Math.round(v)}</td>`);
  const head = `<tr><th class="lbl">config</th>${SCORE_GROUPS.map((g) => `<th>${esc(g.label)}<i>↑</i></th>`).join('')}${stab.ingredients.map((i) => `<th class="sub" title="${esc(stab.label)} ingredient">${esc(i.label)}</th>`).join('')}<th>repos</th></tr>`;
  const body = rows.map((r, i) => `<tr><th class="lbl" data-v="${esc(r.label)}"><span class="rk">${i + 1}</span><span class="dot" style="background:${familyColour(r.strategy)}"></span>${esc(r.label)}</th>${r.groups.map(cell).join('')}${r.ingredients.map(cell).join('')}<td data-v="${r.repos}">${r.repos}</td></tr>`).join('');
  return `<div class="tw"><table class="sb sortable sum"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

const KIND_TITLES: Record<string, string> = { public: 'Public repos', synthetic: 'Synthetic repos' };

/** Rankings per fixture kind (public, synthetic, …) and combined. */
function summarySection(fixtures: FixtureResult[]): string {
  const kinds = [...new Set(fixtures.map((f) => f.kind ?? 'other'))].sort((a, b) => (a === 'public' ? -1 : b === 'public' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const parts: { title: string; note: string; fx: FixtureResult[] }[] = kinds.map((k) => {
    const fx = fixtures.filter((f) => (f.kind ?? 'other') === k);
    const note = k === 'synthetic'
      ? 'Generated stress repos, each built to break one kind of strategy (explosion, mass move, churn, alphabet adversary, deep nesting). Adversarial by design: read as "where does it fail", not as typical behaviour.'
      : k === 'public' ? 'Real histories: the ranking that says what to expect in practice.' : '';
    return { title: KIND_TITLES[k] ?? `${k} repos`, note, fx };
  });
  if (kinds.length > 1) parts.push({ title: 'All repos', note: 'Public and synthetic together, each repo weighted equally (so synthetics dominate by count).', fx: fixtures });
  const blocks = parts.map((p) => `<h3>${esc(p.title)} <small class="muted">(${p.fx.length}: ${p.fx.map((f) => esc(f.name)).join(', ')})</small></h3>
${p.note ? `<p class="muted small">${esc(p.note)}</p>` : ''}
${summaryTable(p.fx)}`).join('\n');
  return `<p class="small">${esc(scoreDefinition())} Ranks hide magnitudes — check the per-repo tables.</p>
${blocks}`;
}

// ---------- client ----------

/* eslint-disable */
function client(): void {
  const D: any = JSON.parse((document.getElementById('data') as any).textContent);
  const $ = (s: string) => document.querySelector(s) as any;
  const status = $('#selfcheck');
  const report = (m: string, bad?: boolean) => {
    status.textContent = m;
    if (bad) status.className = 'bad';
  };
  window.addEventListener('error', (e: any) => report('script error: ' + e.message, true));

  // ---- sortable tables ----
  document.querySelectorAll('table.sortable').forEach((t: any) => {
    t.querySelectorAll('thead th').forEach((th: any, ci: number) => {
      th.addEventListener('click', () => {
        const tb = t.tBodies[0];
        const rows = Array.from(tb.rows) as any[];
        const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        t.querySelectorAll('thead th').forEach((h: any) => delete h.dataset.dir);
        th.dataset.dir = dir;
        const key = (r: any) => {
          const c = r.cells[ci];
          const v = c.dataset.v;
          const n = parseFloat(v);
          return isNaN(n) ? v || c.textContent : n;
        };
        rows.sort((a, b) => {
          const x = key(a), y = key(b);
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
          return dir === 'asc' ? r : -r;
        });
        rows.forEach((r) => tb.appendChild(r));
      });
    });
  });

  // ---- decoding with snapshots ----
  const SNAP = 10;
  const cache = new Map();
  function player(fi: number, ci: number): any {
    const k = fi + ',' + ci;
    if (cache.has(k)) {
      const v = cache.get(k);
      cache.delete(k);
      cache.set(k, v);
      return v;
    }
    while (cache.size >= 8) cache.delete(cache.keys().next().value);
    const fx = D.fixtures[fi], c = fx.configs[ci];
    const p = c.player;
    const n = p.kinds.length;
    const r = { b: b64bytes(p.data), p: 0 };
    const st = pdNew(n);
    const offs: number[] = [], snaps: any[] = [];
    for (let i = 0; i < p.frames.length; i++) {
      if (i % SNAP === 0) snaps.push({ s: pdCopy(st), p: r.p });
      offs.push(r.p);
      pdFrame(r, st, null);
    }
    if (r.p !== r.b.length) throw new Error('decode length mismatch ' + r.p + ' != ' + r.b.length);
    const v = { fx: fx, c: c, p: p, n: n, bytes: r.b, snaps: snaps, offs: offs };
    cache.set(k, v);
    return v;
  }
  function stateAt(P: any, i: number): any {
    const sn = P.snaps[Math.floor(i / SNAP)];
    const st = pdCopy(sn.s);
    const r = { b: P.bytes, p: sn.p };
    let moved: number[] = [], dist: number[] = [];
    for (let j = Math.floor(i / SNAP) * SNAP; j <= i; j++) {
      moved = [];
      dist = [];
      pdFrame(r, st, moved, dist);
    }
    return { st: st, moved: moved, dist: dist };
  }

  // ---- drawing ----
  const COL = D.colours, PAL = D.palette, NS = D.sizeBuckets, MT = D.moveTiers, MC = D.moveColours, MW = D.moveWidths;
  const tierOf = (d: number) => {
    let t = 0;
    while (t < MT.length && d >= MT[t]) t++;
    return t;
  };
  const farCount = (dist: number[]) => dist.filter((d) => d >= MT[MT.length - 1]).length;
  function draw(cv: any, P: any, i: number, view: any, opts: any) {
    const S = stateAt(P, i);
    const st = S.st, F = st.f;
    const dpr = window.devicePixelRatio || 1;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = PAL.ground;
    g.fillRect(0, 0, cv.width, cv.height);
    const s = view.s * dpr;
    g.setTransform(s, 0, 0, s, -view.x * s, -view.y * s);
    const lw = 1 / s;
    const kinds = P.p.kinds, par = P.p.dirParent;
    const meta = P.fx.metas[P.p.frames[i]];
    const commit = meta[0], total = P.fx.used;
    // wires
    g.strokeStyle = PAL.wire;
    g.lineWidth = Math.max(lw, 0.12);
    g.beginPath();
    for (let k = 0; k < st.n; k++) {
      if (!st.live[k] || kinds[k] !== 'd' || par[k] < 0 || !st.live[par[k]]) continue;
      const q = par[k];
      if (!opts.ghosts && (F[4][k] & 1 || F[4][q] & 1)) continue;
      const ws = P.p.wires || 'elbow';
      if (ws === 'none') continue;
      const px = F[0][q] / 100, py = F[1][q] / 100, pw = F[2][q] / 100, ph = F[3][q] / 100;
      const cx = F[0][k] / 100, cy = F[1][k] / 100, cw = F[2][k] / 100, chh = F[3][k] / 100;
      if (ws === 'straight') {
        g.moveTo(px + pw / 2, py + ph / 2); g.lineTo(cx + cw / 2, cy + chh / 2);
        continue;
      }
      const x1 = px + pw / 2, y1 = py + ph, x2 = cx + cw / 2, y2 = cy;
      const ym = ws === 'bus' ? y1 + Math.min(1, (y2 - y1) / 2) : (y1 + y2) / 2;
      g.moveTo(x1, y1); g.lineTo(x1, ym); g.lineTo(x2, ym); g.lineTo(x2, y2);
    }
    g.stroke();
    // platforms
    g.fillStyle = PAL.platform;
    g.strokeStyle = PAL.platformEdge;
    g.lineWidth = Math.max(lw, 0.08);
    for (let k = 0; k < st.n; k++) {
      if (!st.live[k] || kinds[k] !== 'd') continue;
      const x = F[0][k] / 100, y = F[1][k] / 100, w = F[2][k] / 100, h = F[3][k] / 100;
      if (F[4][k] & 1) {
        if (!opts.ghosts) continue;
        g.setLineDash([3 * lw, 2 * lw]);
        g.strokeStyle = PAL.ghost;
        g.strokeRect(x, y, w, h);
        g.setLineDash([]);
        g.strokeStyle = PAL.platformEdge;
      } else {
        g.fillRect(x, y, w, h);
        g.strokeRect(x, y, w, h);
      }
    }
    // files
    for (let k = 0; k < st.n; k++) {
      if (!st.live[k] || kinds[k] !== 'f') continue;
      const x = F[0][k] / 100, y = F[1][k] / 100, w = F[2][k] / 100, h = F[3][k] / 100;
      if (F[4][k] & 1) {
        if (!opts.ghosts) continue;
        g.strokeStyle = PAL.ghost;
        g.lineWidth = lw;
        g.strokeRect(x, y, w, h);
      } else {
        g.fillStyle = COL[recencyBucket(commit - F[5][k], total)][F[6][k] % NS];
        g.fillRect(x, y, w, h);
      }
    }
    const mv = opts.movedList || S.moved, md = opts.movedDist || S.dist;
    if (opts.moved && mv.length) {
      // one pass per tier, faint (short moves) first so long moves draw on top
      for (let t = 0; t <= MT.length; t++) {
        g.strokeStyle = MC[t];
        g.lineWidth = Math.max(MW[t] * 1.4 * lw, 0.07 * MW[t]);
        g.beginPath();
        for (let j = 0; j < mv.length; j++) if (tierOf(md[j]) === t) { const k = mv[j]; g.rect(F[0][k] / 100, F[1][k] / 100, F[2][k] / 100, F[3][k] / 100); }
        g.stroke();
      }
    }
    return { S: S, meta: meta };
  }
  function fitView(cv: any, vp: any) {
    const s = Math.min(cv.clientWidth / vp.w, cv.clientHeight / vp.h);
    return { s: s, x: vp.x - (cv.clientWidth / s - vp.w) / 2, y: vp.y };
  }

  // ---- canvas filmstrips (fixtures over the inline-SVG budget) ----
  function drawFilmStrip(strip: any) {
    const prevBy: any = {};
    strip.querySelectorAll('canvas.fc').forEach((cv: any) => {
      const a = cv.dataset.fc.split(',').map(Number);
      const P = player(a[0], a[1]);
      // nearest available frame at the chosen resolution
      let best = 0;
      P.p.frames.forEach((m: number, i: number) => {
        if (Math.abs(m - a[2]) < Math.abs(P.p.frames[best] - a[2])) best = i;
      });
      if (P.p.frames[best] !== a[2]) {
        // reduced player resolution: say which commit is actually drawn
        const fc = cv.parentElement.querySelector('figcaption');
        const m = P.fx.metas[P.p.frames[best]];
        if (fc) fc.textContent = '≈ #' + m[0] + ' · ' + new Date(m[1] * 1000).toISOString().slice(0, 10) + ' (nearest frame kept)';
      }
      const key = a[0] + ',' + a[1];
      const prev = prevBy[key];
      const moved: number[] = [], dist: number[] = [];
      if (prev) {
        // moved since the previous filmstrip frame: live, non-ghost in both, x/y changed
        const cur = stateAt(P, best).st, ps = prev.st;
        for (let k = 0; k < cur.n; k++) {
          if (!cur.live[k] || !ps.live[k] || cur.f[4][k] & 1 || ps.f[4][k] & 1) continue;
          if (cur.f[0][k] !== ps.f[0][k] || cur.f[1][k] !== ps.f[1][k]) {
            moved.push(k);
            dist.push(Math.hypot(cur.f[0][k] - ps.f[0][k], cur.f[1][k] - ps.f[1][k]) / 100);
          }
        }
      }
      const r = draw(cv, P, best, fitView(cv, P.c.filmVp), { moved: true, ghosts: true, movedList: moved, movedDist: dist });
      prevBy[key] = r.S;
    });
  }
  function drawFilmCanvases() {
    const strips = Array.from(document.querySelectorAll('.film')).filter((f: any) => f.querySelector('canvas.fc'));
    if (!('IntersectionObserver' in window)) return strips.forEach(drawFilmStrip);
    const io = new IntersectionObserver((es: any) => es.forEach((e: any) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      drawFilmStrip(e.target);
    }), { rootMargin: '400px' });
    strips.forEach((s) => io.observe(s));
  }

  // ---- side by side ----
  // One slider drives several configs of the same repo. Every player of a repo samples the same
  // frame-meta indices, so frame i is the same commit in each (the nearest one if a config was
  // stored at reduced resolution).
  function compare() {
    const box = $('#compare');
    if (!box || !D.compare || !D.compare.length) return;
    const cfx = $('#cfx'), cgr = $('#cgr'), cs = $('#cslider'), grid = $('#cgrid'), cinfo = $('#cinfo');
    let cells: any[] = [], ctimer: any = 0, ci = 0;
    D.fixtures.forEach((f: any, i: number) => cfx.add(new Option(f.name, String(i))));
    D.compare.forEach((g: any, i: number) => cgr.add(new Option(g.label, String(i))));
    const nearest = (frames: number[], meta: number) => {
      let j = 0;
      frames.forEach((m: number, i: number) => { if (Math.abs(m - meta) < Math.abs(frames[j] - meta)) j = i; });
      return j;
    };
    function build() {
      const fi = +cfx.value, f = D.fixtures[fi], g = D.compare[+cgr.value];
      grid.innerHTML = '';
      cells = [];
      g.configs.forEach((label: string) => {
        const k = f.configs.findIndex((c: any) => c.label === label);
        if (k < 0) return;
        const fig = document.createElement('figure');
        fig.innerHTML = '<figcaption><b></b> <span class="muted"></span></figcaption><canvas></canvas>';
        grid.appendChild(fig);
        (fig.querySelector('b') as any).textContent = label;
        cells.push({ P: player(fi, k), cv: fig.querySelector('canvas'), cap: fig.querySelector('span') });
      });
      if (!cells.length) return;
      cs.max = String(cells[0].P.p.frames.length - 1);
      ci = +cs.max;
      cs.value = String(ci);
      draw4();
    }
    // bbox of everything drawn, and the area of live file cells (a file box is 0.8 of its cell)
    function frameBox(st: any, kinds: string) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cells = 0;
      const F = st.f;
      for (let k = 0; k < st.n; k++) {
        if (!st.live[k]) continue;
        x0 = Math.min(x0, F[0][k]); y0 = Math.min(y0, F[1][k]);
        x1 = Math.max(x1, F[0][k] + F[2][k]); y1 = Math.max(y1, F[1][k] + F[3][k]);
        if (kinds[k] === 'f' && !(F[4][k] & 1)) cells += (F[2][k] / 80) * (F[3][k] / 80);
      }
      return x1 > x0 ? { w: (x1 - x0) / 100, h: (y1 - y0) / 100, cells: cells } : { w: 0, h: 0, cells: 0 };
    }
    function draw4() {
      if (!cells.length) return;
      const same = $('#csame').checked;
      cells.forEach((c) => {
        const w = c.cv.parentElement.clientWidth;
        c.cv.style.height = Math.round(w) + 'px';
      });
      // shared scale: the smallest fit scale, so the biggest layout fills its square
      let s = Infinity;
      if (same) cells.forEach((c) => { s = Math.min(s, c.cv.clientWidth / c.P.c.vp.w, c.cv.clientHeight / c.P.c.vp.h); });
      const meta0 = cells[0].P.p.frames[ci];
      cells.forEach((c) => {
        const i = nearest(c.P.p.frames, meta0);
        const vp = c.P.c.vp, cw = c.cv.clientWidth, ch = c.cv.clientHeight;
        const sc = same ? s : Math.min(cw / vp.w, ch / vp.h);
        const view = { s: sc, x: vp.x - (cw / sc - vp.w) / 2, y: vp.y - (ch / sc - vp.h) / 2 };
        const r = draw(c.cv, c.P, i, view, { moved: $('#cmoved').checked, ghosts: true });
        const b = frameBox(r.S.st, c.P.p.kinds);
        const side = Math.max(b.w, b.h);
        c.cap.textContent = Math.round(b.w) + ' × ' + Math.round(b.h) + ' · aspect ' + (b.h ? (b.w / b.h).toFixed(2) : '–') + ' · uses ' + (side ? Math.round((100 * b.w * b.h) / (side * side)) : 0) + '% of its square · files fill ' + (b.w * b.h ? ((100 * b.cells) / (b.w * b.h)).toFixed(1) : 0) + '% of the box';
      });
      const m = cells[0].P.fx.metas[meta0];
      cinfo.textContent = '#' + m[0] + ' of ' + (cells[0].P.fx.used - 1) + ' · ' + new Date(m[1] * 1000).toISOString().slice(0, 10) + ' · ' + m[3];
    }
    function cstop() {
      if (ctimer) clearInterval(ctimer);
      ctimer = 0;
      $('#cplay').textContent = '▶';
    }
    $('#cplay').addEventListener('click', () => {
      if (ctimer) return cstop();
      if (ci >= +cs.max) ci = 0;
      $('#cplay').textContent = '❚❚';
      ctimer = setInterval(() => {
        if (ci >= +cs.max) return cstop();
        ci++;
        cs.value = String(ci);
        draw4();
      }, 1000 / +$('#cfps').value);
    });
    cs.addEventListener('input', () => { ci = +cs.value; draw4(); });
    cfx.addEventListener('change', () => { cstop(); build(); });
    cgr.addEventListener('change', () => { cstop(); build(); });
    $('#csame').addEventListener('change', draw4);
    $('#cmoved').addEventListener('change', draw4);
    window.addEventListener('resize', draw4);
    build();
  }

  // ---- player ----
  const cv = $('#pc'), fxSel = $('#pfx'), cfSel = $('#pcf'), slider = $('#pslider'), info = $('#pinfo'), info2 = $('#pinfo2');
  let P: any = null, idx = 0, view: any = null, timer: any = 0, last: any = null;
  const opts = { moved: true, ghosts: true };
  D.fixtures.forEach((f: any, i: number) => fxSel.add(new Option(f.name, String(i))));
  function fillConfigs(keep?: string) {
    const f = D.fixtures[+fxSel.value];
    cfSel.innerHTML = '';
    f.configs.forEach((c: any, i: number) => cfSel.add(new Option(c.label, String(i))));
    if (keep) {
      const j = f.configs.findIndex((c: any) => c.label === keep);
      if (j >= 0) cfSel.value = String(j);
    }
  }
  function sizeCanvas() {
    const vp = P.c.vp;
    const w = cv.parentElement.clientWidth;
    const h = Math.max(220, Math.min(window.innerHeight * 0.62, 640, w * (vp.h / vp.w) + 8));
    cv.style.height = Math.round(h) + 'px';
  }
  function load(fi: number, ci: number, at?: number) {
    stop();
    P = player(fi, ci);
    slider.max = String(P.p.frames.length - 1);
    idx = at === undefined ? P.p.frames.length - 1 : at;
    slider.value = String(idx);
    sizeCanvas();
    view = fitView(cv, P.c.vp);
    render();
  }
  function render() {
    if (!P) return;
    const r = draw(cv, P, idx, view, opts);
    last = r;
    const m = r.meta;
    info.textContent = '#' + m[0] + ' of ' + (P.fx.used - 1) + ' · ' + new Date(m[1] * 1000).toISOString().slice(0, 10) + ' · ' + m[2] + ' · ' + m[3];
    let live = 0;
    for (let k = 0; k < r.S.st.n; k++) if (r.S.st.live[k] && P.p.kinds[k] === 'f' && !(r.S.st.f[4][k] & 1)) live++;
    const far = farCount(r.S.dist);
    info2.textContent = 'frame ' + (idx + 1) + '/' + P.p.frames.length + ' · ' + live + ' files · ' + (idx ? r.S.moved.length + ' moved since previous frame (' + far + ' by ≥ ' + MT[MT.length - 1] + ' cells)' : 'first frame');
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
    $('#pplay').textContent = '▶';
  }
  $('#pplay').addEventListener('click', () => {
    if (timer) return stop();
    if (idx >= P.p.frames.length - 1) idx = 0;
    $('#pplay').textContent = '❚❚';
    timer = setInterval(() => {
      if (idx >= P.p.frames.length - 1) return stop();
      idx++;
      slider.value = String(idx);
      render();
    }, 1000 / +$('#pfps').value);
  });
  $('#pfps').addEventListener('change', () => {
    if (timer) {
      stop();
      $('#pplay').click();
    }
  });
  slider.addEventListener('input', () => {
    idx = +slider.value;
    render();
  });
  $('#pprev').addEventListener('click', () => { stop(); idx = Math.max(0, idx - 1); slider.value = String(idx); render(); });
  $('#pnext').addEventListener('click', () => { stop(); idx = Math.min(P.p.frames.length - 1, idx + 1); slider.value = String(idx); render(); });
  fxSel.addEventListener('change', () => { const keep = cfSel.selectedOptions[0] && cfSel.selectedOptions[0].text; fillConfigs(keep); load(+fxSel.value, +cfSel.value); });
  cfSel.addEventListener('change', () => {
    const f = D.fixtures[+fxSel.value];
    const oldMeta = P ? P.p.frames[idx] : 0;
    const np = f.configs[+cfSel.value].player.frames;
    let j = 0;
    np.forEach((m: number, i: number) => { if (Math.abs(m - oldMeta) < Math.abs(np[j] - oldMeta)) j = i; });
    load(+fxSel.value, +cfSel.value, j);
  });
  $('#pmoved').addEventListener('change', (e: any) => { opts.moved = e.target.checked; render(); });
  $('#pghost').addEventListener('change', (e: any) => { opts.ghosts = e.target.checked; render(); });
  const zoom = (f: number, cx?: number, cy?: number) => {
    if (cx === undefined) { cx = cv.clientWidth / 2; cy = cv.clientHeight / 2; }
    const wx = view.x + cx / view.s, wy = view.y + (cy as number) / view.s;
    view.s *= f;
    view.x = wx - cx / view.s;
    view.y = wy - (cy as number) / view.s;
    render();
  };
  $('#pzin').addEventListener('click', () => zoom(1.6));
  $('#pzout').addEventListener('click', () => zoom(1 / 1.6));
  $('#pfit').addEventListener('click', () => { view = fitView(cv, P.c.vp); render(); });
  cv.addEventListener('wheel', (e: any) => { e.preventDefault(); const b = cv.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - b.left, e.clientY - b.top); }, { passive: false });
  let drag: any = null;
  cv.addEventListener('pointerdown', (e: any) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e: any) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) { view.x = drag.vx - dx / view.s; view.y = drag.vy - dy / view.s; render(); }
  });
  cv.addEventListener('pointerup', (e: any) => {
    const was = drag;
    drag = null;
    if (!was || was.moved || !last) return;
    // tap: name the node under the pointer
    const b = cv.getBoundingClientRect();
    const wx = (view.x + (e.clientX - b.left) / view.s) * 100, wy = (view.y + (e.clientY - b.top) / view.s) * 100;
    const st = last.S.st, F = st.f;
    let hit = -1;
    for (let k = 0; k < st.n; k++) {
      if (!st.live[k]) continue;
      if (!opts.ghosts && F[4][k] & 1) continue; // hidden
      if (wx >= F[0][k] && wx <= F[0][k] + F[2][k] && wy >= F[1][k] && wy <= F[1][k] + F[3][k]) {
        if (hit < 0 || P.p.kinds[k] === 'f') hit = k;
      }
    }
    if (hit >= 0) {
      const path = P.p.kinds[hit] === 'd' ? P.fx.strings[P.p.dirPath[hit]] || '/' : P.fx.strings[F[7][hit]];
      $('#ptip').textContent = (F[4][hit] & 1 ? 'ghost: ' : '') + path + (P.p.kinds[hit] === 'f' ? ' · last modified #' + F[5][hit] : '');
    } else $('#ptip').textContent = '';
  });
  window.addEventListener('resize', () => { if (P) { sizeCanvas(); view = fitView(cv, P.c.vp); render(); } });
  document.querySelectorAll('button.play').forEach((b: any) => b.addEventListener('click', () => {
    const a = b.dataset.play.split(',').map(Number);
    fxSel.value = String(a[0]);
    fillConfigs();
    cfSel.value = String(a[1]);
    $('#player').scrollIntoView({ behavior: 'smooth' });
    load(a[0], a[1], 0);
  }));

  if (D.fixtures.length && D.fixtures[0].configs.length) {
    fillConfigs();
    load(0, 0);
    report('player ready · self-check pending');
    drawFilmCanvases();
    compare();
    // self-check: decode every frame of every player once (no caching, so memory stays flat),
    // and compare the decoded geometry of a few frames with checksums taken from the source
    // frames at build time.
    const check = () => {
      let frames = 0, sums = 0;
      D.fixtures.forEach((f: any) => f.configs.forEach((c: any) => {
        const p = c.player, r = { b: b64bytes(p.data), p: 0 }, st = pdNew(p.kinds.length);
        const want = new Map(c.check.map((x: number[]) => [x[0], x[1]]));
        for (let i = 0; i < p.frames.length; i++) {
          pdFrame(r, st, null);
          if (!want.has(i)) continue;
          const got = pdChecksum(st);
          if (got !== want.get(i)) throw new Error('checksum mismatch in ' + f.name + '/' + c.label + ' frame ' + i + ': ' + got + ' != ' + want.get(i));
          sums++;
        }
        if (r.p !== r.b.length) throw new Error('decode mismatch in ' + f.name + '/' + c.label);
        frames += p.frames.length;
      }));
      report('ok · ' + frames + ' player frames decoded · ' + sums + ' frame checksums match');
    };
    if (/[?&]check\b/.test(location.search) || navigator.webdriver || !('requestIdleCallback' in window)) check();
    else (window as any).requestIdleCallback(check, { timeout: 4000 });
  } else report('no data');
}

function compareSection(): string {
  return `<section id="compare"><h2>Side by side</h2>
<p class="muted small">The same repo and commit under each arrangement, on one slider. Each box is square, so empty space in a box is screen space the layout leaves unused. "Uses N% of its square" = bounding-box area / (longer side)². "Files fill N% of the box" = live file cells / bounding-box area (the compactness metric for this one frame). Tick "same scale" to compare absolute size instead.</p>
<div class="pctl"><select id="cfx" aria-label="repo"></select><select id="cgr" aria-label="group"></select>
<label><input type="checkbox" id="csame"> same scale</label><label><input type="checkbox" id="cmoved" checked> moved</label></div>
<div class="pctl"><button id="cplay" aria-label="play">▶</button><input id="cslider" type="range" min="0" max="0" value="0" aria-label="frame" style="flex:1 1 160px;accent-color:var(--accent);min-height:32px">
<select id="cfps" aria-label="speed"><option value="3">3 fps</option><option value="8" selected>8 fps</option><option value="20">20 fps</option></select></div>
<p id="cinfo" class="pinfo"></p>
<div id="cgrid" class="cgrid"></div>
</section>`;
}

// ---------- assembly ----------

/** Frames per player whose decoded geometry the self-check compares with build-time checksums. */
const CHECK_FRAMES = 5;

export function buildReport(fixtures: FixtureResult[], o: ReportOptions): ReportResult {
  const p = plan(fixtures, o.budgetBytes);
  const levels: Record<string, number> = {};
  const data = {
    colours: FILE_COLOURS,
    palette: PALETTE,
    sizeBuckets: SIZE_BUCKETS,
    moveTiers: MOVE_TIERS,
    moveColours: MOVE_COLOURS,
    moveWidths: MOVE_WIDTHS,
    compare: o.compare ?? [],
    fixtures: fixtures.map((f) => ({
      name: f.name,
      used: f.used,
      metas: f.metas,
      strings: f.strings,
      configs: f.configs.map((c) => {
        const L = p.level.get(c)!;
        levels[`${f.name}/${c.label}`] = L;
        const pl = c.players[L];
        return {
          label: c.label,
          strategy: c.strategy,
          vp: c.playerViewport,
          filmVp: c.film.viewport,
          player: { frames: pl.frames, kinds: pl.kinds, dirPath: pl.dirPath, dirParent: pl.dirParent, data: pl.data, wires: pl.wires },
          check: pl.sums ? evenly(pl.frames.length, CHECK_FRAMES).map((i) => [i, pl.sums[i]]) : [],
        };
      }),
    })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  const nav = fixtures.map((f, i) => `<a href="#fx-${i}">${esc(f.name)}</a>`).join('');
  const fxSections = fixtures.map((f, i) => {
    const skipped = f.skipped.length
      ? `<p class="muted small">Skipped: ${f.skipped.map((s) => `${esc(s.label)} (${esc(s.reason)})`).join('; ')}</p>`
      : '';
    const truncated = f.used < f.totalCommits ? ` (first ${f.used.toLocaleString('en-US')} of ${f.totalCommits.toLocaleString('en-US')})` : '';
    const last = f.metas.at(-1);
    const span = f.metas.length ? `${date(f.metas[0][1])} → ${date(last![1])}` : '';
    const files = f.configs[0]?.summary.finalLiveFiles ?? 0;
    return `<section class="fx" id="fx-${i}">
<h2>${esc(f.name)} <small>${esc(f.kind ?? '')}</small></h2>
<p class="meta">${f.used.toLocaleString('en-US')} commits${truncated} · ${span} · ${files.toLocaleString('en-US')} files at the end · head <code>${esc(f.head.slice(0, 10))}</code>${f.note ? ` · ${esc(f.note)}` : ''}</p>
${skipped}
<h3>Scoreboard</h3>
<p class="muted small">Tap a column to sort. Highlighted = best in column. Hover/long-press a header for its definition.</p>
${scoreboard(f)}
<h3>Stability vs compactness</h3>
${scatter(f)}
<h3>Filmstrips</h3>
<p class="muted small">${f.configs[0]?.film.frames.length ?? 0} evenly spaced commits per config${isStacked(f) ? ', stacked top to bottom because the layouts are very wide. Each config is scaled to the full width (rows capped at 220 px tall); the grey bar beside its name shows its width relative to the widest config' : ''}. Frames of one config share a viewport, so growth is visible${isStacked(f) ? '' : ', and all configs of this repo share one scale, so sprawl is comparable'}. Outline = moved since the previous frame in the strip, brighter for longer moves (see legend; "far" = ≥ ${MOVE_TIERS[MOVE_TIERS.length - 1]} cells). Frames are many commits apart, so outlines add up all the motion in between.</p>
${filmstrips(f, i, p.canvasFilm.has(f.name))}
</section>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>git-layout · ${esc(o.title ?? 'layout stability report')}</title>
<style>${CSS}</style></head>
<body>
<header><h1>git-layout <span>${esc(o.title ?? 'layout stability report')}</span></h1>
<p class="muted small">Generated ${esc(o.generated)} · ${fixtures.length} repos · ${new Set(fixtures.flatMap((f) => f.configs.map((c) => c.label))).size} configs · <span id="selfcheck">player not initialised (JavaScript off?)</span></p>
<nav><a href="#about">about</a>${o.compare?.length ? '<a href="#compare">side by side</a>' : ''}<a href="#summary">summary</a><a href="#player">player</a>${nav}</nav></header>
<main>
${intro(o.about)}
${o.compare?.length ? compareSection() : ''}
<section id="summary"><h2>Across repos</h2>${summarySection(fixtures)}</section>
<section id="player"><h2>Player</h2>
<div class="pctl"><select id="pfx" aria-label="repo"></select><select id="pcf" aria-label="config"></select></div>
<div class="pctl"><button id="pprev" aria-label="previous">◀</button><button id="pplay" aria-label="play">▶</button><button id="pnext" aria-label="next">▶︎|</button>
<input id="pslider" type="range" min="0" max="0" value="0" aria-label="frame">
<select id="pfps" aria-label="speed"><option value="3">3 fps</option><option value="8" selected>8 fps</option><option value="20">20 fps</option></select></div>
<div class="pwrap"><canvas id="pc"></canvas></div>
<div class="pctl small"><button id="pzout">−</button><button id="pzin">+</button><button id="pfit">fit</button>
<label><input type="checkbox" id="pmoved" checked> moved</label><label><input type="checkbox" id="pghost" checked> ghosts</label></div>
<p id="pinfo" class="pinfo"></p><p id="pinfo2" class="muted small"></p><p id="ptip" class="small"></p>
<p class="muted small">Frames are evenly spaced samples of the history; outline = moved since the previous frame shown (all the motion between two samples adds up), brighter for longer moves: ${MOVE_TIERS.map((_, t) => moveTierText(t)).concat(moveTierText(MOVE_TIERS.length)).join(' / ')}. Drag to pan, wheel or ± to zoom, tap a box to name it.</p>
</section>
${fxSections}
${p.notes.length ? `<section><h2>Notes</h2><ul class="small">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
</main>
<footer class="muted small">${o.command ? `<code>${esc(o.command)}</code><br>` : ''}All data inline; no network requests.</footer>
<script type="application/json" id="data">${json}</script>
<script>
const RECENCY_BUCKETS = ${RECENCY_BUCKETS};
${recencyBucket.toString()}
${decoderSource()}
(${client.toString()})();
</script>
</body></html>`;
  const film = fixtures.filter((f) => !p.canvasFilm.has(f.name)).reduce((s, f) => s + f.configs.reduce((a, c) => a + c.film.bytes, 0), 0);
  return { html, notes: p.notes, bytes: { total: Buffer.byteLength(html), film, player: json.length }, levels };
}

const CSS = `
:root{--bg:#0b1016;--panel:#111922;--line:#223142;--text:#d6e1ec;--muted:#8193a7;--accent:#ff4fd8;--best:#1f4d3a;--film:240px;color-scheme:dark}
@media (max-width:640px){:root{--film:150px}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;-webkit-text-size-adjust:100%}
header,main,footer{max-width:1200px;margin:0 auto;padding:0 14px}
header{padding-top:14px}
h1{font-size:1.35rem;margin:.2em 0}h1 span{color:var(--muted);font-weight:400}
h2{font-size:1.2rem;margin:1.6em 0 .4em;border-bottom:1px solid var(--line);padding-bottom:.2em}
h2 small{color:var(--muted);font-weight:400;font-size:.8rem}
h3{font-size:1rem;margin:1.3em 0 .3em;color:#b8c7d8}
a{color:#7fb4ff}
nav{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:.9rem;position:sticky;top:0;background:var(--bg);padding:6px 0;z-index:5;border-bottom:1px solid var(--line)}
code{font:12px ui-monospace,Menlo,monospace;color:#a9bbcf}
.muted{color:var(--muted)}.small{font-size:.85rem}
#selfcheck{color:#5fc28f}#selfcheck.bad{color:#ff6b6b}
.meta{color:var(--muted);font-size:.9rem;margin:.2em 0}
ul{padding-left:1.2em}
dl.defs{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:4px 14px;font-size:.9rem}
dl.defs dt{font-weight:600}dl.defs dd{margin:0;color:#b7c4d2}
.dir{font-weight:400;color:var(--muted);font-size:.8em}
@media (max-width:640px){dl.defs{grid-template-columns:1fr}dl.defs dd{margin-bottom:6px}}
details summary{cursor:pointer;color:#9cc3ff;margin:.4em 0}
.legend{display:flex;flex-direction:column;gap:4px;font-size:.82rem;margin:.6em 0;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.legend b{font-weight:600;margin-right:6px}
.sw{display:inline-flex;align-items:center;gap:3px;margin-right:8px;vertical-align:middle}.sw small{color:var(--muted)}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:6px}
table.sb{border-collapse:collapse;font-size:.82rem;font-variant-numeric:tabular-nums;white-space:nowrap;width:100%}
table.sb th,table.sb td{padding:5px 8px;text-align:right;border-bottom:1px solid #18232f}
table.sb thead th{background:#142030;color:#b9c9da;font-weight:600;cursor:pointer;position:sticky;top:0;vertical-align:bottom;white-space:normal;min-width:64px;font-size:.78rem}
table.sb thead th i{font-style:normal;color:var(--muted);margin-left:2px}
table.sb thead th[data-dir=asc]::after{content:" ▲";color:var(--accent)}table.sb thead th[data-dir=desc]::after{content:" ▼";color:var(--accent)}
table.sb .lbl{text-align:left;position:sticky;left:0;background:var(--panel);z-index:1;min-width:120px}
table.sb thead .lbl{background:#142030;z-index:2}
table.sb tbody tr:hover td,table.sb tbody tr:hover th{background:#172434}
td.best{background:var(--best);color:#e8fff3;font-weight:600}
table.sb .rk{display:inline-block;min-width:1.4em;color:var(--muted);font-weight:400}
td.heat{background:color-mix(in srgb,#2a78d6 calc(var(--s)*55%),transparent)}
th.sub{font-weight:400!important;color:var(--muted)!important}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:baseline}
figure{margin:0}
.scatter{overflow-x:auto}.scatter svg{width:100%;min-width:560px;max-width:760px;height:auto;display:block;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.scatter text{fill:var(--muted);font:11px system-ui,sans-serif}.scatter .at{fill:#a8b8c9}.scatter .pl{fill:var(--text)}
.scatter .better{fill:#5fc28f}.scatter .ld{stroke:#4a5d72;stroke-width:1}
.scatter .grid{stroke:#1d2a38;stroke-width:1}.scatter .axis{stroke:#3a4c60}
.scatter circle{stroke:var(--panel);stroke-width:2}.scatter circle.hit{stroke:none}
.scatter figcaption{font-size:.8rem;color:var(--muted);margin-top:4px;display:flex;gap:12px;flex-wrap:wrap}
.film{margin:10px 0 16px;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.fh{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:.88rem;margin-bottom:6px}
.fh code{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.spark polyline{fill:none;stroke:var(--accent);stroke-width:1.2}
.spark{background:#0d151d;border-radius:3px}
button{background:#1a2938;color:var(--text);border:1px solid #2e4358;border-radius:5px;padding:5px 10px;font:inherit;font-size:.85rem;cursor:pointer;min-height:32px}
button:hover{border-color:#4d6f92}
.strip{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}.strip>div{display:flex;gap:8px;align-items:flex-start}
.rel{display:inline-block;width:80px;height:6px;background:#0d151d;border-radius:3px;overflow:hidden}.rel span{display:block;height:100%;background:#6d86a0}
.stack{overflow-x:auto;-webkit-overflow-scrolling:touch}.stack>div{min-width:640px}
.stack figure{margin:0 0 6px}.stack figcaption{font-size:.7rem;color:var(--muted);margin-bottom:1px}
.stack svg,.stack canvas{display:block;border-radius:2px;background:${PALETTE.ground};height:auto}
.strip figure{flex:0 0 auto}
.strip svg,.strip canvas{display:block;border-radius:3px;background:${PALETTE.ground};max-width:none}
.strip figcaption{font-size:.7rem;line-height:1.3;color:var(--muted);margin-top:2px}
.mv{color:var(--accent)}
#player,#compare{scroll-margin-top:40px}
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.cgrid figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px;min-width:0}
.cgrid figcaption{font-size:.8rem;margin-bottom:4px;overflow-wrap:anywhere}
.cgrid canvas{display:block;width:100%;border-radius:3px;background:${PALETTE.ground}}
.pctl{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}
.pctl select{background:#1a2938;color:var(--text);border:1px solid #2e4358;border-radius:5px;padding:5px;font:inherit;font-size:.9rem;min-height:32px;max-width:100%}
#pslider{flex:1 1 160px;accent-color:var(--accent);min-height:32px}
.pwrap{width:100%;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:${PALETTE.ground}}
#pc{display:block;width:100%;height:320px;touch-action:none;cursor:grab}
.pinfo{font:12px ui-monospace,Menlo,monospace;margin:.4em 0 0;overflow-wrap:anywhere}
#ptip{color:#ffd27f;min-height:1.2em;margin:0;overflow-wrap:anywhere}
footer{padding:30px 14px}
`;
