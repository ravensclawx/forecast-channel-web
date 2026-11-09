// Port of Sources/Forecast/Render/GXMetal.swift (+ the TextureOverrides logical-size bookkeeping).
// Shared GX→WebGL2 plumbing: program cache keyed by the shader-relevant part of GXState, uniform packing,
// transient vertex ring, samplers, render targets, and the `enc` frame object every draw call receives.
//
// Coordinate conventions (shader contract: header of js/gx/GXShaderGen.js):
//  - Projections are the Swift (Metal-style) ones; WebGL accepts them unchanged.
//  - Texture (0,0) = first uploaded row = top. Off-screen passes are rendered y-flipped so a render-target texture
//    has the same orientation as an uploaded one; Metal-style (top-left) viewport/scissor rects then map 1:1 in
//    off-screen passes and are converted for the default framebuffer.

import { GXShaderGen } from '../../gx/GXShaderGen.js';

const STRIDE = 104;                 // GXShaderGen.vertexStride (26 floats)
const RING_SIZE = 8 << 20;

/** A GPU texture with its original (logical) size — `width`/`height` are what geometry and UV math use. */
export class GXTexture {
    constructor(tex, width, height, opts = {}) {
        this.tex = tex;
        this.width = width; this.height = height;
        this.logicalWidth = opts.logicalWidth ?? width;
        this.logicalHeight = opts.logicalHeight ?? height;
        this.label = opts.label ?? null;
    }
}

