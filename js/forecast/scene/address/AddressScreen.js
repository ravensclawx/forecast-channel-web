import { PortraitArrange } from '../PortraitArrange.js';
import { PortraitSlots } from '../../render/PortraitSlots.js';
import { LogicalScreen } from '../../render/LogicalScreen.js';
import { Message } from '../Message.js';
import { SceneDraw2D } from './SceneDraw2D.js';
import { chaseValue } from '../../game/GlobeMath.js';
import { CursorState } from '../../ui/Cursor.js';
import * as B from '../../ui/bridge.js';

export const AddressState = Object.freeze({ idle: 'idle', cityList: 'cityList', regionList: 'regionList', flyTo: 'flyTo', confirm: 'confirm' });
const regionOf = (id) => (id.raw & 0xFFFF0000) >>> 0;

/** One list row (0x48-byte item). */
class Row {
    constructor(place, cityText, regionText, cityScale, regionScale) {
        this.place = place;               // +8 (null = the "other regions" row)
        this.cityText = cityText;         // +C
        this.regionText = regionText;     // +10
        this.cityScale = cityScale;       // +24
        this.regionScale = regionScale;   // +2C
        this.y = 0;                       // +18
        this.hovered = false;             // +44
        this.wasHovered = false;          // +45
        this.hidden = false;              // +46
        this.rect = [0, 0, 0, 0];         // +34..+40 x0,y0,x1,y1 (screen, y down)
    }
    clone() { const r = Object.assign(new Row(), this); r.rect = this.rect.slice(); return r; }
}

/**
 * CAddress (d_weather_address.cpp, CAddress_ctor fn_80014B40 … CAddress_StConfirm fn_80016F4C).
 * City list (StList) for the current region with a trailing "other regions" row, region list (StList2),
 * globe fly-to (fn_800172A0) and the "is this location correct?" confirm (set_area2).
 */
export class AddressScreen {
    constructor(ctx, around) {
        this.ctx = ctx; this.around = around;
        this.base = ctx.layout('base.brlyt');            // +10
        this.list = ctx.layout('set_area1.brlyt');       // +14 set_area1
        this.confirm = ctx.layout('set_area2.brlyt');    // +18 set_area2
        this.active = this.list;                         // +C
        this.items = [];                 // all places of the country
        this.rows = [];                  // current list (+8 chain)
        this.regionKey = 0;              // +138
        this.otherRegionsText = [];      // +BC  (lbl_80199428[lang])
        // Scrolling (+FC current offset, +128 target, +148 index, +144 max index), list geometry
        this.scroll = 0; this.scrollTarget = 0;
        this.index = 0; this.maxIndex = 0;
        this.rowHeight = 60;             // +11C
        // Touch scrolling (follow the finger, fling, then the original snap rule).
        this.touchActive = false; this.touchInList = false; this.touchDragging = false; this.flinging = false;
        this.touchTravel = 0; this.flingVel = 0; this.flingDir = 0;
        this.dragging = false;           // +15E
        this.dragVel = 0;                // +134
        this.state = AddressState.idle;  // PTMF +2C
        this.step = 0;                   // +14C
        this.wait = 0;                   // +154
        this.reqUp = false; this.reqDown = false; this.holdB = false; this.reqYes = false; this.reqNo = false;   // +158..+15C
        this.backEnabledInRegionList = true;   // +15D
        this.candidate = null;           // +4
        this.firstRun = true;            // !lbl_80330A09
        /** SceneDraw2D (set by WeatherScene). */
        this.drawer = null;
        /** Screen-space scissor (logical 0..W × 0..H → enc rect) — provided by WeatherScene. */
        this.scissor = (_x, _y, _w, _h) => ({ x: 0, y: 0, width: 1, height: 1 });

        // Portrait: list header at the top, the list filling the band, Back/▼/▲ in the bottom row; the confirm
        // dialog stays one centred group over the globe.
        PortraitArrange.stretchBackgrounds(this.base);
        PortraitArrange.place(this.list, ['text'], ['back', 'down', 'up', 'blank']);
        PortraitArrange.extendBodies(this.list, ['back', 'down', 'up', 'blank'], false);   // web: no-op
        // "Other regions" row label: wide string table lbl_80199428 indexed by language (read from main.dol).
        try {
            const dol = B.mainDolBytes(ctx.assets), img = B.dolImage(dol), r = B.beReader(dol);
            let o = img.offset(img.u32(0x80199428 + ctx.lang * 4));
            if (o != null) while (o + 1 < dol.length && r.u16(o) !== 0 && this.otherRegionsText.length < 64) { this.otherRegionsText.push(r.u16(o)); o += 2; }
        } catch (_) { /* no DOL table */ }
        this.buildItems();
    }

