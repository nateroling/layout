// The engine replays a History through a Strategy.
//
//   step(state, tree, commit, delta)  — mutates strategy state; called for EVERY commit
//   frame(state, tree, commit)        — pure; produces the layout at that commit
//
// Because all state change happens in step(), the layout at commit N is the same
// whether you replay every commit or jump via checkpoints. Online strategies
// (usesFuture: false) never see the History; only hindsight strategies do.

import { applyCommit, emptyTree } from './model/tree.ts';
import { bbox } from './geometry/treev.ts';
import type { Commit, Delta, Frame, History, LayoutNode, Options, TreeState } from './types.ts';

export interface StrategyContext {
  options: Options; // defaults already merged in
  history?: History; // only provided when usesFuture is true
}

export interface Strategy<S = unknown> {
  name: string;
  description: string;
  usesFuture: boolean;
  defaults: Options;
  init(ctx: StrategyContext): S;
  step(state: S, tree: TreeState, commit: Commit, delta: Delta, ctx: StrategyContext): void;
  frame(state: S, tree: TreeState, commit: Commit, ctx: StrategyContext): LayoutNode[];
}

export const engineDefaults: Options = { followRenames: true };

export function mergeOptions(s: Strategy, given: Options = {}): Options {
  return { ...engineDefaults, ...s.defaults, ...given };
}

export function parseOptionValue(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}

interface Checkpoint<S> {
  index: number; // state is AFTER applying commit `index`
  tree: TreeState;
  canon: TreeState | null; // rename-following tree, only when followRenames=false
  state: S;
}

interface Cursor<S> {
  index: number; // last applied commit, -1 = nothing applied
  tree: TreeState;
  canon: TreeState | null;
  state: S;
}

export class Runner<S = unknown> {
  readonly history: History;
  readonly strategy: Strategy<S>;
  readonly ctx: StrategyContext;
  readonly checkpointEvery: number;
  private checkpoints: Checkpoint<S>[] = [];
  private builtTo = -1; // highest index covered by checkpoints

  constructor(history: History, strategy: Strategy<S>, options: Options = {}, checkpointEvery = 250) {
    this.history = history;
    this.strategy = strategy;
    const merged = mergeOptions(strategy as Strategy, options);
    this.ctx = { options: merged, history: strategy.usesFuture ? history : undefined };
    this.checkpointEvery = Math.max(1, checkpointEvery);
  }

  private get followRenames(): boolean {
    return this.ctx.options.followRenames !== false;
  }

  private fresh(): Cursor<S> {
    return { index: -1, tree: emptyTree(), canon: this.followRenames ? null : emptyTree(), state: this.strategy.init(this.ctx) };
  }

  private advance(cur: Cursor<S>) {
    const i = cur.index + 1;
    const c = this.history.commits[i];
    const delta = applyCommit(cur.tree, c, this.followRenames);
    if (cur.canon) applyCommit(cur.canon, c, true);
    this.strategy.step(cur.state, cur.tree, c, delta, this.ctx);
    cur.index = i;
    if (i > this.builtTo && i % this.checkpointEvery === 0) {
      this.checkpoints.push({ index: i, tree: structuredClone(cur.tree), canon: structuredClone(cur.canon), state: structuredClone(cur.state) });
      this.builtTo = i;
    }
  }

  /**
   * Every live file node gets `cid`: its identity under rename-following, independent of the
   * strategy's own followRenames option, so metrics compare like with like. Directories: cid = id.
   */
  private makeFrame(cur: Cursor<S>): Frame {
    const c = this.history.commits[cur.index];
    const nodes = this.strategy.frame(cur.state, cur.tree, c, this.ctx);
    for (const n of nodes) {
      if (n.ghost) continue;
      if (n.kind === 'dir' || !cur.canon) n.cid = n.id;
      else {
        const e = cur.canon.files.get(n.path);
        n.cid = e ? `f:${e.id}` : n.id;
      }
    }
    return { commit: c.index, sha: c.sha, time: c.time, strategy: this.strategy.name, nodes, bbox: bbox(nodes) };
  }

  /** Replay every commit in [0, to], calling onFrame for each index for which want(i) is true. */
  run(onFrame: (f: Frame) => void, want: (i: number) => boolean = () => true, to = this.history.commits.length - 1) {
    const cur = this.fresh();
    while (cur.index < to) {
      this.advance(cur);
      if (want(cur.index)) onFrame(this.makeFrame(cur));
    }
  }

  /** Layout at commit index n: resume from the nearest checkpoint <= n (building more as needed). */
  at(n: number): Frame {
    if (!Number.isInteger(n) || n < 0 || n >= this.history.commits.length) throw new Error(`index ${n} out of range`);
    let cp: Checkpoint<S> | undefined;
    for (const c of this.checkpoints) if (c.index <= n && (!cp || c.index > cp.index)) cp = c;
    const cur: Cursor<S> = cp
      ? { index: cp.index, tree: structuredClone(cp.tree), canon: structuredClone(cp.canon), state: structuredClone(cp.state) }
      : this.fresh();
    while (cur.index < n) this.advance(cur);
    return this.makeFrame(cur);
  }
}
