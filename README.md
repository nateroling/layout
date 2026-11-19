# git-layout

fsn/fsv-style ("Jurassic Park file browser") layouts of a git repo's file tree at any commit, with
pluggable strategies for keeping the layout stable as the repo evolves — and metrics to compare them.

```sh
node bin/viz.ts strategies
node bin/viz.ts --repo ../fixtures/chalk --at HEAD --out out/
node bin/viz.ts --repo ../fixtures/chalk --strategy recompute --opt order=birth --opt align=left --every 50 --out out/
npm test
```

Requires Node >= 22.18 (runs TypeScript directly). No dependencies. See SPEC.md.

## Sweeps and the report

```sh
node bin/sweep.ts                                   # every fixture in fixtures.json × every config in sweep.json
node bin/sweep.ts --fixtures chalk --max-commits 200 --out out/quick
node bin/sweep.ts --fixtures express,ripgrep --configs "fsn classic,tombstone"
node bin/sweep.ts --report-only                     # rebuild index.html from out/report/parts/*.json
```

`sweep.json` lists configs (`{ label, strategy, options }`), optionally `fixtures` (names; default: all of
`fixtures.json`), `playerFrames` (150), `filmFrames` (8) and `budgetMB` (15). Configs whose strategy is not
registered are skipped with a warning. Each fixture runs in a child process (`--jobs`, default 2): one
replay per config over every commit, streaming frames into the metrics accumulator (`src/metrics/metrics.ts`)
and keeping only the sampled frames. Output in `out/report/`:

- `index.html` — one self-contained file (no network): metric guide, cross-repo scores, a player
  (scrub/play sampled frames on a canvas, moved nodes outlined, tap a box to name it), and per repo a
  sortable scoreboard, a stability-vs-compactness scatter and filmstrips. Static parts read without JS.
  To stay under `budgetMB`, the largest repos' filmstrips are drawn on canvas from player data, and
  player resolution drops (every 2nd/4th/8th sample) for the heaviest players; the report lists what it cut.
- `metrics.json` (full per-run summaries incl. files/dirs split and 120-bucket time series), `metrics.csv`.
- `svg/<fixture>/<config>-<commit>.svg` — captioned filmstrip frames; `parts/` — per-fixture intermediates.

Metrics (per run; "survivors" = nodes non-ghost in two consecutive frames, matched by id):
moved / commit and moved / tree change (share of survivors whose top-left moved, averaged over all
commits or only over commits that add/delete/rename), mean shift, p95 jump (log-binned, ±3%), max jump,
commits with motion, disruption (total distance), motion without change (content-only commits that still
moved something), compactness (live file cells / bbox area), ghost share, and name-order disorder (adjacent
siblings out of codepoint order).
