// Port of Sources/NW4R/Lyt/TPL.swift — Revolution SDK TPL texture palette file (TPLGet / TPLBind replacement).
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';
import { GXTextureDecoder } from '../../gx/GXTexture.js';

export class TPLFile {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    const r = new BEReader(bytes);
    if (r.u32(0) !== 0x0020AF30) throw RVLError.badMagic(r.magic(0), 'TPL');
    const n = r.u32(4), table = r.u32(8);
    /** @type {{width:number,height:number,format:number,wrapS:number,wrapT:number,minFilter:number,magFilter:number,rgba8:Uint8Array}[]} */
    this.images = [];
    for (let i = 0; i < n; i++) {
      const ih = r.u32(table + i * 8), ph = r.u32(table + i * 8 + 4);
      const h = r.u16(ih), w = r.u16(ih + 2);
      const fmt = r.u32(ih + 4);
      const data = r.u32(ih + 8);
      let palette = [], palFmt = 2;
      if (ph !== 0) {
        const count = r.u16(ph); palFmt = r.u32(ph + 4); const pd = r.u32(ph + 8);
        for (let k = 0; k < count; k++) palette.push(r.u16(pd + k * 2));
      }
      this.images.push({
        width: w, height: h, format: fmt, wrapS: r.u32(ih + 12), wrapT: r.u32(ih + 16),
        minFilter: r.u32(ih + 20), magFilter: r.u32(ih + 24),
        rgba8: GXTextureDecoder.decode(r.data, data, w, h, fmt, palette, palFmt),
      });
    }
  }
}
