// Port of Sources/NW4R/G3D/ResFile.swift — nw4r::g3d::ResFile, a BRRES container ("bres").
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';
import { GXTextureDecoder, GXTexFmt } from '../../gx/GXTexture.js';
import { ResMdl } from './ResMdl.js';

/** nw4r::g3d::ResDic — the Patricia-tree dictionary used by every NW4R resource group. */
export const ResDic = {
  /** Returns [name, absolute data offset] pairs in dictionary order (entries 1...n). */
  entries(r, off) {
    const n = r.u32(off + 4), out = [];
    for (let i = 1; i <= n; i++) {
      const e = off + 8 + i * 16;
      out.push([r.cString(off + r.s32(e + 8)), off + r.s32(e + 12)]);
    }
    return out;
  },
};

/** nw4r::g3d::ResTex (TEX0). */
export class ResTex {
  constructor(r, o, name) {
    this.r = r; this.name = name;
    this.isCI = r.u32(o + 0x18) !== 0;
    this.width = r.u16(o + 0x1C); this.height = r.u16(o + 0x1E);
    this.format = r.u32(o + 0x20);
    this.mipCount = r.u32(o + 0x24);
    this.dataOffset = o + r.s32(o + 0x10);
  }
  rgba8() { return GXTextureDecoder.decode(this.r.data, this.dataOffset, this.width, this.height, this.format); }
}

export class ResFile {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    const r = new BEReader(bytes);
    if (r.magic(0) !== 'bres') throw RVLError.badMagic(r.magic(0), 'bres');
    this.r = r;
    /** @type {Map<string, ResMdl>} */
    this.models = new Map();
    /** @type {Map<string, ResTex>} */
    this.textures = new Map();
    const root = r.u16(0xC);
    for (const [folder, fo] of ResDic.entries(r, root + 8)) {
      for (const [name, o] of ResDic.entries(r, fo)) {
        switch (folder) {
          case '3DModels(NW4R)': this.models.set(name, new ResMdl(r, o)); break;
          case 'Textures(NW4R)': this.textures.set(name, new ResTex(r, o, name)); break;
          default: break; // animations parsed when the game needs them
        }
      }
    }
  }
}
