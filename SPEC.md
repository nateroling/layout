# git-layout — spec

Lay out a git repo's file tree, fsn/fsv "TreeV" style seen from above, at any commit — and measure how
stable each layout strategy is as the repo evolves. The point is to compare strategies under
different repo shapes, not to ship one answer.

## Pipeline

```
git log --first-parent --raw  ──►  History (events per commit)  ──►  Runner(strategy, options)
                                                                       │ step() every commit (state)
                                                                       │ frame() when asked (pure)
                                                                       ▼
                                                     Frame (nodes with x,y,w,h)  ──►  metrics / SVG / report
```

- **History** (`src/git/extract.ts`): first-parent timeline, merges diffed against first parent, renames
  via `-M`, blob sizes via one `cat-file --batch-check`. Submodules are skipped. Cached in `<project>/.cache/`
  (anchored at the project root, not the cwd), keyed by repo name + head sha + `EXTRACTOR_VERSION`;
  bump that constant whenever extraction semantics change.
- **Tree state** (`src/model/tree.ts`): files by path with a stable `id`, `born`, `arrived`, `modified`;
  directories with `arrived` and a live-file count. Renames keep identity when `followRenames=true`.
  Directories are deleted only at the end of a commit.
- **Runner** (`src/engine.ts`): replays commits; `step()` is the only place state changes, `frame()` is
  pure, so `at(n)` (resumed from the nearest checkpoint, every 250 commits by default) equals a full
  replay. Online strategies (`usesFuture: false`) never receive the History. Every live (non-ghost)
  node in a Frame gets `cid`: its identity under rename-following, whatever the strategy's own
  `followRenames` (directories: `cid = id`; files: `f:<id>` from a shadow rename-following tree).
  Metrics match nodes across frames by `cid`, so strategies with and without rename-following are
  compared like with like; `id` stays the strategy's own node identity.
- **Geometry** (`src/geometry/treev.ts`): directory = platform with a grid of file cells; each subtree
  owns a vertical band; children sit side by side in the row below, wired to the parent. Hooks let a
  strategy reserve more cols/rows/width than required. Unit: 1 file cell = 1.

## Strategies

| name | kind | idea |
|---|---|---|
| `recompute` | stateless | Lay out from scratch every commit. `order=name, align=center` = classic fsn (instability baseline). `order=birth, align=left` = birth order: existing siblings never reorder, but widening bands still push neighbours. |
| `hindsight` | uses future | One layout of the union of every path that ever existed; commit N just shows the live subset. Upper bound on stability, lower bound on compactness. |
| `slack` | online, stateful | Per-directory reservations for cols, rows and band width. When the requirement exceeds a reservation, grow it (`growthMode`). Never shrinks; a vanished directory drops its reservation. |
| `city` | online, stateful | Stretchable nested grid (its own arrangement; no `arrange` option). Each directory is a district on its own grid; cell 0 is its file lot, child directories take the earliest free cell in square-shell order and keep it. Column widths / row heights are ratchets (never shrink), so growth slides what lies beyond a seam outward and nothing is re-packed. Deleted files/dirs leave holes that new arrivals reuse. See `src/strategies/city.ts`. |
| `metro` | online, stateful | `city` grown from the centre: the file lot is cell (0,0) and child directories take cells on a square spiral around it in all four directions; every other district is a `city` mirrored to face away from the centre (orientation from the cell it sits in; in its parent's lot column/row it inherits the parent's), with its lot in the corner facing the centre and files filling away from it. Children hug the side of their cell nearest the lot, so every push points away from the centre. The root lot is pinned at the origin. |
| `metro-spiral` | online, stateful | `metro` where every district uses the root's rule: child directories take cells on the square spiral around the district's file lot in all four directions (no mirroring), so a folder lays out the same at any depth. Orientation (from the cell a district sits in, as in metro) only picks which side of a cell a child hugs and which corner the lot hugs: the side facing the parent's lot. Takes the same options as metro. |
| `metro-seams`, `metro-hex`, `metro-warp`, `metro-pack` | online, stateful | `metro` on looser grids (`src/strategies/metrogrid.ts`), to make it denser. Shared: each district grows +x/+y from its lot in local coordinates and is mirrored to face away from the centre; child positions are ratchets (only ever move outward); holes are reused; the root is a pinwheel (root lot pinned at the origin, four arms off its sides: right grows down, bottom left, left up, top right, so arms never meet) and a new top-level directory joins the arm that keeps the root bbox smallest, then squarest. `seams` = masonry: shared column widths, per-column cell heights. `hex` = brick bond (hex topology): shared row heights, per-row cell widths, odd rows staggered by half the first cell of the row above, children in hex-ring order. `warp` = Townscaper-style: per-cell sizes, a cell sits after its left and upper neighbours, then is shoved clear (+x or +y, the shorter) of cells nearer the lot. `pack` = no grid: a newcomer takes the free spot (x from 0 or any right edge, y from 0 or any bottom edge) minimising the district's longer side, then area; a block that grows into a neighbour shoves it outward. |
| `tombstone` | online, stateful | Persistent per-directory slot lists in arrival order. Deleted files/dirs keep their slot as ghosts. `reuse` lets new files infill the earliest ghost slot (no movement). Local compaction of a directory when its ghost ratio exceeds `compactRatio` or a ghost outlives `ghostTtl`. Optional reservations as in `slack`. |

