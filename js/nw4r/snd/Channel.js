// Port of Sources/NW4R/Snd/Channel.swift — nw4r::snd::detail EnvGenerator / Lfo / Channel + an AX-style voice.
// Channels update every AX frame (3 ms); envelopes/LFOs advance 3 ms per update; voice volume ramps linearly
// across the frame from the previous to the new envelope value.
import { SndTables, PanCurve } from './SndTables.js';

export const EnvStatus = Object.freeze({ attack: 0, decay: 1, sustain: 2, release: 3 });

export class EnvGenerator {
  constructor() {
    this.value = -904;            // 0.1 dB units
    this.status = EnvStatus.attack;
    this.attack = 0; this.decay = 0; this.release = 0;
    this.sustain = 127;
  }
  setup(t, a, d, s, r) {
    this.attack = t.attack[Math.min(Math.max(a, 0), 127)]; this.decay = EnvGenerator.rate(d);
    this.sustain = Math.min(Math.max(s, 0), 127); this.release = EnvGenerator.rate(r);
  }
  reset() { this.value = SndTables.volumeMinDB * 10; this.status = EnvStatus.attack; }

  /** EnvGenerator::CalcRelease — 0.1 dB per msec. */
  static rate(r) {
    if (r >= 127) return 65535;
    if (r === 126) return 24;
    if (r < 50) return (r * 2 + 1) / 128 / 5;
    return 60 / (126 - r) / 5;
  }

  /** dB value (0 = full). */
  get db() { return (this.status === EnvStatus.attack && this.attack === 0) ? 0 : this.value / 10; }

  update(t, msec) {
    let ms = msec;
    if (this.status === EnvStatus.attack) {
      while (ms > 0) {
        this.value = Math.fround(this.value * this.attack); ms--;
        if (this.value > -1.0 / 32.0) { this.value = 0; this.status = EnvStatus.decay; break; }
      }
      if (this.status !== EnvStatus.decay) return;   // falls through into decay with the remaining msec
    }
    switch (this.status) {
      case EnvStatus.decay: {
        const target = t.decibelSquare[this.sustain];
        this.value -= this.decay * ms;
        if (this.value <= target) { this.value = target; this.status = EnvStatus.sustain; }
        break;
      }
      case EnvStatus.release:
        this.value -= this.release * ms;
        break;
      default: break;
    }
  }
}

export class Lfo {
  constructor() { this.depth = 0; this.range = 1; this.speed = 6.25; this.delay = 0; this.counter = 0; this.delayCounter = 0; }
  reset() { this.counter = 0; this.delayCounter = 0; }
  update(msec) {
    let ms = msec;
    if (this.delayCounter < this.delay) {
      if (this.delayCounter + ms <= this.delay) { this.delayCounter += ms; return; }
      ms -= this.delay - this.delayCounter; this.delayCounter = this.delay;
    }
    this.counter += this.speed * ms / 1000;
    this.counter -= Math.trunc(this.counter);
  }
  value(t) {
    if (this.depth === 0 || this.delayCounter < this.delay) return 0;
    const idx = Math.trunc(4 * (32 * this.counter));
    let s;
    if (idx < 32) s = t.lfoSin[idx];
    else if (idx < 64) s = t.lfoSin[32 - (idx - 32)];
    else if (idx < 96) s = -t.lfoSin[idx - 64];
    else s = -t.lfoSin[32 - (idx - 96)];
    return s / 127 * this.depth * this.range;
  }
}

/** Decoded wave shared by voices. */
export class PCMWave {
  constructor(channels, sampleRate, loop, loopStart, loopEnd) {
    this.channels = channels; this.sampleRate = sampleRate; this.loop = loop;
    this.loopStart = loopStart; this.loopEnd = Math.min(loopEnd, channels.length ? channels[0].length : 0);
  }
}

export const LfoTarget = Object.freeze({ pitch: 0, volume: 1, pan: 2 });

export class Channel {
  /** @param {PCMWave} wave */
  constructor(wave) {
    this.active = true;
    this.key = 60; this.originalKey = 60;
    this.initVolume = 1; this.userVolume = 1; this.tune = 1;
    this.initPan = 0; this.userPan = 0;
    this.userPitch = 0; this.userPitchRatio = 1;
    this.mainSend = 0;
    this.fxSendC = 0;                  // AUX C send (0..1); the channel's reverb bus
    this.panCurve = PanCurve.sqrt;
    this.env = new EnvGenerator();
    this.lfo = new Lfo(); this.lfoTarget = LfoTarget.pitch;
    this.length = -1;                  // ticks until release; -1 = until released
    this.sweepPitch = 0; this.sweepLength = 0; this.sweepCounter = 0; this.autoSweep = true;
    this.track = null;                 // null once freed from its track (still releasing)
    // Voice
    this.wave = wave;
    this.pos = 0;
    this.pitchRatio = 1;
    this.gainL = 0; this.gainR = 0;    // gains at frame start (ramp from)
    this.auxScale = 0;                 // aux gain relative to main
    this.nextL = 0; this.nextR = 0;    // gains at frame end
  }

