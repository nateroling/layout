# Status

- [x] M1 Core: extractor, tree model, runner with checkpoints, TreeV geometry, `recompute` strategy, CLI, minimal SVG
- [x] M2 Fixtures: chalk, express, vue-core, ripgrep (pinned) + 5 synthetic stress repos; extractor verified against `git ls-tree` on all 9; fixed quoted paths, file<->submodule changes, `--root`
- [x] M3 Strategies: `hindsight`, `slack`, `tombstone` (incremental reservations; randomized checkpoint-equivalence tests)
- [x] M4 Metrics, renderer, sweep runner, HTML report (9 fixtures × 15 configs in ~30 s); slack `growthMode=additive`, tombstone `ghostTtl`
- [ ] M5 Independent review, fixes, published report