/** Off-screen colour (+ depth) target: the scene buffer / frame capture of WeatherScene.render. */
export class RenderTarget {
    constructor(gl, w, h, withDepth = true) {
        this.gl = gl; this.width = w; this.height = h;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.color = new GXTexture(t, w, h, { label: 'render target' });
        this.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        if (withDepth) {
            this.depth = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    dispose() {
        const gl = this.gl;
        gl.deleteTexture(this.color.tex); gl.deleteFramebuffer(this.fbo);
        if (this.depth) gl.deleteRenderbuffer(this.depth);
    }
}

// GXCompare → GL depth func: never, less, equal, lequal, greater, notequal, gequal, always
function depthFunc(gl, f) {
    return [gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS][f & 7];
}
// GXBlendFactor: 0 zero, 1 one, 2 srcclr/dstclr, 3 invsrcclr/invdstclr, 4 srcalpha, 5 invsrcalpha, 6 dstalpha, 7 invdstalpha
function srcFactor(gl, f) {
    return [gl.ZERO, gl.ONE, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA][f & 7];
}
function dstFactor(gl, f) {
    return [gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA][f & 7];
}

/** FNV-1a over the RGBA bytes (+ size): content key for the upload cache. */
function contentKey(px, w, h) {
    let hsh = 0x811c9dc5 >>> 0;
    const n = Math.min(px.length, w * h * 4);
    for (let i = 0; i < n; i++) { hsh ^= px[i]; hsh = Math.imul(hsh, 0x01000193) >>> 0; }
    return `${w}x${h}-${hsh.toString(16)}-${n}`;
}

/**
 * The frame drawing context passed as `enc` through all draw calls (the MTLRenderCommandEncoder role).
 * Mirrors the Metal calls the Swift code makes; draw state is applied lazily at drawPrimitives.
 */
export class GXEncoder {
    constructor(gx, target) {
        this.gx = gx; this.gl = gx.gl;
        this.target = target;                       // RenderTarget or null (canvas)
        this.flipY = !!target;                      // off-screen passes render y-flipped (see header)
        this.targetWidth = target ? target.width : gx.gl.drawingBufferWidth;
        this.targetHeight = target ? target.height : gx.gl.drawingBufferHeight;
        this._pipe = null; this._depth = null; this._cull = 'none'; this._front = 'counterClockwise';
        this._vbOffset = 0; this._vbuf = null; this._vu = null; this._fu = null;
        this._tex = new Array(8).fill(null); this._samp = new Array(8).fill(null);
        this.gl.disable(this.gl.SCISSOR_TEST);
    }

    /** MTLViewport {originX, originY, width, height} (origin top-left). */
    setViewport(vp) {
        const gl = this.gl;
        const x = Math.round(vp.originX), w = Math.round(vp.width), h = Math.round(vp.height);
        const y = this.flipY ? Math.round(vp.originY) : this.targetHeight - Math.round(vp.originY) - h;
        gl.viewport(x, y, w, h);
    }
    /** MTLScissorRect {x, y, width, height} (origin top-left, target pixels). */
    setScissorRect(r) {
        const gl = this.gl;
        gl.enable(gl.SCISSOR_TEST);
        const y = this.flipY ? r.y : this.targetHeight - r.y - r.height;
        gl.scissor(r.x | 0, y | 0, Math.max(0, r.width | 0), Math.max(0, r.height | 0));
    }
    /** Turn the scissor off again (Metal resets it per encoder; GL keeps it). */
    clearScissor() { this.gl.disable(this.gl.SCISSOR_TEST); }
    setCullMode(m) { this._cull = m; }                  // 'none' | 'front' | 'back'
    setFrontFacing(f) { this._front = f; }              // 'clockwise' | 'counterClockwise'
    setRenderPipelineState(p) { this._pipe = p; }
    setDepthStencilState(d) { this._depth = d; }
    setVertexBuffer(buf, offset = 0) { this._vbuf = buf; this._vbOffset = offset; }
    setVertexBytes(vu) { this._vu = vu; }
    setFragmentBytes(fu) { this._fu = fu; }
    setFragmentTexture(t, i) { this._tex[i] = t; }
    setFragmentSamplerState(s, i) { this._samp[i] = s; }

    _apply() {
        const gl = this.gl, gx = this.gx, p = this._pipe;
        gl.useProgram(p.program);
        // blend
        const b = p.blend;
        if (b && b.enable) {
            gl.enable(gl.BLEND);
            gl.blendFunc(srcFactor(gl, b.srcFactor), dstFactor(gl, b.dstFactor));
            gl.blendEquation(b.subtract ? gl.FUNC_REVERSE_SUBTRACT : gl.FUNC_ADD);
        } else gl.disable(gl.BLEND);
        // depth
        const z = this._depth ?? { test: false, function: 7, update: false };
        if (z.test) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(depthFunc(gl, z.function)); }
        else if (z.update) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); }   // Metal: compare always, still writes
        else gl.disable(gl.DEPTH_TEST);
        gl.depthMask(!!z.update);
        // cull (GX: clockwise screen winding is front; flipped passes reverse the winding)
        if (this._cull === 'none') gl.disable(gl.CULL_FACE);
        else { gl.enable(gl.CULL_FACE); gl.cullFace(this._cull === 'front' ? gl.FRONT : gl.BACK); }
        let cw = this._front === 'clockwise';
        if (this.flipY) cw = !cw;
        gl.frontFace(cw ? gl.CW : gl.CCW);
        // uniforms
        if (p.uVu && this._vu) {
            let vu = this._vu;
            if (this.flipY) {   // negate clip y: row 1 of the projection (component y of its 4 columns)
                vu = Float32Array.from(vu);
                vu[1] = -vu[1]; vu[5] = -vu[5]; vu[9] = -vu[9]; vu[13] = -vu[13];
            }
            gl.uniform4fv(p.uVu, vu);
        }
        if (p.uFu && this._fu) gl.uniform4iv(p.uFu, this._fu);
        for (let i = 0; i < 8; i++) {
            gl.activeTexture(gl.TEXTURE0 + i);
            const t = this._tex[i] ?? gx.whiteTexture;
            gl.bindTexture(gl.TEXTURE_2D, t.tex);
            gl.bindSampler(i, this._samp[i] ?? gx.defaultSampler);
        }
        // vertex stream
        gl.bindVertexArray(gx.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vbuf ?? gx.ring);
        const o = this._vbOffset;
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, o);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, o + 12);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, o + 24);
        for (let i = 0; i < 8; i++) gl.vertexAttribPointer(3 + i, 2, gl.FLOAT, false, STRIDE, o + 40 + i * 8);
    }

    drawPrimitives(type, vertexStart, vertexCount) {
        if (!this._pipe || vertexCount <= 0) return;
        this._apply();
        this.gl.drawArrays(this.gl.TRIANGLES, vertexStart, vertexCount);
    }
    /** Indexed draw: `indexBuffer` is a WebGLBuffer of uint32 indices. */
    drawIndexedPrimitives(type, indexCount, indexBuffer, indexBufferOffset = 0) {
        if (!this._pipe || indexCount <= 0) return;
        this._apply();
        const gl = this.gl;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, indexBufferOffset);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }
    endEncoding() { this.gl.disable(this.gl.SCISSOR_TEST); }
}

