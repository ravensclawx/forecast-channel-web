// Port of Sources/Forecast/Render/LytRenderer.swift + LytRenderer+Sprites.swift.
// Draws nw4r::lyt layouts with WebGL2 (the role of Layout::Draw → Pane::Draw → *::DrawSelf + GX), and the
// immediate-mode 2D quads in SetOrtho2D space used by the sprite-number / icon / telop drawing.
// Web: the iPhone edge-strip branch (PortraitArrange.extendBodies) is omitted — no edge extension.

import { GXState, GXTevColorArg as C, GXTevAlphaArg as A } from '../../gx/GXState.js';
import { Picture, Window, TextBox } from '../../nw4r/lyt/Layout.js';
import { LytMaterial } from '../../nw4r/lyt/Layout.js';
import { CharWriter } from '../../nw4r/ut/CharWriter.js';
import { GXWebGL } from './GXWebGL.js';
import { LogicalScreen } from './LogicalScreen.js';

/** Column-major 4×4 from 4 rows (simd_float4x4(rows:)). */
export function mat4FromRows(r) {
    const m = new Float32Array(16);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) m[col * 4 + row] = r[row][col];
    return m;
}
export const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * A font's sheet textures, uploaded one at a time on first use (a system font has >100 sheets; only the few
 * holding the glyphs actually drawn are ever uploaded).
 */
export class FontSheets {
    constructor(font, gx) { this.font = font; this.gx = gx; this._cache = new Map(); }
    get count() { return this.font.sheets.length; }
    /** subscript(i) */
    get(i) {
        let t = this._cache.get(i);
        if (t) return t;
        // Glyph UVs come from the font's own sheetWidth/Height (TelopText, drawText), never the texture size.
        t = this.gx.makeTexture2D(this.font.sheets[i], this.font.sheetWidth, this.font.sheetHeight, `font sheet ${i}`);
        this._cache.set(i, t);
        return t;
    }
}

export class LytRenderer {
    /** @param {GXWebGL} gx */
    constructor(gx) {
        this.gx = gx;
        this._textures = new Map();
        this._fontSheets = new Map();
        /** Resolves a txl1 texture name ("btn1.tpl") to a TPL image ({width, height, rgba8}); set by the scene. */
        this.textureProvider = (_name) => null;
        /** Resolves an fnl1 font name to a ResFont. */
        this.fontProvider = (_name) => null;
    }

    /** Prewarm a layout texture by its txl1 name. */
    prewarmTexture(name) { this.texture(name); }
    /** Prewarm the sheets holding Latin text (the system font's CJK sheets load only if used). */
    prewarmFont(f) {
        const s = this.sheets(f);
        const used = new Set();
        for (let c = 0x20; c <= 0xFF; c++) used.add(f.glyph(c).sheet);
        for (const c of [0x2019, 0x2013, 0x2014, 0x201C, 0x201D, 0x2026, 0x00B0]) used.add(f.glyph(c).sheet);
        for (const i of [...used].sort((a, b) => a - b)) if (i >= 0 && i < s.count) s.get(i);
    }

    texture(name) {
        const hit = this._textures.get(name);
        if (hit) return hit;
        const img = this.textureProvider(name);
        if (!img) return null;
        const t = this.gx.makeTexture2D(img.rgba8, img.width, img.height, name);
        this._textures.set(name, t);
        return t;
    }

    sheets(f) {
        let s = this._fontSheets.get(f);
        if (!s) { s = new FontSheets(f, this.gx); this._fontSheets.set(f, s); }
        return s;
    }

    /** Orthographic projection for a W × H logical screen, origin at center, y up. */
    static ortho(width, height) {
        return mat4FromRows([[2 / width, 0, 0, 0], [0, 2 / height, 0, 0], [0, 0, -1 / 1000, 0.5], [0, 0, 0, 1]]);
    }

    /** Layout::Draw. `viewMtx` lets the game offset/scale the whole layout (DrawInfo view matrix). */
    draw(layout, enc, screenWidth = 608, viewMtx = IDENTITY4, locationAdjust = null) {
        layout.root.calculate(viewMtx, 255, locationAdjust);
        const proj = LytRenderer.ortho(screenWidth, LogicalScreen.height);
        enc.setCullMode('none');
        this._drawPane(layout, layout.root, enc, proj);
    }

