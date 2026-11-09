// Port of Sources/NW4R/Lyt/Layout.swift — nw4r::lyt layout resources (RLYT v8) and the runtime pane tree.
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';
import { GXState } from '../../gx/GXState.js';

// --- column-major 4×4 helpers (same convention as simd_float4x4 / js/gx/mat.js) ---
export function mat4Identity() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function rotAxis(deg, x, y, z) {
  if (deg === 0) return null;
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const m = mat4Identity();
  // simd_float4x4(simd_quatf(angle:axis:)) — standard right-handed rotation, column-major
  m[0] = t * x * x + c;     m[4] = t * x * y - s * z; m[8] = t * x * z + s * y;
  m[1] = t * x * y + s * z; m[5] = t * y * y + c;     m[9] = t * y * z - s * x;
  m[2] = t * x * z - s * y; m[6] = t * y * z + s * x; m[10] = t * z * z + c;
  return m;
}

/** nw4r::lyt::Layout */
export class Layout {
  constructor(bytes) {
    const r = bytes instanceof BEReader ? bytes : new BEReader(bytes);
    if (r.magic(0) !== 'RLYT') throw RVLError.badMagic(r.magic(0), 'RLYT');
    let o = r.u16(0xC);
    const count = r.u16(0xE);
    let w = 608, h = 456, centered = true;
    let texNames = [], fntNames = [], mats = [];
    let rootPane = null, last = null;
    const stack = [];
    const groupNames = new Map();
    const nameList = (s) => {
      const n = r.u16(s + 8), base = s + 12, out = [];
      for (let i = 0; i < n; i++) out.push(r.cString(base + r.u32(base + i * 8)));
      return out;
    };
    for (let k = 0; k < count; k++) {
      const magic = r.magic(o), size = r.u32(o + 4);
      switch (magic) {
        case 'lyt1': centered = r.u8(o + 8) !== 0; w = r.f32(o + 12); h = r.f32(o + 16); break;
        case 'txl1': texNames = nameList(o); break;
        case 'fnl1': fntNames = nameList(o); break;
        case 'mat1': {
          const n = r.u16(o + 8);
          for (let i = 0; i < n; i++) mats.push(new LytMaterial(r, o + r.u32(o + 12 + i * 4)));
          break;
        }
        case 'pan1': case 'pic1': case 'txt1': case 'wnd1': case 'bnd1': {
          let p;
          switch (magic) {
            case 'pic1': p = new Picture(r, o); break;
            case 'txt1': p = new TextBox(r, o); break;
            case 'wnd1': p = new Window(r, o); break;
            case 'bnd1': p = new Bounding(r, o); break;
            default: p = new Pane(r, o);
          }
          if (stack.length) stack[stack.length - 1].append(p); else if (!rootPane) rootPane = p;
          last = p;
          break;
        }
        case 'pas1': if (last) stack.push(last); break;
        case 'pae1': stack.pop(); break;
        case 'grp1': {
          const name = r.cString(o + 8), n = r.u16(o + 0x18), names = [];
          for (let i = 0; i < n; i++) names.push(r.cString(o + 0x1C + i * 16));
          groupNames.set(name, names);
          break;
        }
        default: break;
      }
      o += size;
    }
    this.width = w; this.height = h; this.originCentered = centered;
    this.textureNames = texNames; this.fontNames = fntNames; this.materials = mats;
    this.root = rootPane ?? Pane.named('RootPane');
    /** @type {Map<string, Pane[]>} */
    this.groups = new Map();
    for (const [g, names] of groupNames) this.groups.set(g, names.map((n) => this.root.find(n)).filter(Boolean));
    // Bind materials/fonts by index
    this.root.forEach((p) => {
      if (p instanceof Picture) p.material = mats[p.materialIndex] ?? null;
      if (p instanceof TextBox) { p.material = mats[p.materialIndex] ?? null; p.fontName = fntNames[p.fontIndex] ?? null; }
      if (p instanceof Window) p.material = mats[p.contentMaterialIndex] ?? null;
    });
  }

