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
  `recompute(order=birth)`, but mean displacement is similar or higher: a reservation overflow grows by
  `ceil(required * growth)`, and that growth cascades up through every ancestor band, so the nodes to
  the right jump by ~half the ancestor's width at once. Possible refinements: grow by the child's
  increment rather than re-multiplying the ancestor's whole requirement; or a growth factor that decays
  with depth. Left as specified for now.
- **slack rows/cols start reserved even for file-less directories** (1 required → 2 reserved at slack
  0.25), so every platform is at least 2×2 cells. Follows the spec formula literally.
- **tombstone `slack` defaults to 0 = reservations off** (not "reservations with zero initial headroom");
  any `slack > 0` turns them on, with `growth` (default 1.5).
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