    _drawPane(layout, p, enc, proj) {
        if (!p.visible || p.suppressed) return;
        if (p instanceof Picture) this._drawQuad(layout, p, p.material, p.vtxColors, p.texCoords, enc, proj);
        else if (p instanceof Window) this._drawQuad(layout, p, p.material, p.vtxColors, p.texCoords, enc, proj);
        else if (p instanceof TextBox) this._drawText(p, enc, proj);
        for (const c of p.children) this._drawPane(layout, c, enc, proj);
    }

    /** detail::IsModulateVertexColor */
    static isModulate(colors, alpha) {
        return alpha !== 255 || colors.some(c => c[0] !== 255 || c[1] !== 255 || c[2] !== 255 || c[3] !== 255);
    }

    static _vertex(out, pos, c, alpha, uvs) {
        const o = out.length;
        for (let i = 0; i < 26; i++) out.push(0);
        out[o] = pos[0]; out[o + 1] = pos[1];
        out[o + 6] = c[0] / 255; out[o + 7] = c[1] / 255; out[o + 8] = c[2] / 255;
        out[o + 9] = Math.trunc(c[3] * alpha / 255) / 255;   // detail::MultipleAlpha
        const n = Math.min(uvs.length, 8);
        for (let i = 0; i < n; i++) { out[o + 10 + i * 2] = uvs[i][0]; out[o + 11 + i * 2] = uvs[i][1]; }
    }

    /** Picture::DrawSelf (and Window content). */
    _drawQuad(layout, p, mat, colors, texCoords, enc, proj, cornersOverride = null) {
        if (!mat) return;
        const alpha = p.globalAlpha;
        const state = mat.setupGX(LytRenderer.isModulate(colors, alpha), alpha);
        const o = p.vertexOrigin, s = p.size;
        const corners = cornersOverride ?? [[o[0], o[1]], [o[0] + s[0], o[1]], [o[0], o[1] - s[1]], [o[0] + s[0], o[1] - s[1]]];
        const verts = [];
        for (const i of [0, 1, 2, 1, 3, 2]) LytRenderer._vertex(verts, corners[i], colors[i], alpha, texCoords.map(t => t[i]));
        const texs = [], samps = [], dims = [];
        const ov = mat.texturePatternOverride;
        mat.texMaps.forEach((tm, slot) => {
            const over = ov ? (ov instanceof Map ? ov.get(slot) : ov[slot]) : undefined;
            const name = over ?? layout.textureNames[tm.texture] ?? '';
            const t = this.texture(name);
            texs.push(t); samps.push(this.gx.sampler(tm.wrapS, tm.wrapT, tm.minFilter, tm.magFilter));
            dims.push([t ? t.logicalWidth : 1, t ? t.logicalHeight : 1]);
        });
        // Texgen matrices: TexCoordGen.mtx 30 + 3k → TexSRT k; 60 → identity.
        const pre = [];
        for (const g of mat.texCoordGens) {
            let m = GXWebGL.identity34;
            if (g.mtx >= 30 && g.mtx < 60) {
                const srt = mat.texSRTs[((g.mtx - 30) / 3) | 0];
                if (srt) m = LytMaterial.texMtx(srt);
            }
            pre.push(m);
        }
        this.gx.submit(enc, state, verts, proj, p.globalMtx, pre, [], texs, samps, dims);
    }

