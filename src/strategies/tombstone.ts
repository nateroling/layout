// "tombstone": online, stateful. Every directory keeps a persistent, ordered
// list of file slots (arrival order) and of child directories. A deleted file
// leaves a ghost in its slot; a vanished directory stays as a ghost platform in
// its parent's child list. Nothing moves on deletion.
//
// Options:
//   reuse (true)        new files infill the EARLIEST ghost slot of their directory;
//                       a re-appearing directory path revives its ghost entry in place.
//                       With reuse=false new files append, and a re-appearing directory
//                       replaces its ghost entry with a fresh one appended at the end.
//   compactRatio (0.5)  after a commit, a live directory whose ghost fraction
//                       (ghost slots + ghost child dirs) / (all slots + child dirs)
//                       exceeds this is compacted locally (ghosts dropped, live order
//                       kept). 1 = never.
//   ghostTtl (0)        a ghost older than this many commits triggers the same local
//                       compaction of its (live) parent directory, at the first
//                       commit where it has expired. 0 = ghosts live forever.
//   slack (0 = off), growth (1.5), growthMode (multiply|additive)
//                       per-directory reservations from reserve.ts.
//
// Renames (followRenames): within a directory the file keeps its slot; across
// directories it leaves a ghost behind and arrives in the new directory.
//
// Node ids: live file `f:<fileId>`; ghost of a deleted file `f:<fileId>` (ids are
// never reused by the tree, so no collision); ghost left behind by a cross-dir
// move `g:<seq>` (the identity lives on elsewhere); directories `d:<path>`.

import { defaultsOf, type Strategy } from '../engine.ts';
import { geoFromOptions, geoSchema, measure, place, type LDir, type LFile } from '../geometry/treev.ts';
import { cmp, dirname } from '../model/tree.ts';
import type { FileEntry, LayoutNode, OptionSchema, Options, TreeState } from '../types.ts';
import { fixedHooks, reserveOptions, reserveSchema, updateReservations, type Reservations, type ReserveOptions } from './reserve.ts';

export interface TSlot {
  fid: number; // file id (live) or id of the file that left it (ghost)
  path: string; // current path (live) or last-known path (ghost)
  ghost: boolean;
  died: number; // commit index it became a ghost (ghosts only)
  gid: string; // node id while ghost
  size: number; // last-known, ghosts only
  born: number;
  modified: number;
}

export interface TDir {
  path: string;
  ghost: boolean;
  died: number; // commit index it became a ghost (ghost dirs only)
  slots: TSlot[];
  kids: string[]; // child directory paths, persistent order
}

export interface TombstoneState {
  dirs: Map<string, TDir>; // every directory entry, live or ghost
  seq: number; // counter for ghost ids of moved-away files
  res: Reservations;
  // ghostTtl > 0: [expiresAt, directory to re-check] in creation order, so sorted by expiresAt.
  expiry: [number, string][];
}

interface TOpts extends ReserveOptions {
  reuse: boolean;
  compactRatio: number;
  ghostTtl: number;
}

function opts(o: Options): TOpts {
  const ro = reserveOptions(o, { slack: 0, growth: 1.5 });
  const r = typeof o.compactRatio === 'number' ? o.compactRatio : Number(o.compactRatio);
  const ttl = typeof o.ghostTtl === 'number' ? o.ghostTtl : Number(o.ghostTtl);
  return {
    ...ro,
    reuse: o.reuse !== false,
    compactRatio: Number.isFinite(r) ? r : 0.5,
    ghostTtl: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 0,
  };
}

function newDir(path: string): TDir {
  return { path, ghost: false, died: 0, slots: [], kids: [] };
}

/** Remove a directory entry and its whole subtree from the map. */
function dropSubtree(s: TombstoneState, path: string) {
  const d = s.dirs.get(path);
  if (!d) return;
  for (const k of d.kids) dropSubtree(s, k);
  s.dirs.delete(path);
  s.res.delete(path);
}

function ghostFraction(d: TDir, s: TombstoneState): number {
  let g = 0;
  for (const x of d.slots) if (x.ghost) g++;
  for (const k of d.kids) if (s.dirs.get(k)!.ghost) g++;
  const n = d.slots.length + d.kids.length;
  return n ? g / n : 0;
}