    /**
     * +118 / +120 and +124 (100 / 393 on the Wii). Portrait: the list runs from just below the header box
     * (moved to the top) to just above the bottom button row, keeping the original 32 / 30 px gaps.
     */
    get listTop() { return PortraitArrange.on ? PortraitSlots.pixelY(160 + PortraitSlots.topRowShift) + 32 : 100; }
    get listBottom() { return PortraitArrange.on ? PortraitSlots.pixelY(-195 + PortraitSlots.bottomRowShift) - 30 : 393; }
    /** Rows that fit the list band (4 on the Wii → the original maxIndex = count − 3). */
    get visibleRows() { return Math.max(1, Math.trunc((this.listBottom - this.listTop) / this.rowHeight)); }

    get width() { return this.ctx.screenWidth; }
    get textMaxWidth() { return this.width - (this.ctx.isWide ? 0x24 : 0x1C) * 2; }

    /**
     * CAddress_ctor item setup: per place, the city text and the region text (region, else country, else city),
     * each scaled to fit the list width.
     */
    buildItems() {
        this.items = [];
        const places = this.ctx.data?.forecast.places, font = Message.systemFont(this.ctx);
        if (!places || !font) return;
        const max = this.textMaxWidth;
        for (const p of places) {
            if (p.id.country !== this.ctx.countryCode) continue;
            const city = B.utf16(p.city);
            const region = B.utf16(p.region ?? p.country ?? p.city);
            const cw = SceneDraw2D.stringWidth(city, font), rw = SceneDraw2D.stringWidth(region, font);
            this.items.push(new Row(p, city, region, cw > max ? max / cw : 1, rw > max ? max / rw : 1));
        }
    }

    // MARK: entering

    /** fn_80015340 reset + fn_800154C8: start in the city list of the user's region, else the region list. */
    start() {
        this.buildItems();
        this.base.reset(); this.list.reset(); this.confirm.reset();
        this.regionKey = regionOf(this.ctx.locationID);
        if (this.items.some(it => regionOf(it.place.id) === this.regionKey)) this.enterCityList(); else this.enterRegionList();
    }

    /** fn_8001576C: rows = places in `regionKey` + the "other regions" row; returns the user's row index. */
    buildCityRows() {
        this.rows = this.items.filter(it => regionOf(it.place.id) === this.regionKey).map(r => r.clone());
        let y = 0.5 * this.rowHeight;
        for (const r of this.rows) { r.y = y; y += this.rowHeight; }
        const font = Message.systemFont(this.ctx);
        if (font) {
            const w = SceneDraw2D.stringWidth(this.otherRegionsText, font), max = this.textMaxWidth;
            const other = new Row(null, this.otherRegionsText, this.otherRegionsText, w > max ? max / w : 1, 1);
            other.y = y;
            this.rows.push(other);
        }
        this.maxIndex = this.rows.length - this.visibleRows + 1;
        const i = this.rows.findIndex(r => r.place && r.place.id.raw === this.ctx.locationID.raw);
        return i < 0 ? 0 : i;
    }

    /** fn_800158D0: one row per region (first place of each region), in data order. */
    buildRegionRows() {
        const seen = new Set(); this.rows = [];
        for (const it of this.items) {
            const k = regionOf(it.place.id);
            if (seen.has(k)) continue;
            seen.add(k); this.rows.push(it.clone());
        }
        let y = 0.5 * this.rowHeight;
        for (const r of this.rows) { r.y = y; y += this.rowHeight; }
        this.maxIndex = this.rows.length - this.visibleRows + 1;
        const i = this.rows.findIndex(r => regionOf(r.place.id) === this.regionKey);
        return i < 0 ? 0 : i;
    }

