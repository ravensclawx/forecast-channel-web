// Track E ↔ other tracks: every call the scenes/UI make into A (rvl/gx/system), B (render), C (nw4r/sound) and
// D (data) goes through here, so API differences are reconciled in one file. Namespace imports never fail at link
// time when a name is missing.
import { WPAD } from '../system/KPad.js';
import { Content } from '../system/Assets.js';
import * as LayoutMod from '../../nw4r/lyt/Layout.js';
import * as DOLMod from '../../rvl/DOL.js';
import * as BRMod from '../../rvl/BinaryReader.js';
import * as CXMod from '../../rvl/CX.js';
import * as TPLMod from '../../nw4r/lyt/TPL.js';
import * as GXTexMod from '../../gx/GXTexture.js';

// ---- Wii Remote buttons (WPAD_BUTTON_*) -------------------------------------------------------------------------
export { WPAD };
/** OptionSet.contains for button masks (numbers, or objects with rawValue / contains). */
export function has(mask, bit) {
    if (mask == null) return false;
    if (typeof mask === 'number') return (mask & bit) !== 0;
    if (typeof mask.contains === 'function') return mask.contains(bit);
    if ('rawValue' in mask) return (mask.rawValue & bit) !== 0;
    return false;
}

// ---- strings ----------------------------------------------------------------------------------------------------
export const utf16 = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
export const fromUtf16 = (u) => String.fromCharCode(...u);

// ---- lyt panes ---------------------------------------------------------------------------------------------------
export const Lyt = LayoutMod;
export function materialOf(p) { return p?.material ?? null; }
export function isTextBox(p) { return !!p && (LayoutMod.TextBox ? p instanceof LayoutMod.TextBox : ('topColor' in p && 'text' in p)); }
export function isPicture(p) { return !!p && (LayoutMod.Picture ? p instanceof LayoutMod.Picture : ('texCoords' in p && !('content' in p))); }
export function isBounding(p) { return !!p && (LayoutMod.Bounding ? p instanceof LayoutMod.Bounding : p.kind === 'bnd'); }
export function findPane(root, name) {
    if (!root) return null;
    if (typeof root.find === 'function') return root.find(name);
    if (root.name === name) return root;
    for (const c of root.children ?? []) { const r = findPane(c, name); if (r) return r; }
    return null;
}
export function walk(p, fn) { fn(p); for (const c of p.children ?? []) walk(c, fn); }
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Pane.calculate(parentMtx:parentAlpha:locationAdjust:) */
export function calculate(root, locationAdjust = null) { root.calculate(IDENT, 255, locationAdjust); }
/** Pane.vertexOrigin / size / globalMtx as plain arrays. */
export const vertexOrigin = (p) => p.vertexOrigin;
export function xform(m, x, y, z = 0, w = 1) {
    return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w];
}

// ---- rvl ---------------------------------------------------------------------------------------------------------
export function dolImage(bytes) { return new DOLMod.DOLImage(bytes); }
export function beReader(bytes) { return new BRMod.BEReader(bytes); }
export function uncompressIfNeeded(b) { return CXMod.CX?.uncompressIfNeeded ? CXMod.CX.uncompressIfNeeded(b) : CXMod.uncompressIfNeeded(b); }
export function tplFile(bytes) { return new TPLMod.TPLFile(bytes); }
export const GXTexFmt = GXTexMod.GXTexFmt ?? { i4: 0, i8: 1 };

// ---- assets (track A) -----------------------------------------------------------------------------------------------
/** main.dol bytes (Assets.Content.mainDol), cached on the assets object. */
export function mainDolBytes(assets) { return assets.dolBytes(); }
export function weatherArchive(assets) { return assets.archive(Content.weather); }

// ---- LytRenderer / sprites (track B) --------------------------------------------------------------------------------
export function lytDraw(lyt, layout, enc, screenWidth = 608, locationAdjust = null) {
    lyt.draw(layout, enc, screenWidth, undefined, locationAdjust);
}
export function drawScreenQuad(lyt, tex, x, y, w, h, color, screenWidth, enc) {
    lyt.drawScreenQuad(tex, x, y, w, h, color, [0, 0, 1, 1], screenWidth, enc);
}
export function drawScreenQuads(lyt, tex, quads, color, screenWidth, enc, intensityFont = false) {
    lyt.drawScreenQuads(tex, quads, color, screenWidth, enc, undefined, intensityFont);
}
export function drawScreenRect(lyt, x0, y0, x1, y1, color, screenWidth, enc) {
    lyt.drawScreenRect(x0, y0, x1, y1, color, screenWidth, enc);
}
/** fn_8002E9EC: untextured quad with per-corner colours (TL, BL, BR, TR). */
export function drawGradientRect(lyt, r, colors, screenWidth, enc) {
    if (typeof lyt.drawScreenGradient === 'function') return lyt.drawScreenGradient(r, colors, screenWidth, enc);
    if (typeof lyt.drawGradientRect === 'function') return lyt.drawGradientRect(r, colors, screenWidth, enc);
    // Fallback: flat quad in the average colour.
    const avg = [0, 1, 2, 3].map(i => Math.round(colors.reduce((s, c) => s + c[i], 0) / colors.length));
    lyt.drawScreenRect(r[0], r[1], r[2], r[3], avg, screenWidth, enc);
}
export function fontSheets(lyt, font) { return lyt.fontSheets(font); }
export function makeTexture(lyt, img, label) { return lyt.makeTexture(img, label); }
export function texW(t) { return t.logicalWidth ?? t.width; }
export function texH(t) { return t.logicalHeight ?? t.height; }

// ---- enc scissor (logical rect, SetOrtho2D px) ---------------------------------------------------------------------
export function setScissor(enc, rect) {
    if (!enc) return;
    if (rect == null) { enc.clearScissor?.(); enc.setScissorLogical?.(null); return; }
    if (typeof enc.setScissorLogical === 'function') enc.setScissorLogical(rect.x, rect.y, rect.w, rect.h);
    else if (typeof enc.setScissor === 'function') enc.setScissor(rect.x, rect.y, rect.w, rect.h);
}

// ---- sound (track C) ---------------------------------------------------------------------------------------------
export function playSE(sound, id) { sound?.playSE?.(id); }
