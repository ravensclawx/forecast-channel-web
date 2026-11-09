// Port of Sources/NW4R/Ef/EfResource.swift — nw4r::ef resources: REFF (effect/emitter set) and REFT (texture set),
// in the layout this channel's library version uses (verified against the DOL: ParticleManager ctor fn_80090698,
// DrawStrategyImpl::InitTev fn_8009A78C). EmitterDesc 0xA0 bytes (type bytes at +0x8C), EmitterDrawSetting 0xA0
// bytes, ParticleParameterDesc without rotate offsets (texture names at +0x7A).
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';
import { GXTextureDecoder } from '../../gx/GXTexture.js';

const dec = new TextDecoder();
const strz = (b, o, n) => { let e = o; while (e < o + n && b[e] !== 0) e++; return dec.decode(b.subarray(o, e)); };

/** Common REFF/REFT container: header, block, project, name table → [{name, offset, size}]. */
export const EfNameTable = {
  read(b, magic) {
    const r = new BEReader(b);
    if (r.magic(0) !== magic || r.magic(0x10) !== magic) throw RVLError.badMagic(r.magic(0), magic);
    const project = 0x18;
    const table = project + r.u32(0x18);
    const count = r.u16(table + 4);
    const out = [];
    let p = table + 8;
    for (let i = 0; i < count; i++) {
      const n = r.u16(p);
      const name = strz(b, p + 2, n);
      p += 2 + n;
      out.push({ name, offset: table + r.u32(p), size: r.u32(p + 4) });
      p += 8;
    }
    return out;
  },
};

/** EmitterDrawSetting flag bits */
export const EfDrawFlags = Object.freeze({
  zCompEnableTest: 1 << 0, zCompEnableUpdate: 1 << 1, zCompBeforeTex: 1 << 2, clipDisable: 1 << 3,
  tex1Enable: 1 << 4, tex2Enable: 1 << 5, texIndEnable: 1 << 6, tex1Proj: 1 << 7, hidden: 1 << 10,
  drawOrder: 1 << 11, fogEnable: 1 << 12, xySameSize: 1 << 13, xySameScale: 1 << 14,
});

/**
 * EmitterResource: { char* name, u32 headerSize } EmitterDesc { u32 size, ParticleParameterDesc } { tracks }.
 * Fields: desc (EmitterDesc), draw (EmitterDrawSetting), particle (ParticleParameterDesc).
 */
