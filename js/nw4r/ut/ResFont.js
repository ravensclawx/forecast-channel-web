// Port of Sources/NW4R/Ut/ResFont.swift — nw4r::ut::ResFont, RFNT bitmap font (FINF / TGLP / CWDH / CMAP),
// and ArchiveFont (RFNA, compressed sheets).
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';
import { CX, CXHuffman } from '../../rvl/CX.js';
import { GXTextureDecoder, GXTexFmt } from '../../gx/GXTexture.js';

export class ResFont {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    const r = new BEReader(bytes);
    const m = r.magic(0);
    if (m !== 'RFNT' && m !== 'RFNA') throw RVLError.badMagic(m, 'RFNT');
    // RFNT starts with FINF; RFNA (nw4r::ut::ArchiveFont) has a GLGR block first — walk the blocks.
    let finf = r.u16(0xC);
    while (finf + 8 <= bytes.length && r.magic(finf) !== 'FINF') finf += r.u32(finf + 4);
    this.fontType = r.u8(finf + 8);
    this.lineFeed = r.s8(finf + 9);
    this.alterCharIndex = r.u16(finf + 0xA);
    this.defaultWidths = { left: r.s8(finf + 0xC), glyphWidth: r.u8(finf + 0xD), charWidth: r.s8(finf + 0xE) };
    this.encoding = r.u8(finf + 0xF);
    const tglp = r.u32(finf + 0x10) - 8, cwdh = r.u32(finf + 0x14) - 8, cmapOff = r.u32(finf + 0x18) - 8;
    this.height = r.u8(finf + 0x1C); this.width = r.u8(finf + 0x1D); this.ascent = r.u8(finf + 0x1E);

    this.cellWidth = r.u8(tglp + 8); this.cellHeight = r.u8(tglp + 9);
    this.baselinePos = r.s8(tglp + 10); this.maxCharWidth = r.u8(tglp + 11);
    const sheetSize = r.u32(tglp + 12), sheetNum = r.u16(tglp + 16);
    const fmtRaw = r.u16(tglp + 18) & 0x7FFF;
    this.sheetFormat = fmtRaw;
    const compressed = (r.u16(tglp + 18) & 0x8000) !== 0;
    this.sheetRow = r.u16(tglp + 20); this.sheetLine = r.u16(tglp + 22);
    this.sheetWidth = r.u16(tglp + 24); this.sheetHeight = r.u16(tglp + 26);
    const image = r.u32(tglp + 28);
    const sw = this.sheetWidth, sh = this.sheetHeight, fmt = fmtRaw;
    /** Decoded sheets (RGBA8 Uint8Array each) — decoded lazily on first access (the system font has many CJK sheets). */
    this._sheetSrc = [];
    if (compressed) {
      // ArchiveFont: each sheet = u32 compressed size + CX stream (Huffman 0x2x / LZ 0x1x).
      let p = image;
      for (let i = 0; i < sheetNum; i++) {
        const n = r.u32(p);
        const stream = bytes.subarray(p + 4, Math.min(p + 4 + n, bytes.length));
        this._sheetSrc.push({ stream, compressed: true });
        p += 4 + n;
      }
    } else {
      for (let i = 0; i < sheetNum; i++) this._sheetSrc.push({ offset: image + i * sheetSize, compressed: false });
    }
    this._bytes = bytes;
    this._sheetSize = sheetSize;
    this._sheetCache = new Array(sheetNum).fill(null);

    /** @type {{begin:number,end:number,entries:{left:number,glyphWidth:number,charWidth:number}[]}[]} */
    this.widthTable = [];
    let w = cwdh;
    while (w > 0) {
      const begin = r.u16(w + 8), end = r.u16(w + 10), next = r.u32(w + 12);
      const entries = [];
      for (let i = 0; i <= Math.max(end - begin, 0); i++) {
        entries.push({ left: r.s8(w + 16 + i * 3), glyphWidth: r.u8(w + 17 + i * 3), charWidth: r.s8(w + 18 + i * 3) });
      }
      this.widthTable.push({ begin, end, entries });
      w = next === 0 ? 0 : next - 8;
    }
    /** @type {Map<number, number>} */
    this.cmap = new Map();
    this.directRanges = [];
    let c = cmapOff;
    while (c > 0) {
      const begin = r.u16(c + 8), end = r.u16(c + 10), method = r.u16(c + 12), next = r.u32(c + 16);
      const data = c + 20;
      switch (method) {
        case 0: this.directRanges.push({ begin, end, offset: r.u16(data) }); break;
        case 1:
          for (let code = begin; code <= end; code++) {
            const idx = r.u16(data + (code - begin) * 2);
            if (idx !== 0xFFFF) this.cmap.set(code, idx);
          }
          break;
        default: {
          const n = r.u16(data);
          for (let i = 0; i < n; i++) this.cmap.set(r.u16(data + 2 + i * 4), r.u16(data + 4 + i * 4));
        }
      }
      c = next === 0 ? 0 : next - 8;
    }
  }

  get sheetCount() { return this._sheetSrc.length; }

  /** Decoded RGBA8 sheet `i` (Uint8Array, sheetWidth × sheetHeight × 4). */
  sheet(i) {
    let s = this._sheetCache[i];
    if (s) return s;
    const src = this._sheetSrc[i];
    const sw = this.sheetWidth, sh = this.sheetHeight, fmt = this.sheetFormat;
    if (src.compressed) {
      let raw;
      const t = src.stream[0] ?? 0;
      try {
        if (t >= 0x20 && t <= 0x2F) raw = CXHuffman.uncompress(src.stream);
        else if (t === 0x10 || t === 0x11) raw = CX.uncompressLZ(src.stream);
        else raw = src.stream;
      } catch { raw = new Uint8Array(0); }
      if (raw.length < this._sheetSize) { const p = new Uint8Array(this._sheetSize); p.set(raw); raw = p; }
      s = GXTextureDecoder.decode(raw, 0, sw, sh, fmt);
    } else {
      s = GXTextureDecoder.decode(this._bytes, src.offset, sw, sh, fmt);
    }
    this._sheetCache[i] = s;
    return s;
  }

  /** All sheets (decodes every one). */
  get sheets() { return this._sheetSrc.map((_, i) => this.sheet(i)); }

  /** ResFontBase::GetGlyphIndex (falls back to the alternate character). */
  glyphIndex(code) {
    const i = this.cmap.get(code);
    if (i !== undefined) return i;
    for (const d of this.directRanges) if (code >= d.begin && code <= d.end) return code - d.begin + d.offset;
    return this.alterCharIndex;
  }

  widths(index) {
    for (const t of this.widthTable) if (index >= t.begin && index <= t.end) return t.entries[index - t.begin];
    return this.defaultWidths;
  }

  /** ResFontBase::GetGlyphFromIndex — cells are laid out with a 1-pixel gutter. */
  glyph(code) {
    const index = this.glyphIndex(code);
    const perSheet = this.sheetRow * this.sheetLine;
    const sheet = (index / perSheet) | 0, cell = index % perSheet;
    return {
      sheet, widths: this.widths(index),
      cellX: (cell % this.sheetRow) * (this.cellWidth + 1), cellY: ((cell / this.sheetRow) | 0) * (this.cellHeight + 1),
    };
  }

  hasGlyph(code) { return this.glyphIndex(code) !== this.alterCharIndex || this.cmap.has(code); }

  /** Sheet format is an intensity format (I4/I8): glyph coverage lives in alpha. */
  get isIntensity() { return this.sheetFormat === (GXTexFmt?.i4 ?? 0) || this.sheetFormat === (GXTexFmt?.i8 ?? 1); }
}
