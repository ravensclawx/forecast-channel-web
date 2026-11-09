import * as M from './GlobeMath.js';
import * as LS from '../render/LogicalScreen.js';

const logical = () => LS.LogicalScreen ?? { height: 1322, isPortrait: true };

/** CGlobeCamera (0xEC bytes, vtable lbl_8019B750) — wraps g3d camera 0. Port of fn_8002B734..fn_8002BEF4. */
export class GlobeCamera {
    // Logical screen (the channel renders to a 608x456 EFB; 832x456 logical in widescreen).
    static get screenHeight() { return logical().height; }
    get screenWidth() { return this.isWide ? 832 : 608; }

    /** fn_8002B734 */
    constructor(isWide) {
        this.isWide = isWide;
        this.up = [0, 1, 0];          // 0x78
        this.target = [0, 0, 0];      // 0x84
        this.lat = 0;                 // 0x90
        this.lon = 0;                 // 0x94
        this.surfaceRoll = 0;         // 0x98
        this.pitch = 0;               // 0x9C
        this.yaw = 0;                 // 0xA0
        this.twist = 0;               // 0xA4
        this.eye = [0, 0, 0];         // 0xA8
        this.look = [0, 0, 0];        // 0xB4
        this.orienting = false;       // 0xC0
        this.fovy = 5.0;              // 0xC4
        this.near = 0.1; this.far = 200.0;
        this.dist = 100.0;            // 0xD4
        this.viewMtx = M.identity();
        this.projMtx = M.identity();
        this.aspect = (isWide ? 832 : 608) / 456;   // 0xC8
        if (logical().isPortrait) {
            // Portrait: keep the original 4:3 horizontal field of view (608 logical px wide, same pixel scale as the
            // Wii) and extend vertically — fovy grows with the taller screen.
            const h = logical().height;
            this.aspect = 608 / h;
            const tanHalfX = Math.tan(2.5 * Math.PI / 180) * (608.0 / 456.0);
            this.fovy = 2 * Math.atan(tanHalfX / this.aspect) * 180 / Math.PI;
        }
    }

    /** fn_8002B8D4 Init(latLonRoll) */
    initialize(latLonRoll) {
        this.projMtx = GlobeCamera.perspective(this.fovy, this.aspect, this.near, this.far);
        if (latLonRoll) { this.lat = latLonRoll[0]; this.lon = latLonRoll[1]; this.surfaceRoll = latLonRoll[2]; }
    }

    /** fn_8002B9B0 Calc */
    calc() {
        let m = M.trans(0, 0, 3);
        m = M.preRot(m, 'x', -this.lat); m = M.preRot(m, 'z', this.surfaceRoll); m = M.preRot(m, 'y', this.lon);
        this.target = M.translation(m);
        const saved = m;
        m = M.trans(0, 0, this.dist);
        m = M.preRot(m, 'x', this.pitch); m = M.preRot(m, 'z', this.twist); m = M.preRot(m, 'y', this.yaw);
        m = M.mul(saved, m);
        this.eye = M.translation(m);
        this.up = M.multVec(m, [0, 1, 0]);   // QUIRK preserved: translation included
        this.look = M.v3sub(this.target, this.eye);
        this.viewMtx = GlobeCamera.lookAt(this.eye, this.up, this.target);
    }

    /** fn_8002BC28 StartOrient / fn_8002BD70 UpdateOrient (targets = [pitch, yaw, twist]) */
    startOrient(t) { this.orienting = true; this._stepOrient(t); }
    updateOrient(t) { if (this.orienting) this._stepOrient(t); return this.orienting; }
    _stepOrient(t) {
        this.pitch = M.approachAngle(this.pitch, t[0]); this.yaw = M.approachAngle(this.yaw, t[1]); this.twist = M.approachAngle(this.twist, t[2]);
        if (this.pitch === t[0] && this.yaw === t[1] && this.twist === t[2]) this.orienting = false;
    }
    /** fn_8002BCC4 */
    isAtOrient(t) { return Math.abs(this.pitch - t[0]) < 0.0008 && Math.abs(this.yaw - t[1]) < 0.0008 && Math.abs(this.twist - t[2]) < 0.0008; }

    /** fn_8002BEF4 Project world → logical screen pixels (0..screenWidth, 0..height, y down). */
    project(world) {
        const clip = M.mulVec4(M.mul(this.projMtx, this.viewMtx), [world[0], world[1], world[2], 1]);
        const nx = clip[0] / clip[3], ny = clip[1] / clip[3];
        const halfW = this.screenWidth / 2, halfH = GlobeCamera.screenHeight / 2;
        return [halfW + halfW * nx, halfH - halfH * ny];
    }

    /** C_MTXLookAt (Revolution SDK): right-handed, camera looks down -Z. */
    static lookAt(eye, up, target) {
        const z = M.v3norm(M.v3sub(eye, target));
        const x = M.v3norm(M.v3cross(up, z));
        const y = M.v3cross(z, x);
        return M.fromRows([x[0], x[1], x[2], -M.v3dot(x, eye)], [y[0], y[1], y[2], -M.v3dot(y, eye)],
                          [z[0], z[1], z[2], -M.v3dot(z, eye)], [0, 0, 0, 1]);
    }

    /** C_MTXPerspective, clip-z [0, 1] as in the Swift port (GXWebGL accepts the Metal-style projections unchanged). */
    static perspective(fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy * M.deg / 2);
        return M.fromRows([f / aspect, 0, 0, 0], [0, f, 0, 0],
                          [0, 0, far / (near - far), near * far / (near - far)], [0, 0, -1, 0]);
    }
}
