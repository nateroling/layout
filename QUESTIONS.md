# Open questions (judgment calls made with a default — revisit)

1. **Timeline = first-parent.** Branch work appears when it merges, as one big step. Alternative: topo
   order over all commits, which shows branch work as it happened but interleaves parallel work.
2. **Directory placement is relative to the parent** (child row starts below the parent platform). A parent
   gaining rows pushes its whole subtree down. Alternative: fixed rows per depth (fsn-like), which moves
   every deeper node whenever any platform at that depth grows.
3. **Rename identity follows git's `-M` heuristic** (50% similarity). A file moved across directories is one
   node that relocates; with `followRenames=false` it is a delete + add.
