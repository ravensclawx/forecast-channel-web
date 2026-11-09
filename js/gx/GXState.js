// Port of Sources/GX/GXState.swift (+ GXAPI.swift extension methods) — a software model of the GX register state
// that matters for shading. Display lists from NW4R resources are fed through apply(displayList), exactly as the
// command processor would consume them. Bitfields follow Dolphin's BPMemory.h / XFMemory.h.
//
// JS notes: Swift value semantics → use .clone() before mutating a shared state. `key()` returns a string usable as a
// pipeline/shader cache key (Swift used Hashable). Colours (konst / tevRegs) are [r, g, b, a] Int32 arrays.

export const GXTevColorArg = Object.freeze({
  cprev: 0, aprev: 1, c0: 2, a0: 3, c1: 4, a1: 5, c2: 6, a2: 7, texc: 8, texa: 9, rasc: 10, rasa: 11, one: 12, half: 13, konst: 14, zero: 15,
});
export const GXTevAlphaArg = Object.freeze({ aprev: 0, a0: 1, a1: 2, a2: 3, texa: 4, rasa: 5, konst: 6, zero: 7 });

const s11 = v => ((v & 0x7FF) << 21) >> 21;

export class GXState {
  constructor() {
    this.numTexGens = 0;
    this.numChans = 0;
    this.numTevStages = 1;
    this.numIndStages = 0;
    /** BP memory (raw, 0x00-0xFF). */
    this.bp = new Uint32Array(256);
    /** Konst colors and TEV color registers (prev, c0, c1, c2): [r,g,b,a] each. */
    this.konst = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    this.tevRegs = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    /** XF texgen registers: 0x1040+i TexMtxInfo, 0x1050+i PostMtxInfo. */
    this.texMtxInfo = new Uint32Array(8);
    this.postMtxInfo = new Uint32Array(8);
    /** XF colour channel controls (0x100E-0x1011). */
    this.chanColorCtrl = new Uint32Array(2);
    this.chanAlphaCtrl = new Uint32Array(2);
    this.chanMatColor = new Uint32Array([0xFFFFFFFF, 0xFFFFFFFF]);
    this.chanAmbColor = new Uint32Array(2);
    this.bpMask = 0xFFFFFF;
  }

  clone() {
    const s = new GXState();
    s.numTexGens = this.numTexGens; s.numChans = this.numChans; s.numTevStages = this.numTevStages; s.numIndStages = this.numIndStages;
    s.bp.set(this.bp);
    s.konst = this.konst.map(c => c.slice());
    s.tevRegs = this.tevRegs.map(c => c.slice());
    s.texMtxInfo.set(this.texMtxInfo); s.postMtxInfo.set(this.postMtxInfo);
    s.chanColorCtrl.set(this.chanColorCtrl); s.chanAlphaCtrl.set(this.chanAlphaCtrl);
    s.chanMatColor.set(this.chanMatColor); s.chanAmbColor.set(this.chanAmbColor);
    s.bpMask = this.bpMask;
    return s;
  }

  /**
   * Cache key of everything that shapes the generated shader + fixed-function state (pipeline key).
   * Colours (konst/tevRegs/mat/amb) are uniforms and are NOT part of it — use `fullKey()` if you need those too.
   */
  shaderKey() {
    return `${this.numTexGens},${this.numChans},${this.numTevStages},${this.numIndStages}|${Array.prototype.join.call(this.bp, ',')}|` +
      `${Array.prototype.join.call(this.texMtxInfo, ',')}|${Array.prototype.join.call(this.postMtxInfo, ',')}|` +
      `${this.chanColorCtrl[0]},${this.chanColorCtrl[1]},${this.chanAlphaCtrl[0]},${this.chanAlphaCtrl[1]}`;
  }
  fullKey() {
    return this.shaderKey() + '|' + this.konst.flat().join(',') + '|' + this.tevRegs.flat().join(',') + '|' +
      `${this.chanMatColor[0]},${this.chanMatColor[1]},${this.chanAmbColor[0]},${this.chanAmbColor[1]}`;
  }

  writeBP(reg, value) {
    const r = reg & 0xFF;
    if (r === 0xFE) { this.bpMask = value & 0xFFFFFF; return; }
    const v = ((this.bp[r] & ~this.bpMask) | (value & this.bpMask)) >>> 0;
    this.bpMask = 0xFFFFFF;
    this.bp[r] = v;
    if (r >= 0xE0 && r <= 0xE7) {
      const i = (r - 0xE0) >> 1;
      const isKonst = (v & (1 << 23)) !== 0;
      const lo = s11(v), hi = s11(v >>> 12);
      const dst = isKonst ? this.konst[i] : this.tevRegs[i];
      if ((r & 1) === 0) { dst[0] = lo; dst[3] = hi; }   // RA
      else { dst[2] = lo; dst[1] = hi; }                 // BG
    }
  }

