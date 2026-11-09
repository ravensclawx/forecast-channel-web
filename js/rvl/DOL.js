// Port of Sources/RVL/DOL.swift — read-only view of a DOL executable by virtual address
// (used to pull constant tables out of main.dol at runtime).
import { BEReader, floatFromBits } from './BinaryReader.js';

export class DOLImage {
  /** @param {Uint8Array} b */
  constructor(b) {
    this.bytes = b;
    this.r = new BEReader(b);
    this.sections = [];
    for (let i = 0; i < 18; i++) {
      const size = this.r.u32(144 + i * 4);
      if (size !== 0) this.sections.push({ file: this.r.u32(i * 4), addr: this.r.u32(72 + i * 4), size });
    }
  }
  /** File offset of a virtual address, or null. */
  offset(address) {
    const a = address >>> 0;
    for (const s of this.sections) if (a >= s.addr && a < s.addr + s.size) return s.file + (a - s.addr);
    return null;
  }
  /** [BEReader over the whole DOL, offset] or null. */
  reader(address) { const o = this.offset(address); return o === null ? null : [this.r, o]; }
  u32(a) { const o = this.offset(a); return o === null ? 0 : this.r.u32(o); }
  u16(a) { const o = this.offset(a); return o === null ? 0 : this.r.u16(o); }
  f32(a) { return floatFromBits(this.u32(a)); }
}
