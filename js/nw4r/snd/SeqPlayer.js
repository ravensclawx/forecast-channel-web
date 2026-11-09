// Port of Sources/NW4R/Snd/SeqPlayer.swift — sequence playback: SeqPlayer (tempo/ticks, variables) and SeqTrack
// (MML command interpreter). Semantics follow nw4r::snd's MmlParser / SeqTrack / SeqPlayer (decomp/notes/sound.md).
import { Channel, EnvGenerator, LfoTarget } from './Channel.js';

const s16 = (v) => (v << 16) >> 16;
const s8 = (v) => (v << 24) >> 24;
const u8 = (v) => v & 0xFF;

export class SeqTrack {
  constructor(player, index) {
    this.player = player; this.index = index;
    this.open = false; this.pc = 0; this.wait = 0; this.noteFinishWait = false;
    // Parser track params (defaults per SeqTrack::InitParam)
    this.volume = 127; this.volume2 = 127; this.pan = 0; this.initPan = 0; this.surroundPan = 0;
    this.transpose = 0; this.pitchBend = 0; this.bendRange = 2; this.priority = 64; this.prgNo = 0; this.bankNo = 0;
    this.attack = 0xFF; this.decay = 0xFF; this.sustain = 0xFF; this.release = 0xFF;
    this.lfoDepth = 0; this.lfoSpeed = 6.25; this.lfoRange = 1; this.lfoDelay = 0; this.lfoTarget = 0;
    this.sweepPitch = 0; this.portaKey = 60; this.portaTime = 0; this.portaFlag = false;
    this.damper = false; this.mute = false; this.silence = false;
    this.lpfFreq = 64; this.mainSend = 127;
    this.fxSend = [0, 0, 0];
    // MML parser params
    this.noteWait = true; this.tie = false; this.cmpFlag = true;
    this.callStack = []; this.loopCounts = [];
    this.vars = new Int16Array(16).fill(-1);
    /** @type {Channel[]} */
    this.channels = [];
  }

  start(offset) { this.pc = offset; this.open = true; this.wait = 0; this.noteFinishWait = false; this.callStack = []; this.loopCounts = []; }
  close() { this.releaseAll(-1); this.freeAll(); this.open = false; }
  releaseAll(rel) {
    this.updateChannelParams();
    for (const c of this.channels) if (c.active) {
      if (rel >= 0) c.env.release = EnvGenerator.rate(rel);
      c.release();
    }
  }
  freeAll() { for (const c of this.channels) c.track = null; this.channels = []; }

  /** SeqTrack::UpdateChannelLength (per tick). */
  updateChannelLength() {
    if (!this.open) return;
    this.channels = this.channels.filter((c) => c.active);
    for (const c of this.channels) {
      if (c.length > 0) c.length--;
      if (c.length === 0 && !c.isReleasing && !this.damper) c.release();
      if (!c.autoSweep) c.updateSweep(1);
    }
  }

  /** SeqTrack::UpdateChannelParam. */
  updateChannelParams() {
    if (!this.open) return;
    const pl = this.player;
    let v = this.volume / 127; v *= v;
    let v2 = this.volume2 / 127; v2 *= v2;
    let pv = pl.parserVolume / 127; pv *= pv;
    const vol = v * v2 * pv * pl.volume;
    const pitch = this.pitchBend / 128 * this.bendRange;
    const p = Math.min(Math.max(this.pan / 63, -1), 1) + pl.pan;
    const send = this.mainSend / 127 - 1;
    for (const c of this.channels) {
      c.userVolume = vol; c.userPitch = pitch; c.userPitchRatio = pl.pitch;
      c.userPan = p; c.mainSend = send;
      c.fxSendC = this.fxSend[2] / 127;
      c.lfo.depth = this.lfoDepth; c.lfo.speed = this.lfoSpeed; c.lfo.range = this.lfoRange; c.lfo.delay = this.lfoDelay;
      c.lfoTarget = [0, 1, 2].includes(this.lfoTarget) ? this.lfoTarget : LfoTarget.pitch;
    }
  }

  /** SeqTrack::ParseNextTick → 1 continue, -1 finished. */
  parseNextTick(noteOn) {
    if (!this.open) return 0;
    if (this.noteFinishWait) {
      this.channels = this.channels.filter((c) => c.active);
      if (this.channels.length) return 1;
      this.noteFinishWait = false;
    }
    if (this.wait > 0) { this.wait--; if (this.wait > 0) return 1; }
    let guardCount = 0;
    while (this.wait === 0 && !this.noteFinishWait) {
      if (!this.step(noteOn)) return -1;
      if (++guardCount > 100000) return -1; // runaway loop protection
    }
    return 1;
  }

