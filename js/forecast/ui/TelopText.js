import * as B from './bridge.js';

/**
 * nw4r::ut::TextWriter-style free text in SetOrtho2D screen space (y down), as the pages use for telops
 * (weather names, wind, weekday, city name). Draw flags follow TextWriter::SetDrawFlag:
 * bits 0-1 line alignment (0 left, 1 centre, 2 right), bits 4-5 horizontal origin, bits 8-9 vertical origin.
 */
export class TelopText {
    constructor(ctx) { this.ctx = ctx; }

    static Style(scale = [1, 1], flags = 0, charSpace = 0, lineSpace = 0) { return { scale, flags, charSpace, lineSpace }; }
    static style(o = {}) { return { scale: o.scale ?? [1, 1], flags: o.flags ?? 0, charSpace: o.charSpace ?? 0, lineSpace: o.lineSpace ?? 0 }; }

    static lines(s) { return s.split('\n').map(B.utf16); }

    lineWidth(l, f, st) {
        if (!l.length) return 0;
        let w = 0;
        for (const c of l) w += f.glyph(c).widths.charWidth * st.scale[0] + st.charSpace;
        return w - st.charSpace;
    }

    /** TextWriter::CalcStringWidth */
    width(s, f, st = TelopText.style()) { return Math.max(0, ...TelopText.lines(s).map(l => this.lineWidth(l, f, st))); }
    /** TextWriter::CalcStringHeight */
    height(s, f, st = TelopText.style()) {
        const n = TelopText.lines(s).length;
        return n * f.lineFeed * st.scale[1] + (n - 1) * st.lineSpace;
    }

    /**
     * TextWriter::Print at cursor `p`.
     * `clipY` ([lo, hi] screen y range) emulates the GXSetScissor band the telop ticker draws inside: glyph quads are
     * cut against it with their texture coordinates adjusted.
     */
    draw(s, f, p, st = TelopText.style(), color, enc, clipY = null) {
        const ls = TelopText.lines(s);
        const widths = ls.map(l => this.lineWidth(l, f, st));
        const bw = Math.max(0, ...widths), bh = this.height(s, f, st);
        const hOrigin = (st.flags >> 4) & 3, vOrigin = (st.flags >> 8) & 3, align = st.flags & 3;
        const x0 = p[0] - (hOrigin === 1 ? bw / 2 : hOrigin === 2 ? bw : 0);
        const y0 = p[1] - (vOrigin === 1 ? bh / 2 : vOrigin === 2 ? bh : 0);
        const lineH = f.lineFeed * st.scale[1] + st.lineSpace;
        const bySheet = new Map();
        ls.forEach((l, i) => {
            let x = x0 + (align === 1 ? (bw - widths[i]) / 2 : align === 2 ? bw - widths[i] : 0);
            const y = y0 + i * lineH;
            for (const c of l) {
                const g = f.glyph(c);
                const gw = g.widths.glyphWidth;
                const left = x + g.widths.left * st.scale[0];
                // half-texel pad each side (the sheet's cell gutter is blank): magnified + filtered glyphs keep their
                // anti-aliased edge instead of being cut flat at the glyph width.
                const pad = 0.5;
                const t = [(g.cellX - pad) / f.sheetWidth, g.cellY / f.sheetHeight,
                           (g.cellX + gw + pad) / f.sheetWidth, (g.cellY + f.cellHeight) / f.sheetHeight];
                const r = [left - pad * st.scale[0], y, left + (gw + pad) * st.scale[0], y + f.cellHeight * st.scale[1]];
                if (clipY) {
                    if (r[3] <= clipY[0] || r[1] >= clipY[1]) { x += g.widths.charWidth * st.scale[0] + st.charSpace; continue; }
                    const h = r[3] - r[1], dv = t[3] - t[1];
                    if (r[1] < clipY[0]) { t[1] += dv * (clipY[0] - r[1]) / h; r[1] = clipY[0]; }
                    if (r[3] > clipY[1]) { t[3] -= dv * (r[3] - clipY[1]) / h; r[3] = clipY[1]; }
                }
                if (!bySheet.has(g.sheet)) bySheet.set(g.sheet, []);
                bySheet.get(g.sheet).push([r, t]);
                x += g.widths.charWidth * st.scale[0] + st.charSpace;
            }
        });
        const sheets = B.fontSheets(this.ctx.lyt, f);
        const fmt = f.sheetFormat;
        const intensity = fmt === B.GXTexFmt.i4 || fmt === B.GXTexFmt.i8 || fmt === 'i4' || fmt === 'i8';
        const count = sheets.count ?? sheets.length;
        for (const [sheet, quads] of bySheet) {
            if (sheet >= count) continue;
            const tex = typeof sheets.get === 'function' ? sheets.get(sheet) : sheets[sheet];
            B.drawScreenQuads(this.ctx.lyt, tex, quads, color, this.ctx.screenWidth, enc, intensity);
        }
    }

    /** fn_8001C89C pattern: fit `s` into (maxW, maxH) by shrinking the scale, then draw shadow (+1,+1) and text. */
    drawFitted(s, f, p, maxSize, scale, flags, color, shadow, enc) {
        const st = TelopText.style({ scale, flags });
        let sx = scale[0], sy = scale[1];
        const w = this.width(s, f, st), h = this.height(s, f, st);
        if (w > maxSize[0] && w > 0) sx = scale[0] * maxSize[0] / w;
        if (h > maxSize[1] && h > 0) sy = scale[1] * maxSize[1] / h;
        const k = Math.min(sx, sy);
        st.scale = [k, k];
        if (shadow) this.draw(s, f, [p[0] + 1, p[1] + 1], st, shadow, enc);
        this.draw(s, f, p, st, color, enc);
    }
}
