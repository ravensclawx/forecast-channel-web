import { LogicalScreen } from '../render/LogicalScreen.js';
import { PortraitSlots } from '../render/PortraitSlots.js';
import { isTextBox } from '../ui/bridge.js';

/**
 * Mobile-portrait arrangements shared by the dialog-style screens (settings, address, messages, connect).
 * Everything is a no-op unless LogicalScreen.isPortrait. Layout space: origin = screen centre, y up.
 * Web: no edge-to-edge extension of the button rows (the iPhone's extendBodies/edgeStrip/hit extension) — the
 * page is letterboxed, so the rows keep their original art.
 */
export const PortraitArrange = {
    get on() { return LogicalScreen.isPortrait; },

    /** Full-screen 608×456 background pictures cover the whole tall screen (scale Y about the centre). */
    stretchBackgrounds(ui, names = new Set(['bg', 'bg_filter', 'back_00', 'back_01', 'back_02'])) {
        if (!this.on) return;
        let changed = false;
        for (const p of ui.panes) if (names.has(p.name)) { p.pane.scale[1] = PortraitSlots.backgroundScaleY; changed = true; }
        if (changed) ui.relayout();
    },

    /**
     * Shift root pane groups: `top` → under the safe area (as the original top row), `bottom` → thumb zone (as the
     * original bottom row), `extra` → arbitrary offsets. Everything else stays centred.
     */
    place(ui, top = [], bottom = [], extra = {}) {
        if (!this.on) return;
        const d = { ...extra };
        for (const n of top) d[n] = [0, PortraitSlots.topRowShift];
        for (const n of bottom) d[n] = [0, PortraitSlots.bottomRowShift];
        ui.place(d);
    },

    /** Replace an (English) text box's text — mobile wording for Wii-specific strings. */
    setText(ui, name, s) {
        const p = ui.pane(name);
        if (isTextBox(p)) p.text = Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
    },

    /** Web: no-op (kept so call sites match the Swift code). */
    extendBodies(_ui, _names, _toTop, _overlap = 40) {},

    /**
     * Vertical shift that moves dialog buttons (authored in the lower half of the 456 screen) into the thumb zone:
     * the lowest one lands `margin` above the bottom row's top edge.
     */
    thumbShift(lowestY, margin = 40) {
        if (!this.on) return 0;
        const rowTop = PortraitSlots.safeBottomY + PortraitSlots.rowHeight;
        return (rowTop + margin) - lowestY;
    },

    /**
     * Vertical shift that moves a dialog's text block (authored near the top of the 456 screen) up by part of the
     * extra height so the dialog reads as a sheet: header high, buttons low.
     */
    textShift(fraction = 0.22) {
        if (!this.on) return 0;
        return (LogicalScreen.height - 456) * fraction;
    },
};


/**
 * Web: the top button row (the bottom row's art mirrored) shows the button art's light label band and highlight
 * line along its lower edge. Replace that white shine with the grey body gradient continued up to the belt: the
 * pictures of the given wrappers sample a derived copy of their texture ("<name>#topflat") whose rows from just past
 * the dark edge line through the light band repeat the first gradient row. The bottom row keeps the original art.
 */
export function flattenTopShine(ctx, ui, names) {
    const lyt = ctx.lyt;
    if (!lyt._topFlat) {
        lyt._topFlat = true;
        const base = lyt.textureProvider, cache = new Map();
        lyt.textureProvider = (name) => {
            if (!name.endsWith('#topflat')) return base(name);
            if (cache.has(name)) return cache.get(name);
            const img = base(name.slice(0, -'#topflat'.length));
            if (!img) return null;
            const w = img.width, h = img.height, px = new Uint8Array(img.rgba8);
            // btn art rows (80 tall): 0–1 dark edge, 2–4 highlight, 5–24 light label band, 25… grey gradient.
            const from = Math.round(2 * h / 80), to = Math.round(25 * h / 80);
            for (let y = from; y < to; y++) px.copyWithin(y * w * 4, to * w * 4, (to + 1) * w * 4);
            const out = { ...img, rgba8: px };
            cache.set(name, out);
            return out;
        };
    }
    const layout = ui.layout;
    const visit = (p) => {
        const m = p.material;
        if (m && m.texMaps) {
            m.texMaps.forEach((tm, slot) => {
                const n = layout.textureNames[tm.texture];
                if (n && /^btn\d\.tpl$/.test(n)) m.texturePatternOverride.set(slot, n + '#topflat');
            });
        }
        (p.children ?? []).forEach(visit);
    };
    for (const n of names) { const b = ui.pane ? ui.pane(n + 'B') : null; if (b) visit(b); }
}