  // MARK: MML interpreter
  u8() { const d = this.player.seq.data; if (this.pc >= d.length) return 0xFF; return d[this.pc++]; }
  u16() { const a = this.u8(); return (a << 8) | this.u8(); }
  u24() { const a = this.u8(), b = this.u8(); return (a << 16) | (b << 8) | this.u8(); }
  vlq() { let v = 0, b; do { b = this.u8(); v = (v << 7) | (b & 0x7F); } while (b & 0x80); return v; }

  arg(kind) {
    switch (kind) {
      case 'u8': return this.u8();
      case 's16': return s16(this.u16());
      case 'vmidi': return this.vlq();
      case 'variable': return this.player.variable(this.u8(), this) ?? 0;
      case 'random': {
        const lo = s16(this.u16()), hi = s16(this.u16());
        return ((this.player.tables.random() * (hi - lo + 1)) >> 16) + lo;
      }
    }
    return 0;
  }

  /** Execute one command. Returns false at FIN. */
  step(noteOn) {
    let cmd = this.u8();
    let exec = true, override = null;
    if (cmd === 0xA2) { cmd = this.u8(); exec = this.cmpFlag; }
    if (cmd === 0xA0) { cmd = this.u8(); override = 'random'; }
    if (cmd === 0xA1) { cmd = this.u8(); override = 'variable'; }

    if (cmd < 0x80) { // note
      const velocity = this.u8();
      const length = this.arg(override ?? 'vmidi');
      if (!exec) return true;
      const k = Math.min(Math.max(cmd + this.transpose, 0), 127);
      if (!this.mute && noteOn) this.noteOnCommand(k, velocity, length > 0 ? length : -1);
      if (this.noteWait) { this.wait = length; if (length === 0) this.noteFinishWait = true; }
      return true;
    }
    switch (cmd & 0xF0) {
      case 0x80:
        switch (cmd) {
          case 0x80: { const t = this.arg(override ?? 'vmidi'); if (exec) this.wait = t; break; }
          case 0x81: { const a = this.arg(override ?? 'vmidi'); if (exec && a < 128) this.prgNo = a & 0x7F; break; }
          case 0x88: {
            const tr = this.u8(), off = this.u24();
            if (exec) { const t = this.player.track(tr); if (t && t !== this) { t.close(); t.start(off); } }
            break;
          }
          case 0x89: { const off = this.u24(); if (exec) this.pc = off; break; }
          case 0x8A: {
            const off = this.u24();
            if (exec && this.callStack.length < 3) { this.callStack.push(this.pc); this.loopCounts.push(0); this.pc = off; }
            break;
          }
          default: break;
        }
        break;
      case 0x90: break;
      case 0xB0: case 0xC0: case 0xD0: {
        const raw = this.arg(override ?? 'u8');
        if (!exec) return true;
        const a = (cmd === 0xC3 || cmd === 0xC4) ? s8(raw) : (raw & 0xFF);
        this.command(cmd, a);
        break;
      }
      case 0xE0: {
        const a = this.arg(override ?? 's16');
        if (!exec) return true;
        switch (cmd) {
          case 0xE0: this.lfoDelay = a * 5; break;
          case 0xE1: this.player.tempo = a; break;
          case 0xE3: this.sweepPitch = a / 32; break;
          default: break;
        }
        break;
      }
      case 0xF0:
        switch (cmd) {
          case 0xFE: this.u16(); break;             // alloctrack (handled from the sound info)
          case 0xFF: return false;                   // FIN
          case 0xFC: // loop end
            if (exec && this.callStack.length) {
              const top = this.loopCounts.length - 1;
              let c = this.loopCounts[top];
              if (c !== 0) c--;
              if (this.loopCounts[top] !== 0 && c === 0) { this.callStack.pop(); this.loopCounts.pop(); }
              else { this.loopCounts[top] = c; this.pc = this.callStack[this.callStack.length - 1]; }
            }
            break;
          case 0xFD: // return
            if (exec && this.callStack.length) { this.pc = this.callStack.pop(); this.loopCounts.pop(); }
            break;
          case 0xF0: {
            const ex = this.u8();
            switch (ex & 0xF0) {
              case 0xE0: this.arg(override ?? 's16'); break; // userproc
              case 0x80: case 0x90: {
                const v = this.u8(), val = this.arg(override ?? 's16');
                if (exec) this.exCommand(ex, v, s16(val));
                break;
              }
              default: break;
            }
            break;
          }
          default: break;
        }
        break;
      default: break;
    }
    return true;
  }

