import { PortraitArrange } from './PortraitArrange.js';
import { PortraitSlots } from '../render/PortraitSlots.js';
import { WeatherDataError } from '../data/ForecastFormat.js';
import { SoundHandle } from '../../nw4r/snd/SoundSystem.js';
import * as B from '../ui/bridge.js';

/**
 * CConnect (Connect.cpp, 0x460): the boot-time WiiConnect24 fetch of forecast.bin / short.bin, its progress dots
 * and error screen. Port of CConnect_ctor/Start/Update/IsDone (fn_8000AA94..fn_8000B624) and draws fn_8000B46C,
 * fn_8000B6B0 (progress) and fn_8000B9C8 (error code). The NWC24 download is replaced by ForecastService.
 */
export class Connect {
    constructor(ctx, service) {
        this.ctx = ctx; this.service = service;
        this.progress = ctx.layout('error1.brlyt');      // +448 error1.brlyt ("please wait")
        this.errorLayout = ctx.layout('error0.brlyt');   // +44C error0.brlyt
        // Mobile portrait: backgrounds cover the screen; the dialogs stay centred as one group.
        PortraitArrange.stretchBackgrounds(this.progress);
        PortraitArrange.stretchBackgrounds(this.errorLayout);
        this.fade = ctx.fade;                             // +C
        /** +10 download state: 0 start, 2 waiting, 6 done, 7 error */
        this.state = 0;
        /** +450 dialog state: 0, 1 decide, 2 progress shown, 3 → error fade, 4 → done fade, 5 error interactive, 6 done */
        this.ui = 0;
        this.counter = 0;          // +444 progress animation 0..72
        this.result = 0;           // +34 NWC24-style result code
        this.serverMessage = null; // +440 forecast-file message (shown instead of data)
        this.box = null;           // { ok: data } | { err: e } once the load settles
        this.waitFrames = 0;
        this.loopSE = new SoundHandle();   // +454 (SE 0x17 while the progress dialog is up)
        this.loopSEActive = false;         // +458
        this.spinnerImages = [];
        this.codeFormat = { fmt: [], label: [], prefix: [] };
        // Tables from main.dol: spinner image indices (lbl_80179358, +0x18 for non-JP regions) and the error-code
        // format "%ls %ls%06d" with its label/prefix strings (relative to the "error1.brlyt" string, lbl_80198D80).
        try {
            const dol = B.mainDolBytes(ctx.assets);
            const img = B.dolImage(dol), r = B.beReader(dol);
            const base = 0x80179358 + (ctx.region !== 0 ? 0x18 : 0);
            this.spinnerImages = Array.from({ length: 6 }, (_, i) => img.u32(base + i * 4));
            const wide = (a) => {
                let o = img.offset(a); if (o == null) return [];
                const s = [];
                while (o + 1 < dol.length && r.u16(o) !== 0 && s.length < 64) { s.push(r.u16(o)); o += 2; }
                return s;
            };
            const s = 0x80198D80;
            const labels = [0x1B8, 0x1C8, 0x1E0, 0x1F8, 0x218, 0x228, 0x248];
            this.codeFormat = { fmt: wide(s + 0x260), label: wide(s + labels[Math.min(ctx.lang, 6)]), prefix: wide(s + 0x1AC) };
        } catch (_) { /* tables unavailable */ }
    }

    /** CConnect_Start (fn_8000AC44): the original builds /<lang>/<country:03>/forecast.bin and short.bin here. */
    start() {
        this.state = 0; this.ui = 0; this.counter = 0; this.result = 0; this.serverMessage = null;
        this.progress.reset(); this.errorLayout.reset();
        const n = this.errorLayout.find('next'); if (n) n.keepPressed = true;
        this.box = null;
    }

    /** CConnect_IsDone */
    get isDone() { return this.state === 6 && this.fade.isIdle; }

    /** CConnect_Update (fn_8000AD28) */
    update() {
        const ctx = this.ctx, fade = this.fade;
        this.progress.update(); this.errorLayout.update();
        switch (this.state) {
            case 0: {
                const pending = ctx.pendingData;
                this.service.loadForBoot((d) => pending.set(d))
                    .then((d) => { this.box = { ok: d }; }, (e) => { this.box = { err: e }; });
                this.state = 2; this.waitFrames = 0;
                break;
            }
            case 2:
                this.waitFrames += 1;
                if (this.box) {
                    const r = this.box;
                    if ('ok' in r) {
                        ctx.data = r.ok;
                        const m = r.ok.forecast?.message;
                        if (m && m.length) { this.serverMessage = B.utf16(m); this.state = 7; this.result = 0; }
                        else this.state = 6;
                    } else { this.result = Connect.nwc24Code(r.err); this.state = 7; }
                }
                break;
            default: break;
        }
        switch (this.ui) {
            case 0: this.ui = 1; // fallthrough
            case 1:
                if (this.state === 6) this.ui = 6;
                else if (this.state === 7) { fade.startFadeIn(0x1E); this.ui = 5; ctx.playSE(0x19); }
                else if (this.waitFrames > 30) { fade.startFadeIn(0x1E); this.ui = 2; }   // NWC24 status 4/5 = transferring
                break;
            case 2:
                if (fade.isIdle) {
                    if (this.state === 6) { fade.startFadeOut(0x32); this.ui = 4; ctx.playSE(0x18); }
                    else if (this.state === 7) { fade.startFadeOut(0x1E); this.ui = 3; }
                }
                break;
            case 3:
                if (fade.isIdle) { fade.startFadeIn(0x1E); this.ui = 5; ctx.playSE(0x19); }
                break;
            case 4:
                if (fade.isIdle) this.ui = 6;
                break;
            case 5:
                ctx.ui.updateHover(this.errorLayout, ctx.pad);
                if (fade.isIdle && ctx.ui.buttonTrig('next', ctx.pad)) { ctx.playSE(0x1A); ctx.returnToWiiMenu = true; }
                break;
            default: break;
        }
        if (this.ui >= 2 && this.ui < 5) { this.counter += 1; if (this.counter > 0x48) this.counter = 0; }
        if (this.ui === 2) {
            if (!this.loopSEActive && ctx.sound) { ctx.sound.startSound?.(this.loopSE, 0x17); this.loopSEActive = true; }
        } else if (this.loopSEActive) { ctx.sound?.stop?.(this.loopSE); this.loopSEActive = false; }
        // A finished download with the dialog never shown still has to report done.
        if (this.ui === 6 && this.state !== 6) this.state = 6;
    }