  /** Pane::FindPaneByName (recursive) */
  find(name) { return this.root.find(name); }
}

// MARK: - Panes

/** nw4r::lyt::Pane */
export class Pane {
  constructor(r, o) {
    this.userData = '';
    this.visible = true;
    this.influencedAlpha = false;
    this.locationAdjust = false;
    this.basePosition = 4;          // 0..8: x = %3 (left,center,right), y = /3 (top,center,bottom)
    this.alpha = 255;
    this.translate = [0, 0, 0];
    this.rotate = [0, 0, 0];
    this.scale = [1, 1];
    this.size = [0, 0];
    /** @type {Pane[]} */
    this.children = [];
    this.parent = null;
    // Calculated each frame (Pane::CalculateMtx)
    this.globalMtx = mat4Identity();
    this.globalAlpha = 255;
    /** fn_8003A35C → fn_8003927C: per-group alpha applied to the whole subtree (port). */
    this.subtreeAlpha = null;
    /** Never drawn, whatever the game sets `visible` to. */
    this.suppressed = false;
    this.name = '';
    if (r) {
      const flags = r.u8(o + 8);
      this.visible = (flags & 1) !== 0; this.influencedAlpha = (flags & 2) !== 0; this.locationAdjust = (flags & 4) !== 0;
      this.basePosition = r.u8(o + 9); this.alpha = r.u8(o + 0xA);
      this.name = r.cString(o + 0xC);
      this.userData = r.cString(o + 0x1C);
      this.translate = [r.f32(o + 0x24), r.f32(o + 0x28), r.f32(o + 0x2C)];
      this.rotate = [r.f32(o + 0x30), r.f32(o + 0x34), r.f32(o + 0x38)];
      this.scale = [r.f32(o + 0x3C), r.f32(o + 0x40)];
      this.size = [r.f32(o + 0x44), r.f32(o + 0x48)];
    }
  }
  static named(name) { const p = new Pane(null, 0); p.name = name; return p; }

  append(c) { c.parent = this; this.children.push(c); }

  find(n) {
    if (this.name === n) return this;
    for (const c of this.children) { const f = c.find(n); if (f) return f; }
    return null;
  }
  forEach(body) { body(this); for (const c of this.children) c.forEach(body); }

  /** Top-left of the pane rectangle in pane space (y up), from basePosition. */
  get vertexOrigin() {
    const h = this.basePosition % 3, v = (this.basePosition / 3) | 0;
    const x = h === 0 ? 0 : (h === 1 ? -this.size[0] / 2 : -this.size[0]);
    const y = v === 0 ? 0 : (v === 1 ? this.size[1] / 2 : this.size[1]);
    return [x, y];
  }

  /**
   * Pane::CalculateMtx — local = T · Rz · Ry · Rx · S; global = parent · local; glbAlpha propagation.
   * `locationAdjust` = DrawInfo::GetLocationAdjustScale when location-adjusting (widescreen) — [sx, sy] or null.
   */
  calculate(parentMtx, parentAlpha, locationAdjust = null, alphaScale = 255) {
    let local = mat4Identity();
    local[12] = this.translate[0]; local[13] = this.translate[1]; local[14] = this.translate[2];
    for (const m of [rotAxis(this.rotate[2], 0, 0, 1), rotAxis(this.rotate[1], 0, 1, 0), rotAxis(this.rotate[0], 1, 0, 0)]) {
      if (m) local = mat4Mul(local, m);
    }
    let sx = this.scale[0], sy = this.scale[1];
    if (locationAdjust && this.locationAdjust) { sx *= locationAdjust[0]; sy *= locationAdjust[1]; }
    // · S (scales columns 0 and 1)
    for (let i = 0; i < 4; i++) { local[i] *= sx; local[4 + i] *= sy; }
    this.globalMtx = parentMtx ? mat4Mul(parentMtx, local) : local;
    this.globalAlpha = this.influencedAlpha ? ((this.alpha * parentAlpha / 255) | 0) : this.alpha;
    const scale = (alphaScale * (this.subtreeAlpha ?? 255) / 255) | 0;
    const own = this.globalAlpha;
    for (const c of this.children) c.calculate(this.globalMtx, own, locationAdjust, scale);
    if (scale < 255) this.globalAlpha = (this.globalAlpha * scale / 255) | 0;
  }
}