  command(cmd, a) {
    switch (cmd) {
      case 0xB0: this.player.timebase = a; break;
      case 0xC0: this.pan = a - 64; break;
      case 0xC1: this.volume = a; break;
      case 0xC2: this.player.parserVolume = a; break;
      case 0xC3: this.transpose = a; break;
      case 0xC4: this.pitchBend = a; break;
      case 0xC5: this.bendRange = a; break;
      case 0xC6: this.priority = a; break;
      case 0xC7: this.noteWait = a !== 0; break;
      case 0xC8: this.tie = a !== 0; this.releaseAll(-1); this.freeAll(); break;
      case 0xC9: this.portaKey = a + this.transpose; this.portaFlag = true; break;
      case 0xCA: this.lfoDepth = u8(a) / 128; break;
      case 0xCB: this.lfoSpeed = u8(a) * (100.0 / 256.0); break;
      case 0xCC: this.lfoTarget = a; break;
      case 0xCD: this.lfoRange = a; break;
      case 0xCE: this.portaFlag = a !== 0; break;
      case 0xCF: this.portaTime = a; break;
      case 0xD0: this.attack = a; break;
      case 0xD1: this.decay = a; break;
      case 0xD2: this.sustain = a; break;
      case 0xD3: this.release = a; break;
      case 0xD4: if (this.callStack.length < 3) { this.callStack.push(this.pc); this.loopCounts.push(a); } break;
      case 0xD5: this.volume2 = a; break;
      case 0xD7: this.surroundPan = a; break;
      case 0xD8: this.lpfFreq = a; break;
      case 0xD9: this.fxSend[0] = a; break;
      case 0xDA: this.fxSend[1] = a; break;
      case 0xDB: this.mainSend = a; break;
      case 0xDC: this.initPan = a - 64; break;
      case 0xDD: this.mute = a !== 0; break;
      case 0xDE: this.fxSend[2] = a; break;
      case 0xDF: this.damper = u8(a) >= 64; break;
      default: break; // 0xD6 printvar etc.
    }
  }

  exCommand(ex, v, val) {
    let x = this.player.variable(v, this);
    if (x === null) return;
    switch (ex) {
      case 0x80: x = val; break;
      case 0x81: x = s16(x + val); break;
      case 0x82: x = s16(x - val); break;
      case 0x83: x = s16(Math.imul(x, val)); break;
      case 0x84: if (val !== 0) x = s16(Math.trunc(x / val)); break;
      case 0x85: x = s16(val >= 0 ? x << val : x >> -val); break;
      case 0x86: {
        const neg = val < 0, m = neg ? -val : val;
        let r = (this.player.tables.random() * (m + 1)) >> 16;
        if (neg) r = -r;
        x = s16(r);
        break;
      }
      case 0x87: x = s16(x & val); break;
      case 0x88: x = s16(x | val); break;
      case 0x89: x = s16(x ^ val); break;
      case 0x8A: x = s16(~val); break;
      case 0x8B: if (val !== 0) x = s16(x % val); break;
      case 0x90: this.cmpFlag = x === val; return;
      case 0x91: this.cmpFlag = x >= val; return;
      case 0x92: this.cmpFlag = x > val; return;
      case 0x93: this.cmpFlag = x <= val; return;
      case 0x94: this.cmpFlag = x < val; return;
      case 0x95: this.cmpFlag = x !== val; return;
      default: return;
    }
    this.player.setVariable(v, this, x);
  }