    /** Map our download failures onto the NWC24 result codes CConnect switches on. */
    static nwc24Code(e) {
        if (e?.offline || e instanceof TypeError || e?.name === 'AbortError' || e?.name === 'TimeoutError') return -9;   // fetch network failure
        if (e instanceof WeatherDataError) return -1;
        return -1;
    }

    /** fn_8000B46C */
    draw(enc, d2, weatherTPL) {
        const ctx = this.ctx, el = this.errorLayout;
        if (this.ui === 5 && ctx.isPortrait) {
            // Mobile: a plain message instead of WiiConnect24 texts and error codes; the button retries.
            const offline = this.result === -9 || this.result === -4;
            const msg = offline ? "Couldn't connect to the internet.\nCheck your connection and try again."
                                : "The forecast couldn't be downloaded\nright now. Please try again later.";
            const tb = el.pane('error_server');
            if (B.isTextBox(tb)) { tb.text = B.utf16(msg); tb.visible = true; }
            const t = el.find('text');
            if (t?.text) { for (const c of t.text.children) c.visible = false; t.text.visible = false; }
            const ec = el.pane('error_code'); if (B.isTextBox(ec)) ec.text = [];
            PortraitArrange.setText(el, 'nextTUS', 'Try Again');
            el.draw(ctx.lyt, enc);
            return;
        }
        if (this.ui === 5) {
            let code = 0, idx;
            const text = el.find('text');
            switch (this.result) {
                case -11: idx = 0; break;
                case -3: idx = 1; break;
                case -9: case -4: idx = 2; break;
                case -5: idx = 3; break;
                case -12: idx = 6; break;
                case -2: idx = 7; break;
                case 0: {
                    const tb = el.pane('error_server');
                    if (this.serverMessage && B.isTextBox(tb)) { tb.text = this.serverMessage; idx = -1; } else code = 6;
                    break;
                }
                case -8: code = 1; break;
                case -1: code = 5; break;
                case -6: code = 2; break;
                case -7: code = 3; break;
                default: code = 0x63;
            }
            if (text) {
                if (idx != null) text.textIndex = idx; else if (code !== 0) text.textIndex = 5;
                text.pendingTextIndex = text.textIndex;
                if (text.textIndex < 0 && text.text) for (const c of text.text.children) c.visible = false;
            }
            const es = el.pane('error_server'); if (es) es.visible = idx === -1;
            this.setErrorCode(code);
            el.draw(ctx.lyt, enc);
        } else if (this.ui >= 2 && this.ui < 5) {
            this.progress.draw(ctx.lyt, enc);
            this.drawSpinner(enc, d2, weatherTPL);
        }
    }

    /** fn_8000B9C8: "Error Code: FORE000005"-style line into the `error_code` text box. */
    setErrorCode(code) {
        const tb = this.errorLayout.pane('error_code');
        if (!B.isTextBox(tb)) return;
        if (code === 0 || !this.codeFormat.fmt.length) { tb.text = []; return; }
        // %ls %ls%06d with (label, prefix, |code|)
        const out = [], strs = [this.codeFormat.label, this.codeFormat.prefix], f = this.codeFormat.fmt;
        let i = 0;
        while (i < f.length) {
            if (f[i] === 0x25 && i + 2 < f.length && f[i + 1] === 0x6C && f[i + 2] === 0x73) { out.push(...(strs.shift() ?? [])); i += 3; continue; }
            if (f[i] === 0x25) { out.push(...B.utf16(String(Math.abs(code)).padStart(6, '0'))); i += 4; continue; }
            out.push(f[i]); i += 1;
        }
        tb.text = out;
    }

    /** fn_8000B6B0: six dots at y 280, 40 px apart, scale 0.6, a light chasing along every 12 frames. */
    drawSpinner(enc, d2, tpl) {
        if (!tpl || this.spinnerImages.length !== 6) return;
        let x = 0.5 * (this.ctx.screenWidth - 200);
        const cur = Math.trunc(this.counter / 12), rem = this.counter % 12;
        for (let i = 0; i < 6; i++) {
            let a;
            if (i === cur) a = Math.trunc(255 * Math.sin(1.5707964 * (rem + 1) / 12));
            else {
                let d = cur - i; if (d < 0) d += 6;
                a = Math.trunc(Math.max(0, 0x48 - (rem + d * 12)) * 255 / 72);
            }
            const img = this.spinnerImages[i];
            if (img < tpl.images.length) {
                const w = tpl.images[img].width, h = tpl.images[img].height;
                d2.image(tpl, img, x - 0.5 * 0.6 * w, PortraitSlots.pixelCentre(280) - 0.5 * 0.6 * h, 0.6, 0.6,
                         [255, 255, 255, Math.max(0, Math.min(255, a))], 'TPLWeather', enc);
            }
            x += 40;
        }
    }
}
