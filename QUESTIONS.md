# Open questions (judgment calls made with a default — revisit)

1. **Timeline = first-parent.** Branch work appears when it merges, as one big step. Alternative: topo
   order over all commits, which shows branch work as it happened but interleaves parallel work.
2. **Directory placement is relative to the parent** (child row starts below the parent platform). A parent
   gaining rows pushes its whole subtree down. Alternative: fixed rows per depth (fsn-like), which moves
   every deeper node whenever any platform at that depth grows.
3. **Rename identity follows git's `-M` heuristic** (50% similarity). A file moved across directories is one
   node that relocates; with `followRenames=false` it is a delete + add.

## Strategies: hindsight / slack / tombstone

- **hindsight birth order = first appearance of the *path*** (not of the file identity). A rename creates a
  new path slot, so the renamed file jumps there; same-directory renames jump too (to the new name's
  slot). Ghost slots (`showGhosts=true`) use ids `g:<path>` for files; ghost directories keep `d:<path>`
  with `ghost: true` (paths are unique in the union, so no collision).
- **slack drops the reservation of a directory that disappears**; a re-appearing path starts fresh
  (initial headroom again). Keeps state bounded by the live tree. Alternative: keep it forever, which
  would make a returning directory reclaim its old size.
- **slack trades frequency for size of moves.** On real repos it moves on ~half as many steps as
  `recompute(order=birth)`, but with the spec rule (`growthMode=multiply`, still the default) mean
  displacement is similar or higher: an overflow grows to `ceil(required * growth)`, and that cascades up
  through every ancestor band, each re-multiplying its whole width. On `synth-deep` this compounds to
  1.5^depth (max jump ~21 000 units).
- **`growthMode=additive`** (slack and tombstone): headroom is added only where growth originates. A band
  whose own platform is the binding term grows to `required + ceil((growth-1) * pw)`. A band whose
  children are the binding term grows to exactly `required`: the overflowing child already carries its
  own headroom, so its increment is passed up unamplified and nothing moves further than the originating
  directory grew. In both modes an ancestor first absorbs a child's growth in any slack it already has.
  Cols/rows are a platform's own size and grow identically in both modes.
  I also tried giving ancestors headroom proportional to their overflow
  (`required + ceil((growth-1) * (required - reserved))`). It was worse on every repo (amplifies by
  `growth` per level; synth-deep max jump 11 658), so I dropped it. Open question: should additive become
  the default? It beats or ties multiply on mean displacement on all 9 fixtures. Even so, `slack`
  with additive growth is still slightly worse than plain `recompute(order=birth)` on the three large
  public repos (it does win on synth-explode/churn/alphabet).
- **tombstone `ghostTtl`** (default 0 = forever). A ghost older than the TTL triggers the same local
  compaction as the ratio, which drops ALL ghosts of that directory, not just the expired one (one
  disruption instead of several). Expiry is tracked in a FIFO queue in state, so an expired ghost is
  handled at the first commit where `now - died > ghostTtl`, even if its directory is untouched that
  commit. A ghost inside a ghost directory goes when the ghost directory's live parent compacts. With
  `ghostTtl=200` almost no ghosts are left at HEAD (ghost nodes: express 202 → 6, ripgrep 197 → 21,
  vue-core 235 → 5), but each expiry is a compaction, so mean displacement rises (express 0.061 → 0.087).
- **slack rows/cols start reserved even for file-less directories** (1 required → 2 reserved at slack
  0.25), so every platform is at least 2×2 cells. Follows the spec formula literally.
- **tombstone `slack` defaults to 0 = reservations off** (not "reservations with zero initial headroom");
  any `slack > 0` turns them on, with `growth` (default 1.5) and `growthMode` (default multiply).
- **tombstone `reuse=false` and a re-appearing directory**: the ghost entry (and its ghost subtree) is
  dropped and a fresh entry is appended at the end of the parent's list, since there can only be one
  `d:<path>` node. With `reuse=true` it is revived in place, keeping its ghost files (which new files then
  infill).