  get isReleasing() { return this.env.status === EnvStatus.release; }
  release() { if (this.env.status !== EnvStatus.release) this.env.status = EnvStatus.release; }
  stop() { this.active = false; }

  setSweep(pitch, time, auto) { this.sweepPitch = pitch; this.sweepLength = time; this.sweepCounter = 0; this.autoSweep = auto; }
  updateSweep(count) { this.sweepCounter = Math.min(this.sweepCounter + count, this.sweepLength); }
  get sweepValue() {
    if (this.sweepPitch === 0 || this.sweepCounter >= this.sweepLength) return 0;
    return this.sweepPitch * (this.sweepLength - this.sweepCounter) / this.sweepLength;
  }

  /** Channel::Update (+ Voice::CalcMixParam), once per AX frame. */
  update(t, periodic) {
    if (!this.active) return;
    const lfoValue = this.lfo.value(t);
    const volume = this.initVolume * this.userVolume;
    let veInit = t.volumeRatio(this.env.db);
    if (this.lfoTarget === LfoTarget.volume) veInit *= t.volumeRatio(SndTables.volumeMaxDB * lfoValue);
    if (this.env.status === EnvStatus.release && volume * veInit === 0) { this.stop(); return; }

    let cent = (this.key - this.originalKey) + this.sweepValue + this.userPitch;
    if (this.lfoTarget === LfoTarget.pitch) cent += lfoValue;
    this.pitchRatio = t.pitchRatio(Math.trunc(256 * cent)) * this.tune * this.userPitchRatio;

    let pan = this.initPan + this.userPan;
    if (this.lfoTarget === LfoTarget.pan) pan += lfoValue;

    if (periodic) {
      if (this.autoSweep) this.updateSweep(3);
      this.lfo.update(3);
      this.env.update(t, 3);
    }
    let veTarget = t.volumeRatio(this.env.db);
    if (this.lfoTarget === LfoTarget.volume) veTarget *= t.volumeRatio(SndTables.volumeMaxDB * this.lfo.value(t));

    const main = Math.min(Math.max(1 + this.mainSend, 0), 1);
    const l = t.panRatio(pan, this.panCurve), r = t.panRatio(-pan, this.panCurve);
    this.auxScale = main > 0 ? Math.min(Math.max(this.fxSendC, 0), 1) / main : 0;
    this.gainL = volume * veInit * main * l; this.gainR = volume * veInit * main * r;
    this.nextL = volume * veTarget * main * l; this.nextR = volume * veTarget * main * r;
  }

  /** Mix `n` output samples at `outRate` into the stereo buffers (linear gain ramp, 4-point interpolation). */
  mix(L, R, AL, AR, n, outRate) {
    if (!this.active) return;
    const w = this.wave;
    const step = this.pitchRatio * w.sampleRate / outRate;
    const ch0 = w.channels[0], ch1 = w.channels.length > 1 ? w.channels[1] : ch0;
    const end = w.loopEnd, loop = w.loop, loopStart = w.loopStart;
    const stereo = w.channels.length > 1;
    const s = (c, k) => {
      let j = k;
      if (j >= end) j = loop ? loopStart + (j - end) : end - 1;
      return c[Math.max(0, Math.min(j, c.length - 1))];
    };
    const interp = (c, ip, fr) => {
      const a = s(c, ip - 1), b = s(c, ip), cc = s(c, ip + 1), d = s(c, ip + 2);
      // Catmull-Rom (AX uses a 4-tap polyphase SRC; this is the closest simple equivalent)
      return b + 0.5 * fr * (cc - a + fr * (2 * a - 5 * b + 4 * cc - d + fr * (3 * (b - cc) + d - a)));
    };
    const gL0 = this.gainL, gR0 = this.gainR, dL = this.nextL - gL0, dR = this.nextR - gR0, aux = this.auxScale;
    for (let i = 0; i < n; i++) {
      if (Math.trunc(this.pos) >= end) {
        if (loop && end > loopStart) this.pos -= end - loopStart; else { this.stop(); return; }
      }
      const f = i / n;
      const gl = gL0 + dL * f, gr = gR0 + dR * f;
      const ip = Math.trunc(this.pos), fr = this.pos - ip;
      const vl = interp(ch0, ip, fr), vr = stereo ? interp(ch1, ip, fr) : vl;
      L[i] += vl * gl; R[i] += vr * gr;
      if (aux > 0) { AL[i] += vl * gl * aux; AR[i] += vr * gr * aux; }
      this.pos += step;
    }
  }
}
