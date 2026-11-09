// Port of Sources/Forecast/Scene/Address/SceneDraw2D.swift.
// Immediate-mode 2D drawing used by the scene code outside of layouts:
//   Setup2DRender (fn_80031170): TEV out = TEXC·C0 + C1, alpha = TEXA·A0 + A1, alpha test > 0, blend SRCALPHA/INVSRCALPHA
//   SetOrtho2D (fn_800313F4): 0..W × 0..H, y down
//   DrawTPLImage (fn_80031BE8): one TPL image at (x, y) scaled
//   TextWriter (nw4r::ut::TextWriter) Print with draw flags (0x111 = centred on the cursor)

import { GXState, GXTevColorArg as C, GXTevAlphaArg as A } from '../../../gx/GXState.js';
import { CharWriter } from '../../../nw4r/ut/CharWriter.js';
import { LogicalScreen } from '../../render/LogicalScreen.js';
import { mat4FromRows, IDENTITY4 } from '../../render/LytRenderer.js';

export class SceneDraw2D {
    /** @param gx GXWebGL  @param lyt LytRenderer  @param width logical screen width */
    constructor(gx, lyt, width) {
        this.gx = gx; this.lyt = lyt; this.width = width;
        this._tplTextures = new Map();
    }

    /** SetOrtho2D: x 0..W, y 0..H (top = 0). */
    get proj() {
        return mat4FromRows([[2 / this.width, 0, 0, -1], [0, -2 / LogicalScreen.height, 0, 1], [0, 0, -1 / 200, 0.5], [0, 0, 0, 1]]);
    }

    _vtx(out, x, y, c, u, v) {
        const o = out.length;
        for (let i = 0; i < 26; i++) out.push(0);
        out[o] = x; out[o + 1] = y; out[o + 6] = c[0]; out[o + 7] = c[1]; out[o + 8] = c[2]; out[o + 9] = c[3];
        out[o + 10] = u; out[o + 11] = v;
    }

    /** Setup2DRender TEV with C0 = colour, C1 = 0. */
    setup2D(color) {
        const s = new GXState();
        s.setNumChans(0); s.setNumTexGens(1); s.setTexCoordGen(0, 1, 4);
        s.setTevOrder(0, 0, 0, 0xFF);
        s.setTevColorIn(0, C.zero, C.texc, C.c0, C.c1);
        s.setTevAlphaIn(0, A.zero, A.texa, A.a0, A.a1);
        s.setTevColorOp(0, 0, 0, 0, true, 0);
        s.setTevAlphaOp(0, 0, 0, 0, true, 0);
        s.setTevSwapModeTable(0, 0, 1, 2, 3);
        s.setNumTevStages(1);
        s.setTevColor(1, [color[0], color[1], color[2], color[3]]);
        s.setTevColor(2, [0, 0, 0, 0]);
        s.setBlendMode(1, 4, 5, 0xF);
        s.setAlphaCompare(4, 0, 0, 7, 0);
        s.setZMode(false, 7, false);
        return s;
    }

    submit(s, verts, tex, samp, enc) {
        if (!verts.length) return;
        enc.setCullMode('none');
        const dims = [[tex ? tex.width : 1, tex ? tex.height : 1]];
        this.gx.submit(enc, s, verts, this.proj, IDENTITY4, [], [], [tex ?? this.gx.whiteTexture], [samp ?? this.gx.defaultSampler], dims);
    }

    quadVerts(x0, y0, x1, y1, uv = [0, 0, 1, 1], c = [1, 1, 1, 1]) {
        const a = [], b = [], d = [], e = [];
        this._vtx(a, x0, y0, c, uv[0], uv[1]); this._vtx(b, x1, y0, c, uv[2], uv[1]);
        this._vtx(d, x0, y1, c, uv[0], uv[3]); this._vtx(e, x1, y1, c, uv[2], uv[3]);
        return [...a, ...b, ...d, ...b, ...e, ...d];
    }

