// Port of Sources/Forecast/System/KPad.swift — Wii Remote button bits + the channel's input update (fn_8002F9CC).

/** Wii Remote button bits (WPAD_BUTTON_*). WPAD sets are plain numbers: `held & WPAD.a`, `held | WPAD.b`. */
export const WPAD = Object.freeze({
  none: 0,
  left: 0x0001, right: 0x0002, down: 0x0004, up: 0x0008,
  plus: 0x0010, two: 0x0100, one: 0x0200,
  b: 0x0400, a: 0x0800, minus: 0x1000, home: 0x8000,
});
/** OptionSet helpers: has(set, bit) ≙ set.contains(bit). */
export const has = (set, bits) => (set & bits) === bits && bits !== 0;

/** Raw controller sample supplied by the shell each frame. position: [x, y] logical px, y down. */
export class PointerSample {
  constructor(position = [0, 0], valid = false, held = 0, twistDegrees = 0) {
    this.position = position;
    this.valid = valid;
    this.held = held;
    this.twistDegrees = twistDegrees;
    /** Touch: this A press is a tap (not a held drag) — the globe must not start a grab for it. */
    this.tap = false;
  }
}

/** KPADRead → hold/trig/release + smoothed pointer. */
export class KPad {
  constructor() {
    this.hold = 0; this.trig = 0; this.release = 0;
    this.pointer = [304, 228];          // lbl_801D9730 / lbl_801D9740
    this.pointerValid = false;
    this.twist = 0;
    this.isTap = false;
    /** Touch: the finger position is exact — no IR-jitter smoothing. */
    this.smoothPointer = true;
  }

  /** @param {PointerSample} s */
  update(s) {
    this.trig = s.held & ~this.hold;
    this.release = this.hold & ~s.held;
    this.hold = s.held;
    this.twist = s.twistDegrees;
    this.isTap = s.tap;
    this.pointerValid = s.valid;
    if (!s.valid) return;
    if (!this.smoothPointer) { this.pointer = [s.position[0], s.position[1]]; return; }
    // a = clamp(0.002·|raw − smoothed|, 0.1, 1); smoothed = (1−a)·smoothed + a·raw, per axis
    const p = this.pointer.slice();
    for (let i = 0; i < 2; i++) {
      const a = Math.min(Math.max(0.002 * Math.abs(s.position[i] - p[i]), 0.1), 1);
      p[i] = Math.fround((1 - a) * p[i] + a * s.position[i]);
    }
    this.pointer = p;
  }
}
