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
