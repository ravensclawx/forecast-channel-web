// Port of Sources/Forecast/Render/LogicalScreen.swift — the logical 2D screen every layout/sprite/projection is
// expressed in. Wii: 608 (4:3) or 832 (16:9) × 456. Mobile web (portrait): 608 × 1322. Mutable module state
// (Swift static vars): set once by main.js before the scene is created.
export const LogicalScreen = {
  /** Height in logical units (456 on the Wii). */
  height: 456,
  get halfHeight() { return this.height / 2; },
  /** Portrait (phone) presentation: screens use their portrait arrangements. */
  isPortrait: false,
  /** Safe-area insets in logical units (0 on the web: the page is letterboxed). */
  safeTop: 0,
  safeBottom: 0,
};