export class Bounding extends Pane {}

/** nw4r::lyt::Picture */
export class Picture extends Pane {
  constructor(r, o) {
    super(r, o);
    this.vtxColors = [];     // TL, TR, BL, BR as [r,g,b,a]
    for (let i = 0; i < 4; i++) this.vtxColors.push([r.u8(o + 0x4C + i * 4), r.u8(o + 0x4D + i * 4), r.u8(o + 0x4E + i * 4), r.u8(o + 0x4F + i * 4)]);
    this.materialIndex = r.u16(o + 0x5C);
    const n = r.u8(o + 0x5E);
    this.texCoords = [];     // per texcoord set: TL, TR, BL, BR
    for (let i = 0; i < n; i++) {
      const set = [];
      for (let k = 0; k < 4; k++) set.push([r.f32(o + 0x60 + i * 32 + k * 8), r.f32(o + 0x64 + i * 32 + k * 8)]);
      this.texCoords.push(set);
    }
    /** @type {LytMaterial|null} */
    this.material = null;
  }
}

const utf16Decoder = (arr) => String.fromCharCode(...arr);

/** nw4r::lyt::TextBox */
export class TextBox extends Pane {
  constructor(r, o) {
    super(r, o);
    this.bufferChars = (r.u16(o + 0x4C) / 2) | 0;
    const strBytes = r.u16(o + 0x4E);
    this.materialIndex = r.u16(o + 0x50); this.fontIndex = r.u16(o + 0x52);
    this.textPosition = r.u8(o + 0x54); this.textAlignment = r.u8(o + 0x55);
    const strOff = o + r.u32(o + 0x58);
    this.topColor = [r.u8(o + 0x5C), r.u8(o + 0x5D), r.u8(o + 0x5E), r.u8(o + 0x5F)];
    this.bottomColor = [r.u8(o + 0x60), r.u8(o + 0x61), r.u8(o + 0x62), r.u8(o + 0x63)];
    this.fontSize = [r.f32(o + 0x64), r.f32(o + 0x68)];
    this.charSpace = r.f32(o + 0x6C); this.lineSpace = r.f32(o + 0x70);
    const t = [];
    for (let p = strOff; p + 1 < strOff + strBytes; p += 2) { const c = r.u16(p); if (c === 0) break; t.push(c); }
    /** UTF-16 code units */
    this.text = t;
    this.material = null;
    this.fontName = null;
    /** Font bound at runtime (ResFont). */
    this.font = null;
  }
  /** TextBox::SetString */
  setString(s) { const u = []; for (let i = 0; i < s.length; i++) u.push(s.charCodeAt(i)); this.text = u; }
  get string() { return utf16Decoder(this.text); }
}

/** nw4r::lyt::Window (content + frames). Only the content quad is drawn. */
export class Window extends Pane {
  constructor(r, o) {
    super(r, o);
    const content = o + r.u32(o + 0x60);
    this.vtxColors = [];
    for (let i = 0; i < 4; i++) this.vtxColors.push([r.u8(content + i * 4), r.u8(content + 1 + i * 4), r.u8(content + 2 + i * 4), r.u8(content + 3 + i * 4)]);
    this.contentMaterialIndex = r.u16(content + 0x10);
    const n = r.u8(content + 0x12);
    this.texCoords = [];
    for (let i = 0; i < n; i++) {
      const set = [];
      for (let k = 0; k < 4; k++) set.push([r.f32(content + 0x14 + i * 32 + k * 8), r.f32(content + 0x18 + i * 32 + k * 8)]);
      this.texCoords.push(set);
    }
    this.material = null;
  }
}

// MARK: - Material

