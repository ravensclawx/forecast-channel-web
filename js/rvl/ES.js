// Port of Sources/RVL/ES.swift — minimal ES (eticket services) replacement: opens an installable WAD the way IOS
// would, decrypts the title key with the common key and exposes decrypted contents by TMD index.
import { BEReader, RVLError, roundUp } from './BinaryReader.js';
import { ARCArchive } from './ARC.js';
import { aesCBCDecrypt, sha1 } from './AES.js';

export class ESTitle {
  /**
   * @param {Uint8Array} wad  the whole .wad file
   * @param {Uint8Array} commonKey  16 bytes
   */
  constructor(wad, commonKey) {
    if (!commonKey || commonKey.length !== 16) throw RVLError.missing('16-byte Wii common key');
    this.wad = wad;
    const r = new BEReader(wad);
    if (!(r.u32(0) === 0x20 && r.u16(4) === 0x4973)) throw RVLError.badMagic(r.magic(4), 'Is');
    const certSize = r.u32(8), tikSize = r.u32(0x10), tmdSize = r.u32(0x14);
    const tik = 0x40 + roundUp(certSize, 0x40);
    const tmd = tik + roundUp(tikSize, 0x40);
    let off = tmd + roundUp(tmdSize, 0x40);

    /** BigInt title ID, plus a hex string form. */
    this.titleID = r.u64(tmd + 0x18C);
    this.titleIDHex = this.titleID.toString(16).padStart(16, '0').toUpperCase();
    this.titleVersion = r.u16(tmd + 0x1DC);
    const n = r.u16(tmd + 0x1DE);
    this.contents = [];
    this.contentOffsets = [];
    for (let i = 0; i < n; i++) {
      const c = tmd + 0x1E4 + i * 36;
      const ct = { id: r.u32(c), index: r.u16(c + 4), type: r.u16(c + 6), size: Number(r.u64(c + 8)), sha1: r.bytes(c + 16, 20) };
      this.contents.push(ct); this.contentOffsets.push(off);
      off += roundUp(roundUp(ct.size, 16), 0x40);
    }
    const iv = new Uint8Array(16);
    iv.set(r.bytes(tik + 0x1DC, 8));
    this.titleKey = aesCBCDecrypt(commonKey, iv, r.bytes(tik + 0x1BF, 16));
    this.cache = new Map();
  }

  /** Decrypted content by TMD index (what the channel sees via CNTOpen / contents of its own title). */
  content(index) {
    if (this.cache.has(index)) return this.cache.get(index);
    const i = this.contents.findIndex(c => c.index === index);
    if (i < 0) throw RVLError.missing(`content index ${index}`);
    const c = this.contents[i];
    const iv = new Uint8Array(16);
    iv[0] = index >> 8; iv[1] = index & 0xFF;
    const start = this.contentOffsets[i];
    const enc = this.wad.subarray(start, start + roundUp(c.size, 16));
    const dec = aesCBCDecrypt(this.titleKey, iv, enc).subarray(0, c.size);
    const digest = sha1(dec);
    for (let k = 0; k < 20; k++) if (digest[k] !== c.sha1[k]) throw RVLError.corrupt(`content ${index} hash mismatch (wrong common key?)`);
    this.cache.set(index, dec);
    return dec;
  }

  /** Content index → U8 archive. */
  archive(index) { return new ARCArchive(this.content(index)); }
}
