// The engine replays a History through a Strategy.
//
//   step(state, tree, commit, delta)  — mutates strategy state; called for EVERY commit
//   frame(state, tree, commit)        — pure; produces the layout at that commit
//
// Because all state change happens in step(), the layout at commit N is the same
// whether you replay every commit or jump via checkpoints. Online strategies
// (usesFuture: false) never see the History; only hindsight strategies do.

import { applyCommit, emptyTree } from './model/tree.ts';
import { wireStyle, type WireStyle } from './geometry/arrange.ts';
import { bbox } from './geometry/treev.ts';
import type { Commit, Delta, Frame, History, LayoutNode, OptionSchema, OptionSpec, Options, TreeState } from './types.ts';

export interface StrategyContext {
  options: Options; // validated, defaults already merged in (see mergeOptions)
  history?: History; // only provided when usesFuture is true
}

export interface Strategy<S = unknown> {
  name: string;
  description: string;
  usesFuture: boolean;
  /** Every option the strategy accepts (its own and the shared geometry), with defaults. */
  schema: OptionSchema;
  defaults: Options; // = defaultsOf(schema), kept for convenience
  init(ctx: StrategyContext): S;
  step(state: S, tree: TreeState, commit: Commit, delta: Delta, ctx: StrategyContext): void;
  frame(state: S, tree: TreeState, commit: Commit, ctx: StrategyContext): LayoutNode[];
  /** Wire style of every frame, for strategies that do their own arrangement (else from `arrange`). */
  wires?: WireStyle;
}

/** Options the Runner itself reads; valid for every strategy. */
export const engineSchema: OptionSchema = {
  followRenames: { type: 'boolean', default: true, doc: 'renames keep file identity (else delete + add)' },
};
export const engineDefaults: Options = defaultsOf(engineSchema);

export function defaultsOf(schema: OptionSchema): Options {
  const o: Options = {};
  for (const [k, spec] of Object.entries(schema)) o[k] = spec.default;
  return o;
}

/** Engine options followed by the strategy's own, as the Runner validates them. */
export function optionSchema(s: Strategy): OptionSchema {
  return { ...engineSchema, ...s.schema };
}

/** One-line description of an option: `growth: number >= 1 (default 1.5)`. */
export function describeOption(name: string, spec: OptionSpec): string {
  let t: string;
  if (spec.type === 'enum') t = spec.values.join('|');
  else if (spec.type === 'boolean') t = 'boolean';
  else {
    const r: string[] = [];
    if (spec.min !== undefined) r.push(`${spec.minExclusive ? '>' : '>='} ${spec.min}`);
    if (spec.max !== undefined) r.push(`<= ${spec.max}`);
    t = `${spec.integer ? 'integer' : 'number'}${r.length ? ' ' + r.join(', ') : ''}`;
  }
  return `${name}: ${t} (default ${spec.default})`;
}

// Plain decimal numbers only: "12", "-0.5", ".25". Not "0x10", "1e3", " ", "".
const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** Check one value against its spec; returns the normalised value or an error message. */
function coerce(spec: OptionSpec, v: unknown): { ok: string | number | boolean } | { err: string } {
  if (spec.type === 'boolean') {
    if (v === true || v === 'true') return { ok: true };
    if (v === false || v === 'false') return { ok: false };
    return { err: 'expected true or false' };
  }
  if (spec.type === 'enum') {
    if (typeof v === 'string' && spec.values.includes(v)) return { ok: v };
    return { err: `expected one of ${spec.values.join('|')}` };
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return { err: 'expected a number' };
  if (spec.integer && !Number.isInteger(n)) return { err: 'expected an integer' };
  if (spec.min !== undefined && (spec.minExclusive ? n <= spec.min : n < spec.min))
    return { err: `must be ${spec.minExclusive ? '>' : '>='} ${spec.min}` };
  if (spec.max !== undefined && n > spec.max) return { err: `must be <= ${spec.max}` };
  return { ok: n };
}

/**
 * Validate `given` against the engine + strategy schema and merge it over the defaults.
 * Unknown keys and wrong types/values throw, listing the valid options. Values are normalised
 * ("true" -> true, "1.5" -> 1.5), so strategies can read them as typed.
 */
export function mergeOptions(s: Strategy, given: Options = {}): Options {
  const schema = optionSchema(s);
  const out = defaultsOf(schema);
  const errs: string[] = [];
  for (const [k, v] of Object.entries(given)) {
    const spec = Object.hasOwn(schema, k) ? schema[k] : undefined;
    if (!spec) {
      const near = Object.keys(schema).find((x) => x.toLowerCase() === k.toLowerCase());
      errs.push(`unknown option "${k}"${near ? ` (did you mean "${near}"?)` : ''}`);
      continue;
    }
    const r = coerce(spec, v);
    if ('err' in r) errs.push(`${k}=${JSON.stringify(v)}: ${r.err}`);
    else out[k] = r.ok;
  }
  if (errs.length) {
    const valid = Object.entries(schema).map(([k, spec]) => '  ' + describeOption(k, spec));
    throw new Error(`invalid options for strategy "${s.name}":\n  ${errs.join('\n  ')}\nvalid options:\n${valid.join('\n')}`);
  }
  return out;
}

/** CLI `--opt k=v` value: true/false -> boolean, plain decimals -> number, anything else stays a string. */
export function parseOptionValue(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (DECIMAL.test(v)) return Number(v);
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
    return { commit: c.index, sha: c.sha, time: c.time, strategy: this.strategy.name, nodes, bbox: bbox(nodes), wires: this.strategy.wires ?? wireStyle(this.ctx.options.arrange) };
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
