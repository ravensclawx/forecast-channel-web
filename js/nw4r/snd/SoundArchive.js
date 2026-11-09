// Port of Sources/NW4R/Snd/SoundArchive.swift — nw4r::snd SoundArchive (RSAR v1.x), RSEQ, RBNK, DSP-ADPCM.
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';

export const SoundType = Object.freeze({ seq: 1, strm: 2, wave: 3 });

export class SoundArchive {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    const r = new BEReader(bytes);
    if (r.magic(0) !== 'RSAR') throw RVLError.badMagic(r.magic(0), 'RSAR');
    this.data = r.data;
    this.sounds = []; this.players = []; this.banks = [];
    /** @type {Map<number, {offset:number,size:number,waveOffset:number,waveSize:number}>} */
    this.files = new Map();
    const symb = r.u32(0x10), info = r.u32(0x18);
    let strings = [];
    if (symb !== 0) {
      const sb = symb + 8, st = sb + r.u32(sb);
      const n = r.u32(st);
      for (let i = 0; i < n; i++) strings.push(r.cString(sb + r.u32(st + 4 + i * 4)));
    }
    const name = (id) => id < strings.length ? strings[id] : `#${id}`;
    const ib = info + 8;
    const table = (refAt) => {
      const t = ib + r.u32(refAt + 4), out = [];
      const n = r.u32(t);
      for (let i = 0; i < n; i++) out.push(ib + r.u32(t + 4 + i * 8 + 4));
      return out;
    };
    for (const o of table(ib)) {
      const det = ib + r.u32(o + 0x1C);
      const type = r.u8(o + 0x16);
      const seq = type === SoundType.seq;
      this.sounds.push({
        name: name(r.u32(o)), fileID: r.u32(o + 4), playerID: r.u32(o + 8),
        volume: r.u8(o + 0x14), playerPriority: r.u8(o + 0x15), type: [1, 2, 3].includes(type) ? type : null,
        panMode: r.u8(o + 0x2C), panCurve: r.u8(o + 0x2D),
        seqLabelOffset: seq ? r.u32(det) : 0, seqBankID: seq ? r.u32(det + 4) : 0,
        seqAllocTrack: seq ? r.u32(det + 8) : 0, seqChannelPriority: seq ? r.u8(det + 12) : 64,
      });
    }
    this.banks = table(ib + 8).map((b) => ({ name: name(r.u32(b)), fileID: r.u32(b + 4) }));
    this.players = table(ib + 16).map((p) => ({ name: name(r.u32(p)), playableSoundCount: r.u8(p + 4) }));
    // Groups locate file bodies and their wave data inside the archive.
    for (const g of table(ib + 32)) {
      const base = r.u32(g + 0x10), wbase = r.u32(g + 0x18);
      const items = ib + r.u32(g + 0x24);
      const n = r.u32(items);
      for (let i = 0; i < n; i++) {
        const it = ib + r.u32(items + 4 + i * 8 + 4);
        const fid = r.u32(it);
        if (!this.files.has(fid)) {
          this.files.set(fid, { offset: base + r.u32(it + 4), size: r.u32(it + 8), waveOffset: wbase + r.u32(it + 12), waveSize: r.u32(it + 16) });
        }
      }
    }
  }

  fileData(id) { const f = this.files.get(id); return f ? this.data.subarray(f.offset, f.offset + f.size) : null; }
  waveData(id) { const f = this.files.get(id); return f ? this.data.subarray(f.waveOffset, f.waveOffset + f.waveSize) : null; }
  soundID(n) { const i = this.sounds.findIndex((s) => s.name === n); return i < 0 ? null : i; }
}

/** RSEQ: sequence data + labels. */
export class SeqFile {
  constructor(bytes) {
    const r = new BEReader(bytes);
    if (r.magic(0) !== 'RSEQ') throw RVLError.badMagic(r.magic(0), 'RSEQ');
    const dataBlk = r.u32(0x10), lablBlk = r.u32(0x18);
    const start = dataBlk + r.u32(dataBlk + 8);
    this.data = r.data.slice(start, dataBlk + r.u32(dataBlk + 4));
    this.labels = new Map();
    if (lablBlk !== 0) {
      const lb = lablBlk + 8, n = r.u32(lb);
      const dec = new TextDecoder();
      for (let i = 0; i < n; i++) {
        const e = lb + r.u32(lb + 4 + i * 4);
        this.labels.set(dec.decode(r.bytes(e + 8, r.u32(e + 4))), r.u32(e));
      }
    }
  }
}