    /** CAddress_StList step 0 */
    enterCityList() {
        this.state = AddressState.cityList; this.step = 1; this.active = this.list;
        this.index = Math.min(Math.max(this.buildCityRows(), 0), Math.max(this.maxIndex - 1, 0));
        this.scrollTarget = -(this.rowHeight * this.index); this.scroll = this.scrollTarget;
        const back = this.list.find('back');
        if (back) { if (this.firstRun) { back.disabled = true; back.press(); } else back.disabled = false; }
        const t = this.list.find('text'); if (t) { t.textIndex = 0; t.pendingTextIndex = 0; }
    }

    /** CAddress_StList2 step 0 */
    enterRegionList() {
        this.state = AddressState.regionList; this.step = 1; this.active = this.list;
        this.index = Math.min(Math.max(this.buildRegionRows(), 0), Math.max(this.maxIndex - 1, 0));
        this.scrollTarget = -(this.rowHeight * this.index); this.scroll = this.scrollTarget;
        const home = regionOf(this.ctx.locationID);
        this.backEnabledInRegionList = !this.firstRun || this.items.some(it => regionOf(it.place.id) === home);
        const back = this.list.find('back'); if (back) back.disabled = !this.backEnabledInRegionList;
        const t = this.list.find('text'); if (t) { t.textIndex = 1; t.pendingTextIndex = 1; }
    }

    // MARK: frame

    /** CAddress_UpdateButtons (fn_80015668) */
    updateButtons() {
        const ctx = this.ctx, pad = ctx.pad;
        this.reqUp = false; this.reqDown = false; this.reqYes = false; this.reqNo = false;
        ctx.ui.updateHover(this.active, pad);
        this.holdB = B.has(pad.hold, B.WPAD.b);
        if (!this.holdB) {
            if (ctx.ui.buttonTrig('down', pad)) this.reqDown = true;
            else if (B.has(pad.trig, B.WPAD.down)) { this.reqDown = true; this.list.find('down')?.flash(); }
            if (ctx.ui.buttonTrig('up', pad)) this.reqUp = true;
            else if (B.has(pad.trig, B.WPAD.up)) { this.reqUp = true; this.list.find('up')?.flash(); }
        }
        if (ctx.ui.buttonTrig('yes', pad)) this.reqYes = true;
        if (ctx.ui.buttonTrig('no', pad)) this.reqNo = true;
    }

    /** fn_80015EFC (button scrolling) / fn_8001611C (B-drag scrolling) */
    updateScroll() {
        if (PortraitArrange.on && this.touchScroll()) return;
        [this.scroll] = chaseValue(this.scroll, this.scrollTarget, 0.1, 20, 5);
        // fn_8001611C (B held): step 0 plays SE 0x16 and raises +15E; each frame the speed +134 = 0.1·v where
        // v = 228 − pointer y with a ±20 dead zone (fn_80035C28, lbl_801F72B8), the cursor shows the scroll
        // sprite (lbl_801D6F98 = 4) and +FC moves by the speed, clamped to [−row·(n−1), 0].
        if (this.maxIndex > 1 && this.holdB) {
            if (!this.dragging) { this.dragging = true; this.dragVel = 0; this.ctx.playSE(0x16); }
            const v = 228 - this.ctx.pad.pointer[1];
            this.dragVel = (v < 20 && v > -20) ? 0 : 0.1 * v;
            const top = 0, bottom = -(this.rowHeight * (this.maxIndex - 1));
            this.scroll = Math.min(top, Math.max(bottom, this.scroll + this.dragVel));
            this.scrollTarget = this.scroll;
            return;
        }
        if (this.dragging) {
            // case −1 on leaving: nearest row in the scroll direction becomes the target (+128).
            this.dragging = false;
            this.index = this.dragVel < 0 ? Math.trunc((-this.scroll + this.rowHeight) / this.rowHeight) : Math.trunc(-this.scroll / this.rowHeight);
            this.index = Math.min(Math.max(this.index, 0), Math.max(this.maxIndex - 1, 0));
            this.dragVel = 0;
        }
        if (this.reqDown && this.maxIndex > 1 && this.index < this.maxIndex - 1) { this.index += 1; this.ctx.playSE(0x30); }
        else if (this.reqUp && this.index > 0) { this.index -= 1; this.ctx.playSE(0x30); }
        const up = this.list.find('up'), down = this.list.find('down');
        if (up) up.disabled = this.index === 0;
        if (down) down.disabled = this.maxIndex <= 0 || this.index === this.maxIndex - 1;
        this.scrollTarget = -(this.rowHeight * this.index);
    }

