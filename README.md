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
