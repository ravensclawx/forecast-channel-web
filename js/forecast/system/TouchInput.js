// Port of Sources/Forecast/System/TouchInput.swift — touch → Wii Remote translation (mobile mode, no cursor).
// One finger is the pointer; `.pressOnRelease` (buttons, lists) or `.grab` (globe). Two fingers feed Gestures.
// main.js feeds it from Pointer Events (pointerId → id), positions in logical px (0..608 × 0..LogicalScreen.height).
import { PointerSample, WPAD } from './KPad.js';

export const TouchMode = Object.freeze({ pressOnRelease: 'pressOnRelease', grab: 'grab' });

export class Gestures {
  constructor() {
    /** Pinch scale ratio accumulated this frame (1 = none, >1 fingers apart). */
    this.pinch = 1;
    /** Two-finger vertical travel this frame, logical units (positive = fingers moved down). */
    this.panY = 0;
    /** Two-finger rotation this frame, degrees (positive = clockwise). */
    this.rotation = 0;
    /** One-finger vertical travel this frame (lists scroll with this), logical units (positive = down). */
    this.dragY = 0;
    this.fingers = 0;
  }
}

const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class TouchInput {
  constructor() {
    this.tapSlop = 18;
    this.grabSlop = 14;
    this.gestures = new Gestures();
    this.pending = new Gestures();
    this.fingers = new Map();    // id → [x, y]
    this.primary = null;
    this.startPos = [0, 0];
    this.lastPos = [0, 0];
    this.travelled = 0;
    this.releaseAt = null;
    this.releaseWasTap = false;
    this.multi = false;
    this.mode = TouchMode.pressOnRelease;
    this.twoFingerRef = null;
    this.panning = false;
  }

  /** `modeAt(p)` asks the scene what kind of touch starts at this point (globe body → TouchMode.grab). */
  began(id, p, modeAt) {
    this.fingers.set(id, p);
    if (this.fingers.size === 1) {
      this.primary = id; this.startPos = p; this.lastPos = p; this.travelled = 0; this.multi = false;
      this.mode = modeAt ? modeAt(p) : TouchMode.pressOnRelease; this.panning = false;
    } else {
      this.multi = true;
      this.twoFingerRef = this.twoFingerState();
    }
  }

  moved(id, p) {
    if (!this.fingers.has(id)) return;
    this.fingers.set(id, p);
    const ref = this.twoFingerRef, now = this.multi && this.fingers.size >= 2 ? this.twoFingerState() : null;
    if (this.multi && this.fingers.size >= 2 && ref && now) {
      if (ref.dist > 1) this.pending.pinch *= now.dist / ref.dist;
      this.pending.panY += now.midY - ref.midY;
      let da = now.angle - ref.angle;
      if (da > 180) da -= 360; else if (da < -180) da += 360;
      this.pending.rotation += da;
      this.twoFingerRef = now;
    } else if (id === this.primary) {
      this.pending.dragY += p[1] - this.lastPos[1];
      this.travelled = Math.max(this.travelled, len(p, this.startPos));
      this.lastPos = p;
    }
  }

  ended(id, cancelled = false) {
    if (!this.fingers.has(id)) return;
    const p = this.fingers.get(id);
    this.fingers.delete(id);
    if (id === this.primary) {
      if (!this.multi && !cancelled) { this.releaseAt = p; this.releaseWasTap = this.travelled <= this.tapSlop; }
      this.primary = null;
    }
    this.twoFingerRef = this.fingers.size >= 2 ? this.twoFingerState() : null;
    if (this.fingers.size === 0) this.multi = false;
  }

  twoFingerState() {
    const pts = [...this.fingers.entries()].sort((a, b) => a[0] - b[0]).slice(0, 2).map(e => e[1]);
    if (pts.length !== 2) return null;
    const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
    return { dist: Math.hypot(dx, dy), midY: (pts[0][1] + pts[1][1]) / 2, angle: Math.atan2(dy, dx) * 180 / Math.PI };
  }

  /** The Wii Remote sample for this frame (fed to KPad.update) and the gestures for the screens. */
  sample() {
    this.gestures = this.pending; this.gestures.fingers = this.fingers.size;
    this.pending = new Gestures();
    if (this.releaseAt) {
      const r = this.releaseAt;
      this.releaseAt = null;
      if (this.mode === TouchMode.pressOnRelease) {
        // A tap: hover + A on this frame at the lift point. A drag only releases the hover.
        return new PointerSample(r, true, this.releaseWasTap ? WPAD.a : 0);
      }
      // grab: never panned → a tap (one-frame A at the start point, flagged); panned → A released.
      if (!this.panning) { const t = new PointerSample(this.startPos, true, WPAD.a); t.tap = true; return t; }
      this.panning = false;
      return new PointerSample(r, true, 0);
    }
    const p = this.primary !== null ? this.fingers.get(this.primary) : null;
    if (this.multi || !p) return new PointerSample(this.lastPos, false, 0);
    if (this.mode === TouchMode.pressOnRelease) return new PointerSample(p, true, 0);
    // grab: A is held only once the finger really pans; a resting/wobbly finger is just a pointer.
    if (this.travelled > this.grabSlop) this.panning = true;
    return new PointerSample(this.panning ? p : this.startPos, true, this.panning ? WPAD.a : 0);
  }
}