/** Commit index of the oldest direct ghost (slot or child dir), or Infinity. */
function oldestGhost(d: TDir, s: TombstoneState): number {
  let t = Infinity;
  for (const x of d.slots) if (x.ghost && x.died < t) t = x.died;
  for (const k of d.kids) {
    const c = s.dirs.get(k)!;
    if (c.ghost && c.died < t) t = c.died;
  }
  return t;
}

function compact(s: TombstoneState, d: TDir) {
  d.slots = d.slots.filter((x) => !x.ghost);
  const keep: string[] = [];
  for (const k of d.kids) {
    if (s.dirs.get(k)!.ghost) dropSubtree(s, k);
    else keep.push(k);
  }
  d.kids = keep;
}

function toGhost(slot: TSlot, e: FileEntry, path: string, gid: string, at: number) {
  slot.ghost = true;
  slot.died = at;
  slot.gid = gid;
  slot.path = path;
  slot.size = e.size;
  slot.born = e.born;
  slot.modified = e.modified;
}

/** The LDir the geometry sees; identical in step() and frame(). */
export function buildLDir(s: TombstoneState, tree: TreeState): LDir {
  const rec = (d: TDir): LDir => ({
    id: `d:${d.path}`,
    path: d.path,
    ghost: d.ghost || undefined,
    slots: d.slots.map((x): LFile => {
      if (x.ghost) return { id: x.gid, path: x.path, size: x.size, born: x.born, modified: x.modified, ghost: true };
      const f = tree.files.get(x.path)!;
      return { id: `f:${f.id}`, path: f.path, size: f.size, born: f.born, modified: f.modified };
    }),
    dirs: d.kids.map((k) => rec(s.dirs.get(k)!)),
  });
  return rec(s.dirs.get('')!);
}

const schema: OptionSchema = {
  reuse: { type: 'boolean', default: true, doc: 'new files infill the earliest ghost slot; a returning dir revives in place' },
  compactRatio: { type: 'number', default: 0.5, min: 0, max: 1, doc: 'compact a dir whose ghost fraction exceeds this (1 = never)' },
  ghostTtl: { type: 'number', default: 0, min: 0, integer: true, doc: 'commits a ghost survives before its dir compacts (0 = forever)' },
  ...reserveSchema({ slack: 0 }),
  ...geoSchema(),
};

