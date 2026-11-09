// Port of Sources/NW4R/Snd/SndTables.swift — numeric tables used by nw4r::snd (envelope, LFO, pitch, volume, pan),
// read at runtime from the channel's own main.dol (.rodata of HAFE v7) so the curves are exactly the console's.
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';

export const PanCurve = Object.freeze({ sqrt: 0, sqrt0dB: 1, sqrt0dBClamp: 2, sinCos: 3, sinCos0dB: 4, sinCos0dBClamp: 5, linear: 6, linear0dB: 7, linear0dBClamp: 8 });

export class SndTables {
  /** @param {Uint8Array} dol */
  constructor(dol) {
    const r = new BEReader(dol);
    const offs = [], addrs = [], sizes = [];
    for (let i = 0; i < 18; i++) { offs.push(r.u32(i * 4)); addrs.push(r.u32(72 + i * 4)); sizes.push(r.u32(144 + i * 4)); }
    const fo = (a) => {
      for (let i = 0; i < 18; i++) if (sizes[i] > 0 && a >= addrs[i] && a < addrs[i] + sizes[i]) return offs[i] + a - addrs[i];
      throw RVLError.missing(`DOL address ${a.toString(16).toUpperCase()}`);
    };
    const floats = (a, n) => { const o = fo(a), out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = r.f32(o + i * 4); return out; };
    this.attack = floats(0x80195938, 128);               // EnvGenerator attack multipliers
    const ds = fo(0x80195838);
    this.decibelSquare = new Int16Array(128); for (let i = 0; i < 128; i++) this.decibelSquare[i] = r.s16(ds + i * 2);
    const ls = fo(0x80195B50);
    this.lfoSin = new Uint8Array(33); for (let i = 0; i < 33; i++) this.lfoSin[i] = r.u8(ls + i);
    this.note = floats(0x80195BA0, 12);
    this.pitch = floats(0x80195BD0, 256);
    this.decibelToRatio = floats(0x80195FD0, 965);       // -90.4..+6.0 dB in 0.1 dB
    this.panSqrt = floats(0x80196EE4, 257);
    this.channelReverbParam = Array.from(floats(0x8018F798, 6));
    if (!(this.attack[0] > 0.999 && this.attack[127] === 0 && this.decibelSquare[127] === 0 && this.note[0] === 1 &&
          this.decibelToRatio[904] === 1 && this.panSqrt[0] === 1)) {
      throw RVLError.corrupt('nw4r::snd tables not found at the HAFE v7 addresses');
    }
    this.seed = 0x12345678;
  }

  /** Util::CalcPitchRatio — `pitch` in 1/256 semitones. */
  pitchRatio(p) {
    let pitch = p, octave = 0;
    while (pitch < 0) { octave--; pitch += 12 * 256; }
    while (pitch >= 12 * 256) { octave++; pitch -= 12 * 256; }
    let ratio = 1;
    while (octave > 0) { ratio *= 2; octave--; }
    while (octave < 0) { ratio /= 2; octave++; }
    const n = (pitch / 256) | 0, m = pitch % 256;
    if (n !== 0) ratio *= this.note[n];
    if (m !== 0) ratio *= this.pitch[m];
    return ratio;
  }

  /** Util::CalcVolumeRatio — dB → linear, 0.1 dB steps. */
  volumeRatio(db) {
    const d = Math.min(Math.max(db, SndTables.volumeMinDB), SndTables.volumeMaxDB);
    return this.decibelToRatio[904 + Math.trunc(10 * d)];
  }

  /** Util::CalcPanRatio with the curve flags Voice::CalcMixParam derives from PanCurve. */
  panRatio(pan, curve) {
    const p = (Math.min(Math.max(pan, -1), 1) + 1) / 2;
    const idx = Math.trunc(p * 256 + 0.5);
    const tbl = (i) => {
      switch (curve) {
        case PanCurve.sqrt: case PanCurve.sqrt0dB: case PanCurve.sqrt0dBClamp: return this.panSqrt[i];
        case PanCurve.sinCos: case PanCurve.sinCos0dB: case PanCurve.sinCos0dBClamp: return Math.cos(i * Math.PI / 512);
        default: return 1 - i / 256;
      }
    };
    let ratio = tbl(idx);
    const centerZero = !(curve === PanCurve.sqrt || curve === PanCurve.sinCos || curve === PanCurve.linear);
    const zeroClamp = curve === PanCurve.sqrt0dBClamp || curve === PanCurve.sinCos0dBClamp || curve === PanCurve.linear0dBClamp;
    if (centerZero) ratio /= tbl(128);
    return zeroClamp ? Math.min(Math.max(ratio, 0), 1) : Math.min(Math.max(ratio, 0), 2);
  }

  /** Util::CalcRandom (LCG). */
  random() { this.seed = (Math.imul(this.seed, 0x19660D) + 0x3C6EF35F) >>> 0; return this.seed >>> 16; }
}
SndTables.volumeMinDB = -90.4;
SndTables.volumeMaxDB = 6.0;
