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
  /** Whether renames keep file identity. Read from options.followRenames by the engine. */
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

  private makeFrame(tree: TreeState, state: S, c: Commit): Frame {
    const nodes = this.strategy.frame(state, tree, c, this.ctx);
    return { commit: c.index, sha: c.sha, time: c.time, strategy: this.strategy.name, nodes, bbox: bbox(nodes) };
  }

  /** Replay every commit in [from, to], calling onFrame for each index for which want(i) is true. */
  run(onFrame: (f: Frame) => void, want: (i: number) => boolean = () => true, to = this.history.commits.length - 1) {
    const tree = emptyTree();
    const state = this.strategy.init(this.ctx);
    for (let i = 0; i <= to; i++) {
      const c = this.history.commits[i];
      const delta = applyCommit(tree, c, this.followRenames);
      this.strategy.step(state, tree, c, delta, this.ctx);
      if (i > this.builtTo && i % this.checkpointEvery === 0) {
        this.checkpoints.push({ index: i, tree: structuredClone(tree), state: structuredClone(state) });
        this.builtTo = i;
      }
      if (want(i)) onFrame(this.makeFrame(tree, state, c));
    }
  }

  /** Layout at commit index n: nearest checkpoint <= n, then a short replay. */
  at(n: number): Frame {
    if (n < 0 || n >= this.history.commits.length) throw new Error(`index ${n} out of range`);
    let cp: Checkpoint<S> | undefined;
    for (const c of this.checkpoints) if (c.index <= n && (!cp || c.index > cp.index)) cp = c;
    // Build checkpoints lazily if we have never been this far.
    if (!cp || (n - cp.index >= this.checkpointEvery && n > this.builtTo)) {
      let out: Frame | undefined;
      this.run((f) => (out = f), (i) => i === n, n);
      return out!;
    }
    const tree = structuredClone(cp.tree);
    const state = structuredClone(cp.state);
    for (let i = cp.index + 1; i <= n; i++) {
      const c = this.history.commits[i];
      const delta = applyCommit(tree, c, this.followRenames);
      this.strategy.step(state, tree, c, delta, this.ctx);
    }
    return this.makeFrame(tree, state, this.history.commits[n]);
  }
}
