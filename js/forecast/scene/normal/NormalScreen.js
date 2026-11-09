import { SpriteText } from '../../ui/SpriteText.js';
import { TelopText } from '../../ui/TelopText.js';
import { PaneCtl, Lang, langSuffix } from '../../ui/PaneCtl.js';
import { LogicalScreen } from '../../render/LogicalScreen.js';
import { PortraitSlots } from '../../render/PortraitSlots.js';
import { PortraitArrange, flattenTopShine } from '../PortraitArrange.js';
import { chaseValue } from '../../game/GlobeMath.js';
import { HubRecord, DOLStrings, UVPage, CurrentPage, DayPage, WeekPage } from './HubPages.js';
import { WPAD, has, calculate, lytDraw, drawScreenRect } from '../../ui/bridge.js';

export const ZoomMode = Object.freeze({ none: 'none', open: 'open', close: 'close' });
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Portrait arrangement of the original rows (layout space, origin = screen centre, y up).
 *   belt (title + city) under the safe area → top button row under the belt → content band →
 *   "supported by" / "As of" strip → bottom button row.
 */
export class Portrait {
    constructor(beltShift, topShift, bottomShift, bandTop, bandBottom) {
        this.beltShift = beltShift;       // belt group + city box (authored y = +130)
        this.topShift = topShift;         // blank / up / set (authored y = +195; body spans +166…+246)
        this.bottomShift = bottomShift;   // back / down / around + the strip (authored −195 / −146)
        this.bandTop = bandTop; this.bandBottom = bandBottom;
    }
    get bandCentre() { return (this.bandTop + this.bandBottom) / 2; }
    get bandHeight() { return this.bandTop - this.bandBottom; }
    static get current() {
        // Original order: the top button row first, then the green belt under it (same 6-unit gap as on the Wii:
        // row bottom +166, belt top +160).
        const top = PortraitSlots.safeTopY;
        const topShift = (top - 40) - 206;             // row body (centre +206, 80 tall) starts at the safe top
        const beltCentre = (166 + topShift) - 6 - 30;  // beltB is 60 tall
        const beltShift = beltCentre - 130;
        const bottomShift = PortraitSlots.bottomRowShift;
        return new Portrait(beltShift, topShift, bottomShift, beltCentre - 30, -135 + bottomShift);
    }
}

/**
 * CNormal (d_weather_normal.cpp, ctor fn_80020F9C) — the hub: buttons (forecast.brlyt), background (base.brlyt),
 * top belt with page title / city telop / clock (base_belt.brlyt), the 6-hour strip (day_6h_nWW.brlyt), and the
 * vertically stacked pages (UV, Current, Today, Tomorrow, 5-Day) scrolled with up/down.
 */
