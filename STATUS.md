# Status

- [x] M1 Core: extractor, tree model, runner with checkpoints, TreeV geometry, `recompute` strategy, CLI, minimal SVG
- [x] M2 Fixtures: chalk, express, vue-core, ripgrep (pinned) + 5 synthetic stress repos; extractor verified against `git ls-tree` on all 9; fixed quoted paths, file<->submodule changes, `--root`
- [x] M3 Strategies: `hindsight`, `slack`, `tombstone` (incremental reservations; randomized checkpoint-equivalence tests)
- [x] M4 Metrics, renderer, sweep runner, HTML report (9 fixtures × 15 configs in ~30 s); slack `growthMode=additive`, tombstone `ghostTtl`
- [x] M5 Independent review (core claims verified: checkpoint determinism, no future leakage, live files == ls-tree, no overlaps over 100k+ frames); fixes: strict option schemas, rename-aware metric identity (`cid`), horizon metrics, public/synthetic rankings, verified player checksums. Report published as an artifact (regenerate: `node bin/sweep.ts`)
- [x] Squarer arrangements (experiment): geometry option `arrange` = treev | wrap | nested | radial | spiral for every strategy; geometry invariants per arrangement; side-by-side comparison report (`sweep-square.json`); `city` strategy (stretchable nested grid) and `metro` (the same, grown from the centre); `metro-spiral` and `metro-spiral-flip` (every district spirals like the root; flip mirrors it away from the parent)
- [x] Nature layouts (snapshot experiment, no history): sunflower (nested phyllotaxis), tree, cells (Voronoi treemap), coral, galaxy in `src/nature/`; `node bin/nature.ts` writes the side-by-side page ; `node bin/nature-anim.ts` animates them over ripgrep's history ; `node bin/cellcity.ts` animates three cells + metro hybrids (cell cities)
- [x] Dot cells (experiment): files are dots (volume = size), each folder is the cell grown around its dots, subfolders nested; `src/nature/dots.ts`, standalone pan/zoom viewer via `node bin/dots.ts <any local repo>` -> out/dots/<name>/standalone.html (opens from disk)
