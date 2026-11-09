// Port of Sources/Forecast/Game/StarField.swift (rendering + the fn_8002EF14 fade).
// The space behind the globe: CAround +0x30C, built by fn_8002EC68 and drawn first in GlobeScreen_Draw by
// fn_8002EFB8.
//
// fn_8002EC68 (ctor): 0x2388 = 9096 stars, each a triangle 100 units out on −Z, (−s,−s) (3s,−s) (−s,3s) with
// s = 0.0045 · size[i] (lbl_80184328, u8), turned by RotY(b)·RotX(a) where (a, b) = lbl_8017B508[i] (u16 angles,
// 0x10000 = one turn).
// fn_8002EFB8 (draw): Setup2DRender, Z test off; the globe camera's view matrix with its translation zeroed
// (stars rotate with the camera, never move), C_MTXPerspective(40°, W/456, 1, 1000); colour = palette
// lbl_80188A38[lbl_801866B0[i]]; texcoords lbl_8017B4F0; texture TPLCommon image 0x60; TEV colour =
// lerp(RASC, ONE, TEXC), alpha = TEXA · A0 with A0 = +4FF20; alpha blend.
// fn_8002EF14: target = clamp(255 − 200·(|vLat|+|vLon|)); above it the alpha drops by 0x20 per frame (to the
// target), below it rises by 2 per frame.

import { DOLImage } from '../../rvl/DOL.js';
import { CX } from '../../rvl/CX.js';
import { TPLFile } from '../../nw4r/lyt/TPL.js';
import { Content } from '../system/Assets.js';
import { GlobeCamera } from './GlobeCamera.js';

const VS = `#version 300 es
precision highp float;
in vec3 a_pos; in vec4 a_color; in vec2 a_uv;
uniform mat4 u_mvp; uniform float u_flipY;
out vec4 v_color; out vec2 v_uv;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); gl_Position.y *= u_flipY; v_color = a_color; v_uv = a_uv; }`;
const FS = `#version 300 es
precision highp float;
in vec4 v_color; in vec2 v_uv;
uniform sampler2D u_tex; uniform float u_a0;
out vec4 fragColor;
void main() {
    vec4 tx = texture(u_tex, v_uv);
    vec3 c = mix(v_color.rgb, vec3(1.0), tx.rgb);   // lerp(RASC, ONE, TEXC)
    fragColor = vec4(c, tx.a * u_a0);                // TEXA · A0
}`;

export class StarField {
    /**
     * @param gx GXWebGL
     * @param assets Assets (track A)
     */
    constructor(gx, assets) {
        this.gx = gx; const gl = gx.gl; this.gl = gl;
        /** +4FF20 (heap memory; starts transparent, fades in) */
        this.alpha = 0;
        const dol = new DOLImage(assets.title.content(Content.mainDol));
        const n = 0x2388;
        const uvs = [0, 1, 2].map(i => [dol.f32(0x8017B4F0 + i * 8), dol.f32(0x8017B4F4 + i * 8)]);
        const baseZ = [0, 1, 2].map(i => dol.f32(0x8017B4D0 + i * 12));
        const rs = dol.reader(0x80184328), rc = dol.reader(0x801866B0), rp = dol.reader(0x80188A38), ra = dol.reader(0x8017B508);
        if (!rs || !rc || !rp || !ra) throw new Error('star tables');
        const [r, sizeOff] = rs, colIdxOff = rc[1], palOff = rp[1], angOff = ra[1];
        const turn = 2 * Math.PI / 65536;
        // pos3 colour4 uv2 = 9 floats per vertex
        const verts = new Float32Array(n * 3 * 9);
        let k = 0;
        for (let i = 0; i < n; i++) {
            const s = 0.0045 * r.u8(sizeOff + i);
            const a = r.u16(angOff + i * 4) * turn, b = r.u16(angOff + i * 4 + 2) * turn;
            const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
            // m = RotY(b) · RotX(a), rows
            const m = [[cb, sb * sa, sb * ca], [0, ca, -sa], [-sb, cb * sa, cb * ca]];
            const ci = r.u8(colIdxOff + i);
            const col = [r.u8(palOff + ci * 3) / 255, r.u8(palOff + ci * 3 + 1) / 255, r.u8(palOff + ci * 3 + 2) / 255, 1];
            const local = [[-s, -s, baseZ[0]], [3 * s, -s, baseZ[1]], [-s, 3 * s, baseZ[2]]];
            for (let q = 0; q < 3; q++) {
                const p = local[q];
                verts[k++] = m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2];
                verts[k++] = m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2];
                verts[k++] = m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2];
                verts[k++] = col[0]; verts[k++] = col[1]; verts[k++] = col[2]; verts[k++] = col[3];
                verts[k++] = uvs[q][0]; verts[k++] = uvs[q][1];
            }
        }
        this.vertexCount = n * 3;
        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

        // TPLCommon image 0x60 (fn_80031B88(lbl_80330C00, 0x60)).
        this.texture = null;
        const c = assets.archive(Content.weather).find('TPLCommon.tpl.LZ');
        if (c) {
            const tpl = new TPLFile(CX.uncompressIfNeeded(c));
            if (tpl.images.length > 0x60) { const im = tpl.images[0x60]; this.texture = gx.makeTexture(im.rgba8, im.width, im.height, 'stars'); }
        }

        // program
        const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
        const p = gl.createProgram();
        gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS));
        gl.bindAttribLocation(p, 0, 'a_pos'); gl.bindAttribLocation(p, 1, 'a_color'); gl.bindAttribLocation(p, 2, 'a_uv');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        this.program = p;
        this.uMvp = gl.getUniformLocation(p, 'u_mvp'); this.uA0 = gl.getUniformLocation(p, 'u_a0');
        this.uFlip = gl.getUniformLocation(p, 'u_flipY');
        gl.useProgram(p); gl.uniform1i(gl.getUniformLocation(p, 'u_tex'), 0);
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 28);
        gl.bindVertexArray(null);
        this.sampler = gx.sampler(0, 0, 1, 1);
    }

    /** fn_8002EF14 */
    update(velLat, velLon) {
        const target = Math.max(0, Math.min(255, Math.trunc(255 - 200 * (Math.abs(velLat) + Math.abs(velLon)))));
        if (this.alpha > target) this.alpha = this.alpha - target < 0x20 ? target : this.alpha - 0x20;
        else if (this.alpha >= 0xFE) this.alpha = 0xFF;
        else this.alpha += 2;
    }

    /**
     * fn_8002EFB8. `aspect` = logical width / height (W/456 on the Wii); `fovy` 40° — portrait keeps the Wii's
     * horizontal field of view and widens vertically.
     */
    draw(enc, view, aspect, fovy) {
        if (this.alpha <= 0 || !this.texture) return;
        const gl = this.gl;
        const v = Float32Array.from(view);
        v[12] = 0; v[13] = 0; v[14] = 0; v[15] = 1;   // translation zeroed (sp7C/sp8C/sp9C = 0)
        const p = GlobeCamera.perspective(fovy, aspect, 1, 1000);
        const mvp = new Float32Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
            mvp[c * 4 + r] = p[r] * v[c * 4] + p[4 + r] * v[c * 4 + 1] + p[8 + r] * v[c * 4 + 2] + p[12 + r] * v[c * 4 + 3];
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uMvp, false, mvp);
        gl.uniform1f(this.uA0, this.alpha / 255);
        gl.uniform1f(this.uFlip, enc.flipY ? -1 : 1);
        gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture.tex); gl.bindSampler(0, this.sampler);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
        gl.bindVertexArray(null);
    }
}