export class NormalScreen {
    constructor(ctx) {
        this.ctx = ctx;
        this.forecast = ctx.layout('forecast.brlyt');     // +00
        this.base = ctx.layout('base.brlyt');             // +04
        this.belt = ctx.layout('base_belt.brlyt');        // +08
        this.sixHours = ctx.layout(ctx.lang === Lang.jp ? 'day_6h_nJP.brlyt' : 'day_6h_nWW.brlyt');   // +0C
        this.sprites = new SpriteText(ctx);
        this.telop = new TelopText(ctx);
        this.strings = new DOLStrings(ctx.assets);
        this.pages = [];                                  // +24[]
        /** TextWriter font lbl_80330BDC = m_pSysFont (wbf1.brfna, content 7). */
        this.telopFont = ctx.assets.systemFont() ?? ctx.assets.font('font_weather_city.brfnt');
        /** lbl_80330BE0 font_weather_timeWW.brfnt */
        this.timeFont = ctx.assets.font(ctx.lang === Lang.jp ? 'font_weather_time.brfnt' : 'font_weather_timeWW.brfnt');
        this.record = null;

        // Scroll (unk72C/730, target unk7E0, state unk800)
        this.scroll = 456;            // +730
        this.scrollState = -1;        // −1 settled/interactive, ≥0 scrolling
        this.reqUp = false; this.reqDown = false;   // +7F7/+7F8
        this.globalAlpha = 1;         // +7D0
        /** +7F9: the button layout is drawn (cleared when the hub zooms back into the globe). */
        this.buttonsVisible = true;

        // Globe ↔ city zoom — fn_80027270 (open, from the tapped marker) / fn_80026DC8 (close, back into it)
        this.zoomMode = ZoomMode.none;
        this.zoomCounter = 0;         // +854 (+0x800 per frame, done past 0x8000 = 16 frames)
        this.zoomFrom = [0, 0];       // +7E8/+7EC
        this.zoomDelta = [0, 0];      // +7E0/+7E4
        this.zoomCentre = [0, 0];     // +768/+76C
        this.zoomRectAlpha = 0;       // +804

        // Belt title alpha (unk810 → unk814), clock alpha (unk81C → unk820)
        this.titleAlpha = 255; this.titleTarget = 255;
        this.clockAlpha = 255; this.clockTarget = 255;
        this.shownTitle = 1;          // +82C belt title text index
        // Title alternation page name ↔ weekday (fn_80026B34): state +828, timer +824
        this.titleState = 0; this.titleTimer = 0xF0;
        // City telop ticker (fn_80027998): state +848, line +84C, timer +850, scroll +7D8
        this.tickerState = 0; this.tickerLine = 0; this.tickerTimer = 0xF0;
        this.tickerScroll = 0;
        // Timestamp "As of …" (fn_8002322C → fn_80023430): text +85C, scale +788/+78C, max width +780
        this.stamp = '';
        this.stampScale = [0.6, 0.6];
        this.stampPage = -1;
        // 6-hour popup (fn_80025FA8): 0 closed, 1 opening, 2 open, 3 closing
        this.popup = 0; this.popupT = 0;     // unk854 in 0..0x8000
        this.exitRequested = false;
        // City telop (CNormal_SetupCityTelop): lines [text, fit scale]; city box (unk790..798, unk794..79C).
        this.cityLines = [];
        this.cityBox = [0, 0, 0, 0];

        // Portrait
        /** Vertical distance between stacked pages (456 on the Wii; the content band height in portrait). */
        this.pageSpacing = ctx.isPortrait ? Math.round(Portrait.current.bandHeight) : 456;
        /** Logical rect → enc scissor rect (set by WeatherScene) — portrait clips the pages to the content band. */
        this.scissor = null;
        /** Portrait one-finger swipe on the page band (▲/▼): accumulated travel, armed per touch. */
        this.swipeAccum = 0; this.swipeArmed = false; this.swipeDone = false; this.lastFingers = 0;

        ctx.startPage = 1;
        if (ctx.isPortrait) this.arrangePortrait();
        flattenTopShine(ctx, this.forecast, ['blank', 'up', 'set']);   // web: no white strip at the top of the top row
        // Pages: page i centred at y = 228 + 456·i (fn_80020F9C).
        this.pages = [new UVPage(this, 'life_nWW.brlyt', 0, 0),
                      new CurrentPage(this, 'day_nWW.brlyt', 1, 1),
                      new DayPage(this, 2, false),
                      new DayPage(this, 3, true),
                      new WeekPage(this, 'week_nWW.brlyt', 4, 4)];
        ctx.pageCount = this.pages.length;
        // fn_800393E8(belt_time wrapper, "belt_timeB") (Pane_SetChildVisible): only belt_timeB<lang> stays visible.
        const g = this.belt.pane('belt_timeB');
        if (g) { const keep = 'belt_timeB' + langSuffix(ctx.lang); for (const c of g.children) if (c.name !== keep) c.visible = false; }
        // City box from the `city` bounding pane (wide: ×1.3684211 about the screen centre).
        const city = this.belt.pane('city');
        if (city) {
            calculate(this.belt.layout.root);
            const k = ctx.isWide ? 1.3684211 : 1;
            const c = SpriteText.layoutCenter(city);
            const w = city.size[0] * k, h = city.size[1];
            const x0 = ctx.screenWidth / 2 + c[0] * k - w / 2;
            const y0 = LogicalScreen.halfHeight - c[1] - h / 2;
            this.cityBox = [x0, y0, x0 + w, y0 + h];
        }
    }

    /** +7F5: the zoom quad is drawn. */
    get zoomActive() { return this.zoomMode !== ZoomMode.none; }
    get screenCentre() { return [this.ctx.screenWidth / 2, LogicalScreen.halfHeight]; }

