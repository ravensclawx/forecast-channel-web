// Port of Sources/Forecast/Render/PortraitSlots.swift — shared portrait arrangement: where the original rows go on
// the tall screen, in layout space (origin = screen centre, y up — the brlyt convention).
import { LogicalScreen } from './LogicalScreen.js';

export const PortraitSlots = {
  get H() { return LogicalScreen.height; },
  get half() { return this.H / 2; },
  /** Layout-space y of the top edge / bottom edge of the usable (safe) area. */
  get safeTopY() { return this.half - LogicalScreen.safeTop; },
  get safeBottomY() { return -this.half + LogicalScreen.safeBottom; },
  /** The original button rows are 66 tall, centred at ±195 on the 456 screen. */
  rowHeight: 66,
  /** Offset that moves something authored at the original top row (y = +195) to the portrait top row. */
  get topRowShift() { return (this.safeTopY - this.rowHeight / 2) - 195; },
  /** Offset that moves the original bottom row (y = −195) to the portrait bottom row. */
  get bottomRowShift() { return (this.safeBottomY + this.rowHeight / 2) - (-195); },
  topShift(_y = 0) { return this.topRowShift; },
  bottomShift(_y = 0) { return this.bottomRowShift; },
  /** Scale for a full-screen 608×456 background pane to cover the whole tall screen. */
  get backgroundScaleY() { return this.H / 456; },
  /** Layout y ↔ SetOrtho2D pixel y. */
  pixelY(layoutY) { return this.half - layoutY; },
  /** 2D sprites authored in the 456-high SetOrtho2D space: where an original pixel y lands (centre / top / bottom). */
  pixelCentre(y) { return y + (this.H - 456) / 2; },
  pixelTop(y) { return this.pixelCentre(y) - this.topRowShift; },
  pixelBottom(y) { return this.pixelCentre(y) - this.bottomRowShift; },
};
