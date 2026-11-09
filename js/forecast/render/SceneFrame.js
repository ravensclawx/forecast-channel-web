// The off-screen part of WeatherScene.render (Sources/Forecast/Scene/WeatherScene.swift: ensureTargets /
// sceneColor / sceneDepth / capture / render). WeatherScene draws the whole scene into `scene`, optionally copies
// it into `capture` (System_Frame transitions 2–4), then composites onto the canvas (d2.texture + drawTransition).
//
//   const f = new SceneFrame(gx);
//   f.ensure(w, h);                          // drawable size in device pixels (MTLViewport width/height)
//   const enc = f.beginScene();              // cleared black + depth; viewport = whole target
//   ... drawScene(enc) ...
//   if (pendingCapture) f.capture();         // blit.copy(from: color, to: cap)
//   const out = f.beginPresent(viewport);    // canvas pass (load), viewport {originX, originY, width, height}
//   d2.texture(f.frameTexture, 0, 0, W, H, [0,0,1,1], 255, out); drawTransition(out)
import { GXEncoder } from './GXWebGL.js';

export class SceneFrame {
    constructor(gx) { this.gx = gx; this.scene = null; this.captureTarget = null; }

    ensure(w, h) {
        w = Math.max(1, w | 0); h = Math.max(1, h | 0);
        if (this.scene && this.scene.width === w && this.scene.height === h) return;
        this.scene?.dispose(); this.captureTarget?.dispose();
        this.scene = this.gx.createRenderTarget(w, h, true);
        this.captureTarget = this.gx.createRenderTarget(w, h, false);
    }
    /** sceneColor (the HOME-Menu-style frame texture). */
    get frameTexture() { return this.scene ? this.scene.color : null; }
    /** The captured frame (System_Frame transitions). */
    get captureTexture() { return this.captureTarget ? this.captureTarget.color : null; }

    beginScene() { return this.gx.beginPass(this.scene, { clearColor: [0, 0, 0, 1], clearDepth: true }); }
    capture() { this.gx.copyTexture(this.scene, this.captureTarget); }
    /** Canvas pass without clearing (the shell clears the letterbox once per frame). */
    beginPresent(viewport) {
        const enc = this.gx.beginPass(null, { clearColor: null, clearDepth: true });
        enc.setViewport(viewport);
        return enc;
    }
}
export { GXEncoder };
