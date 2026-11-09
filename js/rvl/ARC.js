// Port of Sources/RVL/ARC.swift — replacement for the RVL SDK ARC library (U8 archives, magic 0x55AA382D).
// Paths resolve like ARCOpen/ARCConvertPathToEntrynum: "/arc/blyt/forecast.brlyt".
import { BEReader, RVLError } from './BinaryReader.js';

export class ARCArchive {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    const r = new BEReader(bytes);
    if (r.u32(0) !== 0x55AA382D) throw RVLError.badMagic(r.magic(0), 'U8');
    this.data = r.data;
    /** path → [start, end) */
    this.files = new Map();
    const root = r.u32(4);
    const count = r.u32(root + 8);
    const strings = root + count * 12;
    const stack = [{ end: count, path: '' }];
    for (let i = 1; i < count; i++) {
      while (stack.length && i >= stack[stack.length - 1].end) stack.pop();
      const e = root + i * 12;
      const type = r.u8(e);
      const nameOff = r.u32(e) & 0x00FFFFFF;
      const a = r.u32(e + 4), b = r.u32(e + 8);
      const name = r.cString(strings + nameOff);
      const parent = stack.length ? stack[stack.length - 1].path : '';
      // "." directories are the archive's current-dir root (ARCConvertPathToEntrynum skips them).
      const path = name === '.' ? parent : parent + '/' + name;
      if (type === 1) stack.push({ end: b, path });
      else this.files.set(path, [a, a + b]);
    }
  }

  /** File bytes by path (case-insensitive like the console), or null. Returns a copy. */
  file(path) {
    const p = path.startsWith('/') ? path : '/' + path;
    let r = this.files.get(p);
    if (!r) {
      const lp = p.toLowerCase();
      for (const [k, v] of this.files) if (k.toLowerCase() === lp) { r = v; break; }
    }
    return r ? this.data.slice(r[0], r[1]) : null;
  }

  /** Find a file by name anywhere in the archive (the channel often opens by bare name). */
  find(name) {
    const ln = name.toLowerCase();
    for (const [k, v] of this.files) {
      const last = k.split('/').pop();
      if (last.toLowerCase() === ln) return this.data.slice(v[0], v[1]);
    }
    return null;
  }
}
