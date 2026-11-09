import * as M from './GlobeMath.js';
import { GlobeCamera } from './GlobeCamera.js';
import { WPAD, has } from '../ui/bridge.js';

/**
 * CSimpleGlobe (0xD0 bytes, "m_pSimpleGlobe", global lbl_80330BEC). Port of fn_8003F628..fn_800411B4.
 * Owns the globe camera and drives zoom, tilt, grab/inertia and the per-frame emboss material tweaks.
 */
export class SimpleGlobe {
    // Tables from .rodata
    static kZoomDist = [1, 2, 5, 8, 12, 17, 25, 40, 65, 100];                      // lbl_8018F730
    static kFriction = [0.85, 0.90, 0.95, 0.97, 0.98, 0.98, 0.98, 0.98, 0.98, 0.98]; // lbl_8018F770
    static kTilt = [0, 45, 55, 65, 73, 80];                                          // lbl_8018F758
    static kResetOrient = [0, 0, 0];                                                 // lbl_801D7264
    static kZoomSE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];                               // lbl_801793A0
    static kTiltSE = [12, 13, 14, 15, 16, 17];                                       // lbl_801793C8

    /** fn_8003F628 */
    constructor(isWide) {
        this.camera = new GlobeCamera(isWide);   // 0x04
        this.homeLatLon = [0, 0, 0];             // 0x08
        this.northPole = [0, 3, 0];              // 0x14
        this.southPole = [0, -3, 0];             // 0x20
        this.grabStartAngles = [0, 0];           // 0x2C (single channel)
        this.grabStartPointer = [0, 0];          // 0x4C
        this.velLat = 0; this.velLon = 0;        // 0x6C, 0x70
        this.northPoleScreen = [0, 0]; this.southPoleScreen = [0, 0];   // 0x7C, 0x84
        this.grabbing = false;                   // 0x8C
        this.inertiaActive = false;              // 0x90
        this.reqZoomOut = false; this.reqZoomIn = false; this.reqTiltUp = false; this.reqTiltDown = false; // 0x91..0x94
        this.levelLatitude = false;              // 0x95
        this.nPoleBehindView = false; this.nPoleFacing = false; this.sPoleBehindView = false; this.sPoleFacing = false; // 0x96..0x99
        this.nPoleBehindCam = false; this.sPoleBehindCam = false;   // 0x9A, 0x9B
        this.zoomIdx = 0;                        // 0x9C
        this.tiltIdx = 0;                        // 0xA0
        this.grabStartTwist = 0;                 // 0xA4
        this.distCur = 0; this.distTarget = 0;   // 0xB4, 0xB8
        this.pitchCur = 0; this.pitchTarget = 0; // 0xBC, 0xC0
        this.grabStartHeading = 0;               // 0xC4
        this.dist = 0;                           // 0xC8
        this.lonDragSign = 1;                    // 0xCC
        /** Camera 1 ("light" camera used as the emboss env-map source) — computed in UpdateMaterials. */
        this.camera1View = M.identity();
        /** LightObj 0 (headlight) — UpdateLight. */
        this.lightPos = [0, 0, 0]; this.lightDir = [0, 0, -1];
        /** Hook for SE playback. */
        this.playSE = () => {};
    }

    /** fn_8003F888 Reset(latLon, zoomIdx) */
    reset(latLon, zoomIdx) {
        this.reqZoomOut = false; this.reqZoomIn = false; this.reqTiltUp = false; this.reqTiltDown = false;
        this.grabbing = false; this.inertiaActive = false; this.velLat = 0; this.velLon = 0;
        this.homeLatLon = latLon;
        this.zoomIdx = zoomIdx;
        this.distCur = SimpleGlobe.kZoomDist[zoomIdx]; this.distTarget = this.distCur; this.camera.dist = this.distCur;
        this.camera.initialize(this.homeLatLon);
    }

    /** fn_8003FA7C Init(latLon) — entering the globe screen. */
    initialize(latLon) { this.reset(latLon, this.zoomIdx); }

    /** fn_80041074 */
    setZoomIndex(i) { this.zoomIdx = i; this.distTarget = SimpleGlobe.kZoomDist[i]; }
    /** fn_800402A4 */
    syncDist() { this.dist = this.camera.dist; }
    /** fn_80040B08 */
    setTiltIndexImmediate(i) {
        this.tiltIdx = i; this.pitchTarget = SimpleGlobe.kTilt[i]; this.pitchCur = this.pitchTarget;
        this.camera.pitch = this.pitchTarget; this.camera.orienting = false;
    }
    /** fn_80040A48 */
    setTiltIndex(i, level) {
        if (this.zoomIdx >= 8) this.levelLatitude = level;
        this.tiltIdx = i; this.pitchTarget = SimpleGlobe.kTilt[i];
        this.camera.startOrient(SimpleGlobe.kResetOrient);
    }
    /** fn_80040A78 */
    canReset() {
        return this.zoomIdx >= 8
            ? !(Math.abs(this.camera.lat) < 0.0008 && this.camera.isAtOrient(SimpleGlobe.kResetOrient))
            : !this.camera.isAtOrient(SimpleGlobe.kResetOrient);
    }

    /** fn_8003FD7C CalcCamera (`materials`: the earth model's ResMat list, edited in place). */
    calcCamera(materials) {
        this.updateMaterials(materials);
        this.camera.calc();
    }

    /** fn_8003FDBC CalcPoles */
    calcPoles() {
        const cam = this.camera, lookN = M.v3norm(cam.look);
        const flags = (pole) => {
            const toPole = M.v3norm(M.v3sub(pole, cam.eye));
            return [M.v3dot(M.v3norm(pole), lookN) < 0, M.v3dot(M.v3norm(pole), toPole) < 0, M.v3dot(lookN, toPole) < 0];
        };
        [this.nPoleBehindView, this.nPoleFacing, this.nPoleBehindCam] = flags(this.northPole);
        [this.sPoleBehindView, this.sPoleFacing, this.sPoleBehindCam] = flags(this.southPole);
        this.northPoleScreen = cam.project(this.northPole);
        this.southPoleScreen = cam.project(this.southPole);
    }

    /** fn_8004006C UpdateLight — white headlight at the eye. */
    updateLight() { this.lightPos = this.camera.eye; this.lightDir = this.camera.look; }

    /** fn_80040190 UpdateZoom */
    updateZoom() {
        const old = this.zoomIdx;
        if (this.reqZoomOut) this.zoomIdx = Math.min(this.zoomIdx + 1, 9); else if (this.reqZoomIn) this.zoomIdx = Math.max(this.zoomIdx - 1, 0);
        if (this.reqZoomOut || this.reqZoomIn) {
            this.distTarget = SimpleGlobe.kZoomDist[this.zoomIdx];
            if (this.zoomIdx !== old) this.playSE(SimpleGlobe.kZoomSE[this.zoomIdx]);
        }
        this.distCur = this.camera.dist;
        [this.distCur] = M.chaseValue(this.distCur, this.distTarget, 0.1, 100.0, 0.001);
        this.camera.dist = this.distCur;
        this.dist = this.camera.dist;
    }

    /** fn_80040B3C UpdateTilt */
    updateTilt() {
        let moving = this.camera.updateOrient(SimpleGlobe.kResetOrient);
        const old = this.tiltIdx;
        if (this.reqTiltUp || this.reqTiltDown) {
            this.tiltIdx = this.reqTiltUp ? Math.min(this.tiltIdx + 1, 5) : Math.max(this.tiltIdx - 1, 0);
            moving = true; this.pitchTarget = SimpleGlobe.kTilt[this.tiltIdx]; this.camera.orienting = false;
            if (this.tiltIdx !== old) this.playSE(SimpleGlobe.kTiltSE[this.tiltIdx]);
        }
        if (!moving) {
            this.pitchCur = this.camera.pitch;
            [this.pitchCur] = M.chaseValue(this.pitchCur, this.pitchTarget, 0.1, 100, 0.001);
            this.camera.pitch = this.pitchCur;
        }
        if (this.levelLatitude) {
            if (Math.abs(this.camera.lat) < 0.0008) { this.levelLatitude = false; this.camera.lat = 0; }
            else {
                let rem;
                [this.camera.lat, rem] = M.chaseValue(this.camera.lat, 0, 0.1, 100, 0.001);
                if (rem === 0) this.levelLatitude = false;
            }
        }
    }

    /** fn_800402BC TryBeginGrab */
    tryBeginGrab(pad) {
        if (!has(pad.trig, WPAD.a)) return false;
        this.grabbing = true; this.camera.orienting = false; this.levelLatitude = false; this.inertiaActive = false;
        this.grabStartAngles = [this.camera.lat, this.camera.lon];
        this.grabStartPointer = [pad.pointer[0], pad.pointer[1]];
        this.grabStartHeading = this.camera.twist;
        this.grabStartTwist = pad.twist;
        this.lonDragSign = 1;
        if (this.nPoleFacing && !this.nPoleBehindCam) { if (this.grabStartPointer[1] < this.northPoleScreen[1]) this.lonDragSign = -1; }
        else if (this.sPoleFacing && !this.sPoleBehindCam) { if (this.grabStartPointer[1] > this.southPoleScreen[1]) this.lonDragSign = -1; }
        return true;
    }

    /** fn_800405E4 UpdateGrab → 'idle' | 'dragging' | 'released' */
    updateGrab(pad) {
        const s = 0.5 * (0.01 * this.dist);
        if (!this.grabbing) return 'idle';
        if (!has(pad.hold, WPAD.a)) { this.grabbing = false; this.inertiaActive = true; return 'released'; }
        const cam = this.camera;
        const dTwist = pad.twist - this.grabStartTwist;
        let heading;
        if (Math.abs(dTwist) > 30) {
            heading = M.wrap360(dTwist + this.grabStartHeading);
            cam.orienting = false; this.velLat = 0; this.velLon = 0;
        } else {
            heading = this.grabStartHeading;
            const prevLat = cam.lat, prevLon = cam.lon;
            let v = [s * (pad.pointer[1] - this.grabStartPointer[1]), s * (pad.pointer[0] - this.grabStartPointer[0]), 0];
            if (Math.abs(cam.twist) < 0.0008) v[1] *= this.lonDragSign;
            const r = M.mulVec4(M.rot('z', cam.twist), [v[0], v[1], v[2], 0]);
            v = [r[0], r[1], r[2]];
            cam.lat = Math.min(Math.max(this.grabStartAngles[0] + v[0], -89), 89);
            cam.lon = M.wrap180(this.grabStartAngles[1] - v[1]);
            this.velLat = cam.lat - prevLat;
            this.velLon = M.wrap180(cam.lon - prevLon);
        }
        cam.twist = M.chaseAngle(cam.twist, heading, 0.1, 180, 1.0);
        return 'dragging';
    }

    /** fn_80040D48 UpdateInertia */
    updateInertia(stop) {
        if (stop) this.inertiaActive = false;
        if (!this.inertiaActive) return;
        const cam = this.camera;
        cam.lat += this.velLat;
        if (cam.lat > 89 || cam.lat < -89) { cam.lat = Math.min(Math.max(cam.lat, -89), 89); this.velLat = 0; }
        cam.lon = M.wrap180(cam.lon + this.velLon);
        const f = SimpleGlobe.kFriction[this.zoomIdx];
        const dLon = this.velLon * (1 - f);
        this.velLon -= dLon;
        if (Math.abs(this.velLon) < 0.0008) this.velLon = 0;
        if (Math.abs(dLon) < 0.05) {
            this.velLat *= f;
            if (Math.abs(this.velLat) < 0.0008) this.velLat = 0;
        } else if (Math.abs(this.velLat) >= 0.0008) {
            const step = Math.min(Math.abs(dLon), Math.abs(this.velLat));
            this.velLat -= this.velLat < 0 ? -step : step;
        }
        if (Math.sqrt(this.velLat * this.velLat + this.velLon * this.velLon) < 0.001) { this.inertiaActive = false; this.velLat = 0; this.velLon = 0; }
    }

    /** fn_800411B4 UpdateMaterials — distance-driven emboss + camera-1 env-map source. */
    updateMaterials(mats) {
        const cam = this.camera;
        const d = this.distCur;
        const embossK = Math.min(M.clamp01((100 - d) / 35), M.clamp01((d - 2) / 15));
        const edgeK = M.clamp01((d - 40) / 20);
        const edgeScale = 0.85 + 0.15 * edgeK;
        const shadeK = M.clamp01((d - 2) / 15);
        // GXSetIndTexMatrix-style mantissa/exponent split (Float.exponent = floor(log2 x))
        let e = 0, m = embossK;
        if (embossK > 1e-18) { e = Math.floor(Math.log2(1 + embossK)); m = embossK * Math.pow(2, -e); }

        // Camera 1: the main camera shifted by (-¼, +¼)·dist.
        let Mx = M.trans(-0.75, 0.75, 3);
        Mx = M.preRot(Mx, 'x', -cam.lat); Mx = M.preRot(Mx, 'z', cam.surfaceRoll); Mx = M.preRot(Mx, 'y', cam.lon);
        const saved = Mx, t1 = M.translation(Mx);
        Mx = M.trans(-0.25 * cam.dist, 0.25 * cam.dist, cam.dist);
        Mx = M.preRot(Mx, 'x', cam.pitch); Mx = M.preRot(Mx, 'z', cam.twist); Mx = M.preRot(Mx, 'y', cam.yaw);
        Mx = M.mul(saved, Mx);
        const eye1 = M.translation(Mx);
        Mx[12] = 0; Mx[13] = 0; Mx[14] = 0; Mx[15] = 1;
        const up1 = M.multVec(Mx, [0, 1, 0]);
        this.camera1View = GlobeCamera.lookAt(eye1, up1, t1);

        if (!mats) return;
        for (const mat of mats) {
            if (mat.name === 'luminous_mat') continue;
            mat.gx.konst[0][3] = Math.trunc(77 * shadeK) & 0xFF;
            const fx = mat.effects[1]; fx.mapMode = 1; fx.camera = 1; fx.light = -1;
            mat.srt[3].scale = [edgeScale, edgeScale];
            mat.gx.setIndMatrix(0, [m, 0, 0], [0, m, 0], e);
        }
    }
}