    /** TextBox::DrawSelf via TextWriter/CharWriter. */
    _drawText(t, enc, proj) {
        const mat = t.material;
        const font = t.font ?? (t.fontName ? this.fontProvider(t.fontName) : null);
        if (!mat || !font || !t.text || t.text.length === 0) return;
        t.font = font;
        const clamp = c => c.map(v => Math.max(0, Math.min(255, v)));
        const state = CharWriter.setupGX(font.sheetFormat, clamp(mat.tevColors[0]), clamp(mat.tevColors[1]));
        const quads = CharWriter.layout(t.text, font, t.fontSize, t.charSpace, t.lineSpace, t.size, t.textPosition,
            t.textAlignment, t.topColor, t.bottomColor);
        const o = t.vertexOrigin;
        const sheetTex = this.sheets(font);
        const samp = this.gx.sampler(0, 0, 1, 1);
        const bySheet = new Map();
        for (const q of quads) {
            const x0 = o[0] + q.rect[0], x1 = o[0] + q.rect[2], y0 = o[1] + q.rect[1], y1 = o[1] + q.rect[3];
            const v = [];
            LytRenderer._vertex(v, [x0, y0], q.top, t.globalAlpha, [[q.uv[0], q.uv[1]]]);
            LytRenderer._vertex(v, [x1, y0], q.top, t.globalAlpha, [[q.uv[2], q.uv[1]]]);
            LytRenderer._vertex(v, [x0, y1], q.bottom, t.globalAlpha, [[q.uv[0], q.uv[3]]]);
            LytRenderer._vertex(v, [x1, y1], q.bottom, t.globalAlpha, [[q.uv[2], q.uv[3]]]);
            const c0 = v.slice(0, 26), c1 = v.slice(26, 52), c2 = v.slice(52, 78), c3 = v.slice(78, 104);
            let arr = bySheet.get(q.sheet);
            if (!arr) { arr = []; bySheet.set(q.sheet, arr); }
            arr.push(...c0, ...c1, ...c2, ...c1, ...c3, ...c2);
        }
        for (const [sheet, verts] of bySheet) {
            if (sheet >= sheetTex.count) continue;
            this.gx.submit(enc, state, verts, proj, t.globalMtx, [], [], [sheetTex.get(sheet)], [samp],
                [[font.sheetWidth, font.sheetHeight]]);
        }
    }

    // ---- LytRenderer+Sprites: immediate-mode 2D quads in SetOrtho2D space (x 0..W, y 0..H downwards) ----

    /** Ortho for screen pixels, y down (SetOrtho2D). */
    static ortho2D(width) {
        return mat4FromRows([[2 / width, 0, 0, -1], [0, -2 / LogicalScreen.height, 0, 1], [0, 0, -1 / 1000, 0.5], [0, 0, 0, 1]]);
    }

    /** TEV used by DrawSpriteString after GXSetTevColor(GX_TEVREG0, color): out = tex × C0. */
    static spriteGX(color, intensityFont = false) {
        const gx = new GXState();
        gx.setNumChans(1);
        gx.setChanCtrl(GXState.color0a0, false, 0, 1);
        gx.setNumTexGens(1);
        gx.setTexCoordGen(0, 1, 4);
        gx.setTevSwapModeTable(0, 0, 1, 2, 3);
        gx.setNumTevStages(1);
        gx.setTevOrder(0, 0, 0, 0xFF);
        if (intensityFont) {
            // CharWriter::SetupGX for I4/I8 sheets: colour = rasterised colour, alpha = texture × alpha.
            gx.setTevColorIn(0, C.zero, C.zero, C.zero, C.c0);
        } else {
            gx.setTevColorIn(0, C.zero, C.texc, C.c0, C.zero);
        }
        gx.setTevAlphaIn(0, A.zero, A.texa, A.a0, A.zero);
        gx.setTevColorOp(0, 0, 0, 0, true, 0);
        gx.setTevAlphaOp(0, 0, 0, 0, true, 0);
        gx.setTevDirect(0);
        gx.setTevSwapMode(0, 0, 0);
        gx.setTevColor(1, [color[0], color[1], color[2], color[3]]);
        gx.setAlphaCompare(7, 0, 0, 7, 0);
        gx.setBlendMode(1, 4, 5, 0xF);
        gx.setZMode(false, 7, false);
        return gx;
    }

    /** Draw `tex` stretched over rect (x, y, w, h) in screen pixels (y down), modulated by `color`. */
    drawScreenQuad(tex, x, y, w, h, color, uv = [0, 0, 1, 1], screenWidth, enc) {
        this.drawScreenQuads(tex, [[[x, y, x + w, y + h], uv]], color, screenWidth, enc);
    }

