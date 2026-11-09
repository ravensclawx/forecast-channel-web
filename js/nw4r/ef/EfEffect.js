// Port of Sources/NW4R/Ef/EfEffect.swift — nw4r::ef runtime: EffectSystem → Effect → Emitter → ParticleManager →
// Particle. Ported for the emitter features this channel's effects use (point/zero-size forms, no animation tracks);
// calc order follows Effect::Calc: CalcEmitter, CalcParticle, CalcEmission, CalcParticle.
// Matrices: column-major Float32Array(16).
import { EfDrawFlags } from './EfResource.js';

const ident = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
const mul = (a, b) => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
export function mtxTranslation(t) { const m = ident(); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m; }
/** MTX34 from a ZYX Euler rotation (Rz·Ry·Rx). */
export function mtxRotationZYX(r) {
  const sx = Math.sin(r[0]), cx = Math.cos(r[0]), sy = Math.sin(r[1]), cy = Math.cos(r[1]), sz = Math.sin(r[2]), cz = Math.cos(r[2]);
  const rows = (a) => { const m = new Float32Array(16); for (let rr = 0; rr < 4; rr++) for (let c = 0; c < 4; c++) m[c * 4 + rr] = a[rr][c]; return m; };
  const rx = rows([[1, 0, 0, 0], [0, cx, -sx, 0], [0, sx, cx, 0], [0, 0, 0, 1]]);
  const ry = rows([[cy, 0, sy, 0], [0, 1, 0, 0], [-sy, 0, cy, 0], [0, 0, 0, 1]]);
  const rz = rows([[cz, -sz, 0, 0], [sz, cz, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  return mul(mul(rz, ry), rx);
}

/** ParticleParameter (Particle +0x20): per-particle copy of ParticleParameterDesc plus motion state. */
export class EfParticleParameter {
  constructor(d) {
    this.color = d.color.map((l) => l.map((c) => c.slice()));
    this.size = d.size.slice(); this.scale = d.scale.slice(); this.rotate = d.rotate.slice();
    this.textureScale = d.textureScale.map((v) => v.slice()); this.textureRotate = d.textureRotate.slice();
    this.textureTranslate = d.textureTranslate.map((v) => v.slice());
    this.textureWrap = d.textureWrap; this.textureReverse = d.textureReverse;
    this.aCmpRef0 = d.aCmpRef0; this.aCmpRef1 = d.aCmpRef1;
    this.alphaFlickRnd = 0;
    this.velocity = [0, 0, 0]; this.position = [0, 0, 0]; this.prevPosition = [0, 0, 0];
    this.momentum = 1;
  }
}

/** nw4r::ef::Particle */
export class EfParticle {
  constructor(life, position, velocity, momentum, desc) {
    this.parameter = new EfParticleParameter(desc);
    this.parameter.momentum = momentum;
    this.tick = 0;
    this.life = life === 0 ? 1 : life;
    this.alive = true;   // mLifeStatus ACTIVE/CLOSING — what fn_8002CB1C tests at +0xC
    this.parameter.position = position.slice(); this.parameter.prevPosition = position.slice(); this.parameter.velocity = velocity.slice();
  }

  /** Particle::Draw_GetColor (alpha flicker). Returns [pri, sec] (each [r,g,b,a]). */
  drawColor(layer, ds) {
    const pri = this.parameter.color[layer][0].slice(), sec = this.parameter.color[layer][1].slice();
    if (ds.alphaFlickType !== 0) {
      const rnd = (this.parameter.alphaFlickRnd >>> 0);
      const cycleL = (ds.alphaFlickCycle + Math.floor(((ds.alphaFlickCycle * rnd) >>> 0) * ds.alphaFlickRandom / 12700)) >>> 0;
      const cycle = Math.min(cycleL, 0xFFFF), amp = ds.alphaFlickAmplitude;
      const pos = (this.tick - 1) % Math.max(cycle, 1);
      let alpha = 0;
      switch (ds.alphaFlickType) {
        case 1: alpha = pos * 2 <= cycle ? 128 - amp + Math.trunc(amp * (pos * 4) / cycle) : 128 + amp * 3 - Math.trunc((amp * pos * 4) / cycle); break;
        case 2: alpha = 128 + amp - Math.trunc((amp * pos * 2) / cycle); break;
        case 3: alpha = 128 - amp + Math.trunc(amp * (pos * 2) / cycle); break;
        case 4: alpha = pos * 2 <= cycle ? 128 + amp : 128 - amp; break;
        case 5: alpha = 128 + Math.trunc(amp * Math.sin(2 * Math.PI * pos / cycle)); break;
        default: break;
      }
      alpha = Math.max(0, Math.min(255, alpha));
      pri[3] = (pri[3] * alpha + 128) >> 8; sec[3] = (sec[3] * alpha + 128) >> 8;
    }
    return [pri, sec];
  }

  /** Draw_GetSizeX / Draw_GetSizeY. */
  drawSize(ds) {
    const p = this.parameter;
    const sx = p.size[0] * p.scale[0];
    let sy;
    switch (ds.flags & (EfDrawFlags.xySameSize | EfDrawFlags.xySameScale)) {
      case EfDrawFlags.xySameScale: sy = p.size[1] * p.scale[0]; break;
      case EfDrawFlags.xySameSize: sy = p.size[0] * p.scale[1]; break;
      case EfDrawFlags.xySameSize | EfDrawFlags.xySameScale: sy = p.size[0] * p.scale[0]; break;
      default: sy = p.size[1] * p.scale[1];
    }
    return [sx, sy];
  }
}

/** nw4r::ef::ParticleManager — the particles of one emitter. */
export class EfParticleManager {
  constructor(res) { this.resource = res; this.particles = []; this.emitter = null; this.lastCalced = 0; }
  /** CalcGlobalMtx: the particle manager inherits the emitter's space. */
  get globalMtx() { return this.emitter ? this.emitter.globalMtx : ident(); }
  /** ParticleManager::Calc — particles not yet calculated this frame: retire at end of life, integrate, tick++. */
  calc() {
    for (let i = this.lastCalced; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      const pp = p.parameter;
      pp.prevPosition = pp.position.slice();
      if (p.life <= p.tick) { p.alive = false; continue; }
      pp.position = [pp.position[0] + pp.velocity[0] * pp.momentum, pp.position[1] + pp.velocity[1] * pp.momentum, pp.position[2] + pp.velocity[2] * pp.momentum];
      p.tick = (p.tick + 1) & 0xFFFF;
    }
    this.particles = this.particles.filter((p) => p.alive);
    this.lastCalced = this.particles.length;
  }
}

/** nw4r::ef::Emitter */
export class EfEmitter {
  constructor(res) {
    this.resource = res;
    this.manager = new EfParticleManager(res);
    this.effect = null;
    this.tick = 0;
    this.waitTime = res.desc.emitStart;
    this.emitIntervalWait = 0;
    this.emitCount = 0;
    this.isFirstEmission = true;
    this.alive = true;
    this.manager.emitter = this;
  }
  /** Emitter::CalcGlobalMtx: effect root × emitter S/R/T. */
  get globalMtx() {
    const d = this.resource.desc;
    let m = this.effect ? this.effect.rootMtx : ident();
    m = mul(m, mtxTranslation(d.translate));
    if (d.rotate.some((v) => v !== 0)) m = mul(m, mtxRotationZYX(d.rotate));
    const s = ident(); s[0] = d.scale[0]; s[5] = d.scale[1]; s[10] = d.scale[2];
    return mul(m, s);
  }
  /** Emitter::CalcEmitter — retire at the end of the emit span unless CMN_FLAG_MAX_LIFE (4). */
  calcEmitter() {
    if (!this.alive || this.waitTime > 0) return;
    if ((this.resource.desc.commonFlag & 4) === 0 && this.tick >= this.resource.desc.emitLife) this.alive = false;
  }
  /** Emitter::CalcEmission */
  calcEmission() {
    if (!this.alive) { this.tick = (this.tick + 1) >>> 0; return; }
    if (this.waitTime > 0) { this.waitTime--; return; }
    this.emission();
    this.tick = (this.tick + 1) >>> 0;
  }
  emission() {
    if (this.emitIntervalWait > 0) { this.emitIntervalWait--; return; }
    const d = this.resource.desc;
    this.emitIntervalWait = d.emitInterval;
    this.emitCount += d.emit;
    if (this.isFirstEmission && d.emit !== 0 && this.emitCount < 1) this.emitCount = 1;
    if (this.emitCount >= 1) {
      const n = Math.trunc(this.emitCount);
      for (let i = 0; i < n; i++) this.emitOne();
      this.emitCount -= n;
    }
    this.isFirstEmission = false;
  }
  /** EmitterFormPoint::Emission (form 9): position at the emitter origin, zero velocity (velPower terms are 0 here). */
  emitOne() {
    const d = this.resource.desc;
    this.manager.particles.push(new EfParticle(d.ptclLife, [0, 0, 0], [0, 0, 0], 1, this.resource.particle));
  }
}

/** nw4r::ef::Effect — a set of emitters from one resource name, placed by its root matrix. */
export class EfEffect {
  constructor() { this.translate = [0, 0, 0]; this.emitters = []; }
  get rootMtx() { return mtxTranslation(this.translate); }
  /** Effect::Calc */
  calc() {
    for (const e of this.emitters) e.calcEmitter();
    for (const e of this.emitters) e.manager.calc();
    for (const e of this.emitters) e.calcEmission();
    for (const e of this.emitters) e.manager.calc();
  }
  /** The particle managers in draw order. */
  get particleManagers() { return this.emitters.map((e) => e.manager); }
}

/** nw4r::ef::EffectSystem (CreateEffect by resource name). */
export class EfEffectSystem {
  constructor(effects, textures) { this.effects = effects; this.textures = textures; }
  createEffect(name) {
    const r = this.effects.emitters.get(name);
    if (!r) return null;
    const fx = new EfEffect();
    const e = new EfEmitter(r);
    e.effect = fx;
    fx.emitters = [e];
    return fx;
  }
}