    /**
     * Touch: one finger dragged in the list moves it directly; on release it keeps the finger's speed, decays,
     * then snaps like the original's B-scroll exit (nearest row in the travel direction). Returns true while the
     * touch owns the scroll (the button/snap path is skipped that frame).
     */
    touchScroll() {
        const g = this.ctx.gestures, pad = this.ctx.pad;
        const bottom = -(this.rowHeight * Math.max(this.maxIndex - 1, 0));
        if (pad.pointerValid && g.fingers === 1) {
            if (!this.touchActive) {
                this.touchActive = true; this.touchTravel = 0; this.touchDragging = false; this.flinging = false;
                this.touchInList = pad.pointer[1] > this.listTop && pad.pointer[1] < this.listBottom;
            }
            if (!this.touchInList || !(this.maxIndex > 1)) return false;
            this.touchTravel += Math.abs(g.dragY);
            if (!this.touchDragging && this.touchTravel > 18) this.touchDragging = true;
            if (!this.touchDragging) return false;
            this.scroll = Math.min(0, Math.max(bottom, this.scroll + g.dragY));
            this.scrollTarget = this.scroll;
            this.flingVel = g.dragY;
            if (Math.abs(g.dragY) > 0.5) this.flingDir = g.dragY < 0 ? -1 : 1;
            return true;
        }
        this.touchActive = false;
        if (this.touchDragging) { this.touchDragging = false; this.flinging = true; }
        if (!this.flinging) return false;
        this.flingVel *= 0.92;
        this.scroll = Math.min(0, Math.max(bottom, this.scroll + this.flingVel));
        this.scrollTarget = this.scroll;
        if (Math.abs(this.flingVel) < 1 || this.scroll <= bottom || this.scroll >= 0) {
            this.flinging = false;
            this.index = this.flingDir < 0 ? Math.trunc((-this.scroll + this.rowHeight) / this.rowHeight) : Math.trunc(-this.scroll / this.rowHeight);
            this.index = Math.min(Math.max(this.index, 0), Math.max(this.maxIndex - 1, 0));
            return false;
        }
        return true;
    }

    /** Row rects + hover (fn_800164F0 / fn_8001673C first loop, fn_80017368 hit test). Returns the chosen row. */
    updateRows() {
        let chosen = null;
        for (const r of this.rows) {
            r.wasHovered = r.hovered; r.hovered = false;
            const y0 = r.y + (this.scroll + this.listTop) - 20;
            r.rect = [0, y0, this.width, y0 + 40];
            r.hidden = y0 + 40 < 0 || y0 > this.listBottom;
        }
        const pad = this.ctx.pad;
        if (!pad.pointerValid || this.dragging || this.touchDragging || this.flinging) return null;
        const p = pad.pointer;
        if (!(p[1] > this.listTop && p[1] < this.listBottom)) return null;
        this.rows.forEach((r, i) => {
            if (r.hidden) return;
            const q = r.rect;
            if (p[0] > q[0] && p[0] < q[2] && p[1] > q[1] && p[1] < q[3]) {
                r.hovered = true;
                if (!r.wasHovered) this.ctx.playSE(0x2E);
                if (B.has(pad.trig, B.WPAD.a)) chosen = i;
            }
        });
        return chosen;
    }

