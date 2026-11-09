// Port of Sources/NW4R/Snd/FxReverbHi.swift — AUX-bus reverb modelled on AXFX ReverbHi (nw4r::snd::FxReverbHi),
// driven by the channel's own parameter block (main.dol 0x8018F798). Structure follows AXFX's: per-channel
// pre-delay → 3 damped feedback combs → 2 allpasses, with left/right crosstalk. APPROXIMATION (as in Swift):
// AXFX's exact delay lengths/coefficients are not yet decompiled.

class Line {
  constructor(n) { this.buf = new Float32Array(Math.max(n, 1)); this.i = 0; }
  read() { return this.buf[this.i]; }
  write(v) { this.buf[this.i] = v; if (++this.i === this.buf.length) this.i = 0; }
}
class Comb {
  constructor(n, g, damp) { this.line = new Line(n); this.g = g; this.damp = damp; this.lp = 0; }
  process(x) {
    const y = this.line.read();
    this.lp = y + this.damp * (this.lp - y);
    this.line.write(x + this.lp * this.g);
    return y;
  }
}
class AllPass {
  constructor(n, g) { this.line = new Line(n); this.g = g; }
  process(x) {
    const d = this.line.read(), v = x + this.g * d;
    this.line.write(v);
    return d - this.g * v;
  }
}

export class FxReverbHi {
  constructor(rate, param = {}) {
    const p = { preDelay: 0.1, time: 2.1, coloration: 0.6, damping: 0.4, crosstalk: 0.1, outGain: 0.2, ...param };
    this.p = p;
    const n = (ms) => Math.trunc(ms / 1000 * rate);
    this.pre = [new Line(n(p.preDelay * 1000)), new Line(n(p.preDelay * 1000) + 7)];
    // Mutually prime comb lengths (ms), offset per channel for stereo decorrelation.
    const combMs = [[35.3, 40.6, 44.9], [36.1, 41.3, 45.7]];
    this.combs = combMs.map((ms) => ms.map((d) => new Comb(n(d), Math.pow(10, -3 * d / 1000 / Math.max(p.time, 0.01)), p.damping)));
    const apMs = [[5.0, 1.7], [5.3, 1.9]];
    this.aps = apMs.map((ms) => ms.map((d) => new AllPass(n(d), p.coloration)));
  }

  /** In-place: AUX buffers in → wet signal out. */
  process(L, R) {
    const x = this.p.crosstalk, g = this.p.outGain;
    for (let i = 0; i < L.length; i++) {
      const inL = L[i] * (1 - x) + R[i] * x, inR = R[i] * (1 - x) + L[i] * x;
      for (let c = 0; c < 2; c++) {
        const pre = this.pre[c];
        const d = pre.read(); pre.write(c === 0 ? inL : inR);
        let s = 0;
        for (const comb of this.combs[c]) s += comb.process(d);
        s /= 3;
        for (const ap of this.aps[c]) s = ap.process(s);
        if (c === 0) L[i] = s * g; else R[i] = s * g;
      }
    }
  }
}