export const tombstone: Strategy<TombstoneState> = {
  name: 'tombstone',
  description:
    'Online: persistent per-directory slots in arrival order; deletions leave ghosts. reuse (infill earliest ghost), compactRatio (local compaction; 1 = never), ghostTtl (commits; 0 = forever), slack/growth/growthMode reservations.',
  usesFuture: false,
  schema,
  defaults: defaultsOf(schema),
  init: () => ({ dirs: new Map([['', newDir('')]]), seq: 0, res: new Map(), expiry: [] }),

  step(s, tree, c, delta, ctx) {
    const o = opts(ctx.options);
    const now = c.index;
    // Record a new ghost living in directory `dir` (re-checked when it expires).
    const expires = (dir: string) => {
      if (o.ghostTtl > 0) s.expiry.push([now + o.ghostTtl + 1, dir]);
    };
    const touched = new Set<string>();

    // Per-directory id -> slot index, built lazily once per touched directory.
    const idx = new Map<string, Map<number, number>>();
    const slotOf = (dir: string, fid: number): TSlot | undefined => {
      const d = s.dirs.get(dir);
      if (!d) return undefined;
      let m = idx.get(dir);
      if (!m) {
        m = new Map();
        d.slots.forEach((x, i) => {
          if (!x.ghost) m!.set(x.fid, i);
        });
        idx.set(dir, m);
      }
      const i = m.get(fid);
      return i === undefined ? undefined : d.slots[i];
    };

    // 1. Deletions leave ghosts (id f:<fileId>: the identity is gone for good).
    for (const e of delta.removed) {
      const dir = dirname(e.path);
      const slot = slotOf(dir, e.id);
      if (!slot) continue;
      toGhost(slot, e, e.path, `f:${e.id}`, now);
      expires(dir);
      idx.get(dir)!.delete(e.id);
      touched.add(dir);
    }

    // 2. Moves: same directory keeps the slot; across directories leaves a ghost.
    const arrivals: FileEntry[] = [...delta.added];
    for (const { from, entry } of delta.moved) {
      const od = dirname(from);
      const slot = slotOf(od, entry.id);
      if (od === dirname(entry.path) && slot) {
        slot.path = entry.path;
        continue;
      }
      if (slot) {
        toGhost(slot, entry, from, `g:${s.seq++}`, now);
        expires(od);
        idx.get(od)!.delete(entry.id);
        touched.add(od);
      }
      arrivals.push(entry);
    }

    // 3. Directories that (re)appear: parents first. Ghost entries are revived in
    //    place (reuse) or replaced by a fresh entry appended at the end.
    const ensure = (path: string) => {
      const d = s.dirs.get(path);
      if (d && !d.ghost) return;
      const parent = dirname(path);
      ensure(parent);
      const p = s.dirs.get(parent)!;
      touched.add(parent);
      touched.add(path);
      if (d && o.reuse) {
        d.ghost = false;
        return;
      }
      if (d) {
        dropSubtree(s, path);
        p.kids = p.kids.filter((k) => k !== path);
        idx.delete(path);
      }
      s.dirs.set(path, newDir(path));
      p.kids.push(path);
    };
    for (const p of [...delta.dirsAdded].sort(cmp)) if (p !== '') ensure(p);

    // 4. Arrivals in name order within the commit: earliest ghost slot (reuse) or append.
    arrivals.sort((a, b) => cmp(a.path, b.path));
    const cursor = new Map<string, number>(); // earliest possibly-ghost index per dir (this step)
    for (const e of arrivals) {
      const dir = dirname(e.path);
      ensure(dir); // defensive: should already exist via dirsAdded
      const d = s.dirs.get(dir)!;
      const slot: TSlot = { fid: e.id, path: e.path, ghost: false, died: 0, gid: '', size: 0, born: 0, modified: 0 };
      let i = -1;
      if (o.reuse) {
        let j = cursor.get(dir) ?? 0;
        while (j < d.slots.length && !d.slots[j].ghost) j++;
        cursor.set(dir, j + 1);
        if (j < d.slots.length) i = j;
      }
      if (i >= 0) d.slots[i] = slot;
      else d.slots.push(slot);
      idx.get(dir)?.set(e.id, i >= 0 ? i : d.slots.length - 1);
      touched.add(dir);
    }

    // 5. Vanished directories become ghost platforms.
    for (const p of delta.dirsRemoved) {
      const d = s.dirs.get(p);
      if (d) {
        d.ghost = true;
        d.died = now;
      }
      touched.add(dirname(p));
      expires(dirname(p));
    }

    // 6. Local compaction of live directories whose ghost fraction exceeds the ratio,
    //    or (ghostTtl) whose oldest ghost has expired. Expired queue entries bring
    //    their directory up for a check even if nothing else touched it.
    //    Stale entries (ghost already reused/compacted) are harmless: the check
    //    looks at the directory as it is now.
    if (o.ghostTtl > 0) {
      let k = 0;
      while (k < s.expiry.length && s.expiry[k][0] <= now) touched.add(s.expiry[k++][1]);
      if (k) s.expiry.splice(0, k);
    }
    if (o.compactRatio < 1 || o.ghostTtl > 0) {
      for (const p of [...touched].sort(cmp)) {
        const d = s.dirs.get(p);
        if (!d || d.ghost) continue;
        if (
          (o.compactRatio < 1 && ghostFraction(d, s) > o.compactRatio) ||
          (o.ghostTtl > 0 && now - oldestGhost(d, s) > o.ghostTtl)
        )
          compact(s, d);
      }
    }

    // 7. Reservations (only when slack > 0).
    //    Every directory whose slot count or child list changed is in `touched`;
    //    dropped subtrees already took their reservations with them (dropSubtree).
    if (o.slack > 0 && touched.size) {
      updateReservations(s.res, o, geoFromOptions(ctx.options), touched, (p) => {
        const d = s.dirs.get(p);
        return d && { files: d.slots.length, kids: d.kids };
      });
    }
  },

  frame(s, tree, _c, ctx): LayoutNode[] {
    const o = opts(ctx.options);
    const g = geoFromOptions(ctx.options);
    const root = buildLDir(s, tree);
    return place(root, g, measure(root, g, o.slack > 0 ? fixedHooks(s.res) : {}));
  },
};