  /** SeqTrack::NoteOn → SeqPlayer/Bank::NoteOn. */
  noteOnCommand(key, velocity, length) {
    let ch = null;
    if (this.tie) {
      for (let i = this.channels.length - 1; i >= 0; i--) if (this.channels[i].active) { ch = this.channels[i]; break; }
      if (ch) { ch.key = key; const iv = velocity / 127; ch.initVolume = iv * iv; }
    }
    if (!ch) {
      const c = this.player.bankNoteOn(this.prgNo, key, velocity, this.tie ? -1 : length, this.initPan);
      if (!c) return;
      c.track = this;
      this.channels.push(c);
      ch = c;
    }
    const c = ch, t = this.player.tables;
    if (this.attack !== 0xFF) c.env.attack = t.attack[Math.min(this.attack, 127)];
    if (this.decay !== 0xFF) c.env.decay = EnvGenerator.rate(this.decay);
    if (this.sustain !== 0xFF) c.env.sustain = Math.min(this.sustain, 127);
    if (this.release !== 0xFF) c.env.release = EnvGenerator.rate(this.release);
    let sweep = this.sweepPitch;
    if (this.portaFlag) sweep += this.portaKey - key;
    if (this.portaTime === 0) {
      c.setSweep(sweep, length, false);
    } else {
      let time = this.portaTime * this.portaTime;
      time = Math.trunc(time * Math.abs(sweep));
      time = ((time >> 5) << 2) + (time >> 5);
      c.setSweep(sweep, time, true);
    }
    this.portaKey = key;
  }
}

export class SeqPlayer {
  constructor(system, seq, bank, startOffset, allocTrack, panCurve) {
    this.system = system; this.tables = system.tables; this.seq = seq; this.bank = bank; this.panCurve = panCurve;
    this.tracks = [];
    this.tempo = 120; this.timebase = 48; this.parserVolume = 127;
    this.localVars = new Int16Array(16).fill(-1);
    this.tickFraction = 0;
    this.tempoRatio = 1;
    // External params (from the BasicSound / handle)
    this.volume = 1; this.pitch = 1; this.pan = 0;
    this.paused = false;
    this.finished = false;
    for (let i = 0; i < 16; i++) if ((allocTrack & (1 << i)) !== 0 || i === 0) this.tracks.push(new SeqTrack(this, i));
    this.tracks[0].start(startOffset);
  }

  track(n) { return this.tracks.find((t) => t.index === n) ?? null; }

  variable(i, track) {
    if (i < 16) return this.localVars[i];
    if (i < 32) return this.system.globalVars[i - 16];
    if (i < 48) return track.vars[i - 32];
    return null;
  }
  setVariable(i, track, v) {
    if (i < 16) this.localVars[i] = v;
    else if (i < 32) this.system.globalVars[i - 16] = v;
    else if (i < 48) track.vars[i - 32] = v;
  }

  /** ticks per msec */
  get baseTempo() { return this.tempoRatio * (this.timebase * this.tempo) / 60000; }

  /** SeqPlayer::Update (one AX frame = 3 ms). */
  update() {
    if (this.finished) return;
    if (!this.paused) this.updateTick(3);
    for (const t of this.tracks) t.updateChannelParams();
  }

  updateTick(msec) {
    let tpm = this.baseTempo;
    if (!(tpm > 0)) return;
    let rest = msec;
    let next = this.tickFraction / tpm;
    while (next < rest) {
      rest -= next;
      if (this.parseNextTick() !== 0) { this.finish(); return; }
      tpm = this.baseTempo;
      if (!(tpm > 0)) return;
      next = 1 / tpm;
    }
    next -= rest;
    this.tickFraction = next * tpm;
  }

  /** SeqPlayer::ParseNextTick: lengths first, then every track parses; finish when all tracks are closed. */
  parseNextTick() {
    let active = false;
    for (const t of this.tracks) if (t.open) t.updateChannelLength();
    for (const t of this.tracks) if (t.open) {
      if (t.parseNextTick(true) < 0) t.close(); else active = true;
    }
    return active ? 0 : 1;
  }

  finish() { this.finished = true; for (const t of this.tracks) if (t.open) t.close(); }
  stopNow() { for (const t of this.tracks) { for (const c of t.channels) c.stop(); t.freeAll(); t.open = false; } this.finished = true; }

  /** Bank::NoteOn — instrument lookup, wave, channel init. */
  bankNoteOn(program, key, velocity, length, initPan) {
    const inst = this.bank.file.instInfo(program, key, velocity);
    if (!inst) return null;
    const wave = this.bank.wave(inst.waveIndex);
    if (!wave) return null;
    const c = new Channel(wave);
    c.key = key; c.originalKey = inst.originalKey;
    let iv = velocity / 127; iv *= iv;
    c.initVolume = iv * inst.volume / 127;
    c.tune = inst.tune;
    c.env.setup(this.tables, inst.attack, inst.decay, inst.sustain, inst.release);
    c.env.reset();
    c.initPan = (inst.pan - 64) / 63 + initPan / 63;
    c.length = length;
    c.panCurve = this.panCurve;
    this.system.addChannel(c);
    return c;
  }
}
