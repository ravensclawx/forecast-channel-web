import { SimpleGlobe } from './SimpleGlobe.js';
import { G3DRenderer } from '../render/G3DRenderer.js';
import { StarField } from './StarField.js';
import { LogicalScreen } from '../render/LogicalScreen.js';
import { KPad, WPAD, has } from '../system/KPad.js';
import { CursorState } from '../ui/Cursor.js';

/**
 * The globe ("around") screen's per-frame flow: fn_800186F0 (interactive state) → fn_8001A758 (zoom/grab/tilt)
 * → fn_80018BE0 (CalcCamera, CalcPoles, city markers, UpdateLight, CalcScene) → Draw.
 */
export class GlobeScene {
    /** Default home location in CCityMarker (0x29C/0x2A0): 34.8, 135.4. */
    static defaultHome = [34.8, 135.4, 0];

    /** @param gx GXWebGL  @param assets Assets */
    constructor(gx, assets, isWide = true, sound = null, pad = new KPad()) {
        this.sound = sound; this.pad = pad;
        this.resetRequested = false;
        /** Cursor state per fn_800186F0: grabbing → hold, pointer outside 63<y<393 → arrow (normal), else open hand. */
        this.cursorState = CursorState.normal;
        const file = assets.earthBRRES();
        this.earth = new G3DRenderer(gx, file, 'earth');
        /** CAround +0x30C: the star field drawn behind the earth (fn_8002EFB8). */
        try { this.stars = new StarField(gx, assets); } catch (_) { this.stars = null; }
        this.globe = new SimpleGlobe(isWide);
        this.globe.playSE = (id) => sound?.playSE(id);
        this.globe.setZoomIndex(0);
        this.globe.initialize(GlobeScene.defaultHome);
    }

    /** One 60 Hz frame of game logic (stand-alone globe; CAround drives the globe itself). */
    step(sample) {
        const pad = this.pad, globe = this.globe;
        pad.update(sample);
        // fn_800186F0: request flags from (layout buttons |) hardware buttons
        globe.reqZoomOut = has(pad.trig, WPAD.minus);
        globe.reqZoomIn = has(pad.trig, WPAD.plus);
        globe.reqTiltUp = has(pad.trig, WPAD.up);
        globe.reqTiltDown = has(pad.trig, WPAD.down);
        if (this.resetRequested) { this.resetRequested = false; if (!globe.camera.orienting) { globe.playSE(0x13); globe.setTiltIndex(0, true); } }
        globe.updateInertia(false);
        // fn_8001A758 zoom state: UpdateZoom, SyncDist, grab loop (fn_8001AA70), UpdateTilt
        globe.updateZoom();
        globe.syncDist();
        const y = pad.pointer[1];
        if (pad.pointerValid && !pad.isTap && y > 63 && y < 393 && globe.tryBeginGrab(pad)) globe.playSE(0x15);
        if (globe.updateGrab(pad) === 'released') {
            this.sound?.updateRotateSound?.(Math.sqrt(globe.velLat * globe.velLat + globe.velLon * globe.velLon));   // fn_800410A4(0x14)
        }
        globe.updateTilt();
        this.cursorState = globe.grabbing ? CursorState.hold : (pad.pointerValid && y > 63 && y < 393 ? CursorState.open : CursorState.normal);
        // fn_80018BE0
        globe.calcCamera(this.earth.materials);
        globe.calcPoles();
        globe.updateLight();
    }

    /** fn_8003FC10 Draw (scnRoot DrawOpa + DrawXlu). */
    draw(enc) {
        // GlobeScreen_Draw: fn_8002EFB8 (stars) first, then SimpleGlobe_DrawEarth.
        const cam = this.globe.camera;
        if (this.stars) {
            if (LogicalScreen.isPortrait) {
                // keep the Wii's horizontal field of view (608 wide), extend vertically
                const aspect = 608 / LogicalScreen.height;
                const tanHalfX = Math.tan(20 * Math.PI / 180) * (608.0 / 456.0);
                this.stars.draw(enc, cam.viewMtx, aspect, 2 * Math.atan(tanHalfX / aspect) * 180 / Math.PI);
            } else {
                this.stars.draw(enc, cam.viewMtx, cam.screenWidth / 456, 40);
            }
        }
        const scene = G3DRenderer.Scene();
        scene.view = cam.viewMtx;
        scene.projection = cam.projMtx;
        scene.lightDirWorld = this.globe.lightDir;
        scene.lightPosWorld = this.globe.lightPos;
        // TexMtx.calcEnv reads the reference cameras as a Map<index, view> (G3DRenderer.Scene() defaults to {}).
        scene.cameras = new Map([[0, cam.viewMtx], [1, this.globe.camera1View]]);
        this.earth.draw(enc, scene);
    }
}