    calc() {
        const ctx = this.ctx;
        this.base.update(); this.list.update(); this.confirm.update();
        switch (this.state) {
            case AddressState.idle: break;
            case AddressState.cityList:
                this.updateButtons();
                if (this.step === 1) {
                    let i;
                    if (!this.firstRun && ctx.ui.buttonTrig('back', ctx.pad)) {
                        const b = this.list.find('back'); if (b) b.keepPressed = true;
                        ctx.playSE(0x26); ctx.request = 4; this.step = 2;
                    } else if ((i = this.updateRows()) != null) {
                        const p = this.rows[i].place;
                        if (p) { ctx.playSE(0x24); this.candidate = p; this.beginFlyTo(); }
                        else { ctx.playSE(0x2F); this.enterRegionList(); }
                    }
                    this.updateScroll();
                }
                break;
            case AddressState.regionList:
                this.updateButtons();
                if (this.step === 1) {
                    let i;
                    if (this.backEnabledInRegionList && ctx.ui.buttonTrig('back', ctx.pad)) {
                        const b = this.list.find('back'); if (b) b.keepPressed = true;
                        ctx.playSE(0x26); this.wait = 0x14; this.step = 2;
                    } else if ((i = this.updateRows()) != null) {
                        this.regionKey = regionOf(this.rows[i].place.id);
                        ctx.playSE(0x23);
                        this.enterCityList();
                    }
                    this.updateScroll();
                } else if (this.step === 2) {
                    if (this.wait > 0) this.wait -= 1; else { this.regionKey = regionOf(ctx.locationID); this.enterCityList(); }
                }
                break;
            case AddressState.flyTo:
                // fn_800172A0: the globe flies to the candidate (CAround/SimpleGlobe), then confirm.
                this.animateGlobe();
                if (this.wait > 0) this.wait -= 1; else this.enterConfirm();
                break;
            case AddressState.confirm:
                this.updateButtons();
                this.animateGlobe();
                if (this.step === 1) {
                    if (this.reqYes) {
                        ctx.playSE(0x25); this.step = 2; this.wait = 0;
                        const y = this.confirm.find('yes'); if (y) y.keepPressed = true;
                        if (this.candidate) ctx.locationID = this.candidate.id;
                        ctx.request = 2;
                    }
                    if (this.reqNo) {
                        ctx.playSE(0x26); this.step = 3; this.wait = 0xC;
                        const n = this.confirm.find('no'); if (n) n.keepPressed = true;
                    }
                } else if (this.step === 3) {
                    if (this.wait > 0) this.wait -= 1; else this.enterCityList();
                }
                break;
        }
    }

    /** Globe camera/material update only (fn_80018BE0 subset) — no CAround input while CAddress owns the pointer. */
    animateGlobe() {
        const g = this.ctx.globeScene.globe;
        g.updateZoom(); g.syncDist(); g.updateTilt();
        g.calcCamera(this.ctx.globeScene.earth.materials);
        g.calcPoles(); g.updateLight();
    }

    beginFlyTo() {
        this.state = AddressState.flyTo; this.step = 0; this.wait = 40;
        if (this.candidate) this.around.enterForAddress(this.candidate.id);
    }

    /** CAddress_StConfirm step 0 */
    enterConfirm() {
        this.state = AddressState.confirm; this.step = 1; this.active = this.confirm;
        this.confirm.reset();
        this.scroll = 0; this.scrollTarget = 0;
    }

    /** fn_800101C0 input: the scroll sprite while B-scrolling the list. */
    get cursorState() { return this.dragging ? CursorState.scroll : CursorState.normal; }

    get showsGlobe() { return this.state === AddressState.flyTo || this.state === AddressState.confirm; }

    /** fn_80015380 + row drawing (fn_80015A58 city rows / fn_80015C10 region rows) */
    draw(enc) {
        const ctx = this.ctx;
        if (this.showsGlobe) {
            this.around.drawGlobe(enc);
            if (this.state === AddressState.confirm) this.confirm.draw(ctx.lyt, enc);
            return;
        }
        this.base.draw(ctx.lyt, enc);
        const d2 = this.drawer, font = Message.systemFont(ctx);
        if (d2 && font) {
            const a = this.list.layoutAlpha / 255, W = this.width;
            if (PortraitArrange.on) enc.setScissorRect(this.scissor(0, this.listTop + 3, W, LogicalScreen.height - (this.listTop + 3)));
            else enc.setScissorRect(this.scissor(0, 0x67, W, 0x161));
            for (const r of this.rows) {
                if (r.hidden) continue;
                const c = r.hovered ? [0x8C, 0xB4, 0xB4, 0xFF] : [0xFF, 0xFF, 0xFF, 0x40];
                d2.fillRect(r.rect[0], r.rect[1], r.rect[2], r.rect[3], [c[0], c[1], c[2], Math.trunc(c[3] * a)], enc);
            }
            const region = this.state === AddressState.regionList;
            for (const r of this.rows) {
                if (r.hidden) continue;
                d2.text(region ? r.regionText : r.cityText, font, W * 0.5, r.y + this.scroll + this.listTop, [region ? r.regionScale : r.cityScale, 1],
                        [255, 255, 255, Math.trunc(255 * a)], undefined, undefined, true, enc);
            }
            enc.setScissorRect(this.scissor(0, 0, W, LogicalScreen.height));
        }
        this.list.draw(ctx.lyt, enc);
    }
}
