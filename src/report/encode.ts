// Compact encoding of sampled frames for the HTML player.
//
// Per fixture: one string table (paths) shared by every config, and one frame-meta
// list (commit, time, sha, subject) shared too (sample indices depend only on the
// commit count). Per config: a node table (kind, and for dirs: path + parent) and
// one varint byte stream, base64'd, holding per-frame deltas against the previous
// sampled frame:
//
//   frame   := nRemoved, removed idx (delta-coded, ascending),
//              nUpsert,  { idxDelta, mask, field* } (ascending idx)
//   mask    := bit 0 x, 1 y, 2 w, 3 h, 4 flags, 5 modified, 6 sizeBucket, 7 pathIdx
//   x,y,w,h := zigzag delta of round(v*100) vs the node's previous value (0 when new)
//   flags   := 1 = ghost;  modified := zigzag delta;  sizeBucket, pathIdx := raw
//   (dirs use pathIdx for the wire source instead: node idx + 1 of Frame node.link, 0 = parent)
//
// Node identity: directories by id; live files by `cid` (the Runner's rename-following
// identity, so a renamed file is one node even under followRenames=false, matching the
// metrics); ghost files by id in a separate key space (cids and strategy ids can collide).
// A file that becomes a ghost is therefore a remove + a new node; nothing tracks motion of
// ghosts anyway.
//
// Each frame also gets a checksum of its rounded geometry (frameChecksum), computed from
// the source frame at encode time, so the report can verify decoded positions.
//
// The decoder functions below are plain JS once types are stripped; the report
// embeds them with Function.prototype.toString(), so the tests exercise the
// exact code that runs in the browser.

import { sizeBucket } from '../render/svg.ts';
import { meshMap, warpPoly } from '../geometry/warp.ts';
import type { Frame } from '../types.ts';

export class StringTable {
  list: string[] = [];
  private map = new Map<string, number>();
  id(s: string): number {
    let i = this.map.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.map.set(s, i);
    }
    return i;
  }
}