    /** fn_80027270 step 0: alpha 0, the quad starts at the marker. */
    startOpenZoom(p) {
        this.zoomMode = ZoomMode.open; this.zoomCounter = 0;
        const c = this.screenCentre;
        this.zoomFrom = p.slice(); this.zoomDelta = [c[0] - p[0], c[1] - p[1]];
        this.globalAlpha = 0; this.zoomCentre = p.slice(); this.zoomRectAlpha = 40;
    }
    /** fn_80026DC8 step 0: from the current page's centre (page offset 0 at rest) toward the marker. */
    startCloseZoom(p) {
        this.zoomMode = ZoomMode.close; this.zoomCounter = 0;
        const c = this.screenCentre;
        this.zoomFrom = c; this.zoomDelta = [p[0] - c[0], p[1] - c[1]];
        this.globalAlpha = 1; this.zoomCentre = c.slice(); this.zoomRectAlpha = 0;
    }
    /** The zoom sub-state's frame: t = ½ − ½·CosFIdx(+854 / 256) (fn_800D7AFC, 256 = one turn), so t eases 0 → 1. */
    stepZoom() {
        if (this.zoomMode === ZoomMode.none) return;
        this.zoomCounter += 0x800;
        if (this.zoomCounter > 0x8000) {
            this.globalAlpha = this.zoomMode === ZoomMode.open ? 1 : 0;
            this.zoomMode = ZoomMode.none;
        } else {
            const t = 0.5 - 0.5 * Math.cos(Math.PI * this.zoomCounter / 0x8000);
            this.globalAlpha = this.zoomMode === ZoomMode.open ? t : 1 - t;
            this.zoomCentre = [this.zoomFrom[0] + this.zoomDelta[0] * t, this.zoomFrom[1] + this.zoomDelta[1] * t];
            this.zoomRectAlpha = Math.trunc(40 * (1 - this.globalAlpha));
        }
        this.calcPages();
    }
    calcPages() { this.pages.forEach((p, i) => p.calc([0, this.scroll - this.pageSpacing * i], this.globalAlpha)); }

    /** Band centre / pixel rect, for pages and the 6-hour popup. */
    get portrait() { return Portrait.current; }

    /**
     * Portrait: move the original rows to their portrait slots, stretch the background plate, centre the
     * 6-hour popup in the content band. Hit rects follow (UILayout.place recomputes them).
     * Web: the rows keep their original art (no edge extension; the page is letterboxed).
     */
    arrangePortrait() {
        const ctx = this.ctx;
        // No Wii-Remote glyphs on mobile: the Ⓐ beside "Back" goes, the caption centres.
        const bi = this.forecast.pane('backI'); if (bi) bi.suppressed = true;
        const t = this.forecast.pane('backT' + langSuffix(ctx.lang) + '1'); if (t) t.translate[0] = 0;
        const g = Portrait.current;
        const bg = this.base.find('bg');
        if (bg) { bg.pane.scale[1] = PortraitSlots.backgroundScaleY; this.base.relayout(); }
        this.forecast.place({ blank: [0, g.topShift], up: [0, g.topShift], set: [0, g.topShift],
                              back: [0, g.bottomShift], down: [0, g.bottomShift], around: [0, g.bottomShift] });
        this.belt.place({ belt: [0, g.beltShift], city: [0, g.beltShift],
                          belt_logo: [0, g.bottomShift], belt_time: [0, g.bottomShift],
                          timeJP: [0, g.bottomShift], timeWW: [0, g.bottomShift] });
        PortraitArrange.extendBodies(this.forecast, ['back', 'down', 'around'], false);   // web: no-op
        PortraitArrange.extendBodies(this.forecast, ['blank', 'up', 'set'], true);        // web: no-op
        const f = this.sixHours.find('bg_filter');
        if (f) f.pane.scale[1] = PortraitSlots.backgroundScaleY;
        this.sixHours.placeAll([0, g.bandCentre], new Set(['bg_filter']));
    }

    /** Content band in SetOrtho2D pixels (y down): [x, y, w, h]. */
    get bandPixels() {
        const g = this.portrait;
        return [0, PortraitSlots.pixelY(g.bandTop), this.ctx.screenWidth, g.bandHeight];
    }

    /** Enter the hub (from boot / settings / globe). */
    enter(_fromGlobe) {
        const ctx = this.ctx;
        this.record = HubRecord.find(ctx.data, ctx.displayLocation ?? ctx.locationID);
        this.setupCityTelop();
        this.forecast.reset(); this.base.reset(); this.belt.reset(); this.sixHours.reset();
        this.scroll = this.pages[Math.min(ctx.startPage, this.pages.length - 1)].scrollTarget;
        this.scrollState = -1;
        this.shownTitle = this.pages[ctx.startPage].titleIndex;
        this.titleAlpha = 255; this.titleTarget = 255;
        this.titleState = 0; this.tickerState = 0; this.tickerScroll = 0; this.stampPage = -1;
        this.popup = 0; this.popupT = 0;
        this.exitRequested = false;
        this.buttonsVisible = true; this.zoomMode = ZoomMode.none; this.globalAlpha = 1;
        // Ready before the first visible frame (the hub is drawn under the fade-in before its first calc):
        // button state for this level, and every page's alpha/offset at full opacity.
        this.applyButtonState();
        this.forecast.update();
        this.calcPages();
    }