    /** Batched variant: rects as [x0, y0, x1, y1] with matching uv rects [u0, v0, u1, v1]. */
    drawScreenQuads(tex, quads, color, screenWidth, enc, sampler = null, intensityFont = false) {
        if (!quads.length) return;
        const state = LytRenderer.spriteGX(color, intensityFont);
        const verts = new Float32Array(quads.length * 6 * 26);
        let k = 0;
        const v = (x, y, u, t) => {
            verts[k] = x; verts[k + 1] = y; verts[k + 6] = 1; verts[k + 7] = 1; verts[k + 8] = 1; verts[k + 9] = 1;
            verts[k + 10] = u; verts[k + 11] = t; k += 26;
        };
        for (const [r, uv] of quads) {
            v(r[0], r[1], uv[0], uv[1]); v(r[2], r[1], uv[2], uv[1]); v(r[0], r[3], uv[0], uv[3]);
            v(r[2], r[1], uv[2], uv[1]); v(r[2], r[3], uv[2], uv[3]); v(r[0], r[3], uv[0], uv[3]);
        }
        enc.setCullMode('none');
        const samp = sampler ?? this.gx.sampler(0, 0, 1, 1);
        this.gx.submit(enc, state, verts, LytRenderer.ortho2D(screenWidth), IDENTITY4, [], [], [tex], [samp],
            [[tex.logicalWidth, tex.logicalHeight]]);
    }

    /** fn_8002E9EC: untextured quad with per-corner colours, rect [x0, y0, x1, y1], colours TL, BL, BR, TR
     *  (SpriteText.drawGradientRect in the Swift port: rasterised vertex colour straight through TEV stage 0). */
    drawScreenGradient(r, c, screenWidth, enc) {
        const gx = new GXState();
        gx.setNumChans(1);
        gx.setChanCtrl(GXState.color0a0, false, 0, 1);
        gx.setNumTexGens(0);
        gx.setTevSwapModeTable(0, 0, 1, 2, 3);
        gx.setTevSwapMode(0, 0, 0);
        gx.setNumTevStages(1);
        gx.setTevOrder(0, 0xFF, 0xFF, 4);
        gx.setTevColorIn(0, C.zero, C.zero, C.zero, C.rasc);
        gx.setTevAlphaIn(0, A.zero, A.zero, A.zero, A.rasa);
        gx.setTevColorOp(0, 0, 0, 0, true, 0);
        gx.setTevAlphaOp(0, 0, 0, 0, true, 0);
        gx.setTevDirect(0);
        gx.setAlphaCompare(7, 0, 0, 7, 0);
        gx.setBlendMode(1, 4, 5, 0xF);
        gx.setZMode(false, 7, false);
        const verts = new Float32Array(6 * 26);
        let k = 0;
        const v = (x, y, col) => {
            verts[k] = x; verts[k + 1] = y;
            verts[k + 6] = col[0] / 255; verts[k + 7] = col[1] / 255; verts[k + 8] = col[2] / 255; verts[k + 9] = col[3] / 255;
            k += 26;
        };
        v(r[0], r[1], c[0]); v(r[0], r[3], c[1]); v(r[2], r[3], c[2]);
        v(r[0], r[1], c[0]); v(r[2], r[3], c[2]); v(r[2], r[1], c[3]);
        enc.setCullMode('none');
        this.gx.submit(enc, gx, verts, LytRenderer.ortho2D(screenWidth), IDENTITY4, [], [], [], [], []);
    }

    /** Untextured coloured quad (fn_8002E79C-style fills / fades). */
    drawScreenRect(x0, y0, x1, y1, color, screenWidth, enc) {
        this.drawScreenQuad(this.gx.whiteTexture, x0, y0, x1 - x0, y1 - y0, color, [0, 0, 1, 1], screenWidth, enc);
    }

    /** Font sheet textures (shared cache with TextBox drawing). */
    fontSheets(f) { return this.sheets(f); }

    /** Upload an RGBA8 image once (keyed by content). `img` = TPLFile image {width, height, rgba8}. */
    makeTexture(img, label) { return this.gx.makeTexture2D(img.rgba8, img.width, img.height, label); }
}
