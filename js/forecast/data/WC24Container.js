// Port of Sources/Forecast/Data/WC24Container.swift (BEWriter, LZ10 encoder, WC24 download container).

/** Big-endian byte writer (growable). */
export class BEWriter {
  constructor(capacity = 4096) { this.buf = new Uint8Array(capacity); this.count = 0; }
  _grow(n) {
    if (this.count + n <= this.buf.length) return;
    let c = this.buf.length * 2; while (c < this.count + n) c *= 2;
    const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.count)); this.buf = b;
  }
  get bytes() { return this.buf.subarray(0, this.count); }
  u8(v) { this._grow(1); this.buf[this.count++] = v & 0xFF; }
  s8(v) { this.u8(v & 0xFF); }
  u16(v) { this._grow(2); this.buf[this.count++] = (v >>> 8) & 0xFF; this.buf[this.count++] = v & 0xFF; }
  s16(v) { this.u16(v & 0xFFFF); }
  u32(v) {
    this._grow(4);
    this.buf[this.count++] = (v >>> 24) & 0xFF; this.buf[this.count++] = (v >>> 16) & 0xFF;
    this.buf[this.count++] = (v >>> 8) & 0xFF; this.buf[this.count++] = v & 0xFF;
  }
  pad(a) { while (this.count % a !== 0) this.u8(0); }
  put32(v, o) {
    this.buf[o] = (v >>> 24) & 0xFF; this.buf[o + 1] = (v >>> 16) & 0xFF; this.buf[o + 2] = (v >>> 8) & 0xFF; this.buf[o + 3] = v & 0xFF;
  }
  /** UTF-16BE, NUL-terminated. */
  utf16(s) { for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); this.u16(0); }
  /** Copy of the written bytes. */
  toArray() { return this.buf.slice(0, this.count); }
}

