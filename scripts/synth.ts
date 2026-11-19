// Deterministic synthetic stress repos, built with `git fast-import` (no working-tree churn).
//
//   node scripts/synth.ts [outDir] [scenario...]
//
// Writes <outDir>/synth-<name> (default outDir: ../fixtures relative to the repo root) and
// recreates it from scratch each run. Author, committer, dates and contents all come from a
// seeded PRNG, so commit shas are identical on every machine and every run.
//
// Scenarios:
//   explode   quiet tree, then one mid-tree directory (src/net/handlers) gains hundreds of files
//   massmove  steady growth, then whole-directory moves (lib/ -> src/lib/ ...) and a .js->.ts
//             rename-heavy refactor (content mostly identical so `git -M` pairs them)
//   churn     constant add/delete turnover keeping the file count roughly flat
//   alphabet  name-order adversary: every new file/dir sorts before all existing siblings
//   deep      growth by nesting deeper and deeper (plus a few side chains)

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1_600_000_000; // fixed epoch for commit dates
const IDENT = 'Synth <synth@example.invalid>';

// ---- deterministic PRNG (mulberry32) ----
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'alpha beta gamma delta tree node leaf root branch commit merge layout grid cell band slot ghost order stable shift'.split(' ');

/** Builds one linear history and serializes it as a fast-import stream. */
class Repo {
  name: string;
  rand: () => number;
  files = new Map<string, string>(); // path -> content
  stream: string[] = [];
  ops: string[] = [];
  commits = 0;
  uid = 0;

