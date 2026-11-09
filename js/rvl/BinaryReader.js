// Port of Sources/RVL/BinaryReader.swift — big-endian reader over Wii data (Uint8Array).

const f32buf = new DataView(new ArrayBuffer(4));
const textDecoder = new TextDecoder('utf-8');

export class RVLError extends Error {
  static badMagic(got, expected) { return new RVLError(`bad magic '${got}', expected '${expected}'`); }
  static corrupt(s) { return new RVLError(`corrupt data: ${s}`); }
  static missing(s) { return new RVLError(`missing: ${s}`); }
}

/** Big-endian reader. `data` is a Uint8Array (an ArrayBuffer/Array is converted). */
export class BEReader {
  constructor(data) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  u8(o) { return this.data[o]; }
  s8(o) { return (this.data[o] << 24) >> 24; }
  u16(o) { const d = this.data; return (d[o] << 8) | d[o + 1]; }
  s16(o) { return (this.u16(o) << 16) >> 16; }
  u32(o) { const d = this.data; return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0; }
  s32(o) { const d = this.data; return (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]; }
  /** u64 as BigInt. */
  u64(o) { return (BigInt(this.u32(o)) << 32n) | BigInt(this.u32(o + 4)); }
  f32(o) { f32buf.setUint32(0, this.u32(o)); return f32buf.getFloat32(0); }

  bytes(o, n) { return this.data.slice(o, o + n); }
  slice(o, n) { return new BEReader(this.bytes(o, n)); }
  magic(o) { return String.fromCharCode(this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]); }

  /** NUL-terminated string. */
  cString(o) {
    let e = o;
    const d = this.data;
    while (e < d.length && d[e] !== 0) e++;
    return textDecoder.decode(d.subarray(o, e));
  }
}

/** Float bits ↔ value helpers (Float(bitPattern:)). */
export function floatFromBits(u) { f32buf.setUint32(0, u >>> 0); return f32buf.getFloat32(0); }
export function bitsFromFloat(f) { f32buf.setFloat32(0, f); return f32buf.getUint32(0); }

export function roundUp(n, a) { return (n + a - 1) & ~(a - 1); }