    _buttons() {
        const f = this.forecast;
        const set = f.find('set'), back = f.find('back'), up = f.find('up'), down = f.find('down'), around = f.find('around');
        return set && back && up && down && around ? { set, back, up, down, around } : null;
    }

    /** CNormal_StInteractive step 1 (button state for top level / city opened from the globe). */
    applyButtonState() {
        const b = this._buttons();
        if (!b) return;
        const { set, back, up, down, around } = b, ctx = this.ctx;
        // CNormal_StInteractive: +10 = "around", +14 = "set", +18 = "back" (ctor 0x800215AC..). Top level:
        // around/set enabled, backI hidden, caption "Wii Menu"; opened from a globe marker: around and set
        // disabled + pressed, back shows backI and "Back".
        if (ctx.isTopLevel) {
            // Web: the channel's own Settings screen is used again (the iPhone build left this slot inert).
            around.disabled = false; set.disabled = false;
            const bi = back.pane.find('backI'); if (bi) bi.visible = false;
            back.textIndex = 0; back.pendingTextIndex = 0;
        } else {
            around.disabled = true; around.press(); set.disabled = true; set.press();
            const bi = back.pane.find('backI'); if (bi) bi.visible = true;
            back.textIndex = 1; back.pendingTextIndex = 1;
        }
        this.updateUpDownButtons(up, down);
        if (ctx.isPortrait) this.portraitBottomRow(ctx.isTopLevel, back, down);
    }

    // MARK: - Calc (CNormal_StInteractive fn_800227B0)

    calc() {
        const ctx = this.ctx;
        if (!this.record) { this.record = HubRecord.find(ctx.data, ctx.displayLocation ?? ctx.locationID); this.setupCityTelop(); }
        const pad = ctx.pad;
        this.reqUp = false; this.reqDown = false;
        const b = this._buttons();
        if (!b) return;
        const { set, back, up, down, around } = b;
        // 1. CNormal_StInteractive button state (see applyButtonState).
        this.applyButtonState();
        this.forecast.update(); this.base.update(); this.belt.update(); this.sixHours.update();

        if (this.popup === 0) {
            ctx.ui.updateHover(this.forecast, pad, 0x28);
            if (!up.disabled && ctx.ui.buttonTrig('up', pad)) this.reqUp = true;
            else if (has(pad.trig, WPAD.up)) { if (!up.disabled) { this.reqUp = true; up.flash(); } else ctx.playSE(0x2B); }
            if (!down.disabled && ctx.ui.buttonTrig('down', pad)) this.reqDown = true;
            else if (has(pad.trig, WPAD.down)) { if (!down.disabled) { this.reqDown = true; down.flash(); } else ctx.playSE(0x2B); }
            if (ctx.ui.buttonTrig('set', pad)) { ctx.playSE(0x25); ctx.request = 4; set.keepPressed = true; }
            if (ctx.ui.buttonTrig('back', pad)) {
                if (ctx.isTopLevel) { ctx.playSE(0x25); ctx.returnToWiiMenu = true; }
                ctx.playSE(0x26); ctx.request = 3; back.keepPressed = true;
                // off the top level: CNormal_StInteractive switches +168 to fn_80026DC8 (zoom back into the marker)
                if (!ctx.isTopLevel) this.startCloseZoom(ctx.markerPoint);
                this.exitRequested = true;
            }
            if (ctx.ui.buttonTrig('around', pad)) { ctx.playSE(0); ctx.request = 5; around.keepPressed = true; this.exitRequested = true; }
            if (ctx.isPortrait) this.portraitSwipe(up, down);
            // A outside the buttons on Today/Tomorrow opens the 6-hour strip (fn_80025FA8 state 3 entry).
            // (Portrait: only a tap on the page band itself.)
            if (has(pad.trig, WPAD.a) && ctx.ui.hovered == null && this.scrollState < 0 && (ctx.startPage === 2 || ctx.startPage === 3) &&
                (!ctx.isPortrait || this.inBand(pad.pointer)) &&
                this.pages[ctx.startPage] instanceof DayPage && this.pages[ctx.startPage].isAvailable) {
                this.popup = 1; this.popupT = 0; ctx.playSE(0x29);
            }
        } else if (has(pad.trig, WPAD.a) || has(pad.trig, WPAD.b)) {
            if (this.popup === 2) { this.popup = 3; ctx.playSE(0x26); }
        }
        this.scrollUpdate();
        if (this.scrollState < 0) this.titleUpdate();
        this.tickerUpdate();
        this.popupUpdate();
        this.beltFade();
        if ((this.stampPage !== ctx.startPage && this.titleAlpha === 0) || this.stampPage < 0) { this.buildStamp(); this.stampPage = ctx.startPage; }
        this.calcPages();
    }