class Bytes {
  buf = new Uint8Array(1 << 12);
  len = 0;
  push(v: number): void {
    // unsigned LEB128 using arithmetic (safe past 2^31)
    if (this.len + 10 > this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    while (v >= 128) {
      this.buf[this.len++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buf[this.len++] = v;
  }
  zz(v: number): void {
    this.push(v >= 0 ? 2 * v : -2 * v - 1);
  }
}

const F_X = 0, F_Y = 1, F_W = 2, F_H = 3, F_FL = 4, F_MOD = 5, F_SZ = 6, F_PATH = 7;
const NF = 8;
const ZZ_FIELDS = [true, true, true, true, false, true, false, false];

export interface PlayerData {
  frames: number[]; // indices into the fixture's frame-meta list
  kinds: string; // 'd' | 'f' per node
  dirPath: number[]; // per node: string idx for dirs, -1 for files
  dirParent: number[]; // per node: parent node idx for dirs, -1 otherwise
  data: string; // base64 varint stream
  bytes: number; // raw byte length (before base64)
  sums: number[]; // per frame: frameChecksum of the encoded geometry
  wires: string; // Frame.wires of the config (elbow | bus | straight | none)
  /**
   * Warped configs (Frame.mesh): x/y/w/h above are the unwarped rects (LayoutNode.base), and this
   * second varint stream holds each frame's mesh: zz(i0), zz(j0), ni, nj, then the number of changed
   * components and, per change, the gap from the previous changed index (2*(j*ni+i)+c, row-major)
   * and the zz delta of round(d*20) vs the same vertex in the previous frame (0 if new).
   */
  mesh?: string;
  meshCell?: number;
}

/**
 * Checksum of one frame's geometry over node index i with the x100-rounded fields
 * x, y, w, h and the ghost flag. Weighted by (i mod 997)+1 so that swapped nodes or
 * fields change the sum; stays well below 2^53 for any realistic frame.
 */
export function pdSumTerm(i: number, x: number, y: number, w: number, h: number, ghost: number): number {
  return ((i % 997) + 1) * (x + 3 * y + 5 * w + 7 * h + 11 * ghost + 13);
}

export class PlayerEncoder {
  private strings: StringTable;
  private idx = new Map<string, number>();
  private kinds: string[] = [];
  private dirPath: number[] = [];
  private dirParent: number[] = [];
  private prev = new Map<number, number[]>(); // node idx -> field values in the previous frame
  private out = new Bytes();
  private frames: number[] = [];
  private sums: number[] = [];
  private wires = 'elbow';
  private meshOut: Bytes | null = null;
  private meshPrev = new Map<string, number>();
  private meshCell = 0;

  constructor(strings: StringTable) {
    this.strings = strings;
  }

  private nodeIndex(id: string, kind: 'dir' | 'file', path: string, parent: string | null): number {
    let i = this.idx.get(id);
    if (i !== undefined) return i;
    i = this.kinds.length;
    this.idx.set(id, i);
    this.kinds.push(kind === 'dir' ? 'd' : 'f');
    this.dirPath.push(kind === 'dir' ? this.strings.id(path) : -1);
    // parents are listed before children in a Frame (pre-order), so the parent already has an index
    this.dirParent.push(kind === 'dir' && parent !== null ? (this.idx.get(parent) ?? -1) : -1);
    return i;
  }

  add(f: Frame, metaIndex: number): void {
    this.frames.push(metaIndex);
    this.wires = f.wires ?? 'elbow';
    const cur = new Map<number, number[]>();
    let sum = 0;
    for (const n of f.nodes) {
      const key = n.kind === 'dir' ? n.id : n.ghost ? `ghost ${n.id}` : `live ${n.cid ?? n.id}`;
      const i = this.nodeIndex(key, n.kind, n.path, n.parent);
      const r = f.mesh && n.base ? n.base : [n.x, n.y, n.w, n.h];
      const v = [
        Math.round(r[0] * 100),
        Math.round(r[1] * 100),
        Math.round(r[2] * 100),
        Math.round(r[3] * 100),
        n.ghost ? 1 : 0,
        n.kind === 'file' ? (n.modified ?? 0) : 0,
        n.kind === 'file' ? sizeBucket(n.size ?? 0) : 0,
        n.kind === 'file' ? this.strings.id(n.path) : n.link ? (this.idx.get(n.link) ?? -1) + 1 : 0,
      ];
      cur.set(i, v);
      sum += pdSumTerm(i, v[0], v[1], v[2], v[3], v[4]);
    }
    this.sums.push(sum);
    if (f.mesh) {
      const m = f.mesh, o = (this.meshOut ??= new Bytes());
      this.meshCell = m.s;
      o.zz(m.i0), o.zz(m.j0), o.push(m.ni), o.push(m.nj);
      // sparse: most vertices sit still between frames, so only (gap, delta) pairs of changes
      const ch: number[] = [];
      for (let j = 0; j < m.nj; j++)
        for (let i = 0; i < m.ni; i++)
          for (let c = 0; c < 2; c++) {
            const k = `${m.i0 + i},${m.j0 + j},${c}`, v = Math.round(m.d[2 * (j * m.ni + i) + c] * 20);
            const dv = v - (this.meshPrev.get(k) ?? 0);
            if (dv) ch.push(2 * (j * m.ni + i) + c, dv);
            this.meshPrev.set(k, v);
          }
      o.push(ch.length / 2);
      for (let e = 0, last = 0; e < ch.length; e += 2) o.push(ch[e] - last), o.zz(ch[e + 1]), (last = ch[e]);
    }
    const removed: number[] = [];
    for (const i of this.prev.keys()) if (!cur.has(i)) removed.push(i);
    removed.sort((a, b) => a - b);
    const ups: [number, number, number[]][] = [];
    for (const [i, v] of cur) {
      const p = this.prev.get(i);
      let mask = 0;
      for (let k = 0; k < NF; k++) if (v[k] !== (p ? p[k] : 0)) mask |= 1 << k;
      if (!p || mask) ups.push([i, mask, v]);
    }
    ups.sort((a, b) => a[0] - b[0]);
    const o = this.out;
    o.push(removed.length);
    let last = 0;
    for (const i of removed) {
      o.push(i - last);
      last = i;
    }
    o.push(ups.length);
    last = 0;
    for (const [i, mask, v] of ups) {
      o.push(i - last);
      last = i;
      o.push(mask);
      const p = this.prev.get(i);
      for (let k = 0; k < NF; k++) {
        if (!(mask & (1 << k))) continue;
        if (ZZ_FIELDS[k]) o.zz(v[k] - (p ? p[k] : 0));
        else o.push(v[k]);
      }
    }
    this.prev = cur;
  }

  get byteLength(): number {
    return this.out.len;
  }

  finish(): PlayerData {
    const raw = this.out.buf.subarray(0, this.out.len);
    return {
      frames: this.frames,
      kinds: this.kinds.join(''),
      dirPath: this.dirPath,
      dirParent: this.dirParent,
      data: Buffer.from(raw).toString('base64'),
      bytes: raw.length,
      sums: this.sums,
      wires: this.wires,
      ...(this.meshOut ? { mesh: Buffer.from(this.meshOut.buf.subarray(0, this.meshOut.len)).toString('base64'), meshCell: this.meshCell } : {}),
    };
  }
}

// ---- decoder (also embedded verbatim in the report) ----

export interface PdReader {
  b: Uint8Array;
  p: number;
}

export interface PdState {
  n: number;
  live: Uint8Array;
  f: Int32Array[]; // NF fields, each length n; x..h stored as raw ints (x100)
}

export function pdVar(r: PdReader): number {
  let v = 0, m = 1, c = 0;
  do {
    c = r.b[r.p++];
    v += (c & 127) * m;
    m *= 128;
  } while (c & 128);
  return v;
}

export function pdZz(r: PdReader): number {
  const u = pdVar(r);
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

export function pdNew(n: number): PdState {
  const f: Int32Array[] = [];
  for (let k = 0; k < 8; k++) f.push(new Int32Array(n));
  return { n: n, live: new Uint8Array(n), f: f };
}

export function pdCopy(s: PdState): PdState {
  const f: Int32Array[] = [];
  for (let k = 0; k < 8; k++) f.push(s.f[k].slice());
  return { n: s.n, live: s.live.slice(), f: f };
}

/**
 * Apply one frame's delta. `moved` receives node idx that existed, are non-ghost, and changed
 * x/y; `dist` (optional) receives each such node's move distance in layout units, in step.
 */
export function pdFrame(r: PdReader, s: PdState, moved: number[] | null, dist?: number[] | null): void {
  const zzf = [1, 1, 1, 1, 0, 1, 0, 0];
  let nr = pdVar(r), i = 0;
  while (nr-- > 0) {
    i += pdVar(r);
    s.live[i] = 0;
    for (let k = 0; k < 8; k++) s.f[k][i] = 0;
  }
  let nu = pdVar(r);
  i = 0;
  while (nu-- > 0) {
    i += pdVar(r);
    const mask = pdVar(r);
    const was = s.live[i] && !(s.f[4][i] & 1);
    const ox = s.f[0][i], oy = s.f[1][i];
    if (!s.live[i]) for (let k = 0; k < 8; k++) s.f[k][i] = 0;
    for (let k = 0; k < 8; k++) {
      if (!(mask & (1 << k))) continue;
      if (zzf[k]) s.f[k][i] += pdZz(r);
      else s.f[k][i] = pdVar(r);
    }
    s.live[i] = 1;
    if (moved && was && mask & 3 && !(s.f[4][i] & 1)) {
      moved.push(i);
      if (dist) dist.push(Math.hypot(s.f[0][i] - ox, s.f[1][i] - oy) / 100);
    }
  }
}

export function b64bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** frameChecksum of a decoded state (must equal the encoder's sum for that frame). */
export function pdChecksum(s: PdState): number {
  let sum = 0;
  for (let i = 0; i < s.n; i++) if (s.live[i]) sum += pdSumTerm(i, s.f[0][i], s.f[1][i], s.f[2][i], s.f[3][i], s.f[4][i] & 1);
  return sum;
}

/** Decode every frame's mesh of a warped config (see PlayerData.mesh). */
export function pdMeshes(data: string, s: number, frames: number): any[] {
  const r = { b: b64bytes(data), p: 0 };
  const prev = new Map();
  const out: any[] = [];
  for (let f = 0; f < frames; f++) {
    const i0 = pdZz(r), j0 = pdZz(r), ni = pdVar(r), nj = pdVar(r);
    const d = new Array(2 * ni * nj);
    for (let j = 0; j < nj; j++)
      for (let i = 0; i < ni; i++)
        for (let c = 0; c < 2; c++) d[2 * (j * ni + i) + c] = prev.get(i0 + i + ',' + (j0 + j) + ',' + c) || 0;
    let nc = pdVar(r), at = 0;
    while (nc-- > 0) {
      at += pdVar(r);
      d[at] += pdZz(r);
      const c = at % 2, v = (at - c) / 2, i = v % ni, j = (v - i) / ni;
      prev.set(i0 + i + ',' + (j0 + j) + ',' + c, d[at]);
    }
    for (let e = 0; e < d.length; e++) d[e] = d[e] / 20;
    out.push({ s: s, i0: i0, j0: j0, ni: ni, nj: nj, d: d });
  }
  if (r.p !== r.b.length) throw new Error('mesh decode length mismatch');
  return out;
}

/** Source of the decoder for embedding in a <script>. */
export function decoderSource(): string {
  return [pdVar, pdZz, pdNew, pdCopy, pdFrame, pdSumTerm, pdChecksum, b64bytes, pdMeshes, meshMap, warpPoly].map((fn) => fn.toString()).join('\n');
}