// GXTevColorArg / GXTevAlphaArg raw values (GXAPI.swift)
export const CA = Object.freeze({ cprev: 0, aprev: 1, c0: 2, a0: 3, c1: 4, a1: 5, c2: 6, a2: 7, texc: 8, texa: 9, rasc: 10, rasa: 11, one: 12, half: 13, konst: 14, zero: 15 });
export const AA = Object.freeze({ aprev: 0, a0: 1, a1: 2, a2: 3, texa: 4, rasa: 5, konst: 6, zero: 7 });
// GXChannelID
const COLOR0 = 0, ALPHA0 = 2, COLOR0A0 = 4;

/** nw4r::lyt::Material (resource form + runtime colors). `setupGX` is a port of fn_800E0568. */
export class LytMaterial {
  constructor(r, o) {
    this.name = r.cString(o);
    /** C0 (black), C1 (white), C2 — s16 GXColorS10, each [r,g,b,a] */
    this.tevColors = [];
    for (let i = 0; i < 3; i++) { const c = []; for (let k = 0; k < 4; k++) c.push(r.s16(o + 0x14 + i * 8 + k * 2)); this.tevColors.push(c); }
    this.tevKColors = [];
    for (let i = 0; i < 4; i++) { const c = []; for (let k = 0; k < 4; k++) c.push(r.u8(o + 0x2C + i * 4 + k)); this.tevKColors.push(c); }
    const f = r.u32(o + 0x3C);
    let p = o + 0x40;
    this.texMaps = [];
    for (let i = 0; i < (f & 0xF); i++, p += 4) {
      const ws = r.u8(p + 2), wt = r.u8(p + 3);
      this.texMaps.push({ texture: r.u16(p), wrapS: ws & 3, wrapT: wt & 3, minFilter: (ws >> 2) & 7, magFilter: (wt >> 2) & 1 });
    }
    this.texSRTs = [];
    for (let i = 0; i < ((f >>> 4) & 0xF); i++, p += 20) {
      this.texSRTs.push({ translate: [r.f32(p), r.f32(p + 4)], rotate: r.f32(p + 8), scale: [r.f32(p + 12), r.f32(p + 16)] });
    }
    this.texCoordGens = [];
    for (let i = 0; i < ((f >>> 8) & 0xF); i++, p += 4) {
      this.texCoordGens.push({ type: r.u8(p), src: r.u8(p + 1), mtx: r.u8(p + 2) });
    }
    if (((f >>> 25) & 1) === 1) { this.chanCtrl = { color: r.u8(p), alpha: r.u8(p + 1) }; p += 4; } else this.chanCtrl = null;
    if (((f >>> 27) & 1) === 1) { this.matColor = [r.u8(p), r.u8(p + 1), r.u8(p + 2), r.u8(p + 3)]; p += 4; } else this.matColor = null;
    if (((f >>> 12) & 1) === 1) { this.swapTable = Array.from(r.bytes(p, 4)); p += 4; } else this.swapTable = null;
    p += ((f >>> 13) & 3) * 20;  // ind SRTs (unused by this title)
    p += ((f >>> 15) & 7) * 4;   // ind stages
    this.tevStages = [];         // raw 16-byte stage records
    for (let i = 0; i < ((f >>> 18) & 0x1F); i++, p += 16) this.tevStages.push(Array.from(r.bytes(p, 16)));
    if (((f >>> 23) & 1) === 1) { this.alphaCompare = Array.from(r.bytes(p, 4)); p += 4; } else this.alphaCompare = null;
    if (((f >>> 24) & 1) === 1) { this.blendMode = Array.from(r.bytes(p, 4)); p += 4; } else this.blendMode = null;
    /** RLTP texture-pattern animation: texMap slot → texture name (overrides the txl1 binding). */
    this.texturePatternOverride = new Map();
  }

  /** Texture SRT → GX texture matrix (fn_800DE144): rotate/scale about (0.5, 0.5), then translate. 3 rows of 4. */
  static texMtx(s) {
    const r = s.rotate * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    const m00 = c * s.scale[0], m01 = -sn * s.scale[1], m10 = sn * s.scale[0], m11 = c * s.scale[1];
    return [[m00, m01, 0, s.translate[0] + 0.5 - 0.5 * m00 - 0.5 * m01],
            [m10, m11, 0, s.translate[1] + 0.5 - 0.5 * m10 - 0.5 * m11],
            [0, 0, 1, 0]];
  }

