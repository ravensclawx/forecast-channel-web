// AudioWorklet for SoundManager: plays the 32 kHz stereo blocks the NW4R engine renders on the main thread.
// If the AudioContext runs at another rate (it could not be created at 32 kHz), blocks are linearly resampled.
class FCSoundProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.queue = [];
    this.cur = null;
    this.pos = 0;
    const src = options?.processorOptions?.sourceRate ?? 32000;
    this.ratio = src / sampleRate;   // `sampleRate` is the AudioWorkletGlobalScope's context rate
    this.port.onmessage = (e) => { this.queue.push(e.data); if (this.queue.length > 64) this.queue.splice(0, this.queue.length - 64); };
  }
  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0];
    const ratio = this.ratio;
    for (let i = 0; i < L.length; i++) {
      if (!this.cur || this.pos >= this.cur.l.length) {
        if (this.cur) this.pos -= this.cur.l.length;
        this.cur = this.queue.shift() ?? null;
        if (!this.cur) { this.pos = 0; for (let k = i; k < L.length; k++) { L[k] = 0; R[k] = 0; } return true; }
      }
      const c = this.cur, k = this.pos | 0, f = this.pos - k;
      if (ratio === 1) { L[i] = c.l[k]; R[i] = c.r[k]; }
      else {
        const k1 = k + 1 < c.l.length ? k + 1 : k;
        L[i] = c.l[k] + (c.l[k1] - c.l[k]) * f; R[i] = c.r[k] + (c.r[k1] - c.r[k]) * f;
      }
      this.pos += ratio;
    }
    return true;
  }
}
registerProcessor('fc-sound', FCSoundProcessor);