/** LZ10 ("LZ77 type 0x10") encoder — the inverse of CXUncompressLZ. */
export const LZ10 = Object.freeze({
  compress(src) {
    const out = new BEWriter(src.length + 64);
    out.u8(0x10);
    if (src.length < 0x100_0000) {
      out.u8(src.length & 0xFF); out.u8((src.length >>> 8) & 0xFF); out.u8((src.length >>> 16) & 0xFF);
    } else {
      out.u8(0); out.u8(0); out.u8(0);
      out.u8(src.length & 0xFF); out.u8((src.length >>> 8) & 0xFF); out.u8((src.length >>> 16) & 0xFF); out.u8(src.length >>> 24);
    }
    // hash chains over 3-byte prefixes, window 4096, match 3...18
    const head = new Int32Array(1 << 15).fill(-1);
    const prev = new Int32Array(src.length).fill(-1);
    const h = i => ((src[i] << 7) ^ (src[i + 1] << 3) ^ src[i + 2]) & 0x7FFF;
    const insert = i => { if (i + 2 >= src.length) return; const k = h(i); prev[i] = head[k]; head[k] = i; };
    let i = 0;
    while (i < src.length) {
      const flagPos = out.count; out.u8(0);
      let flags = 0;
      for (let bit = 0; bit < 8 && i < src.length; bit++) {
        let bestLen = 0, bestDist = 0;
        if (i + 2 < src.length) {
          let c = head[h(i)], tries = 0;
          while (c >= 0 && i - c <= 0x1000 && tries < 64) {
            let l = 0;
            while (l < 18 && i + l < src.length && src[c + l] === src[i + l]) l++;
            if (l > bestLen) { bestLen = l; bestDist = i - c; if (l === 18) break; }
            c = prev[c]; tries++;
          }
        }
        if (bestLen >= 3) {
          flags |= 0x80 >> bit;
          const d = bestDist - 1;
          out.u8(((bestLen - 3) << 4) | (d >> 8));
          out.u8(d & 0xFF);
          for (let k = 0; k < bestLen; k++) insert(i + k);
          i += bestLen;
        } else {
          out.u8(src[i]); insert(i); i++;
        }
      }
      out.buf[flagPos] = flags;
    }
    while (out.count % 4 !== 0) out.u8(0);
    return out.toArray();
  },

  /** CXUncompressLZ (types 0x10 and 0x11), as Sources/RVL/CX.swift — self-contained so the data layer has no
   *  dependency on the asset pipeline. Accepts an "LZ77"-prefixed stream. */
  uncompress(input) {
    let src = input;
    if (src.length >= 4 && src[0] === 0x4C && src[1] === 0x5A && src[2] === 0x37 && src[3] === 0x37) src = src.subarray(4);
    if (src.length < 4 || (src[0] !== 0x10 && src[0] !== 0x11)) throw new Error('CXGetCompressionType() data is not LZ.');
    const ext = src[0] === 0x11;
    let size = src[1] | (src[2] << 8) | (src[3] << 16);
    let p = 4;
    if (size === 0) { size = (src[4] | (src[5] << 8) | (src[6] << 16) | (src[7] << 24)) >>> 0; p = 8; }
    const out = new Uint8Array(size);
    let n = 0;
    while (n < size) {
      if (p >= src.length) throw new Error('CXIsFinisiedUncompLZ() is false.');
      const flags = src[p++];
      for (let bit = 0; bit < 8 && n < size; bit++) {
        if ((flags & (0x80 >> bit)) === 0) { out[n++] = src[p++]; continue; }
        let len, disp;
        if (!ext) {
          len = (src[p] >> 4) + 3;
          disp = (((src[p] & 0xF) << 8) | src[p + 1]) + 1; p += 2;
        } else {
          switch (src[p] >> 4) {
            case 0:
              len = (((src[p] & 0xF) << 4) | (src[p + 1] >> 4)) + 0x11;
              disp = (((src[p + 1] & 0xF) << 8) | src[p + 2]) + 1; p += 3; break;
            case 1:
              len = (((src[p] & 0xF) << 12) | (src[p + 1] << 4) | (src[p + 2] >> 4)) + 0x111;
              disp = (((src[p + 2] & 0xF) << 8) | src[p + 3]) + 1; p += 4; break;
            default:
              len = (src[p] >> 4) + 1;
              disp = (((src[p] & 0xF) << 8) | src[p + 1]) + 1; p += 2;
          }
        }
        if (disp > n) throw new Error('LZ: back-reference before start');
        for (let k = 0; k < len && n < size; k++) { out[n] = out[n - disp]; n++; }
      }
    }
    return out;
  },
});

/** WiiConnect24 download container as served at weather.wapp.wii.com/<lang>/<country>/{forecast,short}.bin:
 *    0x000  0x40  header (zero for unencrypted content)
 *    0x040  0x100 RSA-2048 PKCS#1 v1.5 SHA-1 signature over the payload
 *    0x140  …     LZ-compressed payload (the forecast.bin / short.bin bytes)
 *  The port, like Dolphin + RiiConnect24/WiiLink setups, does not verify the signature; the generator writes a
 *  zero signature. The web build keeps the container for cache parity with the Mac/iOS builds. */
export const WC24Container = Object.freeze({
  headerSize: 0x140,

  wrap(payload) {
    const lz = LZ10.compress(payload);
    const out = new Uint8Array(0x140 + lz.length);
    out.set(lz, 0x140);
    return out;
  },

  /** Accepts the full container, a bare LZ payload, or an already-decompressed file. */
  unwrap(data) {
    let body = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (body.length > 0x140 && (body[0x140] === 0x10 || body[0x140] === 0x11)) {
      let zero = true;
      for (let i = 0; i < 0x40; i++) if (body[i] !== 0) { zero = false; break; }
      if (zero) body = body.subarray(0x140);
    }
    if (body.length > 0 && (body[0] === 0x10 || body[0] === 0x11)) {
      try { return LZ10.uncompress(body); } catch (e) { throw new Error(`container: ${e.message}`); }
    }
    return body;
  },
});