  writeXF(addr, v) {
    v >>>= 0;
    if (addr >= 0x1040 && addr <= 0x1047) this.texMtxInfo[addr - 0x1040] = v;
    else if (addr >= 0x1050 && addr <= 0x1057) this.postMtxInfo[addr - 0x1050] = v;
    else if (addr >= 0x100E && addr <= 0x100F) this.chanColorCtrl[addr - 0x100E] = v;
    else if (addr >= 0x1010 && addr <= 0x1011) this.chanAlphaCtrl[addr - 0x1010] = v;
    else if (addr >= 0x100A && addr <= 0x100B) this.chanAmbColor[addr - 0x100A] = v;
    else if (addr >= 0x100C && addr <= 0x100D) this.chanMatColor[addr - 0x100C] = v;
  }

  /** Consume a GX display list containing register loads (0x61 BP, 0x10 XF, 0x08 CP, NOPs). */
  apply(d) {
    let i = 0;
    while (i < d.length) {
      switch (d[i]) {
        case 0x00: i += 1; break;
        case 0x61:
          if (i + 5 > d.length) return;
          this.writeBP(d[i + 1], (d[i + 2] << 16) | (d[i + 3] << 8) | d[i + 4]); i += 5; break;
        case 0x10: {
          if (i + 5 > d.length) return;
          const n = ((d[i + 1] << 8) | d[i + 2]) + 1;
          const a = (d[i + 3] << 8) | d[i + 4];
          for (let k = 0; k < n; k++) {
            const o = i + 5 + k * 4;
            this.writeXF(a + k, ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
          }
          i += 5 + n * 4; break;
        }
        case 0x08: i += 6; break;
        default: return;
      }
    }
  }
  /** Swift name alias: apply(displayList:) */
  applyDisplayList(d) { this.apply(d); }

  // MARK: - Decoded views

  tevStage(n) {
    const order = this.bp[0x28 + (n >> 1)] >>> ((n & 1) ? 12 : 0);
    const ksel = this.bp[0xF6 + (n >> 1)];
    return {
      cc: this.bp[0xC0 + n * 2], ac: this.bp[0xC1 + n * 2], ind: this.bp[0x10 + n],
      texMap: order & 7, texCoord: (order >>> 3) & 7, texEnable: ((order >>> 6) & 1) === 1,
      colorChan: (order >>> 7) & 7,
      kcsel: (ksel >>> ((n & 1) ? 14 : 4)) & 0x1F, kasel: (ksel >>> ((n & 1) ? 19 : 9)) & 0x1F,
    };
  }

  /** Swap table i → [r,g,b,a] channel indices. */
  swapTable(i) {
    const rg = this.bp[0xF6 + i * 2], ba = this.bp[0xF6 + i * 2 + 1];
    return [rg & 3, (rg >>> 2) & 3, ba & 3, (ba >>> 2) & 3];
  }

  /** Indirect stage i → { map, coord } from RAS1_IREF (0x27). */
  indRef(i) {
    const v = this.bp[0x27] >>> (i * 6);
    return { map: v & 7, coord: (v >>> 3) & 7 };
  }

  /** Indirect coordinate scale shifts (RAS1_SS0/SS1) for stage i → [s, t]. */
  indScale(i) {
    const v = this.bp[0x25 + (i >> 1)] >>> ((i & 1) * 8);
    return [v & 0xF, (v >>> 4) & 0xF];
  }

  /** Indirect matrix m (0..2): { row0:[3], row1:[3], shift } (s11 ints, Dolphin's 17 - scale). */
  indMatrix(m) {
    const a = this.bp[0x06 + m * 3], b = this.bp[0x07 + m * 3], c = this.bp[0x08 + m * 3];
    const scale = ((a >>> 22) & 3) | (((b >>> 22) & 3) << 2) | (((c >>> 22) & 1) << 4);
    return { row0: [s11(a), s11(b), s11(c)], row1: [s11(a >>> 11), s11(b >>> 11), s11(c >>> 11)], shift: 17 - scale };
  }

  /** GXSetIndTexMatrix(id, offset[2][3], scaleExp). */
  setIndMatrix(m, row0, row1, scaleExp) {
    const f = v => (Math.trunc(v * 1024) >>> 0) & 0x7FF;
    const scale = (scaleExp + 17) >>> 0;
    this.bp[0x06 + m * 3] = (f(row0[0]) | (f(row1[0]) << 11) | ((scale & 3) << 22)) >>> 0;
    this.bp[0x07 + m * 3] = (f(row0[1]) | (f(row1[1]) << 11) | (((scale >>> 2) & 3) << 22)) >>> 0;
    this.bp[0x08 + m * 3] = (f(row0[2]) | (f(row1[2]) << 11) | (((scale >>> 4) & 1) << 22)) >>> 0;
  }

  get alphaCompare() {
    const v = this.bp[0xF3];
    return { ref0: v & 0xFF, ref1: (v >>> 8) & 0xFF, comp0: (v >>> 16) & 7, comp1: (v >>> 19) & 7, logic: (v >>> 22) & 3 };
  }
  get zMode() { const v = this.bp[0x40]; return { test: (v & 1) === 1, function: (v >>> 1) & 7, update: ((v >>> 4) & 1) === 1 }; }
  get blendMode() {
    const v = this.bp[0x41];
    return {
      enable: (v & 1) === 1, logicOp: ((v >>> 1) & 1) === 1, subtract: ((v >>> 11) & 1) === 1,
      srcFactor: (v >>> 8) & 7, dstFactor: (v >>> 5) & 7, logicMode: (v >>> 12) & 0xF,
    };
  }
  texGen(i) {
    const v = this.texMtxInfo[i], p = this.postMtxInfo[i];
    return {
      projectionSTQ: ((v >>> 1) & 1) === 1, inputABC1: ((v >>> 2) & 1) === 1, type: (v >>> 4) & 7,
      sourceRow: (v >>> 7) & 0x1F, embossSource: (v >>> 12) & 7, embossLight: (v >>> 15) & 7,
      postMatrix: p & 0x3F, normalize: ((p >>> 8) & 1) === 1,
    };
  }
}

// GXChannelID / null constants (GXState.color0 … in Swift)
GXState.texCoordNull = 0xFF; GXState.texMapNull = 0xFF; GXState.colorNull = 0xFF;
GXState.color0 = 0; GXState.color1 = 1; GXState.alpha0 = 2; GXState.alpha1 = 3; GXState.color0a0 = 4; GXState.color1a1 = 5;

// ---- GX API (port of Sources/GX/GXAPI.swift), installed on the prototype ----
const P = GXState.prototype;

/** GXSetNumTevStages / NumTexGens / NumChans / NumIndStages */
P.setNumTevStages = function (n) { this.numTevStages = n; };
P.setNumTexGens = function (n) { this.numTexGens = n; };
P.setNumChans = function (n) { this.numChans = n; };
P.setNumIndStages = function (n) { this.numIndStages = n; };

/** GXSetTevOrder(stage, coord, map, color) — map may carry GX_TEX_DISABLE (0x100). */
P.setTevOrder = function (stage, coord, map, color) {
  const enable = ((map & 0xFF) !== 0xFF && (map & 0x100) === 0) ? 1 : 0;
  const m = (map & 0xFF) === 0xFF ? 7 : map & 7;
  const c = coord === 0xFF ? 7 : coord & 7;
  let chan;
  switch (color) {
    case 0: case 2: case 4: chan = 0; break;
    case 1: case 3: case 5: chan = 1; break;
    case 6: chan = 5; break;
    case 7: chan = 6; break;
    default: chan = 7;
  }
  const field = m | (c << 3) | (enable << 6) | (chan << 7);
  const reg = 0x28 + (stage >> 1), shift = (stage & 1) ? 12 : 0;
  this.bp[reg] = ((this.bp[reg] & ~(0xFFF << shift)) | (field << shift)) >>> 0;
};

/** GXSetTevColorIn(stage, a, b, c, d) — args are GXTevColorArg numbers. */
P.setTevColorIn = function (stage, a, b, c, d) {
  const r = 0xC0 + stage * 2;
  this.bp[r] = ((this.bp[r] & ~0xFFFF) | d | (c << 4) | (b << 8) | (a << 12)) >>> 0;
};
/** GXSetTevAlphaIn(stage, a, b, c, d) */
P.setTevAlphaIn = function (stage, a, b, c, d) {
  const r = 0xC1 + stage * 2;
  this.bp[r] = ((this.bp[r] & ~0xFFF0) | (d << 4) | (c << 7) | (b << 10) | (a << 13)) >>> 0;
};
function encodeOp(op, bias, scale, clamp, out) {
  let v = ((clamp ? 1 : 0) << 19) | ((out & 3) << 22);
  if (op <= 1) v |= ((op & 1) << 18) | ((bias & 3) << 16) | ((scale & 3) << 20);
  else v |= ((op & 1) << 18) | (3 << 16) | (((op >> 1) & 3) << 20);   // compare modes
  return v >>> 0;
}
/** GXSetTevColorOp / GXSetTevAlphaOp(stage, {op, bias, scale, clamp, out}). op 0 add, 1 sub, >=8 compare. */
P.setTevColorOp = function (stage, op, bias, scale, clamp, out) {
  if (typeof op === 'object') ({ op, bias, scale, clamp, out } = op);
  const r = 0xC0 + stage * 2;
  this.bp[r] = ((this.bp[r] & 0xFFFF) | encodeOp(op, bias, scale, clamp, out)) >>> 0;
};
P.setTevAlphaOp = function (stage, op, bias, scale, clamp, out) {
  if (typeof op === 'object') ({ op, bias, scale, clamp, out } = op);
  const r = 0xC1 + stage * 2;
  this.bp[r] = ((this.bp[r] & 0xFFFF) | encodeOp(op, bias, scale, clamp, out)) >>> 0;
};
/** GXSetTevOp(stage, mode): 0 MODULATE, 1 DECAL, 2 BLEND, 3 REPLACE, 4 PASSCLR */
P.setTevOp = function (stage, mode) {
  const C = GXTevColorArg, A = GXTevAlphaArg;
  const carg = stage === 0 ? C.rasc : C.cprev;
  const aarg = stage === 0 ? A.rasa : A.aprev;
  switch (mode) {
    case 0: this.setTevColorIn(stage, C.zero, C.texc, carg, C.zero); this.setTevAlphaIn(stage, A.zero, A.texa, aarg, A.zero); break;
    case 1: this.setTevColorIn(stage, carg, C.texc, C.texa, C.zero); this.setTevAlphaIn(stage, A.zero, A.zero, A.zero, aarg); break;
    case 2: this.setTevColorIn(stage, carg, C.one, C.texc, C.zero); this.setTevAlphaIn(stage, A.zero, A.texa, aarg, A.zero); break;
    case 3: this.setTevColorIn(stage, C.zero, C.zero, C.zero, C.texc); this.setTevAlphaIn(stage, A.zero, A.zero, A.zero, A.texa); break;
    default: this.setTevColorIn(stage, C.zero, C.zero, C.zero, carg); this.setTevAlphaIn(stage, A.zero, A.zero, A.zero, aarg);
  }
  this.setTevColorOp(stage, 0, 0, 0, true, 0);
  this.setTevAlphaOp(stage, 0, 0, 0, true, 0);
};
/** GXSetTevKColorSel / GXSetTevKAlphaSel */
P.setTevKColorSel = function (stage, sel) {
  const r = 0xF6 + (stage >> 1), sh = (stage & 1) ? 14 : 4;
  this.bp[r] = ((this.bp[r] & ~(0x1F << sh)) | ((sel & 0x1F) << sh)) >>> 0;
};
P.setTevKAlphaSel = function (stage, sel) {
  const r = 0xF6 + (stage >> 1), sh = (stage & 1) ? 19 : 9;
  this.bp[r] = ((this.bp[r] & ~(0x1F << sh)) | ((sel & 0x1F) << sh)) >>> 0;
};
/** GXSetTevSwapMode(stage, ras, tex) */
P.setTevSwapMode = function (stage, ras, tex) {
  const r = 0xC1 + stage * 2;
  this.bp[r] = ((this.bp[r] & ~0xF) | (ras & 3) | ((tex & 3) << 2)) >>> 0;
};
/** GXSetTevSwapModeTable(table, r, g, b, a) */
P.setTevSwapModeTable = function (t, r, g, b, a) {
  const rg = 0xF6 + t * 2, ba = rg + 1;
  this.bp[rg] = ((this.bp[rg] & ~0xF) | r | (g << 2)) >>> 0;
  this.bp[ba] = ((this.bp[ba] & ~0xF) | b | (a << 2)) >>> 0;
};
/** GXSetTevDirect(stage) */
P.setTevDirect = function (stage) { this.bp[0x10 + stage] = 0; };
/** GXSetTevColor (u8) / S10: reg 0 PREV, 1..3 REG0..REG2. c = [r,g,b,a] */
P.setTevColor = function (reg, c) { this.tevRegs[reg] = [c[0] | 0, c[1] | 0, c[2] | 0, c[3] | 0]; };
/** GXSetTevKColor */
P.setTevKColor = function (id, c) { this.konst[id] = [c[0] | 0, c[1] | 0, c[2] | 0, c[3] | 0]; };
/** GXSetAlphaCompare(comp0, ref0, op, comp1, ref1) */
P.setAlphaCompare = function (comp0, ref0, op, comp1, ref1) {
  this.bp[0xF3] = ((ref0 & 0xFF) | ((ref1 & 0xFF) << 8) | ((comp0 & 7) << 16) | ((comp1 & 7) << 19) | ((op & 3) << 22)) >>> 0;
};
/** GXSetBlendMode(type, src, dst, logicOp). type 0 none, 1 blend, 2 logic, 3 subtract. */
P.setBlendMode = function (type, src, dst, logic) {
  const enable = (type === 1 || type === 3) ? 1 : 0;
  this.bp[0x41] = ((this.bp[0x41] & 0x1C) | enable | (type === 2 ? 2 : 0) | ((dst & 7) << 5) | ((src & 7) << 8)
    | ((type === 3 ? 1 : 0) << 11) | ((logic & 0xF) << 12)) >>> 0;
};
/** GXSetZMode(enable, func, update) */
P.setZMode = function (enable, fn, update) {
  this.bp[0x40] = ((enable ? 1 : 0) | ((fn & 7) << 1) | ((update ? 1 : 0) << 4)) >>> 0;
};
/** GXSetChanCtrl(chan, enable, ambSrc, matSrc, lightMask = 0, diffFn = 0, attnFn = 2) */
P.setChanCtrl = function (chan, enable, ambSrc, matSrc, lightMask = 0, diffFn = 0, attnFn = 2) {
  if (typeof enable === 'object') ({ enable, ambSrc, matSrc, lightMask = 0, diffFn = 0, attnFn = 2 } = enable);
  let v = (matSrc & 1) | (enable ? 2 : 0) | ((lightMask & 0xF) << 2) | ((ambSrc & 1) << 6);
  v |= ((attnFn === 0 ? 0 : diffFn & 3) << 7) | ((attnFn !== 2 ? 1 : 0) << 9) | ((attnFn !== 0 ? 1 : 0) << 10) | (((lightMask >> 4) & 0xF) << 11);
  v >>>= 0;
  switch (chan) {
    case 0: this.chanColorCtrl[0] = v; break;
    case 1: this.chanColorCtrl[1] = v; break;
    case 2: this.chanAlphaCtrl[0] = v; break;
    case 3: this.chanAlphaCtrl[1] = v; break;
    case 4: this.chanColorCtrl[0] = v; this.chanAlphaCtrl[0] = v; break;
    default: this.chanColorCtrl[1] = v; this.chanAlphaCtrl[1] = v;
  }
};
/** GXSetChanMatColor / GXSetChanAmbColor (RGBA8 packed u32) */
P.setChanMatColor = function (chan, rgba) { this.chanMatColor[(chan === 1 || chan === 5) ? 1 : 0] = rgba >>> 0; };
P.setChanAmbColor = function (chan, rgba) { this.chanAmbColor[(chan === 1 || chan === 5) ? 1 : 0] = rgba >>> 0; };
/**
 * GXSetTexCoordGen2(dst, type, src, normalize = false, postMtx = 125). Matrices themselves are uniforms.
 * type: 0 MTX3x4, 1 MTX2x4, 2..9 BUMP, 10 SRTG. src: 0 POS, 1 NRM, 2 BINRM, 3 TANGENT, 4..11 TEX0..7, …
 */
P.setTexCoordGen = function (i, type, src, normalize = false, postMtx = 125) {
  if (typeof type === 'object') ({ type, src, normalize = false, postMtx = 125 } = type);
  let row;
  if (src === 0) row = 0;
  else if (src === 1) row = 1;
  else if (src === 2) row = 4;
  else if (src === 3) row = 3;
  else if (src >= 4 && src <= 11) row = src + 1;
  else if (src === 19 || src === 20) row = 2;
  else row = 5;
  const tgType = type <= 1 ? 0 : (type === 10 ? 2 : 1);
  this.texMtxInfo[i] = ((type === 0 ? 2 : 0) | (src <= 1 ? 4 : 0) | (tgType << 4) | (row << 7)) >>> 0;
  this.postMtxInfo[i] = (((postMtx - 64) & 0x3F) | (normalize ? 1 << 8 : 0)) >>> 0;
};
