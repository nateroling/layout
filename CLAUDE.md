# Working rules

- Read SPEC.md first. STATUS.md is the milestone log; QUESTIONS.md holds judgment calls for Nate.
- Node >= 22.18 runs `.ts` directly via type stripping. So: no `enum`, no `namespace`, no constructor
  parameter properties, use `import type` for types, and always import with the `.ts` extension.
- Zero runtime dependencies. Use node built-ins (`node:test`, `node:child_process`, `node:fs`).
- Determinism matters: the layout at commit N must not depend on how you got there. All state changes
  happen in `step()`; `frame()` is pure. Sort with codepoint `cmp()`, never `localeCompare`.
- Online strategies must not look at the future (`usesFuture: false` gets no History).
- Tests: `npm test` (node:test, `test/*.test.ts`). Every new strategy must pass the shared
  checkpoint-equivalence test in `test/core.test.ts` (it iterates the registry automatically).
- Fixture repos live in `../fixtures/` and are never committed. Generated output goes in `out/` (ignored),
  except the published report.
- Anything that's a taste/judgment call: make a reasonable default, note it in QUESTIONS.md, keep going.