    /**
     * Mobile: at top level the bottom-left slot stays as a blank, inert button (no "Wii Menu" caption, no action) so
     * the bottom row mirrors the top row's blank slot — the original disabled look (normal body, text/icon alpha 0,
     * excluded from hit tests). Off the top level it is the original "Back".
     */
    portraitBottomRow(topLevel, back, _down) {
        back.hidden = false;
        back.disabled = topLevel;
    }

    inBand(p) {
        const b = this.bandPixels;
        return p[1] >= b[1] && p[1] <= b[1] + b[3];
    }

    /**
     * Mobile: a vertical one-finger swipe on the page band works like ▲/▼ (same request path as the Remote's
     * d-pad: the button flashes, or SE 0x2B at the end). Finger up = next page (content moves up with it).
     */
    portraitSwipe(up, down) {
        const ctx = this.ctx, g = ctx.gestures;
        if (g.fingers === 1 && this.lastFingers === 0) {
            this.swipeArmed = ctx.pad.pointerValid && this.inBand(ctx.pad.pointer) && ctx.ui.hovered == null;
            this.swipeAccum = 0; this.swipeDone = false;
        }
        this.lastFingers = g.fingers;
        if (!this.swipeArmed || this.swipeDone || g.fingers !== 1) return;
        this.swipeAccum += g.dragY;
        if (this.swipeAccum <= -60) {
            this.swipeDone = true;
            if (!down.disabled) { this.reqDown = true; down.flash(); } else ctx.playSE(0x2B);
        } else if (this.swipeAccum >= 60) {
            this.swipeDone = true;
            if (!up.disabled) { this.reqUp = true; up.flash(); } else ctx.playSE(0x2B);
        }
    }

    /** up/down captions show the neighbour page names (upT 0..3 = page i−1, downT 1..4 = page i+1); disabled at the ends. */
    updateUpDownButtons(up, down) {
        const cur = this.ctx.startPage;
        up.disabled = cur === 0;
        down.disabled = cur >= this.pages.length - 1;
        if (cur > 0) { up.textIndex = cur - 1; up.pendingTextIndex = cur - 1; }
        if (cur < this.pages.length - 1) { down.textIndex = cur; down.pendingTextIndex = cur; }
    }

    /** fn_80025CF8: ChaseValue(scroll, target, 0.1125, 100, 1); title fades out while moving, swaps when invisible. */
    scrollUpdate() {
        const ctx = this.ctx;
        if (this.reqDown && ctx.startPage < this.pages.length - 1) { ctx.startPage += 1; this.scrollState = 0; ctx.playSE(0x29); }
        if (this.reqUp && ctx.startPage > 0) { ctx.startPage -= 1; this.scrollState = 0; ctx.playSE(0x29); }
        if (this.scrollState < 0) return;
        if (this.scrollState === 0) { this.titleTarget = 0; this.clockTarget = 0; this.scrollState = 1; this.titleState = 0; }
        const target = this.pages[ctx.startPage].scrollTarget;
        const k = this.pageSpacing / 456;   // portrait: same feel over the taller page spacing (k = 1 on the Wii)
        let rem;
        [this.scroll, rem] = chaseValue(this.scroll, target, 0.1125, 100 * k, 1 * k);
        if (this.titleAlpha === 0) {
            this.shownTitle = this.pages[ctx.startPage].titleIndex; this.titleTarget = 255; this.clockTarget = 255;
            this.buildStamp(); this.stampPage = ctx.startPage;
        }
        if (Math.abs(rem) < 0.0008) { this.scrollState = -1; this.titleTarget = 255; this.clockTarget = 255; }
    }

