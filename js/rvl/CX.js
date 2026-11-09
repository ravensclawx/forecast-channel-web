// Port of Sources/RVL/CX.swift (+ CXHuffman from NW4R/Snd) — replacement for the RVL SDK CX library.
import { RVLError } from './BinaryReader.js';

export const CompressionType = Object.freeze({ lz: 0x10, lzExtended: 0x11, huffman: 0x20, rl: 0x30, none: 0x00 });

export const CX = {
  compressionType(d) {
    if (!d.length) return null;
    const first = d[0];
    return (first & 0xF0) === 0x10 ? first : first & 0xF0;
  },

  uncompressedSize(d) {
    const s = d[1] | (d[2] << 8) | (d[3] << 16);
    if (s !== 0) return s;
    return (d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] << 24)) >>> 0;
  },

  /** LZ77 (types 0x10 and the 0x11 extended variant). Also accepts an "LZ77" prefixed stream. */
  uncompressLZ(input) {
    let src = input;
    if (src.length >= 4 && src[0] === 0x4C && src[1] === 0x5A && src[2] === 0x37 && src[3] === 0x37) src = src.subarray(4);
    if (src.length < 4 || (src[0] !== 0x10 && src[0] !== 0x11)) throw RVLError.corrupt('CXGetCompressionType() data is not LZ.');
    const ext = src[0] === 0x11;
    const size = CX.uncompressedSize(src);
    let p = (src[1] | (src[2] << 8) | (src[3] << 16)) === 0 ? 8 : 4;
    const out = new Uint8Array(size);
    let n = 0;
    while (n < size) {
      if (p >= src.length) throw RVLError.corrupt('CXIsFinisiedUncompLZ() is false.');
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
              disp = (((src[p + 1] & 0xF) << 8) | src[p + 2]) + 1; p += 3;
              break;
            case 1:
              len = (((src[p] & 0xF) << 12) | (src[p + 1] << 4) | (src[p + 2] >> 4)) + 0x111;
              disp = (((src[p + 2] & 0xF) << 8) | src[p + 3]) + 1; p += 4;
              break;
            default:
              len = (src[p] >> 4) + 1;
              disp = (((src[p] & 0xF) << 8) | src[p + 1]) + 1; p += 2;
          }
        }
        for (let i = 0; i < len && n < size; i++) { out[n] = out[n - disp]; n++; }
      }
    }
    return out;
  },

  /** Files named *.LZ in this title are sometimes stored already-decompressed; detect by header. */
  uncompressIfNeeded(d) {
    if (!(d.length > 8 && (d[0] === 0x10 || d[0] === 0x11))) return d;
    const size = CX.uncompressedSize(d);
    if (!(size > 0 && size < (64 << 20))) return d;
    return CX.uncompressLZ(d);
  },
};

/** CX Huffman decompression (CXUncompressHuffman), used by the HOME Menu sound archives and RFNA font sheets. */
export const CXHuffman = {
  uncompress(d) {
    if (!(d.length > 5 && (d[0] & 0xF0) === 0x20)) throw RVLError.corrupt('not CX Huffman data');
    const bits = d[0] & 0xF;
    if (bits !== 4 && bits !== 8) throw RVLError.corrupt(`bad Huffman unit ${bits}`);
    const size = d[1] | (d[2] << 8) | (d[3] << 16);
    const root = 5;
    let p = 4 + (d[4] + 1) * 2;
    const out = new Uint8Array(size);
    let n = 0, cur = 0, nb = 0, pos = root;
    while (n < size) {
      if (p + 4 > d.length) throw RVLError.corrupt('Huffman stream truncated');
      let word = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
      p += 4;
      for (let i = 0; i < 32; i++) {
        const bit = word >>> 31; word = (word << 1) >>> 0;
        const node = d[pos];
        const child = (pos & ~1) + (node & 0x3F) * 2 + 2;
        let leaf;
        if (bit === 0) { leaf = (node & 0x80) !== 0; pos = child; } else { leaf = (node & 0x40) !== 0; pos = child + 1; }
        if (leaf) {
          cur |= d[pos] << nb; nb += bits; pos = root;
          if (nb === 8) {
            out[n++] = cur & 0xFF; cur = 0; nb = 0;
            if (n >= size) break;
          }
        }
      }
    }
    return out;
  },
};
