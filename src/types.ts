// Core data types shared by every module.
// Units: one file cell = 1 layout unit. All coordinates are top-down 2D.

export type ChangeType = 'A' | 'M' | 'D' | 'R';

export interface Change {
  type: ChangeType;
  path: string;
  oldPath?: string; // only for 'R'
  size: number; // blob size in bytes after the change (0 for 'D')
}

export interface Commit {
  index: number; // position on the first-parent timeline, 0-based
  sha: string;
  time: number; // committer time, unix seconds
  author: string;
  subject: string;
  changes: Change[];
}

export interface History {
  repo: string; // display name
  head: string; // sha the history was extracted from
  commits: Commit[];
}

// ---- tree state (what exists at commit N) ----

export interface FileEntry {
  id: number; // stable identity; survives renames when followRenames is on
  path: string;
  size: number;
  born: number; // commit index the identity was created
  arrived: number; // commit index it arrived in its current directory
  modified: number; // commit index of last content change
}

export interface DirEntry {
  path: string; // '' is the root
  arrived: number; // commit index this directory (re)appeared
  count: number; // live files anywhere beneath it
}

export interface TreeState {
  files: Map<string, FileEntry>; // keyed by path
  dirs: Map<string, DirEntry>; // keyed by path; root '' always present
  nextId: number;
}

export interface Delta {
  added: FileEntry[];
  removed: FileEntry[];
  modified: FileEntry[];
  moved: { from: string; entry: FileEntry }[]; // only when followRenames
  dirsAdded: string[];
  dirsRemoved: string[];
}

// ---- layout output ----

export interface LayoutNode {
  id: string; // 'd:<path>' for directories, 'f:<fileId>' for files
  kind: 'dir' | 'file';
  path: string;
  parent: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  ghost?: boolean; // tombstoned: no longer exists but keeps its slot
  cid?: string; // set by the Runner on live nodes: identity under rename-following (use for metrics)
  size?: number; // files only
  born?: number; // files only
  modified?: number; // files only
}

export interface Frame {
  commit: number;
  sha: string;
  time: number;
  strategy: string;
  nodes: LayoutNode[];
  bbox: { x: number; y: number; w: number; h: number };
  wires?: 'elbow' | 'bus' | 'straight' | 'none'; // how to draw parent -> child wires (default elbow)
}

export type Options = Record<string, string | number | boolean>;

// ---- option schemas (validated by mergeOptions in engine.ts) ----

export type OptionSpec =
  | { type: 'number'; default: number; min?: number; max?: number; minExclusive?: boolean; integer?: boolean; doc?: string }
  | { type: 'boolean'; default: boolean; doc?: string }
  | { type: 'enum'; default: string; values: string[]; doc?: string };

export type OptionSchema = Record<string, OptionSpec>;