export class EfEmitterResource {
  constructor(name, b, o) {
    const r = new BEReader(b);
    this.name = name;
    const headerSize = r.u32(o + 4);
    const e = o + 8;
    const f = (x) => r.f32(x);
    const v3 = (x) => [f(x), f(x + 4), f(x + 8)];
    const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
    this.desc = {
      commonFlag: r.u32(e), emitFlag: r.u32(e + 4), emitLife: r.u16(e + 8), ptclLife: r.u16(e + 0xA),
      ptclLifeRandom: r.s8(e + 0xC), emitIntervalRandom: r.s8(e + 0xE), emitRandom: r.s8(e + 0xF),
      emit: f(e + 0x10), emitStart: r.u16(e + 0x14), emitPast: r.u16(e + 0x16), emitInterval: r.u16(e + 0x18),
      commonParam: range(6, (i) => f(e + 0x1C + i * 4)), emitDiv: r.u16(e + 0x34),
      velInitVelocityRandom: r.s8(e + 0x36), velMomentumRandom: r.s8(e + 0x37),
      velPower: range(7, (i) => f(e + 0x38 + i * 4)), velSpecDir: v3(e + 0x54),
      scale: v3(e + 0x60), rotate: v3(e + 0x6C), translate: v3(e + 0x78),
      lodNear: r.u8(e + 0x84), lodFar: r.u8(e + 0x85), lodMinEmit: r.u8(e + 0x86), lodAlpha: r.u8(e + 0x87),
      randomSeed: r.u32(e + 0x88),
      ptclType: r.u8(e + 0x8C), typeOption: r.u8(e + 0x8D), typeDir: r.u8(e + 0x8E), typeAxis: r.u8(e + 0x8F),
      get formType() { return this.emitFlag & 0xFF; },   // 9 = point
    };

    const d = e + 0xA0;
    const tev = range(4, (i) => {
      const c = d + 8 + i * 4, co = d + 0x18 + i * 5, a = d + 0x2C + i * 4, ao = d + 0x3C + i * 5;
      return {
        color: { a: r.u8(c), b: r.u8(c + 1), c: r.u8(c + 2), d: r.u8(c + 3) },
        colorOp: { op: r.u8(co), bias: r.u8(co + 1), scale: r.u8(co + 2), clamp: r.u8(co + 3), out: r.u8(co + 4) },
        alpha: { a: r.u8(a), b: r.u8(a + 1), c: r.u8(a + 2), d: r.u8(a + 3) },
        alphaOp: { op: r.u8(ao), bias: r.u8(ao + 1), scale: r.u8(ao + 2), clamp: r.u8(ao + 3), out: r.u8(ao + 4) },
        kColorSel: r.u8(d + 0x50 + i), kAlphaSel: r.u8(d + 0x54 + i),
      };
    });
    this.draw = {
      flags: r.u16(d), aCmpComp0: r.u8(d + 2), aCmpComp1: r.u8(d + 3), aCmpOp: r.u8(d + 4), numTevs: r.u8(d + 5),
      flagClamp: r.u8(d + 6), indirectTargetStage: r.u8(d + 7), tev,
      blend: { type: r.u8(d + 0x58), src: r.u8(d + 0x59), dst: r.u8(d + 0x5A), op: r.u8(d + 0x5B) },
      rasColor: r.u8(d + 0x5C), tevColorInput: range(3, (i) => r.u8(d + 0x5D + i)),
      tevKColorInput: range(4, (i) => r.u8(d + 0x60 + i)), zCompareFunc: r.u8(d + 0x64),
      alphaFlickType: r.u8(d + 0x65), alphaFlickCycle: r.u16(d + 0x66), alphaFlickRandom: r.u8(d + 0x68),
      alphaFlickAmplitude: r.u8(d + 0x69), indTexOffsetMtx: range(6, (i) => f(d + 0x84 + i * 4)),
      indTexScaleExp: r.s8(d + 0x9C), pivot: [r.s8(d + 0x9D) / 100, r.s8(d + 0x9E) / 100],
    };

    const p0 = e + headerSize, psize = r.u32(p0), p = p0 + 4;
    const rgba = (x) => [r.u8(x), r.u8(x + 1), r.u8(x + 2), r.u8(x + 3)];
    const names = [];
    let q = p + 0x7A;
    for (let i = 0; i < 3; i++) { const n = r.u16(q); names.push(strz(b, q + 2, n)); q += 2 + n; }
    this.particle = {
      color: [[rgba(p), rgba(p + 4)], [rgba(p + 8), rgba(p + 0xC)]],
      size: [f(p + 0x10), f(p + 0x14)], scale: [f(p + 0x18), f(p + 0x1C)], rotate: v3(p + 0x20),
      textureScale: range(3, (i) => [f(p + 0x2C + i * 8), f(p + 0x30 + i * 8)]),
      textureRotate: range(3, (i) => f(p + 0x44 + i * 4)),
      textureTranslate: range(3, (i) => [f(p + 0x50 + i * 8), f(p + 0x54 + i * 8)]),
      textureWrap: r.u16(p + 0x74), textureReverse: r.u8(p + 0x76), aCmpRef0: r.u8(p + 0x77), aCmpRef1: r.u8(p + 0x78),
      textureNames: names,
    };
    const tracks = p0 + 4 + psize;
    this.numPtclTrack = r.u16(tracks);
    this.numEmitTrack = r.u16(tracks + 4 + this.numPtclTrack * 8);
  }
}

/** REFF file: emitter resources by name (EffectSystem::RegisterResource). */
export class EfEffectFile {
  constructor(b) {
    /** @type {Map<string, EfEmitterResource>} */
    this.emitters = new Map();
    for (const { name, offset } of EfNameTable.read(b, 'REFF')) this.emitters.set(name, new EfEmitterResource(name, b, offset));
  }
}

const GX_C4 = 8, GX_C8 = 9, GX_C14X2 = 10, GX_I8 = 1;

/** REFT TextureData: { u32 0, u16 w, u16 h, u32 dataSize, u8 format, u8 tlutFormat, u16 tlutEntries, …, u8 mipmap } (0x20). */
export class EfTextureFile {
  constructor(b) {
    const r = new BEReader(b);
    /** @type {Map<string, {name,width,height,format,mipmap,rgba8}>} */
    this.textures = new Map();
    for (const { name, offset: off } of EfNameTable.read(b, 'REFT')) {
      const w = r.u16(off + 4), h = r.u16(off + 6);
      let fmt = r.u8(off + 0xC);
      if (fmt > 14) fmt = GX_I8;
      const dataSize = r.u32(off + 8);
      const palette = [];
      const tlutEntries = r.u16(off + 0xE);
      if (fmt === GX_C4 || fmt === GX_C8 || fmt === GX_C14X2) for (let i = 0; i < tlutEntries; i++) palette.push(r.u16(off + 0x20 + dataSize + i * 2));
      const rgba8 = GXTextureDecoder.decode(r.data, off + 0x20, w, h, fmt, palette, r.u8(off + 0xD));
      this.textures.set(name, { name, width: w, height: h, format: fmt, mipmap: r.u8(off + 0x14), rgba8 });
    }
  }
}