    /** MinutesToDate (fn_800364D8): minutes since 2000-01-01 00:00 → calendar fields (wday 0 = Sunday). */
    static minutesToDate(m) {
        const d = new Date((946684800 + (m >>> 0) * 60) * 1000);
        const days = Math.trunc((m >>> 0) / 1440);
        return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), mday: d.getUTCDate(), mon: d.getUTCMonth(), year: d.getUTCFullYear(), wday: (days + 6) % 7 };
    }

    /**
     * Weekday title index for the shown page (fn_8002698C): UV → today, Current → the current-conditions entry,
     * Today → today, Tomorrow → today + 0x5A0 min; 5-Day keeps its page title. Belt titles 5..11 = weekdays.
     */
    weekdayTitle() {
        const r = this.record;
        const longTime = r?.long?.time.localTime ?? r?.summary?.time.localTime ?? null;
        const wd = (m) => 5 + NormalScreen.minutesToDate(m).wday;
        switch (this.ctx.startPage) {
            case 0: return longTime != null ? wd(longTime) : null;
            case 1: return r?.current ? wd(r.current.time.localTime) : null;
            case 2: return longTime != null ? wd(longTime) : null;
            case 3: return longTime != null ? wd(longTime + 0x5A0) : null;
            default: return null;
        }
    }

    /** fn_80026B34: hold the page title 240 frames, fade (±0x10/frame), weekday 240 frames, fade back. */
    titleUpdate() {
        const page = this.pages[this.ctx.startPage];
        const weekday = page.isAvailable ? this.weekdayTitle() : null;
        if (weekday == null) { this.shownTitle = page.titleIndex; return; }
        switch (this.titleState) {
            case 0: this.titleState = 1; this.titleTimer = 0xF0; this.shownTitle = page.titleIndex; break;
            case 1:
                if (this.titleTimer > 0) this.titleTimer -= 1;
                if (this.titleTimer === 0) { this.titleState = 2; this.titleTarget = 0; }
                break;
            case 2:
                if (this.titleAlpha === 0) { this.titleState = 3; this.titleTimer = 0xF0; this.shownTitle = weekday; this.titleTarget = 255; }
                break;
            case 3:
                if (this.titleTimer > 0) this.titleTimer -= 1;
                if (this.titleTimer === 0) { this.titleState = 4; this.titleTarget = 0; }
                break;
            default:
                if (this.titleAlpha === 0) { this.titleState = 1; this.titleTimer = 0xF0; this.shownTitle = page.titleIndex; this.titleTarget = 255; }
        }
    }

    /**
     * fn_80027998: city telop ticker — hold a line 240 frames, then slide up 50 px to the next
     * (ChaseValue(+7D8, lbl_8017B440[line] = {0, −50, −100}, 0.1, 10, 0.5)), wrapping to the first.
     */
    tickerUpdate() {
        if (this.tickerState === 0) { this.tickerState = 1; this.tickerLine = 0; this.tickerTimer = 0xF0; this.tickerScroll = 0; return; }
        if (this.tickerTimer > 0) this.tickerTimer -= 1;
        let rem;
        [this.tickerScroll, rem] = chaseValue(this.tickerScroll, -50 * this.tickerLine, 0.1, 10, 0.5);
        if (this.tickerState === 1) {
            if (this.tickerTimer === 0) {
                this.tickerState = 2; this.tickerLine += 1;
                if (this.tickerLine >= this.cityLines.length) this.tickerLine = 0;
                this.tickerTimer = 0xF0;
            }
        } else if (Math.abs(rem) < 0.0008) this.tickerState = 1;
    }

    /**
     * fn_8002322C + the US formatter fn_80023430: "<prefix><h>:<mm><sp><a.m./p.m.><, ><MM>/<DD>" from the
     * entry time (Current page: the current-conditions entry; other pages: the long/summary forecast entry).
     * All strings are read from main.dol: lbl_8019BC2C[lang], lbl_8032FF68, *lbl_803300F8 / *lbl_803300FC, lbl_8032FF6C.
     */
    buildStamp() {
        const ctx = this.ctx, r = this.record, f = this.telopFont;
        const t = ctx.startPage === 1 ? r?.current?.time.localTime : (r?.long?.time.localTime ?? r?.summary?.time.localTime);
        if (!t || !f) { this.stamp = ''; return; }
        const d = NormalScreen.minutesToDate(t), s = this.strings;
        const h12 = d.hour === 0 ? 12 : (d.hour > 12 ? d.hour - 12 : d.hour);
        let out = s.wstring(s.dol.u32(0x8019BC2C + ctx.lang * 4));
        out += `${h12}:` + pad2(d.minute);
        out += s.wstring(0x8032FF68);
        out += s.wstring(s.dol.u32(d.hour < 12 ? 0x803300F8 : 0x803300FC));
        out += s.wstring(0x8032FF6C);
        out += `${pad2(d.mon + 1)}/${pad2(d.mday)}`;
        this.stamp = out;
        // scale 0.6, x shrunk to fit the timeWW box width (+780 = 1.3684211·width when wide)
        const k = ctx.isWide ? 1.3684211 : 1;
        const maxW = (this.belt.pane('timeWW')?.size[0] ?? 280) * k;
        this.stampScale = [0.6, 0.6];
        const w = this.telop.width(out, f, TelopText.style({ scale: this.stampScale }));
        if (w > maxW && w > 0) this.stampScale[0] *= maxW / w;
    }

    /** fn_80025B58: belt title / clock alpha step 0x10 per frame toward their targets. */
    beltFade() {
        const step = (v, t) => v < t ? Math.min(v + 0x10, t) : v > t ? Math.max(v - 0x10, t) : v;
        this.titleAlpha = step(this.titleAlpha, this.titleTarget); this.clockAlpha = step(this.clockAlpha, this.clockTarget);
    }

    /** fn_80025FA8 popup: 0x800 per frame up to 0x8000 (16 frames), sin-eased; dim quad alpha 40·t. */
    popupUpdate() {
        switch (this.popup) {
            case 1: this.popupT = Math.min(this.popupT + 0x800, 0x8000); if (this.popupT >= 0x8000) this.popup = 2; break;
            case 3: this.popupT = Math.max(this.popupT - 0x800, 0); if (this.popupT <= 0) this.popup = 0; break;
            default: break;
        }
    }
    get popupEase() { return Math.sin(this.popupT / 0x8000 * Math.PI / 2); }

    // MARK: - City telop (CNormal_SetupCityTelop fn_80022D2C)

    setupCityTelop() {
        this.cityLines = [];
        const place = this.record?.place, f = this.telopFont;
        if (!place || !f) return;
        const boxW = this.cityBox[2] - this.cityBox[0];
        const lines = [place.city];
        if (this.ctx.lang === Lang.jp && place.id.country === 1) {
            if (place.region) lines[0] += place.region;
            if (place.country) lines.push(place.country);
        } else {
            if (place.region) lines.push(place.region);
            if (place.country) lines.push(place.country);
        }
        for (const l of lines) {
            const w = this.telop.width(l, f);
            this.cityLines.push([l, w > boxW && w > 0 ? boxW / w : 1]);
        }
        this.tickerState = 0;
    }

    // MARK: - Draw (fn_80023E58)

    /** CLayout_Draw with a page translation and layout alpha (fn_8003A35C + fn_8003A3CC). */
    drawLayout(ui, enc, translateY = 0, alpha = 255, before = null) {
        if (!ui.visible) return;
        // fn_8003A35C → fn_8003927C: every root pane's mGlbAlpha (+0xCD) = alpha — ignores the wrappers' fixed flag
        // (so the base plate really is half transparent off the top level, showing the globe).
        for (const p of ui.panes) p.pane.subtreeAlpha = alpha;
        ui.panes.forEach(p => p.preDraw());
        before?.();
        ui.layout.root.translate = [0, translateY, 0];
        lytDraw(this.ctx.lyt, ui.layout, enc, 608, ui.locationAdjust);
    }

    draw(enc) {
        const ctx = this.ctx;
        const a = Math.trunc(255 * this.globalAlpha);
        // background plate: full on top level, half otherwise
        this.drawLayout(this.base, enc, 0, ctx.isTopLevel ? a : Math.trunc(128 * this.globalAlpha));
        if (ctx.isPortrait && this.scissor) {
            const b = this.bandPixels;
            enc.setScissorRect(this.scissor(b[0], b[1], b[2], b[3]));
            for (const p of this.pages) p.draw(enc);
            enc.setScissorRect(this.scissor(0, 0, ctx.screenWidth, LogicalScreen.height));
        } else {
            for (const p of this.pages) p.draw(enc);
        }
        // fn_80023E58 (+7F5): the white zoom quad, centre +768/+76C, half size (W/2, H/2)·+7D0, alpha +804
        // (fn_8002E79C → fn_8002E5C0: GX quad, raster colour).
        if (this.zoomActive && this.zoomRectAlpha > 0) {
            const h = [ctx.screenWidth / 2 * this.globalAlpha, LogicalScreen.halfHeight * this.globalAlpha], c = this.zoomCentre;
            drawScreenRect(ctx.lyt, c[0] - h[0], c[1] - h[1], c[0] + h[0], c[1] + h[1], [255, 255, 255, this.zoomRectAlpha], ctx.screenWidth, enc);
        }
        if (this.buttonsVisible) this.drawLayout(this.forecast, enc);
        if (this.popup !== 0) this.drawSixHours(enc);
        // Closing back into the globe: the belt (title, city, clock strip) is gone at once, before the zoom — only
        // the pages and the zoom quad play the close.
        if (this.zoomMode === ZoomMode.close) return;
        this.drawLayout(this.belt, enc, 0, a, () => {
            const t = this.belt.pane('beltT');
            if (t) PaneCtl.setAlpha(t, Math.trunc(this.titleAlpha * a / 255));
            const bp = this.belt.find('belt');
            if (bp) {
                // CPaneCtl text variant = page title index (beltT<lang><N>: A main, B shadow).
                bp.textIndex = this.shownTitle;
                if (bp.text) bp.text.children.forEach((c, i) => { c.visible = i === this.shownTitle; });
            }
        });
        this.drawCityTelop(enc, a);
        this.drawStamp(enc, Math.trunc(this.clockAlpha * this.globalAlpha));
        // The credit is CWeatherScene's (WeatherScene_StE6C8 → WeatherScene.drawCredit).
    }

    /**
     * fn_80023E58 telop part: lines spaced 50 px (+400 − +3F8), x = box right edge (+798), y = box centre + ticker
     * scroll + i·50, draw flag 0x122, writer scale (fit, 1.0); scissor y 74..124; shadow (0x20) at +1,+1, then white.
     */
    drawCityTelop(enc, alpha) {
        const f = this.telopFont;
        if (!f || !this.cityLines.length) return;
        const box = this.cityBox, centre = (box[1] + box[3]) / 2;
        const clip = [centre - 23, centre + 27];   // 74…124 on the Wii (box centre 97)
        this.cityLines.forEach(([s, fit], i) => {
            const y = centre + this.tickerScroll + 50 * i;
            if (!(y + 30 > clip[0] && y - 30 < clip[1])) return;
            const st = TelopText.style({ scale: [fit, 1], flags: 0x122 });
            this.telop.draw(s, f, [box[2] + 1, y + 1], st, [0x20, 0x20, 0x20, alpha], enc, clip);
            this.telop.draw(s, f, [box[2], y], st, [255, 255, 255, alpha], enc, clip);
        });
    }

    /** Timestamp at the timeWW anchor: x = W − 36 (wide; 28 otherwise), y = 228 − centre.y, flag 0x122, white × +81C. */
    drawStamp(enc, alpha) {
        const f = this.telopFont, box = this.belt.pane('timeWW');
        if (!f || !this.stamp || !box) return;
        calculate(this.belt.layout.root);
        const y = LogicalScreen.halfHeight - SpriteText.layoutCenter(box)[1];
        const x = this.ctx.screenWidth - (this.ctx.isWide ? 36 : 28);
        this.telop.draw(this.stamp, f, [x, y], TelopText.style({ scale: this.stampScale, flags: 0x122 }), [255, 255, 255, alpha], enc);
    }

    /** 6-hour strip overlay (day_6h_nWW): dim quad + layout + 4 slot icons and precipitation texts. */
    drawSixHours(enc) {
        const ctx = this.ctx, e = this.popupEase;
        drawScreenRect(ctx.lyt, 0, 0, ctx.screenWidth, LogicalScreen.height, [0, 0, 0, Math.trunc(40 * e * 3)], ctx.screenWidth, enc);
        const a = Math.trunc(255 * e);
        this.drawLayout(this.sixHours, enc, 0, a);
        const page = this.pages[ctx.startPage];
        if (!(page instanceof DayPage)) return;
        const d = page.day;
        if (!d) return;
        const k = ctx.isWide ? 1.3684211 : 1;
        calculate(this.sixHours.layout.root);
        ['a', 'b', 'c', 'd'].forEach((col, i) => {
            const p = this.sixHours.pane(`icon_${col}`);
            if (p && i < d.slots.length) {
                const code = d.slots[i];
                const sp = this.sprites.screenPoint(SpriteText.layoutCenter(p));
                const w = code !== 0xFFFF ? this.record?.weather(code) : null;
                this.sprites.drawWeatherIcon(w ? w.icon : 0x7FFF, sp, a, 0.7, enc);
            }
            const tp = this.sixHours.pane(`text_icon_${col}USA`) ?? this.sixHours.pane(`text_icon_${col}`);
            if (tp && i < d.precipitation.length && this.telopFont) {
                const sp = this.sprites.screenPoint(SpriteText.layoutCenter(tp));
                const v = d.precipitation[i];
                const s = v === 0xFF ? '--%' : `${v}%`;
                this.telop.drawFitted(s, this.telopFont, sp, [tp.size[0] * k, tp.size[1]], [1, 1], 0x111,
                                      [255, 255, 255, a], [0x20, 0x20, 0x20, a], enc);
            }
        });
    }
}
