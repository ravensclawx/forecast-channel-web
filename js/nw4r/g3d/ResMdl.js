// Port of Sources/NW4R/G3D/ResMdl.swift — nw4r::g3d::ResMdl (MDL0 v8/9: 11 resource groups) + ResMat.
import { RVLError } from '../../rvl/BinaryReader.js';
import { GXState } from '../../gx/GXState.js';
import { ResDic } from './ResFile.js';

/** Floats per vertex in GXShaderGen.vertexStride (104 bytes): pos3 nrm3 clr4 tex 8×2. */
export const VERTEX_FLOATS = 26;

export class ResMdl {
  constructor(r, m) {
    if (r.magic(m) !== 'MDL0') throw RVLError.badMagic(r.magic(m), 'MDL0');
    const version = r.u32(m + 8);
    if (version !== 8 && version !== 9) throw RVLError.corrupt(`MDL0 v${version} not supported yet`);
    const sec = [];
    for (let i = 0; i < 11; i++) sec.push(r.s32(m + 0x10 + i * 4));
    this.name = r.cString(m + r.s32(m + 0x3C));
    const group = (i) => sec[i] === 0 ? [] : ResDic.entries(r, m + sec[i]);

    // Bones
    this.bones = [];
    const boneEntries = group(1);
    const boneOffsetToIndex = new Map();
    boneEntries.forEach(([, o], i) => boneOffsetToIndex.set(o, i));
    boneEntries.forEach(([nm, o], i) => {
      const po = r.s32(o + 0x5C);
      // bind-pose transform (rows of the stored 3×4) → column-major 4×4
      const mtx = new Float32Array(16); mtx[15] = 1;
      for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) mtx[col * 4 + row] = r.f32(o + 0x6C + (row * 4 + col) * 4);
      this.bones.push({
        name: nm, index: i, flags: r.u32(o + 0x14), billboard: r.u32(o + 0x18),
        scale: [r.f32(o + 0x20), r.f32(o + 0x24), r.f32(o + 0x28)],
        rotation: [r.f32(o + 0x2C), r.f32(o + 0x30), r.f32(o + 0x34)],
        translation: [r.f32(o + 0x38), r.f32(o + 0x3C), r.f32(o + 0x40)],
        parent: po === 0 ? null : (boneOffsetToIndex.get(o + po) ?? null), modelMtx: mtx,
      });
    });

    // Vertex arrays, indexed by their resource "index" field
    const arrays = (s, comps) => {
      const out = new Map();
      for (const [, o] of group(s)) {
        const data = o + r.s32(o + 8), idx = r.u32(o + 0x10);
        const ncomp = comps(r.u32(o + 0x14)), fmt = r.u32(o + 0x18);
        const shift = r.u8(o + 0x1C), stride = r.u8(o + 0x1D), count = r.u16(o + 0x1E);
        const div = 1 << shift;
        const a = new Float32Array(count * ncomp);
        let k = 0;
        for (let v = 0; v < count; v++) {
          const p = data + v * stride;
          for (let c = 0; c < ncomp; c++) {
            switch (fmt) {
              case 0: a[k++] = r.u8(p + c) / div; break;
              case 1: a[k++] = r.s8(p + c) / div; break;
              case 2: a[k++] = r.u16(p + c * 2) / div; break;
              case 3: a[k++] = r.s16(p + c * 2) / div; break;
              default: a[k++] = r.f32(p + c * 4);
            }
          }
        }
        out.set(idx, { values: a, comps: ncomp });
      }
      return out;
    };
    const positions = arrays(2, (t) => t === 0 ? 2 : 3);
    const normals = arrays(3, () => 3);
    const uvs = arrays(5, (t) => t === 0 ? 1 : 2);
    const colors = ResMdl.colorArrays(r, group(4));

    // Materials
    this.materials = group(6).map(([nm, o], i) => new ResMat(r, o, nm, i));

    // Shapes
    this.shapes = group(8).map(([nm, o]) => ResMdl.loadShape(r, o, nm, positions, normals, colors, uvs));
    this.shapes.sort((a, b) => a.index - b.index);