    /** fn_8002E5C0: solid-colour quad (white texture × colour). */
    fillRect(x0, y0, x1, y1, color, enc) {
        this.submit(this.setup2D(color), this.quadVerts(x0, y0, x1, y1), null, null, enc);
    }

    /** fn_80031BE8 DrawTPLImage(tpl, index, pos, sx, sy) with Setup2DRender's C0 tint. */
    image(tpl, index, x, y, sx = 1, sy = 1, color = [255, 255, 255, 255], key, enc) {
        if (index < 0 || index >= tpl.images.length) return;
        const img = tpl.images[index];
        const k = `${key}#${index}`;
        let tex = this._tplTextures.get(k);
        if (!tex) { tex = this.gx.makeTexture2D(img.rgba8, img.width, img.height, k); this._tplTextures.set(k, tex); }
        const samp = this.gx.sampler(0, 0, 1, 1);
        this.submit(this.setup2D(color), this.quadVerts(x, y, x + img.width * sx, y + img.height * sy), tex, samp, enc);
    }

    /**
     * Draw a texture (frame capture / off-screen scene: a RenderTarget's `.color`, or any GXTexture) as a quad with
     * alpha (Setup2DRender, C0 = (255,255,255,a)).
     */
    texture(tex, x0, y0, x1, y1, uv = [0, 0, 1, 1], alpha, enc) {
        const s = this.setup2D([255, 255, 255, alpha]);
        s.setAlphaCompare(7, 0, 0, 7, 0);
        if (alpha === 255) s.setBlendMode(0, 1, 0, 0xF);
        const samp = this.gx.sampler(0, 0, 1, 1);
        this.submit(s, this.quadVerts(x0, y0, x1, y1, uv), tex, samp, enc);
    }

    /** TextWriter::CalcStringWidth (scale 1, no char space) — used to fit text to boxes. */
    static stringWidth(text, font, scale = 1) {
        return text.reduce((a, c) => a + font.glyph(c).widths.charWidth * scale, 0);
    }

    /** TextWriter::Print at (x, y) with draw flags 0x111 (centre on the cursor) and colour mapping min/max. */
    text(s, font, x, y, scale = [1, 1], color, minColor = [0, 0, 0, 0], maxColor = [255, 255, 255, 255], centered = true, enc) {
        if (!s.length) return;
        const state = CharWriter.setupGX(font.sheetFormat, minColor, maxColor);
        const size = [font.width * scale[0], font.height * scale[1]];
        const quads = CharWriter.layout(s, font, size, 0, 0, [0, 0], 0, 1, color, color);
        // Block extents for centring
        const w = quads.reduce((m, q) => Math.max(m, q.rect[2]), 0);
        let lines = 1; for (const ch of s) if (ch === 0x0A) lines++;
        const h = lines * font.lineFeed * scale[1];
        const ox = centered ? x - w / 2 : x, oy = centered ? y - h / 2 : y;
        const sheetTex = this.lyt.sheets(font);
        const samp = this.gx.sampler(0, 0, 1, 1);
        const c = [color[0] / 255, color[1] / 255, color[2] / 255, color[3] / 255];
        const bySheet = new Map();
        for (const q of quads) {
            // layout rects are y-up (negative downward) relative to the block top-left
            let arr = bySheet.get(q.sheet);
            if (!arr) { arr = []; bySheet.set(q.sheet, arr); }
            arr.push(...this.quadVerts(ox + q.rect[0], oy - q.rect[1], ox + q.rect[2], oy - q.rect[3], q.uv, c));
        }
        for (const [sheet, v] of bySheet) if (sheet < sheetTex.count) this._submitText(state, v, sheetTex.get(sheet), samp, font, enc);
    }

    _submitText(s, verts, tex, samp, _font, enc) {
        s.setChanCtrl(GXState.color0a0, false, 0, 1);
        this.submit(s, verts, tex, samp, enc);
    }
}