  /** Material::SetupGX(modulate, alpha) — fn_800E0568. Returns a GXState. */
  setupGX(modulate, alpha) {
    const gx = new GXState();
    // Channel control
    let usesVtx = true, usesReg = false;
    gx.setNumChans(1);
    const cc = this.chanCtrl;
    if (cc) {
      gx.setChanCtrl(COLOR0, false, 0, cc.color);
      gx.setChanCtrl(ALPHA0, false, 0, cc.alpha);
      usesVtx = cc.color === 1 || cc.alpha === 1;
      usesReg = cc.color === 0 || cc.alpha === 0;
    } else {
      gx.setChanCtrl(COLOR0A0, false, 0, 1);
    }
    let rasStage = usesVtx && modulate;
    if (usesReg) {
      const mc = this.matColor ?? [255, 255, 255, 255];
      const a = ((mc[3] * alpha) / 255) >>> 0;
      const rgba = ((mc[0] << 24) | (mc[1] << 16) | (mc[2] << 8) | a) >>> 0;
      gx.setChanMatColor(COLOR0A0, rgba);
      if (!rasStage) rasStage = rgba !== 0xFFFFFFFF;
    }
    // Texgens
    gx.setNumTexGens(this.texCoordGens.length);
    this.texCoordGens.forEach((g, i) => gx.setTexCoordGen(i, g.type, g.src));
    // TEV colors (GXSetTevColorS10 REG0..2, GXSetTevKColor)
    for (let i = 0; i < 3; i++) gx.setTevColor(i + 1, this.tevColors[i]);
    for (let i = 0; i < 4; i++) gx.setTevKColor(i, this.tevKColors[i]);
    // Swap tables
    const st = this.swapTable;
    if (st) {
      st.forEach((v, t) => gx.setTevSwapModeTable(t, v & 3, (v >> 2) & 3, (v >> 4) & 3, (v >> 6) & 3));
    } else {
      gx.setTevSwapModeTable(0, 0, 1, 2, 3); gx.setTevSwapModeTable(1, 0, 0, 0, 3);
      gx.setTevSwapModeTable(2, 1, 1, 1, 3); gx.setTevSwapModeTable(3, 2, 2, 2, 3);
    }
    if (this.tevStages.length) {
      gx.setNumTevStages(this.tevStages.length);
      this.tevStages.forEach((b, s) => {
        gx.setTevOrder(s, b[0], (b[2] | ((b[3] << 8) & 0x100)) >>> 0, b[1]);
        gx.setTevSwapMode(s, (b[3] >> 1) & 3, (b[3] >> 3) & 3);
        gx.setTevColorIn(s, b[4] & 0xF, b[4] >> 4, b[5] & 0xF, b[5] >> 4);
        gx.setTevColorOp(s, b[6] & 0xF, (b[6] >> 4) & 3, (b[6] >> 6) & 3, (b[7] & 1) === 1, (b[7] >> 1) & 3);
        gx.setTevKColorSel(s, (b[7] >> 3) & 0x1F);
        gx.setTevAlphaIn(s, b[8] & 0x7, (b[8] >> 4) & 7, b[9] & 0x7, (b[9] >> 4) & 7);
        gx.setTevAlphaOp(s, b[10] & 0xF, (b[10] >> 4) & 3, (b[10] >> 6) & 3, (b[11] & 1) === 1, (b[11] >> 1) & 3);
        gx.setTevKAlphaSel(s, (b[11] >> 3) & 0x1F);
        gx.setTevDirect(s);
      });
    } else {
      // Default TEV (no stages in the resource), by texture count.
      let n = 0;
      switch (this.texMaps.length) {
        case 0:
          gx.setTevOrder(0, 0xFF, 0xFF, 4);
          gx.setTevColorIn(0, CA.zero, CA.c1, CA.rasc, CA.zero);
          gx.setTevAlphaIn(0, AA.zero, AA.a1, AA.rasa, AA.zero);
          rasStage = false; n = 1;
          break;
        case 1:
          gx.setTevOrder(0, 0, 0, 0xFF);
          gx.setTevColorIn(0, CA.c0, CA.c1, CA.texc, CA.zero);
          gx.setTevAlphaIn(0, AA.a0, AA.a1, AA.texa, AA.zero);
          n = 1;
          break;
        case 2:
          gx.setTevOrder(0, 0, 0, 0xFF);
          gx.setTevColorIn(0, CA.zero, CA.zero, CA.zero, CA.texc);
          gx.setTevAlphaIn(0, AA.zero, AA.zero, AA.zero, AA.texa);
          gx.setTevOrder(1, 1, 1, 0xFF);
          gx.setTevColorIn(1, CA.texc, CA.cprev, CA.konst, CA.zero);
          gx.setTevAlphaIn(1, AA.texa, AA.aprev, AA.konst, AA.zero);
          gx.setTevKColorSel(1, LytMaterial.kselTable[0]); gx.setTevKAlphaSel(1, LytMaterial.kselTable[0]);
          n = 2;
          n = this.appendColorMapStage(gx, n);
          break;
        default:
          for (let i = 0; i < this.texMaps.length; i++) {
            gx.setTevOrder(n, i, i, 0xFF);
            gx.setTevColorIn(n, CA.zero, CA.texc, CA.konst, i === 0 ? CA.zero : CA.cprev);
            gx.setTevAlphaIn(n, AA.zero, AA.texa, AA.konst, i === 0 ? AA.zero : AA.aprev);
            gx.setTevKColorSel(n, LytMaterial.kselTable[i]); gx.setTevKAlphaSel(n, LytMaterial.kselTable[i]);
            n++;
          }
          n = this.appendColorMapStage(gx, n);
      }
      if (rasStage) {
        gx.setTevOrder(n, 0xFF, 0xFF, 4);
        gx.setTevColorIn(n, CA.zero, CA.cprev, CA.rasc, CA.zero);
        gx.setTevAlphaIn(n, AA.zero, AA.aprev, AA.rasa, AA.zero);
        n++;
      }
      for (let s = 0; s < n; s++) {
        gx.setTevColorOp(s, 0, 0, 0, true, 0);
        gx.setTevAlphaOp(s, 0, 0, 0, true, 0);
        gx.setTevDirect(s);
        gx.setTevSwapMode(s, 0, 0);
      }
      gx.setNumTevStages(n);
    }
    const a = this.alphaCompare;
    if (a) gx.setAlphaCompare(a[0] & 0xF, a[2], a[1], a[0] >> 4, a[3]);
    else gx.setAlphaCompare(7, 0, 0, 7, 0);
    const b = this.blendMode;
    if (b) gx.setBlendMode(b[0], b[1], b[2], b[3]);
    else gx.setBlendMode(1, 4, 5, 0xF);
    gx.setZMode(false, 7, false);
    return gx;
  }

  /** When the black/white colors are not the defaults, map the result through lerp(C0, C1, prev). */
  appendColorMapStage(gx, n) {
    const c0 = this.tevColors[0], c1 = this.tevColors[1];
    const isDefault = c0.every((v) => v === 0) && c1.every((v) => v === 255);
    if (isDefault) return n;
    gx.setTevOrder(n, 0xFF, 0xFF, 0xFF);
    gx.setTevColorIn(n, CA.c0, CA.c1, CA.cprev, CA.zero);
    gx.setTevAlphaIn(n, AA.a0, AA.a1, AA.aprev, AA.zero);
    return n + 1;
  }
}
LytMaterial.defaultBlack = [0, 0, 0, 0];                                     // lbl_80333790
LytMaterial.kselTable = [0x1F, 0x1B, 0x17, 0x13, 0x1E, 0x1A, 0x16, 0x12];      // lbl_801B8E60 / lbl_801B8E80