## Options

Each strategy declares an option schema (`Strategy.schema`: type, default, range/values); the Runner
validates `followRenames` + the strategy's schema with `mergeOptions`. Unknown keys (with a
case-insensitive "did you mean" hint, e.g. `growthmode`) and wrong types/values throw one error listing
every problem and every valid option. Booleans accept `true`/`false` or the strings `"true"`/`"false"`;
numbers accept numbers or plain decimal strings (`"1.5"`, not `"0x10"`, `"1e3"` or `" "`); enums accept
exactly their listed values. Values are normalised before the strategy sees them. `node bin/viz.ts
strategies` prints every strategy's options with type and default.

**Engine** (every strategy): `followRenames` boolean, default `true` (rename keeps identity; else delete + add).

**Geometry** (every strategy): `cell` > 0 (1), `pad` >= 0 (0.5), `hgap` >= 0 (1), `vgap` >= 0 (2),
`align` left|center (left; recompute: center), `gridMode` sqrt|fixed (sqrt), `gridCols` integer >= 1 (8,
used when `gridMode=fixed`), `arrange` treev|wrap|nested|radial|spiral (treev; see below). Zero gaps/pad are allowed:
neighbouring platforms may touch, never overlap.

**Arrangement** (`arrange`, `src/geometry/arrange.ts`): where the measured platforms go, independent of the
strategy (which still decides order, ghosts, empty slots and platform cols/rows). `treev` = the band layout
above. `wrap` = TreeV with each directory's children shelf-wrapped onto rows, the row break chosen so the
subtree block is as square as possible. `nested` = Code City districts: a directory is a rectangle holding its
file grid and its children's districts, shelf-packed near-square, no wires. `radial` = TreeV bands mapped to
angles around the root, one ring per depth, each ring the smallest radius that keeps platforms' circumcircles
apart (rounded up to a whole cell). `spiral` = recursive: a directory's children's blocks coil around its
platform counter-clockwise in strips (bottom, right, top, left), a strip ending where the next block would pass
the current box's side. Wires follow the coil (`wires=chain`): the first child links to its parent, each later
child to the sibling before it (`LayoutNode.link`; the player carries it in the dirs' path field). Band-width reservations only affect `treev` and `radial`. A Frame carries
`wires` (elbow|bus|straight|chain|none) so renderers draw the arrangement's connectors.

| strategy | option | type | default | meaning |
|---|---|---|---|---|
| recompute | `order` | name\|birth | name | sibling order: name, or arrival in the directory |
| hindsight | `order` | birth\|name | birth | first appearance of the path, or name |
| hindsight | `showGhosts` | boolean | false | also emit non-live union slots as ghosts (`g:<path>` files, `d:<path>` dirs) |
| slack | `order` | birth\|name | birth | as recompute |
| slack | `slack` | number >= 0 | 0.25 | initial headroom: first reservation = `ceil(required * (1 + slack))` |
| slack | `growth` | number >= 1 | 1.5 | factor when a reservation is exceeded |
| slack | `growthMode` | multiply\|additive | multiply | band growth: `ceil(required * growth)`, or headroom only where growth originates (see `reserve.ts`) |
| city, metro, metro-* | `cell`, `pad`, `hgap` | geometry | as above | the only geometry keys city takes (`hgap` = gap between its columns and rows) |
| city, metro, metro-spiral | `squeeze` | none\|pack\|slide\|organic | none | optional compaction pass after the grid placement. `pack` / `slide` (`src/strategies/squeeze.ts`): each district slides toward its parent's lot, along the axes (pack) or straight at its centre then along the axes (slide); the squeezed offset is kept and the next commit starts from it; overlaps from growth push a district straight back out; root pinned. `organic` (`src/geometry/warp.ts`): a Townscaper-style mesh over the whole city; cells holding files keep their size, empty cells shrink toward `warpMin`, springs relax it; every node is drawn through the mesh (irregular quads). The mesh is state, the root corner pinned, a vertex pulled by < 0.15 stays put, and a move that would fold or sliver a cell is refused, so the map stays one-to-one. Warped frames carry `Frame.mesh` and each node's unwarped rect in `base`; x/y/w/h are the warped outline's bbox |
| city, metro, metro-spiral | `squeezeRate` | number >= 0 | 1 | max move per commit (layout units): a district (pack/slide) or a mesh vertex (organic); 0 = all at once |
| city, metro, metro-spiral | `warpCell` | number >= 1 | 4 | organic: mesh spacing |
| city, metro, metro-spiral | `warpMin` | number 0.05..1 | 0.3 | organic: target size of an empty mesh cell (1 = no squeeze) |
| tombstone | `reuse` | boolean | true | new files infill the earliest ghost slot; a returning directory revives in place |
| tombstone | `compactRatio` | number 0..1 | 0.5 | compact a live directory whose ghost fraction exceeds this (1 = never) |
| tombstone | `ghostTtl` | integer >= 0 | 0 | a ghost older than this many commits compacts its directory (0 = forever) |
| tombstone | `slack` | number >= 0 | 0 | reservations as in slack; 0 = off |
| tombstone | `growth` | number >= 1 | 1.5 | as slack (only with `slack > 0`) |
| tombstone | `growthMode` | multiply\|additive | multiply | as slack (only with `slack > 0`) |

## Metrics (per run, streamed over every consecutive pair of frames)

- **Identity**: nodes are matched across frames by `cid` (rename-following identity set by the Runner), so
  a config's own `followRenames` setting can't hide a rename's move.
- **Horizon**: for K in {100, 500} (when history > 2K), frames 0, K, 2K… are compared with the previous
  sample: share of nodes alive in both that moved, and mean distance — does your mental map survive a gap.
- **Displacement**: for nodes alive (non-ghost) in both frames, distance moved (layout units). Per step:
  mean, max, fraction of surviving nodes that moved. Per run: mean of per-step means, p95 of per-node
  moves, max single jump, fraction of steps with any movement. Files and dirs reported separately.
- **Compactness**: live file cells / bbox area (time-averaged and final); final bbox size and aspect.
- **Order**: fraction of adjacent sibling pairs not in name order (how "alphabetical" a layout still is).

## Outputs

- `bin/viz.ts`: one commit or a filmstrip (`--every K`) → JSON + SVG. `--at`: `HEAD` (default), `#N` =
  first-parent index N (0-based), anything else = a sha prefix of >= 4 hex chars on the first-parent
  timeline. A bare number is always a sha prefix, never an index. `--opt k=v` is validated as above.
- `sweep-square.json`: 3 strategies × 5 arrangements plus city, metro and the four metro grids, with a "side by side" section (`compare` groups: configs
  on one shared slider). `node bin/sweep.ts --sweep sweep-square.json --out out/square`.
- `bin/sweep.ts` + `sweep.json`: fixtures × configs → `out/report/index.html` (scoreboard, filmstrips at a
  consistent scale, scrubbable player) plus `metrics.json` / `metrics.csv`.

## Fixtures

Public repos of different shapes cloned to `../fixtures/` (not committed) by `scripts/fixtures.sh`,
plus synthetic stress repos generated by `scripts/synth.ts` (explosion of one directory, mass move,
churn, alphabetical-adversary inserts, deep nesting).