    // Draw lists
    const defs = new Map(group(0));
    const draws = (key) => {
      let p = defs.get(key);
      if (p === undefined) return [];
      const out = [];
      while (r.u8(p) === 0x04) {
        out.push({ material: r.u16(p + 1), shape: r.u16(p + 3), bone: r.u16(p + 5), priority: r.u8(p + 7) });
        p += 8;
      }
      return out;
    };
    this.drawOpa = draws('DrawOpa'); this.drawXlu = draws('DrawXlu');
  }

  static colorArrays(r, entries) {
    const out = new Map();
    for (const [, o] of entries) {
      const data = o + r.s32(o + 8), idx = r.u32(o + 0x10), fmt = r.u32(o + 0x18);
      const stride = r.u8(o + 0x1C), count = r.u16(o + 0x1E);
      const a = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) {
        const p = data + v * stride;
        let c;
        switch (fmt) {
          case 0: { const x = r.u16(p); c = [((x >> 11) & 31) / 31, ((x >> 5) & 63) / 63, (x & 31) / 31, 1]; break; }
          case 1: case 2: c = [r.u8(p) / 255, r.u8(p + 1) / 255, r.u8(p + 2) / 255, 1]; break;
          case 3: { const x = r.u16(p); c = [((x >> 12) & 15) / 15, ((x >> 8) & 15) / 15, ((x >> 4) & 15) / 15, (x & 15) / 15]; break; }
          case 4: { const x = (r.u8(p) << 16) | (r.u8(p + 1) << 8) | r.u8(p + 2);
            c = [((x >> 18) & 63) / 63, ((x >> 12) & 63) / 63, ((x >> 6) & 63) / 63, (x & 63) / 63]; break; }
          default: c = [r.u8(p) / 255, r.u8(p + 1) / 255, r.u8(p + 2) / 255, r.u8(p + 3) / 255];
        }
        a.set(c, v * 4);
      }
      out.set(idx, a);
    }
    return out;
  }

  /** Emulates the GX vertex loader over the polygon's primitive display list. */
  static loadShape(r, o, name, positions, normals, colors, uvs) {
    const vcdLo = r.u32(o + 0x0C), vcdHi = r.u32(o + 0x10);
    const primSize = r.u32(o + 0x24), primOff = o + 0x24 + r.s32(o + 0x2C);
    const index = r.u32(o + 0x3C);
    const posID = r.s16(o + 0x48), nrmID = r.s16(o + 0x4A), clrID = r.s16(o + 0x4C);
    const uvIDs = []; for (let i = 0; i < 8; i++) uvIDs.push(r.s16(o + 0x50 + i * 2));

    const pnmtx = vcdLo & 1, texmtx = []; for (let i = 0; i < 8; i++) texmtx.push((vcdLo >>> (1 + i)) & 1);
    const pos = (vcdLo >>> 9) & 3, nrm = (vcdLo >>> 11) & 3, clr0 = (vcdLo >>> 13) & 3, clr1 = (vcdLo >>> 15) & 3;
    const tex = []; for (let i = 0; i < 8; i++) tex.push((vcdHi >>> (i * 2)) & 3);
    for (const [kind, v] of [['pos', pos], ['nrm', nrm], ['clr0', clr0], ['clr1', clr1], ...tex.map((t, i) => [`tex${i}`, t])]) {
      if (v === 1) throw RVLError.corrupt(`${name}: direct ${kind} attributes need VAT decoding (not used by NW4R models)`);
    }
    const verts = [], indices = [];
    let p = primOff;
    const end = primOff + primSize;
    const stride = VERTEX_FLOATS;
    const P = posID >= 0 ? positions.get(posID) : null, N = nrmID >= 0 ? normals.get(nrmID) : null;
    const C = clrID >= 0 ? colors.get(clrID) : null;
    const T = uvIDs.map((id) => id >= 0 ? uvs.get(id) : null);
    const readIdx = (enc) => {
      if (enc === 2) return r.u8(p++);
      if (enc === 3) { const v = r.u16(p); p += 2; return v; }
      return -1;
    };
    while (p < end) {
      const cmd = r.u8(p);
      if (cmd === 0x00) { p += 1; continue; }
      if (cmd === 0x20 || cmd === 0x28 || cmd === 0x30 || cmd === 0x38) { p += 5; continue; } // indexed XF loads
      if (cmd >= 0x80 && cmd <= 0xBF) {
        const prim = cmd & 0xF8, count = r.u16(p + 1); p += 3;
        const base = (verts.length / stride) | 0;
        for (let n = 0; n < count; n++) {
          if (pnmtx) p += 1;
          for (const t of texmtx) if (t) p += 1;
          const v = new Array(stride).fill(0);
          v[6] = 1; v[7] = 1; v[8] = 1; v[9] = 1;
          const pi = readIdx(pos);
          if (P && pi >= 0) for (let k = 0; k < P.comps; k++) v[k] = P.values[pi * P.comps + k];
          const ni = readIdx(nrm);
          if (N && ni >= 0) for (let k = 0; k < 3; k++) v[3 + k] = N.values[ni * 3 + k];
          const ci = readIdx(clr0);
          if (C && ci >= 0) for (let k = 0; k < 4; k++) v[6 + k] = C[ci * 4 + k];
          readIdx(clr1);
          for (let t = 0; t < 8; t++) {
            const ti = readIdx(tex[t]);
            const arr = T[t];
            if (arr && ti >= 0) for (let k = 0; k < arr.comps; k++) v[10 + t * 2 + k] = arr.values[ti * arr.comps + k];
          }
          for (const x of v) verts.push(x);
        }
        for (const i of ResMdl.triangulate(prim, count, base)) indices.push(i);
        continue;
      }
      throw RVLError.corrupt(`${name}: unknown GX command 0x${cmd.toString(16)} at ${p - primOff}`);
    }
    return { name, index, bone: r.s32(o + 0x08), vertices: new Float32Array(verts), indices: new Uint32Array(indices) };
  }

  /** GX primitive → triangle list, preserving GX winding (strip parity as the hardware does). */
  static triangulate(prim, count, base) {
    const out = [];
    switch (prim) {
      case 0x90: for (let i = 0; i + 2 < count; i += 3) out.push(base + i, base + i + 1, base + i + 2); break;
      case 0x98:
        for (let i = 0; i < Math.max(count - 2, 0); i++) {
          const a = base + i;
          if ((i & 1) === 0) out.push(a, a + 1, a + 2); else out.push(a + 1, a, a + 2);
        }
        break;
      case 0xA0: for (let i = 1; i < Math.max(count - 1, 1); i++) out.push(base, base + i, base + i + 1); break;
      case 0x80: case 0x88:
        for (let i = 0; i + 3 < count; i += 4) { const a = base + i; out.push(a, a + 1, a + 2, a, a + 2, a + 3); }
        break;
      default: break; // lines/points: not used by g3d models here
    }
    return out;
  }
}