/** RBNK: instruments (InstParam via key/velocity region tables) + wave infos. */
export class BankFile {
  constructor(bytes) {
    const r = new BEReader(bytes);
    if (r.magic(0) !== 'RBNK') throw RVLError.badMagic(r.magic(0), 'RBNK');
    this.r = r;
    const dataBlk = r.u32(0x10), waveBlk = r.u32(0x18);
    this.instBase = dataBlk + 8;
    this.instCount = r.u32(this.instBase);
    this.waves = [];
    const wb = waveBlk + 8, n = r.u32(wb);
    for (let i = 0; i < n; i++) this.waves.push(BankFile.waveInfo(r, wb + r.u32(wb + 4 + i * 8 + 4)));
  }

  /** RWAV-style WaveInfo. Loop addresses are DSP nibble addresses → samples. */
  static waveInfo(r, w) {
    const format = r.u8(w), loop = r.u8(w + 1) !== 0, ch = r.u8(w + 2);
    const rate = (r.u8(w + 3) << 16) | r.u16(w + 4);
    const toSample = (a) => {
      switch (format) {
        case 2: return a % 16 + Math.floor(a / 16) * 14 - 2;
        case 1: return Math.floor(a / 2);
        default: return a;
      }
    };
    const ls = toSample(r.u32(w + 8)), le = toSample(r.u32(w + 12)) + 1;
    const cit = w + r.u32(w + 16);
    const dataLoc = r.u32(w + 20);
    const offs = [], coefs = [], hist = [];
    for (let c = 0; c < ch; c++) {
      const ci = w + r.u32(cit + c * 4);
      offs.push(dataLoc + r.u32(ci));
      const ai = w + r.u32(ci + 4);
      const cf = new Int16Array(16); for (let k = 0; k < 16; k++) cf[k] = r.s16(ai + k * 2);
      coefs.push(cf);
      hist.push([r.s16(ai + 0x24), r.s16(ai + 0x26)]);
    }
    return { format, loop, channels: ch, sampleRate: rate, loopStartSample: ls, loopEndSample: le,
             channelDataOffsets: offs, adpcm: coefs, initialHistory: hist };
  }

  /** BankFileReader::ReadInstInfo — program → key region → velocity region → InstParam. */
  instInfo(program, key, velocity) {
    const r = this.r;
    if (program < 0 || program >= this.instCount) return null;
    let ref = this.instBase + 4 + program * 8;
    for (const split of [key, velocity]) {
      const t = r.u8(ref + 1);
      if (t === 0) return null;
      if (t === 1) break;
      const sub = this.subRegion(ref, split);
      if (sub === null) return null;
      ref = sub;
    }
    if (r.u8(ref + 1) !== 1) return null;
    const p = this.instBase + r.u32(ref + 4);
    const wave = r.s32(p);
    if (wave < 0) return null;
    return { waveIndex: wave, attack: r.u8(p + 4), decay: r.u8(p + 5), sustain: r.u8(p + 6), release: r.u8(p + 7),
             originalKey: r.u8(p + 0xC), volume: r.u8(p + 0xD), pan: r.u8(p + 0xE), tune: r.f32(p + 0x10) };
  }

  subRegion(ref, split) {
    const r = this.r;
    const t = r.u8(ref + 1);
    const tbl = this.instBase + r.u32(ref + 4);
    switch (t) {
      case 2: { // RangeTable: u8 count, u8 key[count], refs (4-aligned) follow
        const n = r.u8(tbl);
        let i = 0;
        while (i < n && split > r.u8(tbl + 1 + i)) i++;
        if (i >= n) return null;
        return tbl + ((1 + n + 3) & ~3) + i * 8;
      }
      case 3: { // IndexTable: u8 min, u8 max, u16 pad, refs
        const lo = r.u8(tbl), hi = r.u8(tbl + 1);
        if (split < lo || split > hi) return null;
        return tbl + 4 + (split - lo) * 8;
      }
      default: return null;
    }
  }
}

/** DSP-ADPCM (GC/Wii DSP "4-bit ADPCM") → PCM. 8-byte frames: ps header + 14 nibbles. */
export const DSPADPCM = {
  decode(src, offset, samples, coefs, hist) {
    const out = new Float32Array(samples);
    let h1 = hist[0], h2 = hist[1];
    let p = offset, n = 0;
    while (n < samples && p < src.length) {
      const ps = src[p++];
      const scale = 1 << (ps & 0xF), ci = (ps >> 4) * 2;
      const c1 = coefs[ci], c2 = coefs[ci + 1];
      for (let i = 0; i < 14 && n < samples; i++) {
        if (p >= src.length) break;
        const byte = src[p];
        let nib = (i & 1) === 0 ? byte >> 4 : byte & 0xF;
        if (nib >= 8) nib -= 16;
        if (i & 1) p++;
        let s = (((nib * scale) << 11) + 1024 + (c1 * h1 + c2 * h2)) >> 11;
        s = Math.min(Math.max(s, -32768), 32767);
        h2 = h1; h1 = s;
        out[n++] = s / 32768;
      }
    }
    return out;
  },
};