export class GXWebGL {
    /** @param {WebGL2RenderingContext} gl */
    constructor(gl) {
        this.gl = gl;
        this._programs = new Map();
        this._samplers = new Map();
        this._uploaded = new Map();
        this.whiteTexture = this._rawTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 'white');
        this.defaultSampler = this.sampler(0, 0, 1, 1);
        this.ring = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.ring);
        gl.bufferData(gl.ARRAY_BUFFER, RING_SIZE, gl.STREAM_DRAW);
        this.ringOffset = 0;
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        for (let i = 0; i < 11; i++) gl.enableVertexAttribArray(i);
        gl.bindVertexArray(null);
    }

    _rawTexture(px, w, h, label) {
        const gl = this.gl;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            px instanceof Uint8Array ? px : new Uint8Array(px));
        return new GXTexture(t, w, h, { label });
    }

    /**
     * Every 2D texture upload: RGBA8 `px` at its original size (no upscaled overrides on the web).
     * One GPU texture per distinct image (content-keyed), as in GXMetal.makeTexture2D.
     */
    makeTexture2D(px, w, h, label = null) {
        const key = contentKey(px, w, h);
        const hit = this._uploaded.get(key);
        if (hit) return hit;
        const t = this._rawTexture(px, w, h, label);
        this._uploaded.set(key, t);
        return t;
    }

    /** Uncached upload (G3D model textures, star texture). */
    makeTexture(px, w, h, label = null) { return this._rawTexture(px, w, h, label); }

    beginFrame() {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.ring);
        gl.bufferData(gl.ARRAY_BUFFER, RING_SIZE, gl.STREAM_DRAW);   // orphan
        this.ringOffset = 0;
    }

    /** Copies vertices (Float32Array / number[]) into the ring; returns [buffer, offset] or null. */
    push(v) {
        const data = v instanceof Float32Array ? v : Float32Array.from(v);
        const bytes = data.byteLength;
        if (this.ringOffset + bytes > RING_SIZE) return null;
        const gl = this.gl, o = this.ringOffset;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.ring);
        gl.bufferSubData(gl.ARRAY_BUFFER, o, data);
        this.ringOffset += (bytes + 255) & ~255;
        return [this.ring, o];
    }

    /** Shader-relevant key: constants that only feed uniforms (and blend/depth state) don't need programs. */
    static shaderKey(s) {
        if (GXShaderGen.pipelineKey) return GXShaderGen.pipelineKey(s);
        const bp = Array.from(s.bp);
        for (let m = 0; m < 9; m++) bp[0x06 + m] = (bp[0x06 + m] & 0x00C00000) >>> 0;
        bp[0xF3] = (bp[0xF3] & ~0xFFFF) >>> 0;
        bp[0x40] = 0; bp[0x41] = 0;   // z mode / blend: dynamic GL state
        return [s.numTexGens, s.numChans, s.numTevStages, s.numIndStages, bp.join(','),
            Array.from(s.texMtxInfo).join(','), Array.from(s.postMtxInfo).join(','),
            Array.from(s.chanColorCtrl).join(','), Array.from(s.chanAlphaCtrl).join(',')].join('|');
    }

    /** Program (+ blend state) for a GXState. Throws on compile errors. */
    pipeline(s) {
        const key = GXWebGL.shaderKey(s);
        let prog = this._programs.get(key);
        if (!prog) {
            prog = this._compile(GXShaderGen.generate(s), key);
            this._programs.set(key, prog);
        }
        return { program: prog.program, uVu: prog.uVu, uFu: prog.uFu, blend: s.blendMode };
    }

    _compile(src, label) {
        const gl = this.gl;
        const mk = (type, text) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, text); gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(sh);
                gl.deleteShader(sh);
                throw new Error(`GX shader compile failed: ${log}\n${text}`);
            }
            return sh;
        };
        const p = gl.createProgram();
        gl.attachShader(p, mk(gl.VERTEX_SHADER, src.vs ?? src.vertexSource));
        gl.attachShader(p, mk(gl.FRAGMENT_SHADER, src.fs ?? src.fragmentSource));
        const names = ['a_pos', 'a_nrm', 'a_clr0'];
        for (let i = 0; i < 8; i++) names.push(`a_tex${i}`);
        names.forEach((n, i) => gl.bindAttribLocation(p, i, n));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`GX program link failed: ${gl.getProgramInfoLog(p)}`);
        gl.useProgram(p);
        for (let i = 0; i < 8; i++) {
            const l = gl.getUniformLocation(p, `t${i}`) ?? gl.getUniformLocation(p, `u_tex${i}`);
            if (l) gl.uniform1i(l, i);
        }
        const loc = (...names) => { for (const n of names) { const l = gl.getUniformLocation(p, n); if (l) return l; } return null; };
        return { program: p, uVu: loc('u_vs', 'u_vs[0]', 'u_vu', 'u_vu[0]'), uFu: loc('u_fs', 'u_fs[0]', 'u_fu', 'u_fu[0]'), label };
    }

    /** GXState.ZMode passes straight through (`{test, function, update}`). */
    depthState(z) { return z; }

    /** GX wrap (0 clamp, 1 repeat, 2 mirror) + filters → WebGL sampler object. */
    sampler(wrapS, wrapT, minFilter, magFilter) {
        const key = (wrapS | (wrapT << 4) | (minFilter << 8) | (magFilter << 12)) >>> 0;
        let s = this._samplers.get(key);
        if (s) return s;
        const gl = this.gl;
        s = gl.createSampler();
        const w = [gl.CLAMP_TO_EDGE, gl.REPEAT, gl.MIRRORED_REPEAT];
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, w[Math.min(wrapS, 2)]);
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, w[Math.min(wrapT, 2)]);
        // Originals have a single level: no mip filtering (a mip filter would make them incomplete).
        gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, [0, 2, 4].includes(minFilter) ? gl.NEAREST : gl.LINEAR);
        gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, magFilter === 0 ? gl.NEAREST : gl.LINEAR);
        this._samplers.set(key, s);
        return s;
    }

    // ---- passes / targets (WeatherScene.render) ----

    createRenderTarget(w, h, withDepth = true) { return new RenderTarget(this.gl, w, h, withDepth); }

    /**
     * Begin a render pass (MTLRenderPassDescriptor + makeRenderCommandEncoder). `target` null = the canvas.
     * opts: { clearColor: [r,g,b,a] | null (load), clearDepth: true }.
     */
    beginPass(target, opts = {}) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
        const enc = new GXEncoder(this, target);
        gl.viewport(0, 0, enc.targetWidth, enc.targetHeight);
        let bits = 0;
        if (opts.clearColor) { const c = opts.clearColor; gl.clearColor(c[0], c[1], c[2], c[3]); bits |= gl.COLOR_BUFFER_BIT; }
        if (opts.clearDepth !== false) { gl.depthMask(true); gl.clearDepth(1); bits |= gl.DEPTH_BUFFER_BIT; }
        if (bits) gl.clear(bits);
        return enc;
    }

    /** Blit `src` RenderTarget colour into `dst` RenderTarget (the frame-capture copy). */
    copyTexture(src, dst) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
        gl.blitFramebuffer(0, 0, src.width, src.height, 0, 0, dst.width, dst.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    /**
     * Convenience used by the 2D helpers (LytRenderer, SceneDraw2D, SpriteText): one GX draw of triangle `verts`.
     * texs/samps/dims per texmap slot; proj/posMtx are 4×4 column-major Float32Array(16).
     */
    submit(enc, state, verts, proj, posMtx, pre, post, texs, samps, dims) {
        if (!verts || verts.length === 0) return;
        const pushed = this.push(verts);
        if (!pushed) return;
        let pipe;
        try { pipe = this.pipeline(state); } catch (e) { console.error(e); return; }
        enc.setRenderPipelineState(pipe);
        enc.setDepthStencilState(this.depthState(state.zMode));
        enc.setVertexBuffer(pushed[0], pushed[1]);
        enc.setVertexBytes(GXWebGL.vertexUniforms(proj, posMtx, pre, post, state));
        enc.setFragmentBytes(GXWebGL.fragmentUniforms(state, dims));
        for (let i = 0; i < 8; i++) {
            enc.setFragmentTexture((i < texs.length ? texs[i] : null) ?? this.whiteTexture, i);
            enc.setFragmentSamplerState((i < samps.length ? samps[i] : null) ?? this.defaultSampler, i);
        }
        enc.drawPrimitives('triangle', 0, (verts.length / 26) | 0);
    }

    // ---- uniform packing (layouts from GXShaderGen) ----

    static identity34 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];

    /** Vertex uniforms: Float32Array(62 × 4). `pre`/`post`: arrays of Mtx34 (3 rows of 4). */
    static vertexUniforms(proj, posMtx, pre, post, gx) {
        const vu = new Float32Array(62 * 4);
        vu.set(proj.subarray ? proj.subarray(0, 16) : proj.slice(0, 16), 0);   // 4 columns
        for (let r = 0; r < 3; r++) {
            vu[(4 + r) * 4 + 0] = posMtx[0 + r]; vu[(4 + r) * 4 + 1] = posMtx[4 + r];
            vu[(4 + r) * 4 + 2] = posMtx[8 + r]; vu[(4 + r) * 4 + 3] = posMtx[12 + r];
            vu[(7 + r) * 4 + r] = 1;
        }
        const id = GXWebGL.identity34;
        for (let i = 0; i < 8; i++) {
            const a = i < pre.length ? pre[i] : id, b = i < post.length ? post[i] : id;
            for (let k = 0; k < 3; k++) {
                vu.set(a[k], (10 + i * 3 + k) * 4);
                vu.set(b[k], (34 + i * 3 + k) * 4);
            }
        }
        const rgba = (v, at) => {
            vu[at] = (v >>> 24) / 255; vu[at + 1] = ((v >>> 16) & 0xFF) / 255;
            vu[at + 2] = ((v >>> 8) & 0xFF) / 255; vu[at + 3] = (v & 0xFF) / 255;
        };
        rgba(gx.chanMatColor[0] >>> 0, 58 * 4); rgba(gx.chanMatColor[1] >>> 0, 59 * 4);
        rgba(gx.chanAmbColor[0] >>> 0, 60 * 4); rgba(gx.chanAmbColor[1] >>> 0, 61 * 4);
        return vu;
    }

    /** Fragment uniforms: Int32Array(33 × 4). `dims` = per texmap [w, h]. */
    static fragmentUniforms(gx, dims) {
        const fu = new Int32Array(33 * 4);
        for (let i = 0; i < 4; i++) { fu.set(gx.konst[i], i * 4); fu.set(gx.tevRegs[i], (4 + i) * 4); }
        for (let i = 0; i < 8; i++) {
            const d = i < dims.length ? dims[i] : [1, 1];
            fu[(8 + i) * 4] = d[0]; fu[(8 + i) * 4 + 1] = d[1];
        }
        const coordMap = new Array(8).fill(-1);
        for (let s = 0; s < gx.numTevStages; s++) {
            const st = gx.tevStage(s);
            if (st.texEnable && coordMap[st.texCoord] < 0) coordMap[st.texCoord] = st.texMap;
        }
        for (let i = 0; i < gx.numIndStages; i++) {
            const r = gx.indRef(i);
            const m = r.map ?? r[0], c = r.coord ?? r[1];
            if (coordMap[c] < 0) coordMap[c] = m;
        }
        for (let c = 0; c < 8; c++) {
            if (coordMap[c] >= 0) { fu[(16 + c) * 4] = fu[(8 + coordMap[c]) * 4]; fu[(16 + c) * 4 + 1] = fu[(8 + coordMap[c]) * 4 + 1]; }
            else { fu[(16 + c) * 4] = 1; fu[(16 + c) * 4 + 1] = 1; }
        }
        for (let m = 0; m < 3; m++) {
            const im = gx.indMatrix(m);
            const r0 = im.row0, r1 = im.row1, sh = im.shift;
            fu.set([r0[0], r0[1], r0[2], sh], (24 + m * 2) * 4);
            fu.set([r1[0], r1[1], r1[2], sh], (25 + m * 2) * 4);
        }
        for (let i = 0; i < 4; i++) {
            const sc = gx.indScale(i);
            const s = sc[0] ?? sc.s, t = sc[1] ?? sc.t;
            fu[(30 + (i >> 1)) * 4 + (i & 1) * 2] = s;
            fu[(30 + (i >> 1)) * 4 + (i & 1) * 2 + 1] = t;
        }
        const ac = gx.alphaCompare;
        fu[32 * 4] = ac.ref0; fu[32 * 4 + 1] = ac.ref1;
        return fu;
    }
}