/** nw4r::g3d::ResMat + its ResShp-independent shader (ResTev). */
export class ResMat {
  constructor(r, o, name, index) {
    this.name = name; this.index = index;
    this.isXlu = (r.u32(o + 0x10) & 0x80000000) !== 0;
    this.cullMode = r.u32(o + 0x18);
    this.lightSet = r.s8(o + 0x1D); this.fogSet = r.s8(o + 0x1E);
    const gx = new GXState();
    gx.numTexGens = r.u8(o + 0x14); gx.numChans = r.u8(o + 0x15);
    gx.numTevStages = r.u8(o + 0x16); gx.numIndStages = r.u8(o + 0x17);

    const ntex = r.u32(o + 0x2C), layerOff = o + r.s32(o + 0x30);
    this.layers = [];
    for (let i = 0; i < ntex; i++) {
      const l = layerOff + i * 0x34;
      this.layers.push({
        texture: r.cString(l + r.s32(l)), texMap: r.u32(l + 0x10),
        wrapS: r.u32(l + 0x18), wrapT: r.u32(l + 0x1C), minFilter: r.u32(l + 0x20), magFilter: r.u32(l + 0x24),
        lodBias: r.f32(l + 0x28),
      });
    }
    this.srtFlags = r.u32(o + 0x1A4); this.texMtxMode = r.u32(o + 0x1A8);
    /** ResMatTexCoordGen SRT (per layer slot) */
    this.srt = [];
    for (let i = 0; i < 8; i++) {
      const s = o + 0x1AC + i * 0x14;
      this.srt.push({ scale: [r.f32(s), r.f32(s + 4)], rotation: r.f32(s + 8), translation: [r.f32(s + 12), r.f32(s + 16)] });
    }
    /** TexMtxEffect */
    this.effects = [];
    for (let i = 0; i < 8; i++) {
      const e = o + 0x24C + i * 0x34;
      const matrix = []; for (let k = 0; k < 12; k++) matrix.push(r.f32(e + 4 + k * 4));
      this.effects.push({ camera: r.s8(e), light: r.s8(e + 1), mapMode: r.u8(e + 2), identity: (r.u8(e + 3) & 1) === 1, matrix });
    }
    // Light channels (GXSetChanCtrl / GXSetChanMatColor / GXSetChanAmbColor).
    for (let c = 0; c < 2; c++) {
      const ch = o + 0x3EC + c * 0x14;
      gx.chanMatColor[c] = r.u32(ch + 4); gx.chanAmbColor[c] = r.u32(ch + 8);
      gx.chanColorCtrl[c] = r.u32(ch + 0xC); gx.chanAlphaCtrl[c] = r.u32(ch + 0x10);
    }
    // Shader (TEV) display list, then the material's own display list.
    const sh = o + r.s32(o + 0x28);
    gx.apply(r.bytes(sh + 0x20, r.u32(sh) - 0x20));
    const dlOff = o + r.s32(o + 0x38), size = r.u32(o);
    gx.apply(r.bytes(dlOff, o + size - dlOff));
    this.gx = gx;
  }
}
