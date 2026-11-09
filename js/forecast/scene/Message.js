import { PortraitArrange } from './PortraitArrange.js';
import { LogicalScreen } from '../render/LogicalScreen.js';
import * as B from '../ui/bridge.js';

/**
 * CMessage (0x18, d_s_weather.cpp): modal message box. Port of CMessage_ctor/Open/Update (fn_8000BED8..fn_8000C0C4)
 * and its draw (fn_8000C2C4).
 *   type 1      error3.brlyt — "is this date and time correct?" yes/no, with the current date written into `message`
 *   type 0,2,3  error4.brlyt — OK (`next`); text 0 for type 2 (save corrupted), 1 for type 3 (cities changed)
 *   type 4,5,6  error2.brlyt — fatal; `next` returns to the Wii Menu; text 1 / 2 / 0
 * State (+10): 0 start fade-in → 1 wait → 2 interactive → 3 after "no" (re-open as type 6) → 4 closing → 5 closed.
 */
export class Message {
    constructor(ctx) {
        this.ctx = ctx;
        this.fade = ctx.fade;                       // +0 (m_pFade)
        this.yesNo = ctx.layout('error3.brlyt');    // +4 error3
        this.ok = ctx.layout('error4.brlyt');       // +8 error4
        this.fatal = ctx.layout('error2.brlyt');    // +C error2
        this.state = 5;                             // +10
        this.type = 0;                              // +14
        this.dateText = [];
        Message.arrangePortrait(this.yesNo, this.ok, this.fatal);
        this.open(0); this.state = 5;
    }

    get isClosed() { return this.state === 5; }

    /** CMessage_Open(type) */
    open(t) {
        this.state = 0; this.type = t;
        this.yesNo.reset(); this.ok.reset(); this.fatal.reset();
        for (const [ui, n] of [[this.yesNo, 'yes'], [this.yesNo, 'no'], [this.ok, 'next'], [this.fatal, 'next']]) {
            const p = ui.find(n); if (p) p.keepPressed = true;
        }
        if (t === 1) this.dateText = Message.formatDate(this.ctx);
    }

    /**
     * Mobile portrait: backgrounds cover the screen; each dialog stays one compact group, centred on screen
     * (the original's layout around the 456 screen's centre lands at the tall screen's centre).
     */
    static arrangePortrait(yesNo, ok, fatal) {
        if (!PortraitArrange.on) return;
        for (const ui of [yesNo, ok, fatal]) PortraitArrange.stretchBackgrounds(ui);
        // No Wii Menu on mobile: the fatal box's button retries (the shell reboots the channel) and its
        // texts don't mention the Wii.
        PortraitArrange.setText(fatal, 'nextTUS', 'Try Again');
        PortraitArrange.setText(fatal, 'textTUS1', "The saved settings couldn't be read.\nPlease try again.");
    }

    /** CMessage_Update */
    update() {
        const ctx = this.ctx, fade = this.fade;
        this.yesNo.update(); this.ok.update(); this.fatal.update();
        switch (this.state) {
            case 0: fade.startFadeIn(0x1E); this.state = 1; break;
            case 1: if (fade.isIdle) this.state = 2; break;
            case 2:
                if (this.type < 4) {
                    if (this.type === 1) {
                        ctx.ui.updateHover(this.yesNo, ctx.pad);
                        if (ctx.ui.buttonTrig('yes', ctx.pad)) { fade.startFadeOut(0x1E); this.state = 4; ctx.playSE(0x1A); }
                        else if (ctx.ui.buttonTrig('no', ctx.pad)) { fade.startFadeOut(0x1E); this.state = 3; ctx.playSE(0x1B); }
                    } else {
                        ctx.ui.updateHover(this.ok, ctx.pad);
                        if (ctx.ui.buttonTrig('next', ctx.pad)) { fade.startFadeOut(0x1E); this.state = 4; ctx.playSE(0x1A); }
                    }
                } else if (this.type < 7) {
                    ctx.ui.updateHover(this.fatal, ctx.pad);
                    if (ctx.ui.buttonTrig('next', ctx.pad)) { ctx.playSE(0x1A); ctx.returnToWiiMenu = true; }
                }
                break;
            case 3: if (fade.isIdle) { fade.startFadeIn(0x1E); this.state = 2; this.type = 6; } break;
            case 4: if (fade.isIdle) this.state = 5; break;
            default: break;
        }
    }

