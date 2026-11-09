import * as B from './bridge.js';
import * as LS from '../render/LogicalScreen.js';

const halfHeight = () => LS.LogicalScreen?.halfHeight ?? (LS.LogicalScreen?.height ?? 456) / 2;
const s8 = (v) => (v << 24) >> 24;

/**
 * TPLCommon / TPLWeather sprite drawing (d_scene.cpp):
 * - DrawSpriteString (fn_8003E414) / DrawSpriteNumberCentered (fn_8003E150) — small digits table lbl_8018F668 (records 0…)
 * - fn_8003F214 / fn_8003F088 — large digits table lbl_8018F6D0 (records 0x21…)
 * - FormatIntW (fn_800362D8) — digits lbl_8018F4D0
 * - weather icons fn_80020574 → layer lists (fn_80020AD4 / fn_80020938 / fn_80020CCC) drawn from TPLWeather.
 * All constant tables are read from the user's main.dol at runtime. Coordinates: SetOrtho2D screen pixels (y down).
 * Colours are [r, g, b, a] (0..255).
 */
export class SpriteText {
    static Table = Object.freeze({ small: 'small', large: 'large' });

    // Colour constants from the page static-init (fn_80010728): white / shadow / high / low …
    static white = [255, 255, 255, 255];        // lbl_80330A0C
    static shadow = [0x20, 0x20, 0x20, 255];    // lbl_80330A10
    static red = [0xEE, 0, 0, 255];             // lbl_80330A14
    static cyan = [0, 0xFF, 0xFF, 255];         // lbl_80330A18
    static lightGrey = [0xEE, 0xEE, 0xEE, 255]; // lbl_80330A1C
    static pink = [0xFF, 0xC0, 0xC0, 255];      // lbl_80330A24
    static blue = [0, 0, 0xFF, 255];            // lbl_80330A30
    static lightCyan = [0x80, 0xFF, 0xFF, 255]; // lbl_80330A3C
    static yellow = [0xFF, 0xD0, 0, 255];       // lbl_80330A40

    constructor(ctx) {
        this.ctx = ctx;
        const arc = B.weatherArchive(ctx.assets);
        const c = arc.find('TPLCommon.tpl.LZ'), w = arc.find('TPLWeather.tpl.LZ');
        if (!c || !w) throw new Error('missing TPLCommon/TPLWeather');
        this.common = B.tplFile(B.uncompressIfNeeded(c));
        this.weather = B.tplFile(B.uncompressIfNeeded(w));
        this.commonTex = new Map(); this.weatherTex = new Map();
        const dol = B.dolImage(B.mainDolBytes(ctx.assets));
        this.smallCodes = Array.from({ length: 18 }, (_, i) => dol.u16(0x8018F668 + i * 2));    // lbl_8018F668 (18)
        this.largeCodes = Array.from({ length: 0x2F }, (_, i) => dol.u16(0x8018F6D0 + i * 2));  // lbl_8018F6D0 (0x2F)
        this.digitCodes = Array.from({ length: 10 }, (_, i) => dol.u16(0x8018F4D0 + i * 2));    // lbl_8018F4D0
        // CScene ctor: for i in 0..<0x59: rec[i] = {lbl_8018F4E8[i], TPL width, TPL height}
        /** lbl_801F6E80: {image, w, h} for the 0x59 codes listed in lbl_8018F4E8. */
        this.records = Array.from({ length: 0x59 }, (_, i) => {
            const img = dol.u32(0x8018F4E8 + i * 4);
            const im = this.common.images[img];
            return { image: img, w: im?.width ?? 0, h: im?.height ?? 0 };
        });
        /** Icon code (0..0x7E) → list of layers (fn_80020574 jump table → lbl_8017A038…). */
        this.iconLayers = new Map();
        this._decodeIconTables(dol);
        this._opaqueCache = new Map();
    }

    // MARK: - Icon tables