  constructor(name: string, seed: number) {
    this.name = name;
    this.rand = rng(seed);
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }
  pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rand() * xs.length)];
  }
  /** Skewed size distribution: mostly small files, a long tail of big ones. */
  size(): number {
    const r = this.rand();
    return Math.round(120 + r * r * r * 24000);
  }
  /** Unique, line-oriented content of roughly `bytes` bytes (unique id => unambiguous rename pairing). */
  body(path: string, bytes = this.size()): string {
    const id = ++this.uid;
    const lines = [`// ${path} #${id}`];
    let n = lines[0].length + 1;
    let i = 0;
    while (n < bytes) {
      const l = `${String(i++).padStart(4, '0')} ${this.pick(WORDS)} ${this.pick(WORDS)} ${this.pick(WORDS)} ${id.toString(36)}`;
      lines.push(l);
      n += l.length + 1;
    }
    return lines.join('\n') + '\n';
  }

  add(path: string, bytes?: number) {
    if (this.files.has(path)) throw new Error(`${this.name}: add of existing ${path}`);
    const c = this.body(path, bytes);
    this.files.set(path, c);
    this.ops.push(modify(path, c));
  }
  /** Small edit: replace/append a few lines so size changes but identity is obvious. */
  modify(path: string) {
    const old = this.files.get(path);
    if (old === undefined) throw new Error(`${this.name}: modify of missing ${path}`);
    const lines = old.split('\n');
    const k = this.int(1, 4);
    for (let j = 0; j < k; j++) {
      const l = `edit ${this.commits} ${this.pick(WORDS)} ${this.pick(WORDS)}`;
      if (this.rand() < 0.5 && lines.length > 3) lines.splice(this.int(1, lines.length - 2), 1, l);
      else lines.splice(lines.length - 1, 0, l);
    }
    const c = lines.join('\n');
    this.files.set(path, c);
    this.ops.push(modify(path, c));
  }
  del(path: string) {
    if (!this.files.delete(path)) throw new Error(`${this.name}: delete of missing ${path}`);
    this.ops.push(`D ${q(path)}`);
  }
  /** Rename keeping content identical; `touch` adds a small edit (still >50% similar). */
  move(from: string, to: string, touch = false) {
    const c = this.files.get(from);
    if (c === undefined) throw new Error(`${this.name}: move of missing ${from}`);
    if (this.files.has(to)) throw new Error(`${this.name}: move onto existing ${to}`);
    this.files.delete(from);
    this.files.set(to, c);
    this.ops.push(`R ${q(from)} ${q(to)}`);
    if (touch) this.modify(to);
  }
  /** Move every file under dir `from` to dir `to`. */
  moveDir(from: string, to: string) {
    for (const p of this.under(from)) this.move(p, to + p.slice(from.length));
  }
  under(dir: string): string[] {
    const pre = dir === '' ? '' : dir + '/';
    return [...this.files.keys()].filter((p) => p.startsWith(pre)).sort();
  }
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
  dirs(): string[] {
    const s = new Set<string>(['']);
    for (const p of this.files.keys()) {
      let d = p;
      while (d.includes('/')) {
        d = d.slice(0, d.lastIndexOf('/'));
        s.add(d);
      }
    }
    return [...s].sort();
  }

  commit(msg: string) {
    if (!this.ops.length) throw new Error(`${this.name}: empty commit "${msg}"`);
    const n = ++this.commits;
    const when = `${T0 + n * 3600} +0000`;
    const m = `${msg}\n`;
    this.stream.push(
      'commit refs/heads/main',
      `mark :${n}`,
      `author ${IDENT} ${when}`,
      `committer ${IDENT} ${when}`,
      `data ${Buffer.byteLength(m)}`,
      m.slice(0, -1),
      ...(n > 1 ? [`from :${n - 1}`] : []),
      ...this.ops,
      '',
    );
    this.ops = [];
  }

  write(outDir: string): string {
    const dir = join(outDir, `synth-${this.name}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const g = (args: string[], input?: string) =>
      execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
    g(['init', '-q', '-b', 'main']);
    g(['fast-import', '--quiet', '--done'], this.stream.join('\n') + '\ndone\n');
    g(['reset', '-q', '--hard', 'main']);
    return dir;
  }
}

function q(path: string): string {
  // fast-import accepts C-style quoted paths; quote everything for uniformity.
  return JSON.stringify(path);
}
function modify(path: string, content: string): string {
  return `M 100644 inline ${q(path)}\ndata ${Buffer.byteLength(content)}\n${content}`;
}

// ---- scenarios ----

function explode(): Repo {
  const r = new Repo('explode', 1);
  const base = ['src/core', 'src/util', 'src/io', 'src/net', 'docs', 'test', 'scripts'];
  r.add('README.md');
  r.add('package.json');
  r.commit('init');
  // Quiet phase: a small tree grows one file at a time.
  for (let i = 0; i < 70; i++) {
    r.add(`${r.pick(base)}/f${String(i).padStart(3, '0')}.js`);
    if (r.rand() < 0.5) r.modify(r.pick(r.paths()));
    r.commit(`quiet ${i}`);
  }
  // Explosion: src/net/handlers gains 2-5 files per commit; the rest is barely touched.
  let h = 0;
  for (let i = 0; i < 200; i++) {
    const k = r.int(2, 5);
    for (let j = 0; j < k; j++) r.add(`src/net/handlers/h${String(h++).padStart(4, '0')}.js`);
    if (r.rand() < 0.15) r.modify(r.pick(r.paths()));
    r.commit(`handlers ${i}`);
  }
  // Settling: modifications only, a few adds elsewhere.
  for (let i = 0; i < 30; i++) {
    r.modify(r.pick(r.paths()));
    if (i % 5 === 0) r.add(`${r.pick(base)}/late${i}.js`);
    r.commit(`settle ${i}`);
  }
  return r;
}

function massmove(): Repo {
  const r = new Repo('massmove', 2);
  const lib = ['lib/parse', 'lib/render', 'lib/store', 'lib/net', 'lib'];
  const other = ['bin', 'test', 'test/fixtures', 'docs'];
  let n = 0;
  const grow = (dirs: string[], label: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const k = r.int(1, 3);
      for (let j = 0; j < k; j++) r.add(`${r.pick(dirs)}/m${String(n++).padStart(4, '0')}.js`);
      if (r.rand() < 0.4) r.modify(r.pick(r.paths()));
      r.commit(`${label} ${i}`);
    }
  };
  r.add('README.md');
  r.add('index.js');
  r.commit('init');
  grow([...lib, ...other], 'grow', 140);

  r.moveDir('lib', 'src/lib');
  r.modify('index.js');
  r.commit('move lib/ -> src/lib/');

  const lib2 = lib.map((d) => 'src/' + d);
  grow([...lib2, ...other], 'grow-src', 40);

  r.moveDir('test', 'src/test');
  r.commit('move test/ -> src/test/');
  r.moveDir('bin', 'tools/bin');
  r.moveDir('docs', 'site/docs');
  r.commit('move bin/ -> tools/bin/, docs/ -> site/docs/');

  // Rename-heavy refactor: .js -> .ts across src/, in three batches, each file lightly edited.
  const js = r.under('src').filter((p) => p.endsWith('.js'));
  for (let b = 0; b < 3; b++) {
    for (const p of js.filter((_, i) => i % 3 === b)) r.move(p, p.replace(/\.js$/, '.ts'), r.rand() < 0.5);
    r.commit(`refactor: .js -> .ts (batch ${b + 1}/3)`);
  }

  // Split a directory: half of src/lib/render moves to src/lib/paint.
  const render = r.under('src/lib/render');
  for (const p of render.slice(0, Math.floor(render.length / 2))) r.move(p, p.replace('src/lib/render/', 'src/lib/paint/'));
  r.commit('split render -> paint');

  // Flatten src/lib/store into src/lib (files move up a level).
  for (const p of r.under('src/lib/store')) r.move(p, p.replace('src/lib/store/', 'src/lib/store-'));
  r.commit('flatten store');

  grow([...lib2.filter((d) => !d.endsWith('store')), 'src/lib/paint', 'src/test', 'tools/bin'], 'grow-ts', 60);
  return r;
}

function churn(): Repo {
  const r = new Repo('churn', 3);
  let dirs = ['a', 'b', 'c', 'a/x', 'a/y', 'b/z', 'd/e/f', 'g'];
  let n = 0;
  const fresh = () => `${r.pick(dirs)}/c${String(n++).padStart(5, '0')}.txt`;
  r.add('README.md');
  r.commit('init');
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 5; j++) r.add(fresh());
    r.commit(`fill ${i}`);
  }
  let d = 0;
  for (let i = 0; i < 300; i++) {
    // Occasionally introduce a new directory and retire an old one from the add pool;
    // retired dirs drain naturally through deletions.
    if (i % 25 === 0) {
      dirs.push(`n${d++}${r.rand() < 0.5 ? '/sub' : ''}`);
      if (dirs.length > 8) dirs = dirs.filter((_, k) => k !== r.int(0, dirs.length - 2));
    }
    const k = r.int(1, 6);
    const live = r.paths().filter((p) => p !== 'README.md');
    const target = 150 + Math.round(15 * Math.sin(i / 20)); // roughly flat
    const dels = live.length > target ? k + 1 : live.length < target ? k - 1 : k;
    const victims = new Set<string>();
    while (victims.size < Math.min(dels, live.length)) victims.add(r.pick(live));
    for (const v of victims) r.del(v);
    for (let j = 0; j < k; j++) r.add(fresh());
    if (r.rand() < 0.5) {
      const p = r.pick(r.paths());
      if (!victims.has(p)) r.modify(p);
    }
    r.commit(`churn ${i}`);
  }
  return r;
}

function alphabet(): Repo {
  const r = new Repo('alphabet', 4);
  // Fixed-width lowercase names from a descending counter: every new name sorts before every
  // existing one (codepoint and locale order agree for [a-z]).
  let ctr = 26 ** 4 - 1;
  const next = () => {
    let x = ctr--;
    let s = '';
    for (let i = 0; i < 4; i++) {
      s = String.fromCharCode(97 + (x % 26)) + s;
      x = Math.floor(x / 26);
    }
    return s;
  };
  const dirs: string[] = [];
  r.add(`${next()}.txt`);
  r.commit('init');
  for (let i = 0; i < 250; i++) {
    const roll = r.rand();
    if (roll < 0.15 || dirs.length === 0) {
      // New directory, at top level or inside an existing top-level dir; sorts first there.
      const parent = dirs.length && r.rand() < 0.4 ? r.pick(dirs.filter((d) => !d.includes('/'))) : '';
      const d = parent ? `${parent}/${next()}` : next();
      dirs.push(d);
      r.add(`${d}/${next()}.txt`);
    } else {
      const k = r.int(1, 3);
      for (let j = 0; j < k; j++) {
        const d = r.rand() < 0.1 ? '' : r.pick(dirs);
        r.add(d ? `${d}/${next()}.txt` : `${next()}.txt`);
      }
    }
    if (r.rand() < 0.3) r.modify(r.pick(r.paths()));
    r.commit(`prepend ${i}`);
  }
  return r;
}

function deep(): Repo {
  const r = new Repo('deep', 5);
  const seg = (i: number) => `l${String(i).padStart(2, '0')}`;
  // Chains: each is a path that keeps getting one level deeper.
  const chains: string[][] = [['src']];
  let n = 0;
  r.add('README.md');
  r.add('src/main.c');
  r.commit('init');
  for (let i = 0; i < 220; i++) {
    const roll = r.rand();
    const c = r.pick(chains);
    if (roll < 0.35) {
      // Go one level deeper on a chain.
      c.push(seg(c.length));
      r.add(`${c.join('/')}/d${n++}.c`);
    } else if (roll < 0.42 && chains.length < 6) {
      // Branch a side chain off a random depth of an existing chain.
      const at = r.int(1, c.length);
      const side = [...c.slice(0, at), `side${chains.length}`];
      chains.push(side);
      r.add(`${side.join('/')}/d${n++}.c`);
    } else {
      // Add a file at a random existing depth (bias toward the deep end).
      const depth = Math.max(1, c.length - Math.floor(r.rand() * r.rand() * c.length));
      r.add(`${c.slice(0, depth).join('/')}/d${n++}.c`);
      if (r.rand() < 0.4) r.modify(r.pick(r.paths()));
    }
    r.commit(`deeper ${i}`);
  }
  return r;
}

export const scenarios: Record<string, () => Repo> = { explode, massmove, churn, alphabet, deep };

function main() {
  const args = process.argv.slice(2);
  const outDir = resolve(args[0] ?? join(ROOT, '..', 'fixtures'));
  const names = args.length > 1 ? args.slice(1) : Object.keys(scenarios);
  for (const name of names) {
    const make = scenarios[name];
    if (!make) throw new Error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(', ')}`);
    const r = make();
    const dir = r.write(outDir);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const depth = Math.max(...r.paths().map((p) => p.split('/').length));
    console.log(`synth-${name}: ${r.commits} commits, ${r.files.size} files, ${r.dirs().length} dirs, depth ${depth}, head ${head}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