    /** fn_8000C2C4 */
    draw(enc, d2) {
        const ctx = this.ctx;
        if (this.type < 4) {
            if (this.type !== 1) {
                const t = this.ok.find('text');
                if (t) { t.textIndex = this.type === 3 ? 1 : 0; t.pendingTextIndex = t.textIndex; }
                this.ok.draw(ctx.lyt, enc);
            } else {
                this.yesNo.draw(ctx.lyt, enc);
                // The date/time line, white, centred in the `message` bounding pane, system font.
                const m = this.yesNo.find('message'), font = Message.systemFont(ctx);
                if (m && font) {
                    const cx = (m.hitRect[0] + m.hitRect[2]) * 0.5, cy = (m.hitRect[1] + m.hitRect[3]) * 0.5;
                    const x = cx + 0.5 * ctx.screenWidth, y = LogicalScreen.halfHeight - cy;   // as fn_8000C2C4: no wide rescale
                    d2.text(this.dateText, font, x, y, [1, 1], [255, 255, 255, 255], undefined, undefined, true, enc);
                }
            }
        } else if (this.type < 7) {
            const t = this.fatal.find('text');
            if (t) { t.textIndex = ({ 4: 1, 5: 2, 6: 0 })[this.type] ?? 0; t.pendingTextIndex = t.textIndex; }
            this.fatal.draw(ctx.lyt, enc);
        }
    }

    /**
     * The channel uses the console's system font (wbf1.brfna, ArchiveFont) for free text. It is not part of the
     * channel's title data; the port substitutes the channel's own city-name font.
     */
    static systemFont(ctx) { return ctx.assets.systemFont() ?? ctx.assets.font('font_weather_city.brfnt.LZ'); }

    /**
     * fn_8000C4F4: date/time string. Region 1 + language 1 (US English) uses the format at lbl_80199018+0x16C
     * with (month, day, year, hour, minute). The wide format string is read from main.dol at runtime.
     */
    static formatDate(ctx) {
        const d = new Date();
        const args = [d.getMonth() + 1, d.getDate(), d.getFullYear(), d.getHours(), d.getMinutes()];
        try {
            const dol = B.mainDolBytes(ctx.assets), off = B.dolImage(dol).offset(0x80199018 + 0x16C);
            if (off == null) throw 0;
            const r = B.beReader(dol), fmt = [];
            let p = off;
            while (p + 1 < dol.length && r.u16(p) !== 0 && fmt.length < 0x40) { fmt.push(r.u16(p)); p += 2; }
            return Message.swprintf(fmt, args);
        } catch (_) {
            return B.utf16(`${args[0]}/${args[1]}/${args[2]} ${args[3]}:${String(args[4]).padStart(2, '0')}`);
        }
    }

    /** Minimal swprintf: %d, %0Nd, %Nd, %%. */
    static swprintf(fmt, args) {
        const out = []; let i = 0, a = 0;
        while (i < fmt.length) {
            const ch = fmt[i];
            if (ch !== 0x25) { out.push(ch); i += 1; continue; }
            i += 1;
            if (i < fmt.length && fmt[i] === 0x25) { out.push(0x25); i += 1; continue; }
            let zero = false, width = 0;
            if (i < fmt.length && fmt[i] === 0x30) { zero = true; i += 1; }
            while (i < fmt.length && fmt[i] >= 0x30 && fmt[i] <= 0x39) { width = width * 10 + (fmt[i] - 0x30); i += 1; }
            while (i < fmt.length && (fmt[i] === 0x6C || fmt[i] === 0x68)) i += 1;   // l / h
            if (i < fmt.length) i += 1;
            let s = String(a < args.length ? args[a] : 0); a += 1;
            while (s.length < width) s = (zero ? '0' : ' ') + s;
            out.push(...B.utf16(s));
        }
        return out;
    }
}
