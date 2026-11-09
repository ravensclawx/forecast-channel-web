import { PortraitArrange } from '../PortraitArrange.js';
import { LogicalScreen } from '../../render/LogicalScreen.js';
import { Message } from '../Message.js';
import { SceneDraw2D } from '../address/SceneDraw2D.js';
import { Portrait } from '../normal/NormalScreen.js';
import { Lang } from '../../ui/PaneCtl.js';
import { utf16 } from '../../ui/bridge.js';

export const SettingState = Object.freeze({ idle: 'idle', interactive: 'interactive', passive: 'passive' });

/**
 * CSetting (d_weather_setting.cpp, CSetting_ctor fn_80027DA8 … CSetting_StInteractive fn_80028598).
 * Rows: city (city_set + city_btn "Change"), temperature (kion_set variants by unit + kion_btn),
 * wind (wind_set + wind_btn; hidden in JP), back.
 * Web: used in both modes again (the iPhone build relied on iOS Settings instead).
 */
export class SettingScreen {
    constructor(ctx) {
        this.ctx = ctx;
        this.set = ctx.layout('set.brlyt');       // +0 set.brlyt
        this.base = ctx.layout('base.brlyt');     // +4 base.brlyt
        const set = this.set;
        this.kionSet = set.find('kion_set');      // +8
        this.citySet = set.find('city_set');      // +C
        this.cityBtn = set.find('city_btn');      // +18 (linked to city_set)
        this.kionBtn = set.find('kion_btn');      // +14 (linked to kion_set)
        if (ctx.lang === Lang.jp) {
            for (const n of ['wind', 'wind_set', 'wind_btn']) { const p = set.find(n); if (p) { p.hidden = true; p.pane.visible = false; } }
            this.windSet = null; this.windBtn = null;
        } else {
            const t = set.find('text'); if (t) { t.hidden = true; t.pane.visible = false; }
            this.windSet = set.find('wind_set');  // +10
            this.windBtn = set.find('wind_btn');  // +1C (linked to wind_set)
        }
        this.state = SettingState.idle;   // PTMF +84
        this.cityName = [];               // +C0
        this.cityScale = 1;               // +A0
        /** Supplied by WeatherScene (shared 2D drawer). */
        this.drawer = null;
        // Portrait: title belt at the top, the three setting rows centred, Back in the bottom row.
        PortraitArrange.stretchBackgrounds(this.base);
        // The "Change Settings" strip sits at the hub belt's height (same vertical rhythm across screens).
        const hub = Portrait.current;
        PortraitArrange.place(set, [], ['back', 'blank'], ctx.isPortrait ? { belt: [0, (hub.beltShift + 130) - 180] } : {});
        PortraitArrange.extendBodies(set, ['back', 'blank'], false);   // web: no-op
        this.setupCityName();
        this.applyUnits();
    }

    applyUnits() {
        const ctx = this.ctx;
        if (this.kionSet) { this.kionSet.textIndex = ctx.tempUnit; this.kionSet.pendingTextIndex = ctx.tempUnit; }
        if (this.windSet) { this.windSet.textIndex = ctx.windUnit; this.windSet.pendingTextIndex = ctx.windUnit; }
    }

    /** fn_8002881C: city name for city_set, scaled to fit the text box. */
    setupCityName() {
        const ctx = this.ctx;
        const place = ctx.data?.forecast.place(ctx.locationID);
        if (!place) { this.cityName = []; return; }
        this.cityName = utf16(place.city);
        const font = Message.systemFont(ctx), box = this.set.pane('city_setTUS');
        if (!font || !box) return;
        const w = SceneDraw2D.stringWidth(this.cityName, font);
        this.cityScale = w > box.size[0] ? box.size[0] / w : 1;
    }

    /** fn_80028258 — reset (entering the screen). */
    reset() {
        this.set.reset(); this.base.reset();
        this.updateBrightness();
        this.setupCityName(); this.applyUnits();
        this.state = SettingState.idle;
    }
    /** fn_80028430 */
    startInteractive() { this.state = SettingState.interactive; }
    /** fn_800284E4 */
    startPassive() { this.state = SettingState.passive; }

    updateBrightness() {
        const lerp = (ramp) => 0x40 + Math.trunc((0xC0 - 0x40) * ramp / 12);   // LerpU8(0x40, 0xC0, hover, 12)
        if (this.cityBtn && this.citySet) this.citySet.brightness = lerp(this.cityBtn.hoverRamp);
        if (this.kionBtn && this.kionSet) this.kionSet.brightness = lerp(this.kionBtn.hoverRamp);
        if (this.windBtn && this.windSet) this.windSet.brightness = lerp(this.windBtn.hoverRamp);
    }

    calc() {
        const ctx = this.ctx;
        switch (this.state) {
            case SettingState.idle: break;
            case SettingState.passive:                    // fn_80028798
                this.applyUnits(); this.base.update(); this.set.update();
                break;
            case SettingState.interactive: {              // CSetting_StInteractive
                this.base.update(); this.set.update();
                ctx.ui.updateHover(this.set, ctx.pad);
                // Hovering a button also lights its value row (+24 link).
                const h = ctx.ui.hovered;
                if (h) {
                    if (h === this.cityBtn) this.citySet?.setHover();
                    else if (h === this.kionBtn) this.kionSet?.setHover();
                    else if (h === this.windBtn) this.windSet?.setHover();
                }
                this.updateBrightness();
                if (ctx.ui.buttonTrig('back', ctx.pad)) {
                    const b = this.set.find('back'); if (b) b.keepPressed = true;
                    ctx.playSE(0x27); ctx.request = 2;
                }
                if (ctx.ui.buttonTrig('city_btn', ctx.pad)) { ctx.request = 1; ctx.playSE(0x2D); }
                if (ctx.ui.buttonTrig('kion_btn', ctx.pad)) {
                    ctx.tempUnit = ctx.tempUnit === 0 ? 1 : 0; ctx.playSE(0x2C);
                    if (this.kionSet) { this.kionSet.textIndex = ctx.tempUnit; this.kionSet.pendingTextIndex = ctx.tempUnit; }
                }
                if (this.windBtn && ctx.ui.buttonTrig('wind_btn', ctx.pad)) {
                    ctx.windUnit = ctx.windUnit === 0 ? 1 : 0; ctx.playSE(0x2C);
                    if (this.windSet) { this.windSet.textIndex = ctx.windUnit; this.windSet.pendingTextIndex = ctx.windUnit; }
                }
                break;
            }
        }
    }

    /** fn_80028308: base, set, then the city name (TextWriter, centred on city_setTUS). */
    draw(enc) {
        const ctx = this.ctx;
        this.base.draw(ctx.lyt, enc);
        this.set.draw(ctx.lyt, enc);
        const d2 = this.drawer, font = Message.systemFont(ctx), box = this.set.pane('city_setTUS');
        if (!d2 || !font || !box) return;
        const m = box.globalMtx;
        const cx = m[12], cy = m[13];
        const a = Math.trunc(this.set.layoutAlpha);
        d2.text(this.cityName, font, 0.5 * ctx.screenWidth + cx, LogicalScreen.halfHeight - cy, [this.cityScale, 1],
                this.citySet?.lastTextColor ?? [0, 0, 0, a], undefined, undefined, true, enc);   // city_set +38 (RGBA, alpha +3B)
    }
}
