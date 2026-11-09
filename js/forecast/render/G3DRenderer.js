// Port of Sources/Forecast/Render/G3DRenderer.swift.
// WebGL2 backend for nw4r::g3d model drawing (the role ScnMdl + GX play on the console).
// Each ResMat's GXState is compiled once via GXShaderGen (through GXWebGL's program cache).

import { G3DTexMtx } from '../../nw4r/g3d/TexMtx.js';
import { GXWebGL } from './GXWebGL.js';
import { IDENTITY4 } from './LytRenderer.js';

// ---- small column-major 4×4 helpers (local, so this file only depends on GXWebGL) ----
function mul4(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
}
function mulVec4(m, v) {
    return [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
}
/** inverse(transpose) of the upper 3×3 → as 3 columns. */
function normalMatrix(m) {
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    // rows of M3: [a b c; d e f; g h i]
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C || 1;
    const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
    // inverse = adj^T / det; (inverse)^T = adj / det  → rows of result
    const inv = 1 / det;
    // result R = (M^-1)^T; R rows = [A B C; D E F; G H I] * inv (cofactor matrix)
    return [[A * inv, B * inv, C * inv], [D * inv, E * inv, F * inv], [G * inv, H * inv, I * inv]];   // rows
}
function normalize3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

export class G3DRenderer {
    /**
     * @param {GXWebGL} gx
     * @param file ResFile (track C: js/nw4r/g3d/ResFile.js)
     * @param {string} name model name
     */
    constructor(gx, file, name) {
        this.gx = gx; const gl = gx.gl; this.gl = gl;
        const mdl = file.models instanceof Map ? file.models.get(name) : file.models[name];
        if (!mdl) throw new Error(`G3D: no model ${name}`);
        this.model = mdl;
        /** Runtime material copies (ScnMdl bufferOption=1): game code mutates these per frame. */
        this.materials = mdl.materials;
        this.shapes = [];
        this.mats = [];
        /** Per-bone world matrices (game code may override, e.g. SimpleGlobe rotation on the "earth" bone). */
        this.boneWorld = [];

        for (const s of mdl.shapes) {
            const vb = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vb);
            gl.bufferData(gl.ARRAY_BUFFER, s.vertices instanceof Float32Array ? s.vertices : new Float32Array(s.vertices), gl.STATIC_DRAW);
            const ib = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, s.indices instanceof Uint32Array ? s.indices : new Uint32Array(s.indices), gl.STATIC_DRAW);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
            this.shapes.push({ vb, ib, count: s.indices.length });
        }

        const texCache = new Map();
        const textures = file.textures;
        const getTex = n => textures instanceof Map ? textures.get(n) : textures[n];
        for (const m of mdl.materials) {
            const tex = new Array(8).fill(null), samps = new Array(8).fill(null);
            for (const l of m.layers) {
                if (l.texMap >= 8) continue;
                if (!texCache.has(l.texture)) {
                    const t = getTex(l.texture);
                    if (t) texCache.set(l.texture, gx.makeTexture(t.rgba8(), t.width, t.height, t.name));
                }
                tex[l.texMap] = texCache.get(l.texture) ?? null;
                samps[l.texMap] = gx.sampler(l.wrapS, l.wrapT, l.minFilter, l.magFilter);
            }
            // GXCullMode: 0 none, 1 front, 2 back, 3 all
            const cull = ['none', 'front', 'back', 'none'][m.cullMode & 3];
            this.mats.push({ textures: tex, samplers: samps, cull });
        }
    }

    /**
     * Scene inputs supplied by the game code (camera from SimpleGlobe, light from its LightSet).
     * { view, projection, lightDirWorld, lightPosWorld, cameras: {index: view} }
     */
    static Scene() {
        return { view: IDENTITY4, projection: IDENTITY4, lightDirWorld: [0, 0, -1], lightPosWorld: [0, 0, 0], cameras: {} };
    }

    draw(enc, scene) {
        if (this.boneWorld.length !== this.model.bones.length) this.boneWorld = this.model.bones.map(() => IDENTITY4);
        enc.setFrontFacing('clockwise');   // GX treats clockwise screen-space winding as front-facing
        for (const call of this.model.drawOpa) this._drawCall(enc, call, scene);
        for (const call of this.model.drawXlu) this._drawCall(enc, call, scene);
        enc.setFrontFacing('counterClockwise');
    }

    _drawCall(enc, call, scene) {
        const mat = this.materials[call.material], gm = this.mats[call.material], gs = this.shapes[call.shape];
        const bone = this.model.bones[call.bone];
        let mv = mul4(scene.view, this.boneWorld[call.bone]);
        if (bone.billboard !== 0) {
            // nw4r BILLBOARD_STD: keep translation/scale, replace rotation with the screen plane.
            const sx = Math.hypot(mv[0], mv[1], mv[2]), sy = Math.hypot(mv[4], mv[5], mv[6]), sz = Math.hypot(mv[8], mv[9], mv[10]);
            mv = Float32Array.from(mv);
            mv.set([sx, 0, 0, 0], 0); mv.set([0, sy, 0, 0], 4); mv.set([0, 0, sz, 0], 8);
        }
        const nrm = normalMatrix(mv);   // rows

        const vu = new Float32Array(62 * 4);
        vu.set(scene.projection.subarray ? scene.projection.subarray(0, 16) : scene.projection, 0);
        for (let r = 0; r < 3; r++) {
            vu.set([mv[r], mv[4 + r], mv[8 + r], mv[12 + r]], (4 + r) * 4);
            vu.set([nrm[r][0], nrm[r][1], nrm[r][2], 0], (7 + r) * 4);
        }
        // fn_800A77D8 (pre-matrices) + fn_800A7388 LoadResTexSrt (post-matrices), see G3DTexMtx.
        const lp = mulVec4(scene.view, [...scene.lightPosWorld, 1]);
        const ld = mulVec4(scene.view, [...scene.lightDirWorld, 0]);
        const envLight = { enabled: true, useDirection: true, viewPos: [lp[0], lp[1], lp[2]], viewDir: normalize3(ld) };
        for (let i = 0; i < mat.gx.numTexGens; i++) {
            const fx = mat.effects[i];
            const nib = (mat.srtFlags >>> (i * 4)) & 0xF;
            const srt = G3DTexMtx.srt(mat.srt[i], mat.texMtxMode, nib);
            const effect = fx.identity ? G3DTexMtx.identity
                : [[fx.matrix[0], fx.matrix[1], fx.matrix[2], fx.matrix[3]], [fx.matrix[4], fx.matrix[5], fx.matrix[6], fx.matrix[7]],
                   [fx.matrix[8], fx.matrix[9], fx.matrix[10], fx.matrix[11]]];
            let pre = G3DTexMtx.identity, post;
            switch (fx.mapMode) {
            case 1: case 3: case 4: {   // env camera / env light / env spec: pre = model-view normal matrix
                pre = [[nrm[0][0], nrm[0][1], nrm[0][2], 0], [nrm[1][0], nrm[1][1], nrm[1][2], 0], [nrm[2][0], nrm[2][1], nrm[2][2], 0]];
                const env = G3DTexMtx.calcEnv(fx.camera, fx.mapMode === 1 ? -1 : fx.light, scene.view, scene.cameras, envLight);
                post = G3DTexMtx.mul(G3DTexMtx.mul(G3DTexMtx.srtForEnv(srt), effect), env);
                break;
            }
            default:
                post = G3DTexMtx.mul(srt, effect);
            }
            for (let k = 0; k < 3; k++) { vu.set(pre[k], (10 + i * 3 + k) * 4); vu.set(post[k], (34 + i * 3 + k) * 4); }
        }
        const rgba = (v, at) => {
            v >>>= 0;
            vu[at] = (v >>> 24) / 255; vu[at + 1] = ((v >>> 16) & 0xFF) / 255; vu[at + 2] = ((v >>> 8) & 0xFF) / 255; vu[at + 3] = (v & 0xFF) / 255;
        };
        rgba(mat.gx.chanMatColor[0], 58 * 4); rgba(mat.gx.chanMatColor[1], 59 * 4);
        rgba(mat.gx.chanAmbColor[0], 60 * 4); rgba(mat.gx.chanAmbColor[1], 61 * 4);

        const dims = gm.textures.map(t => t ? [t.width, t.height] : [1, 1]);
        const fu = GXWebGL.fragmentUniforms(mat.gx, dims);

        let pipe;
        try { pipe = this.gx.pipeline(mat.gx); } catch (e) { console.error(e); return; }
        enc.setRenderPipelineState(pipe);
        enc.setDepthStencilState(mat.gx.zMode);
        enc.setCullMode(gm.cull);
        enc.setVertexBuffer(gs.vb, 0);
        enc.setVertexBytes(vu);
        enc.setFragmentBytes(fu);
        for (let i = 0; i < 8; i++) {
            enc.setFragmentTexture(gm.textures[i] ?? this.gx.whiteTexture, i);
            enc.setFragmentSamplerState(gm.samplers[i] ?? this.gx.defaultSampler, i);
        }
        enc.drawIndexedPrimitives('triangle', gs.count, gs.ib, 0);
    }
}
