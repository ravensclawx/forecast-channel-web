import { PaneCtl } from './PaneCtl.js';
import { calculate, findPane, lytDraw } from './bridge.js';

/**
 * CLayout (0x434, fn_80039994) — a weather_layout.arc layout plus one CPaneCtl per root child,
 * layout-wide slide/fade, hit testing and widescreen location adjust.
 */
export class UILayout {
    /** CLayout(arc, name, ?, colorScheme, wideFlag) */
    constructor(layout, lang, colorScheme = 0, isWide = false) {
        this.layout = layout;
        this.isWide = isWide;
        this.panes = (layout.root.children ?? []).slice(0, 256).map(p => new PaneCtl(p, lang, colorScheme));   // +14[], count +414
        this.slidingOut = false;    // +418 (Swift `slideOut`; renamed — JS can't share it with the method)
        this.slideMax = 15;         // +41C
        this.slideCount = 0;        // +420
        this.fadeOut = false;       // +424
        this.fadeMax = 0;           // +428
        this.fadeCount = 0;         // +42C
        this.layoutAlpha = 255;     // +430
        this.visible = true;
        calculate(layout.root, this.locationAdjust);
        this.panes.forEach(p => p.computeHitRect());
    }

    static fromAssets(assets, name, lang, colorScheme = 0, isWide = false) {
        return new UILayout(assets.layout(name), lang, colorScheme, isWide);
    }

    /** DrawInfo::SetLocationAdjustScale(1/1.3684211, 1) in widescreen. */
    get locationAdjust() { return this.isWide ? [1 / 1.3684211, 1] : null; }

    // MARK: - iPhone portrait placement

    /**
     * Move root pane groups (and their hit rects) to new layout-space positions (origin = screen centre, y up).
     * `offsets`: { paneName: [dx, dy] } added to the authored position.
     */
    place(offsets) {
        for (const p of this.panes) {
            const d = offsets[p.name];
            if (!d) continue;
            p.baseTranslate = [p.authored[0] + d[0], p.authored[1] + d[1], p.authored[2]];
            p.pane.translate = [...p.baseTranslate];
        }
        this.relayout();
    }
    /** Move every root pane group by the same offset. */
    placeAll(d, except = new Set()) {
        const o = {};
        for (const p of this.panes) if (!except.has(p.name)) o[p.name] = d;
        this.place(o);
    }
    /** Recompute matrices and hit rects after panes moved or scaled. */
    relayout() {
        calculate(this.layout.root, this.locationAdjust);
        this.panes.forEach(p => p.computeHitRect());
    }

    /** CLayout_FindPane */
    find(name) { return this.panes.find(p => p.name === name) ?? null; }
    pane(name) { return typeof this.layout.find === 'function' ? this.layout.find(name) : findPane(this.layout.root, name); }

    /** CLayout_Reset (fn_80039D40) */
    reset() {
        for (const p of this.panes) { p.hoverRamp = 0; p.pressTimer = 0; p.keepPressed = false; p.selected = false; p.slideOffset = 0; }
        this.slideCount = 0; this.slidingOut = false; this.fadeCount = 0; this.fadeOut = false;
    }

    /** CLayout_Update (fn_80039E28) */
    update() {
        this.panes.forEach(p => p.update());
        if (this.slidingOut) { if (this.slideCount < this.slideMax) this.slideCount += 1; } else if (this.slideCount > 0) this.slideCount -= 1;
        const first = this.panes[0];
        const h = first ? Math.abs(first.hitRect[1] - first.hitRect[3]) : 0;
        for (const p of this.panes) {
            const sign = p.pane.translate[1] > 0 ? 1 : -1;
            p.slideOffset = h * this.slideCount / Math.max(this.slideMax, 1) * sign;
        }
        if (this.fadeOut) { if (this.fadeCount < this.fadeMax) this.fadeCount += 1; } else if (this.fadeCount > 0) this.fadeCount -= 1;
        this.layoutAlpha = this.fadeMax > 0 ? (255 - Math.trunc(255 * this.fadeCount / this.fadeMax)) : 255;
        for (const p of this.panes) p.alpha = this.layoutAlpha;
    }

    get isSlidOut() { return this.slideCount >= this.slideMax; }
    /** fn_8003A2A4 / fn_8003A2D0: slide in / out over `frames`; a new length rescales the current count. */
    slideIn(frames) { this.slidingOut = false; this._setSlideMax(frames); }
    slideOut(frames) { this.slidingOut = true; this._setSlideMax(frames); }
    _setSlideMax(n) {
        if (n === this.slideMax || !(this.slideMax > 0)) return;
        this.slideCount = Math.trunc(this.slideCount * n / this.slideMax); this.slideMax = n;
    }
    get isFadedOut() { return this.fadeMax > 0 && this.fadeCount >= this.fadeMax; }

    /** CLayout_Draw (fn_8003A00C): 608x456 ortho; pre-draw every wrapper; Layout::Draw. */
    draw(r, enc) {
        if (!this.visible) return;
        this.panes.forEach(p => p.preDraw());
        lytDraw(r, this.layout, enc, 608, this.locationAdjust);
    }

    /** CLayout_HitTest (fn_8003A140): topmost enabled, visible wrapper containing (x, y) in layout space. */
    hitTest(x, y) {
        if (this.fadeOut && this.fadeCount >= this.fadeMax && this.fadeMax > 0) return null;
        for (let i = this.panes.length - 1; i >= 0; i--) {
            const p = this.panes[i];
            if (!p.hidden && p.pane.visible && !p.disabled && p.contains(x, y)) return p;
        }
        return null;
    }
}