- **tombstone ghost ids**: a deleted file's ghost keeps `f:<fileId>` (the tree never reuses ids, and it
  makes live→ghost continuity trivial for animation); the ghost left behind by a cross-directory move
  gets `g:<n>` from a per-run counter, because the identity `f:<fileId>` lives on in the new directory.
- **tombstone compaction only applies to live directories.** A ghost directory is all ghosts by
  definition; it is removed as a unit when its (live) parent compacts. Ghost fraction counts direct
  slots and direct child dirs only. Files arriving in one commit are slotted in path order.

## Report / metrics (sweep)

- **Renames count as moves.** With `followRenames=true` a renamed file is one node that relocates, so it counts as displacement (hindsight's big max jumps on vue-core are renames). Metrics now match nodes by `cid` (rename-following identity set by the Runner), so `followRenames=false` pays for renames too (superseded the earlier "costs nothing" caveat).
- **"Moved / tree change"** (share of surviving nodes that moved, averaged only over commits that add, delete or rename) is the headline stability number. Per-commit averages are diluted by content-only commits, which never move anything.
- **Compactness is bbox-based**, so on very wide repos (vue-core is ~50:1) it mostly measures aspect ratio. Compare it within a repo, not across repos.
- **Wide repos get stacked full-width filmstrips**, scaled per config, with a grey bar showing relative width; other repos use thumbnails at one shared scale.
- **Name order is a taste metric.** Birth-order strategies violate it by design.
- **Player/filmstrip "moved" highlights are cumulative** between sampled frames (about N/150 commits apart), so they overstate per-commit movement.

## Report / metrics, second pass

- **Survivors are matched by the Runner's `cid`** (rename-following identity) for every config. This
  supersedes "renames count as moves … with followRenames=false a rename costs nothing": now it costs the
  same as with followRenames=true. `tombstone no-renames` now scores close to `tombstone`. The player and
  the filmstrip outlines use the same identity (live files are keyed by cid in the player encoding; a file
  becoming a ghost is a remove + a new node there, which nothing visible depends on).
- **Horizon = K in {100, 500}, sampled at frames 0, K, 2K, …**, each compared with the previous sample
  (non-overlapping windows, not every i vs i-K: streaming needs only one stored frame per K). Reported only
  with ≥ 2 pairs (history > 2K commits), so 500 exists only for express, ripgrep and vue-core; no
  clamping of K to short histories (a clamped K would make "after 500" mean different things per repo).
  The composite uses the horizon *share* (moved after K), not the shift.
- **Composite stability** = mean of rank scores for moved / tree change, mean shift, p95 jump, and
  horizon moved (averaged over available K). Dropped disruption (near-duplicate of mean shift). Shown
  for public, synthetic and all repos; the all-repos table weights each repo equally, so the 5 synthetics
  outweigh the 4 public repos. Alternative: weight by kind.
- **"Moved" outlines are tiered by distance** (< 2 cells faint, 2–10 medium, ≥ 10 bright and thicker)
  instead of a threshold, so small nudges stay visible but no longer swamp the picture; filmstrip captions
  add "N far" (≥ 10 cells). Thresholds are in layout units, not relative to repo size — on vue-core
  (~44 commits between samples) recompute still lights up most of the tree, which is accurate.
- **Self-check checksum** = Σ over nodes of ((idx mod 997)+1)·(x + 3y + 5w + 7h + 11·ghost + 13) on the
  x100-rounded values, taken from the source frames in the encoder; 5 evenly spaced frames per player
  are verified in the browser.


## Options / CLI

- `compactRatio` is capped at 1 (1 = never compact); `ghostTtl` must be an integer.
- Options are validated strictly: unknown keys and bad values are errors. Numbers may be given as plain decimal strings.
- In `viz --at`, `#N` is an index; a bare string is always a sha prefix (4+ hex chars), never an index.

## Arrangements (squarer layouts)

- **wrap/nested squareness rule**: per directory, among the greedy shelf packings whose first row holds the
  first k children (k = 1..n), take the one with the shortest longer side, then the smallest area. Each
  subtree is squared locally, so the root is squarish but not optimal, and wrap can come out tall (aspect
  ~0.5 on chalk). A target aspect option (e.g. 16:9 for screens) would be a one-line change.
- **wrap/nested keep sibling order** (shelf packing in the strategy's order, no sorting by size). That keeps
  order-based stability but wastes space under tall items; a squarified treemap would be denser and less stable.
- **Band-width reservations are ignored by wrap and nested** (they are TreeV band semantics); platform
  cols/rows reservations still apply. Radial uses band widths as angles, so root slack is an empty wedge.
- **Radial is sparse by construction**: angle is proportional to TreeV band width, so two small adjacent
  siblings need a ring circumference about as long as the whole TreeV width. Allocating angle per ring
  (or by leaf count) would pack tighter at the cost of children no longer sitting in their parent's wedge.
- **Wires for wrap** turn just below the parent ("bus"), so later rows' wires run behind the rows above.
- **Spiral direction and start**: counter-clockwise, starting below the parent and running left to right, so a
  single child hangs below like TreeV and chains stay vertical. Gaps: `vgap` between the box and a strip,
  `hgap` between blocks in a strip. Wires follow the coil as a chain (parent -> first child -> next
  sibling ...), straight centre to centre; a link between two big neighbouring blocks is long.

## city (stretchable grid)

- **Shell order** for child cells (around the file lot, down column s then back along row s) keeps districts about
  square in cell count; actual widths come from the biggest block in each column, so one big child (vue-core's
  `packages`) widens a whole column/row and leaves gaps beside its neighbours. Lower density is the price.
- **Ratchets never shrink**, even after a big directory is deleted: the space stays as a hole until reused. A
  periodic deliberate "re-plan" (one planned rearrangement) is not implemented.
- **File lots** keep slots (holes reused, earliest first) but still reflow when their column count grows
  (ceil(sqrt(slots))). A fixed lot width per directory would remove that.
- **Child placement is top-left in its cell**, so it only moves when columns/rows before it widen.
- **metro** spirals right, down, left, up from the lot (cell order (1,0), (1,1), (0,1), (-1,1), ...). The first
  big child (vue-core's `packages`) lands at (1,1) and dominates one quadrant, so the lot is not visually centred
  on big repos. Placing children by size (big ones further out) would centre better but breaks arrival order.

## 3D ripgrep demo (bin/city3d.ts, src/render/city3d.html)
- Height defaults to √size, with linear and log in a menu. Linear is literally "height = size", but ripgrep's
  largest file (grep/src/data/sherlock.txt, 595 KB) is ~260× the median (~2 KB), so linear makes nearly every
  building a flat tile. The scale is fixed over the whole history, so heights are comparable across commits.
- Colour groups Rust crates the same before and after the 2020 move under crates/ (grep/ and crates/grep/ share
  a colour). That rule is ripgrep-specific.

## Compact grids (metro-seams / hex / warp / pack)

Results on the four public repos (2026-11-19, `sweep-square.json`): every new grid is denser than metro, and none is less stable.
`metro-pack` is densest: mean compactness about 1.4-2x metro's (express 0.079 vs 0.038, vue-core 0.090 vs 0.051,
ripgrep 0.090 vs 0.064); final bbox on express 52×57 vs metro's 147×82. Its stability is about the same or better (moved per
tree change 3.2% vs 5.0% on express, 3.2% vs 4.1% on vue-core, 4.6% vs 4.3% on ripgrep) and its max jump is lower on the three
big repos. Seams and warp come next; hex is in between.

- **Root pinwheel** instead of metro's spiral: the four arms can't collide, but a growing root lot slides the bottom and left
  arms sideways (along the lot), not only outward. Pinning the lot's centre would fix that but move the root's files.
- **Arm choice** = the arm that keeps the root bbox's longer side smallest, then area, then the arm order right, bottom, left, top.
  It looks only at the present (sizes at arrival), so a folder that later becomes huge can unbalance an arm.
- **Positions are ratchets** (never move back toward the lot). So holes left by deleted subtrees stay empty until something
  new fits there. That is most of the empty space left on vue-core after the packages renames. A periodic deliberate "re-plan"
  would reclaim it.
- **hex is brick bond**: platforms are rectangles, so true hexagons aren't possible; hex topology = staggered rows (six neighbours).
  Its stagger is half the first cell of the row above, which shifts when that cell grows.
- **warp** shoves (+x or +y, the shorter move); ties go to +x.
- **pack** candidate order: longer side of the district, then area, then x+y, then y, then x. A newcomer is placed at its arrival
  size (usually tiny), so it can land in a narrow slot and shove neighbours as it grows.

## Squeeze pass (city/metro `squeeze`)

Nate's idea (2026-11-19): place with the plain grid, then compact in a separate stateful pass. Built as options on city and metro
(`squeeze` = none|pack|organic, `squeezeRate`). Findings on the four public repos: the squeezes are only a little denser than plain
metro (compactness +5-15%, e.g. ripgrep 0.064 -> 0.068-0.071) and are clearly less stable (moved per tree change 2-4x metro's),
because a grid-seeded arrangement leaves districts in long rows and a slide toward the parent can only close the gaps in between,
not reorder anything. metro-pack (packing at placement time) stays both denser and steadier. Calls made:
- **Where a district slides to**: its parent's lot centre, never past the lot's centre line on an axis. Sliding toward the
  root instead would pull subtrees across the city.
- **New districts start at their grid cell** and slide in from there; afterwards the grid position is ignored (the kept offset wins).
- **Gradual** (`squeezeRate=1` default) vs instant (0): gradual means many small moves over many commits, which the per-commit
  metrics punish; instant has fewer, bigger moves. Default kept at 1 because "shrink gaps gradually" was the brief.
- **Overlap from growth** pushes the district back out along the line it came in on (not the shortest way out), so it never moves sideways.
- Rectangles only: "organic" means districts are no longer aligned to rows/columns, not that they are deformed shapes.

## Organic warp (`squeeze=organic`)

Nate (2026-11-19): "organic" = not square, squished like Townscaper's grid. Built as a mesh warp over plain metro/city.
Results (four public repos): densest of everything so far on average (compactness ripgrep 0.139 vs metro 0.064 and metro-pack 0.090;
vue-core 0.116 vs 0.051 / 0.090; express 0.082 vs 0.038 / 0.079), with mean shift no worse than metro and smaller big jumps, but it
moves a larger share of things on each tree change (7-16% vs metro's ~4-5%): when a district grows, the mesh around it
re-settles a little. Calls made:
- **What counts as full**: a mesh cell holding any file. Platform areas without files (district padding, empty lots) are empty
  and collapse. Wanting more air around districts would mean counting platform edges too.
- **warpMin 0.3, warpCell 4**: smaller warpMin squeezes harder but makes slivers (refused moves) more common; bigger cells look
  less organic.
- **Dead zone 0.15** (a vertex pulled less than that stays put): without it the mesh creeps every commit (50-95% of commits moved
  something); with it ~1-2%.
- **Lattice only grows**; new vertices copy their nearest neighbour's displacement. A rare fold there is repaired by pushing the new
  vertices outward, and failing that the mesh resets to square (a one-off jump, never a fold).
- **Rotation**: vertex (1,0) is held on the x axis so the city can't slowly turn.
- **Player**: the mesh is sent per frame (sparse deltas, 1/20 unit); the "moved" outlines only show moves on the underlying grid,
  not the warp's drift. The outer edge of the root platform is extrapolated from the mesh and can look ragged.

## metro-spiral (subfolders spiral like the root)

`metro-spiral` = metro where every district places its children on the root's square spiral (no mirroring), so a folder's
internal layout is the same at any depth (`node scripts/demo-nested.ts` draws the four-folder case one level down: metro gives
sub/ 18 × 12, metro-spiral 18 × 9, the same as at the root). Calls made:
- **No mirroring**: the spiral always starts right, then down, left, up, at every depth, so a district's children also land on
  the side facing its parent. Nate asked to try the mirrored version too: `metro-spiral-flip` (below).
- **Hugging**: a child still hugs the side of its cell facing the district's lot, and the lot hugs the corner facing the parent
  (orientation from the cell the district sits in, as in metro).

Results (four public repos) vs metro: compactness about the same (chalk equal, express -1%, vue-core +5%, ripgrep equal); a bit
less stable (moved / tree change +3% to +18%, disruption up to +54% on express). metro-pack still beats both on both axes.

`metro-spiral-flip` (Nate said try it, 2026-11-20): the spiral mirrored per district so it starts away from the parent
(`node scripts/demo-nested.ts --scene upleft` puts sub/ up-left of the root to show the difference). Compactness is identical to
metro-spiral (mirroring doesn't change any column or row size). Stability is a little better than metro-spiral everywhere:
equal to metro on chalk, better than metro on ripgrep (moved / tree change -4%, disruption -6%) though its p95 jump is larger,
still worse than metro on express (+16% moved, +39% disruption) and vue-core (+18% moved). metro-pack still wins both axes.

## Nature layouts (snapshot experiment, 2026-11-20)

Nate asked for five fresh layouts from nature, one of them a Fibonacci spiral, ignoring stability and history. They live in
`src/nature/` (not strategies: one snapshot in, one Scene out) and `node bin/nature.ts` writes `out/nature/` (page + data.json),
published at https://claude.ai/artifact/NHdB9XKY17DDtuBFD93VwE. Calls made:
- **Sunflower subfolders**: each folder is its own head; subfolder heads continue the parent's golden-angle spiral after the
  parent's files, biggest first, and every head's outline is the smallest circle around its contents (re-centred), so one big
  subfolder doesn't leave a half-empty disc. Files go small-to-large outward.
- **The other four**: tree (da Vinci branching, files as leaves), cells (Voronoi treemap), coral (accretion with a DLA-style tip
  bias), galaxy (log-spiral arms of folder clusters). Picked for being different from each other, not exhaustively.
- **File size**: radius = 0.5 * (bytes/1000)^0.25, clamped to [0.4, 2.6], shared by all five (cells use the same areas).
- **Colours**: by folder group (top-level folders, the biggest split until none holds over 1/8 of the files, 9 + "everything
  else") or by file extension.

Animated (Nate asked, 2026-11-20): `node bin/nature-anim.ts` replays ripgrep's first-parent history (rename-following ids from
the tree model), lays out 160 evenly spaced commits from scratch with all five, and writes a player (out/nature-anim/,
https://claude.ai/artifact/4Txx1GTB2txJUHojnctfza, ~2.2 MB). Calls made:
- **Frames**: 160 evenly spaced commits (every ~14), not every commit, to keep the page under 4 MB; tweened with smoothstep.
- **Tweening**: files matched by identity, folders by path, galaxy arms by index; things that appear grow from nothing,
  things that vanish shrink away. Cells are resampled to 16 rays from the centroid (folders 24) so they morph vertex by vertex.
  Coral links cross-fade.
- **Cells seeding**: each item's starting site now comes from its own name's hash, so a new sibling doesn't reshuffle the
  others (much smoother over time; also changed the static page slightly).
- **Colours**: by identity, from the folder groups of the final tree, so a file keeps its colour through the crates/ move.
- **Encoding**: quantised binary (1/20 unit), shipped as base64 text because artifacts don't serve .bin files.

Stable variations (Nate asked for three more stable versions of each, 2026-11-20): `src/nature/stable.ts`, 15 variants, all in
the animated page (pick a layout to see the original beside its three; scores table at the bottom). Movement metric: mean
displacement per surviving file per frame step, in file widths (sqrt of bbox area per file), root pinned where each layout
puts it; plus jumps (> 2 widths), worst single step (a big subtree shifting) and bbox u²/file. ripgrep, 120 frames:

| layout | original moves | best variant | moves | density cost |
|---|---|---|---|---|
| sunflower | 1.25 | Sticky | 0.09 (7%) | 28 → 85 u²/file |
| tree | 0.19 | Apical growth | 0.04 (21%) | 28 → 21 (denser, subtrees cross) |
| cells | 0.56 | Warm + inertia | 0.16 (29%) | none |
| coral | 3.17 | Living colony | 0.04 (1%) | none (moves-stay variant: 0) |
| galaxy | 0.29 | Fixed orbits | 0.08 (27%) | 25 → 35 |

Calls made:
- **Stateful variants step only through the sampled frames** (every ~19 commits), not every commit, to keep the build fast.
- **Folders are matched by path**, so the crates/ move counts as new folders for the stateful variants; files follow renames.
- **Sunflower variants don't re-centre heads** (re-centring moves every child), which is why they are 2-4x sparser; a newcomer
  takes the innermost of the next 12 golden-angle slots to limit that.
- **Coral polyps keep their birth size** in the living-colony variants (a grown file would otherwise overlap its neighbours).
- **Galaxy variants use a fixed 3 arms** (the original picks 2-4 by size, which reshuffles everything when the count changes).
- Birth-order variants for coral and galaxy barely help or are worse; kept as the honest stateless baseline.

## Cell cities (cells + metro, 2026-11-20)

Nate asked how cells could combine with the city layouts, and to build all three ideas. `src/nature/cellcity.ts`,
`node bin/cellcity.ts` -> out/cellcity/ (the nature player with one family: metro, cells warm+inertia, and the three).
ripgrep, 100 frames (moves in file widths per frame step; metro 0.10, cells 0.18):

| variant | moves | worst step | u²/file |
|---|---|---|---|
| Cells as districts | 0.14 | 4.0 | 1.6 |
| Cells all the way down | 0.18 | 4.7 | 2.1 |
| Metro skeleton, cells skin | 0.21 | 5.8 | 22 |

Calls made:
- **Count, not size**: all three weigh files by count, as metro does, so an edit never moves anything (the cells reference
  still uses size).
- **Districts = top-level folders, opened up**: a folder that mostly holds folders (>= 2 subfolders, own files <= 10% of its
  subtree, e.g. crates/) is replaced by its subfolders; otherwise ripgrep is one giant crates/ district. Region area is 1.3
  grid squares per file. A file keeps its square while it stays in its district; newcomers take the free square nearest
  their metro position relative to the district (metro block scaled to the region's area).
- **All the way down**: a folder's own files are one block cut into lots, two rows back to back along the block's long
  axis (hysteresis: turns only at 1.4x), lots in birth order; files keep their row, newcomers join the shorter row.
- **Seeded**: fully pinned sites (every file at its metro square) gave slivers and badly wrong areas, because metro's lots
  are tight and its streets wide. Now folder and lot sites are anchored at metro but may drift up to half their cell's
  natural radius (TETHER = 0.5; 1 looks evener but moves 0.26), drift and weights warm-started; files are free cells in
  their lot. Region = metro's whole footprint, so it is as sparse as metro (22 u²/file) but has no empty space.
- **Player**: generalised a little (meta.title/intro/footer/baseline/dirRays); folders use 40 rays so metro's
  rectangles keep their corners. Shared encoding moved to `src/nature/anim.ts`.
