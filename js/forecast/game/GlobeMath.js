// Shared math helpers from main.dol game code (see decomp/notes/globe.md §2).
// Matrices follow the Revolution SDK "Mtx" convention (3x4, column vectors, M·v), stored here as column-major
// 4×4 Float32Arrays (m[col * 4 + row]) — the same layout as simd_float4x4 in the Swift port.

export const deg = Math.PI / 180;

/** Column-major 4×4 from rows (helper for the simd_float4x4(rows:) initialisers). */
export function fromRows(r0, r1, r2, r3) {
    const m = new Float32Array(16);
    const rows = [r0, r1, r2, r3];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = rows[r][c];
    return m;
}
export function identity() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export const IDENTITY = identity();

/** a · b (column-major). */
export function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}
/** m · [x, y, z, w] */
export function mulVec4(m, v) {
    const [x, y, z, w] = v;
    return [m[0] * x + m[4] * y + m[8] * z + m[12] * w,
            m[1] * x + m[5] * y + m[9] * z + m[13] * w,
            m[2] * x + m[6] * y + m[10] * z + m[14] * w,
            m[3] * x + m[7] * y + m[11] * z + m[15] * w];
}

// small vec3 helpers
export const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3len = (a) => Math.sqrt(v3dot(a, a));
export const v3norm = (a) => { const l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** PSMTXRotRad about an axis. */
export function rot(axis, degrees) {
    const r = degrees * deg, c = Math.cos(r), s = Math.sin(r);
    switch (axis) {
        case 'x': return fromRows([1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]);
        case 'y': return fromRows([c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]);
        default: return fromRows([c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]);
    }
}
export function trans(x, y, z) { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; }

/** fn_80036834 / fn_80036880 / fn_800368CC MtxPreRot{X,Y,Z}Deg: m = R(deg) · m (returns the new matrix). */
export function preRot(m, axis, degrees) { return mul(rot(axis, degrees), m); }

/** PSMTXMultVec (includes translation — matters for the camera "up" quirk). */
export function multVec(m, v) { const r = mulVec4(m, [v[0], v[1], v[2], 1]); return [r[0], r[1], r[2]]; }
export function translation(m) { return [m[12], m[13], m[14]]; }

export function wrap180(a) { while (a < -180) a += 360; while (a > 180) a -= 360; return a; }
export function wrap360(a) { a = a % 360; if (a < 0) a += 360; return a; }
export function clamp01(v) { return Math.min(Math.max(v, 0), 1); }

/**
 * fn_80035E1C ChaseValue → [newValue, remaining |v − target|].
 * (Swift's inout parameter becomes a returned value: `[v, rem] = chaseValue(v, ...)`.)
 */
export function chaseValue(v, target, rate, maxStep, minStep) {
    const d = v - target;
    if (v !== target) {
        if (Math.abs(d) < minStep) v = target;
        else {
            let step = d * rate;
            if (Math.abs(step) < 0.0008) v = target;
            else {
                if (Math.abs(d) * rate > maxStep) step = step < 0 ? -maxStep : maxStep;
                else if (Math.abs(d) * rate < minStep) step = step < 0 ? -minStep : minStep;
                v -= step;
            }
        }
    }
    return [v, Math.abs(v - target)];
}

/** fn_80035ED0 ChaseAngle: as ChaseValue on [0,360) with the shortest-path delta; snaps when |delta·rate| <= snapEps. */
export function chaseAngle(a, target, rate, maxStep, snapEps) {
    const cur = wrap360(a), tgt = wrap360(target);
    const d = wrap180(cur - tgt);
    let step = d * rate;
    if (Math.abs(step) <= snapEps) return tgt;
    if (Math.abs(step) > maxStep) step = step < 0 ? -maxStep : maxStep;
    return wrap360(cur - step);
}

/** fn_8002BE14 ApproachAngle: 5%/frame toward target, snap under 0.008. */
export function approachAngle(a, target) {
    const d = wrap180(target - a);
    if (Math.abs(d) < 0.008 || Math.abs(d * 0.05) < 0.008) return target;
    return wrap360(a + d * 0.05);
}

/** Float → f32 (Swift Float arithmetic). */
export const f32 = Math.fround;

export const GlobeMath = { deg, rot, trans, preRot, multVec, translation, wrap180, wrap360, clamp01, chaseValue, chaseAngle, approachAngle };