    /** fn_80020574: `jumptable_8019AF48[code]` → case block `lis r3,hi ; addi r3,r3,lo ; b` → layer list address. */
    _decodeIconTables(dol) {
        const jt = 0x8019AF48;
        for (let code = 0; code <= 0x7E; code++) {
            const target = dol.u32(jt + code * 4);
            const i0 = dol.u32(target), i1 = dol.u32(target + 4);
            if ((i0 >>> 26) !== 15 || (i1 >>> 26) !== 14) continue;   // lis / addi
            const hi = (i0 & 0xFFFF) << 16 >> 16, lo = (i1 & 0xFFFF) << 16 >> 16;
            let addr = ((hi << 16) + lo) >>> 0;
            const layers = [];
            while (layers.length < 16) {
                const img = dol.u32(addr);
                if (img === 0xFFFFFFFF) break;
                const col = (o) => { const v = dol.u32(addr + o); return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]; };
                layers.push({ image: img, offset: [dol.f32(addr + 4), dol.f32(addr + 8)], scale: dol.f32(addr + 0xC), main: col(0x10), shadow: col(0x14) });
                addr += 0x18;
            }
            if (layers.length) this.iconLayers.set(code, layers);
        }
    }

    texture(tpl, i, cache) {
        if (cache.has(i)) return cache.get(i);
        const img = tpl.images[i];
        if (!img) return null;
        const t = B.makeTexture(this.ctx.lyt, img, `tpl${i}`);
        cache.set(i, t);
        return t;
    }

    /** Prewarm: upload every TPLCommon / TPLWeather image (weather icons, digits, credits) ahead of first use. */
    prewarmJobs() {
        return [...this.common.images.map((_, i) => () => this.texture(this.common, i, this.commonTex)),
                ...this.weather.images.map((_, i) => () => this.texture(this.weather, i, this.weatherTex))];
    }

    /** TPL_GetImageWidth/Height for an image of TPLCommon (common) or TPLWeather. */
    imageSize(isCommon, index) {
        const img = (isCommon ? this.common : this.weather).images[index];
        return [img?.width ?? 0, img?.height ?? 0];
    }

    /** fn_80031BE8: TPL image `index` with its top-left at `p`, scaled. */
    drawImage(isCommon, index, p, sx, sy, color, enc) {
        const tex = isCommon ? this.texture(this.common, index, this.commonTex) : this.texture(this.weather, index, this.weatherTex);
        if (!tex) return;
        B.drawScreenQuad(this.ctx.lyt, tex, p[0], p[1], B.texW(tex) * sx, B.texH(tex) * sy, color, this.ctx.screenWidth, enc);
    }

    // MARK: - Strings

    recordIndex(c, t) {
        if (t === SpriteText.Table.small) { const i = this.smallCodes.indexOf(c); return i < 0 ? null : i; }
        const i = this.largeCodes.indexOf(c); return i < 0 ? null : i + 0x21;
    }

    /** Total advance width (unscaled) the centering helpers use. */
    width(s, t) { let w = 0; for (const c of s) { const i = this.recordIndex(c, t); if (i != null && this.records[i]) w += this.records[i].w; } return w; }

    /**
     * DrawSpriteString / fn_8003F214: `p` = centre of the first glyph; each next glyph advances by
     * scale·(−1 + ½·prevW + ½·curW). Shadow pass at +2,+2 first.
     */
    drawString(s, p, sx, sy, color, shadow, table, enc) {
        let x = p[0], prevW = null;
        for (const c of s) {
            const ri = this.recordIndex(c, table), r = ri != null ? this.records[ri] : null;
            if (!r) continue;
            if (prevW != null) x += sx * (-1 + 0.5 * prevW + 0.5 * r.w);
            prevW = r.w;
            const tl = [x - 0.5 * r.w * sx, p[1] - 0.5 * r.h * sy];
            this.drawImage(true, r.image, [tl[0] + 2, tl[1] + 2], sx, sy, shadow, enc);
            this.drawImage(true, r.image, tl, sx, sy, color, enc);
        }
    }

    /** DrawSpriteNumberCentered / fn_8003F088: centre the whole string on `center`. */
    drawCentered(s, center, sx, sy, color, shadow = SpriteText.shadow, table = SpriteText.Table.large, enc) {
        if (!s.length) return;
        const fi = this.recordIndex(s[0], table);
        if (fi == null) return;
        const total = this.width(s, table);
        const p = [center[0] - sx * (0.5 * total - 0.5 * this.records[fi].w), center[1]];
        this.drawString(s, p, sx, sy, color, shadow, table, enc);
    }

    /** FormatIntW(value, out, maxDigits, zeroPad) — wide digits, leading '-' for negatives. */
    formatInt(value, maxDigits = 3, zeroPad = false) {
        let v = Math.abs(value); const digits = [];
        do { digits.unshift(this.digitCodes[v % 10]); v = Math.trunc(v / 10); } while (v > 0 && digits.length < maxDigits);
        if (zeroPad) while (digits.length < maxDigits) digits.unshift(this.digitCodes[0]);
        return (value < 0 ? [0x2D] : []).concat(digits);
    }

    /** Draw an integer (or "--" when null) centred at `center` in the large sprite font. */
    drawNumber(value, center, scale = 1, color = SpriteText.white, shadow = SpriteText.shadow, table = SpriteText.Table.large, enc) {
        const s = value != null ? this.formatInt(value) : [0x2D, 0x2D];
        this.drawCentered(s, center, scale, scale, color, shadow, table, enc);
    }

    // MARK: - Weather icons

    /**
     * fn_80020574(iconCode, pos, alpha, scale): code & 0x7FFF selects the layer list, bit 15 = night
     * (layer image 4 → 1, 15 → 0xB); codes < 0x64 draw with a shadow (fn_80020CCC), others without (fn_80020E48).
     * Unknown codes draw "--".
     */
    drawWeatherIcon(code, center, alpha = 255, scale = 1, enc) {
        const c = code & 0x7FFF, night = (code & 0x8000) !== 0;
        const layers = c <= 0x7E ? this.iconLayers.get(c) : null;
        if (!layers) {
            const w = SpriteText.white.slice(), s = SpriteText.shadow.slice(); w[3] = alpha; s[3] = alpha;
            this.drawCentered([0x2D, 0x2D], center, scale, scale, w, s, SpriteText.Table.large, enc);
            return;
        }
        const a = alpha / 255;
        for (const l of layers) {
            let img = l.image;
            if (night) { if (img === 4) img = 1; else if (img === 15) img = 0xB; }
            const p = [center[0] + l.offset[0] * scale, center[1] + l.offset[1] * scale];
            const s = l.scale * scale;
            const tex = this.texture(this.weather, img, this.weatherTex);
            if (!tex) continue;
            const tl = [p[0] - s * 0.5 * B.texW(tex), p[1] - s * 0.5 * B.texH(tex)];
            const main = l.main.slice(); main[3] = Math.trunc(main[3] * a);
            if (c < 0x64) {
                const sh = l.shadow.slice(); sh[3] = Math.trunc(sh[3] * a);
                this.drawImage(false, img, [tl[0] + 2, tl[1] + 2], s, s, sh, enc);
            }
            this.drawImage(false, img, tl, s, s, main, enc);
        }
    }

    // MARK: - Anchors

    /**
     * Pane_GetScreenCenter + the screen mapping the pages use: layout point (design 608 space, y up) →
     * SetOrtho2D pixels: x = W/2 + x·wideScale, y = H/2 − y.
     */
    screenPoint(lp) {
        const k = this.ctx.isWide ? 1.3684211 : 1;
        return [this.ctx.screenWidth / 2 + lp[0] * k, halfHeight() - lp[1]];
    }

    /** Centre of a pane's rectangle in layout space (uses the pane's last calculated global matrix). */
    static layoutCenter(p) {
        const o = p.vertexOrigin, s = p.size;
        return B.xform(p.globalMtx, o[0] + s[0] / 2, o[1] - s[1] / 2);
    }

    // MARK: - Globe marker helpers

    /** fn_8003EF80 / fn_8003F024: unscaled advance width (sum of record widths) and max record height of a string. */
    stringSize(s, table = SpriteText.Table.large) {
        let h = 0;
        for (const c of s) { const i = this.recordIndex(c, table); const r = i != null ? this.records[i] : null; if (r) h = Math.max(h, r.h); }
        return [this.width(s, table), h];
    }

    /** fn_8003F088 → fn_8003F214: string centred on `center`; per glyph `back` at (+2,+2) then `front`. */
    drawCenteredTwoPass(s, center, scale, back, front, table = SpriteText.Table.large, enc) {
        if (!s.length) return;
        const fi = this.recordIndex(s[0], table), r0 = fi != null ? this.records[fi] : null;
        if (!r0) return;
        const total = this.width(s, table);
        const start = [center[0] - scale * (0.5 * total - 0.5 * r0.w), center[1]];
        // fn_8003F214, per glyph: `back` at (+2,+2), then `front`. The advance is scale·(½·prevW + ½·curW) — f2 is
        // reloaded with the previous glyph's width at 0x8003F428 (no −1 here, unlike DrawSpriteString).
        let x = start[0], prevW = null;
        for (const c of s) {
            const ri = this.recordIndex(c, table), r = ri != null ? this.records[ri] : null;
            if (!r) continue;
            if (prevW != null) x += scale * (0.5 * prevW + 0.5 * r.w);
            prevW = r.w;
            const tl = [x - 0.5 * r.w * scale, start[1] - 0.5 * r.h * scale];
            this.drawImage(true, r.image, [tl[0] + 2, tl[1] + 2], scale, scale, back, enc);
            this.drawImage(true, r.image, tl, scale, scale, front, enc);
        }
    }

    /** fn_8002E9EC → fn_8002E804: untextured quad [x0, y0, x1, y1] with per-corner colours in TL, BL, BR, TR order. */
    drawGradientRect(r, c, enc) { B.drawGradientRect(this.ctx.lyt, r, c, this.ctx.screenWidth, enc); }

    /** fn_8001C714: a TPLCommon image centred on `center`, shadow first at +offset. */
    drawImageCentered(image, center, scale, color, shadow, shadowOffset, enc) {
        const im = this.common.images[image];
        if (!im) return;
        const tl = [center[0] - scale * 0.5 * im.width, center[1] - scale * 0.5 * im.height];
        this.drawImage(true, image, [tl[0] + shadowOffset, tl[1] + shadowOffset], scale, scale, shadow, enc);
        this.drawImage(true, image, tl, scale, scale, color, enc);
    }

    /**
     * Union of a weather icon's layer rects at scale 1, relative to the draw centre (drawWeatherIcon geometry).
     * Measured on the visible artwork (alpha > 1/8), not the texture box.
     */
    iconBounds(code) {
        const layers = this.iconLayers.get(code & 0x7FFF);
        if (!layers?.length) return null;
        let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
        const night = (code & 0x8000) !== 0;
        for (const l of layers) {
            let img = l.image;
            if (night) { if (img === 4) img = 1; else if (img === 15) img = 0xB; }   // drawWeatherIcon's night swap
            const o = this.opaqueRect(img);
            if (!o) continue;
            const size = this.imageSize(false, img);
            const a = [(o[0][0] - size[0] / 2) * l.scale + l.offset[0], (o[0][1] - size[1] / 2) * l.scale + l.offset[1]];
            const b = [(o[1][0] - size[0] / 2) * l.scale + l.offset[0], (o[1][1] - size[1] / 2) * l.scale + l.offset[1]];
            lo = [Math.min(lo[0], a[0], b[0]), Math.min(lo[1], a[1], b[1])];
            hi = [Math.max(hi[0], a[0], b[0]), Math.max(hi[1], a[1], b[1])];
        }
        return lo[0] <= hi[0] ? { min: lo, max: hi } : null;
    }

    /** Pixel bounding box of a TPLWeather image's visible pixels (alpha > 32), in texture pixels. */
    opaqueRect(i) {
        if (this._opaqueCache.has(i)) return this._opaqueCache.get(i);
        const im = this.weather.images[i];
        if (!im) return null;
        let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
        const px = im.rgba8;
        for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
            if (px[(y * im.width + x) * 4 + 3] > 32) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        const r = x1 < 0 ? null : [[x0, y0], [x1 + 1, y1 + 1]];
        this._opaqueCache.set(i, r);
        return r;
    }
}
export { s8 };
