import { Connect } from './Connect.js';
import { Message } from './Message.js';
import { SaveData, SaveDataLoadResult } from './SaveData.js';
import { AddressScreen } from './address/AddressScreen.js';
import { SceneDraw2D } from './address/SceneDraw2D.js';
import { NormalScreen } from './normal/NormalScreen.js';
import { AroundScreen } from './around/AroundScreen.js';
import { SettingScreen } from './setting/SettingScreen.js';
import { SpriteText } from '../ui/SpriteText.js';
import { Lang } from '../ui/PaneCtl.js';
import { CursorState } from '../ui/Cursor.js';
import { LogicalScreen } from '../render/LogicalScreen.js';
import { PortraitSlots } from '../render/PortraitSlots.js';
import { ForecastService } from '../data/ForecastService.js';
import { LocationID } from '../data/ForecastFormat.js';
import { SceneFrame } from '../render/SceneFrame.js';
import { TouchMode } from '../system/TouchInput.js';
import { chaseValue } from '../game/GlobeMath.js';
import * as B from '../ui/bridge.js';

/** Scene states (the PTMFs at lbl_80199AA8 + off). */
export const SceneState = Object.freeze({ boot: 'boot', address: 'address', normal: 'normal', globe: 'globe', setting: 'setting', connectError: 'connectError' });

/** An async operation polled by the frame loop (NAND access is synchronous on the Wii; IndexedDB isn't). */
class Pending {
    constructor(promise) {
        this.done = false; this.value = undefined;
        promise.then((v) => { this.value = v; this.done = true; }, (e) => { this.value = e; this.error = true; this.done = true; });
    }
}

/**
 * CWeatherScene ('WTH2', d_s_weather.cpp, 0x16C): the channel's top-level state machine plus the parts of
 * System_Frame the port needs (transition overlay, frame capture). See decomp/notes/scenes.md §1, §3 and
 * decomp/notes/scene_port.md for the state/PTMF mapping.
 */
export class WeatherScene {
    /** @param ctx SceneContext  @param service ForecastService (optional; the shell may configure one) */
    constructor(ctx, service = null) {
        this.ctx = ctx;
        this.service = service ?? new ForecastService();
        this.connect = new Connect(ctx, this.service);   // +158
        this.message = new Message(ctx);                 // +15C
        this.address = null;                             // +B0
        this.normal = null;                              // +B4
        this.around = null;                              // +B8
        this.setting = null;                             // +BC
        this.d2 = new SceneDraw2D(ctx.gx, ctx.lyt, ctx.screenWidth);
        this.overlaySprites = null;
        /**
         * lbl_803309F8 — credit variant for WeatherScene_StE6C8: bit 0 = second line (TPLCommon 3, or 6 with bit 1),
         * bit 1 = globe variant (TPLWeather 0x19 instead of 0x18). Top-level hub 0, hub from a marker 1, globe 3.
         */
        this.creditFlags = 0;
        /** +13C: fn_8001812C runs on the first hub → globe entry only. */
        this.globeInitDone = false;
        /** lbl_801D6F7C.y (ctor: 365) */
        this.creditY = 365;
        this.weatherTPL = null;                          // +AC TPLWeather.tpl.LZ
        this.state = SceneState.boot;
        this.step = 0;                                   // +138
        this.t144 = 0; this.t148 = 0;                    // +144 / +148 timers
        this.dimAlpha = 0;                               // +140
        this.save = new SaveData();                      // +160
        this.pendingOpenZoom = false;
        this.loadResult = SaveDataLoadResult.noFile;     // +164
        this.storeResult = 0;                            // +168
        this.settingsChangeCity = false;                 // +154
        this.quitting = false;
        this._io = null;                                 // in-flight SaveData load/store
        /** Set when the channel would return to the Wii Menu (OSReturnToMenu); the shell polls this (desktop). */
        this.wantsQuit = false;
        /** Mobile: "Try Again" / exit finished its press/fade sequence — the shell reboots the channel. */
        this.wantsSuspend = false;

        // BGM layers (lbl_801F76D4[4]) and their fades (+F4 + 12·i: cur, target, step)
        this.bgmCur = [0, 0, 0, 0]; this.bgmTarget = [0, 0, 0, 0]; this.bgmStep = [0, 0, 0, 0];
        this.bgmMode = 0;                                // +134
        this.fadeIn = [[1 / 135, 1 / 240, 1 / 240, 1 / 240], [1 / 120, 1 / 240, 1 / 240, 1 / 240]];   // day / night
        this.fadeOut = [[1 / 240, 1 / 135, 1 / 135, 1 / 135], [1 / 240, 1 / 120, 1 / 120, 1 / 120]];

        // System_Frame transition overlay (lbl_80330B48 mode, B4C counter, B50 length) and the frame-capture buffer.
        this.transitionMode = 0;
        this.transitionCount = 0; this.transitionLength = 1;
        /** sceneColor / sceneDepth / capture (track B's SceneFrame). */
        this.frame = new SceneFrame(ctx.gx);
        this.pendingCapture = false;
        this.viewportSize = [1, 1];
        this.viewportOrigin = [0, 0];

        try {
            const lz = B.weatherArchive(ctx.assets).find('TPLWeather.tpl.LZ');
            if (lz) this.weatherTPL = B.tplFile(B.uncompressIfNeeded(lz));
        } catch (_) { this.weatherTPL = null; }
        // Fade-step tables (rodata 0x80179400 day in/out, 0x80179420 night in/out).
        try {
            const img = B.dolImage(B.mainDolBytes(ctx.assets));
            const row = (a) => [0, 1, 2, 3].map(i => img.f32(a + i * 4));
            const di = row(0x80179400), dout = row(0x80179410), ni = row(0x80179420), nout = row(0x80179430);
            if (di.every(v => v > 0 && v < 1)) { this.fadeIn = [di, ni]; this.fadeOut = [dout, nout]; }
        } catch (_) { /* keep defaults */ }
        ctx.startPage = 1;
        ctx.pageCount = ctx.lang === Lang.jp ? 4 : 5;
        // Port-only: the shell reuses one SceneContext when it reboots the channel (web "Wii Menu" / "Try Again"),
        // so the globals a fresh boot expects are reset here (on the Wii they start zeroed with the process).
        ctx.returnToWiiMenu = false; ctx.request = 0; ctx.isTopLevel = true; ctx.displayLocation = null; ctx.globeMode = 0;
        ctx.fade.maxAlpha = 255; ctx.fade.state = 'idle'; ctx.fade.alpha = 255;
        ctx.fade2.maxAlpha = 0xA0; ctx.fade2.state = 'idle'; ctx.fade2.alpha = 0;
        ctx.ui.clearHover();
    }

    /** The last rendered scene frame. */
    get frameTexture() { return this.frame.frameTexture; }
    get dayIdx() { return this.ctx.isDaytime ? 0 : 1; }

    /** Touch: how a touch starting at `p` maps to the A button (see TouchInput). */
    touchMode(p) {
        if (this.state === SceneState.globe && this.around) return this.around.touchMode(p);
        return TouchMode.pressOnRelease;
    }

    /** Cursor choice (CErrorSystem): grab/open hand on the globe, the scroll sprite in the city list, else the pointing hand. */
    get cursorState() {
        switch (this.state) {
            case SceneState.globe: return this.around?.cursorState ?? CursorState.normal;
            case SceneState.address: return this.address?.cursorState ?? CursorState.normal;
            default: return CursorState.normal;
        }
    }

    // MARK: - Calc (WeatherScene_Calc → current state PTMF; fn_8000DD84 common per-frame work)

    calc() {
        const ctx = this.ctx;
        // Everything uploaded ahead of first use, a few items per frame from boot (no art popping in later).
        if (!this.overlaySprites) { try { this.overlaySprites = new SpriteText(ctx); } catch (_) {} }
        ctx.queuePrewarm(this.overlaySprites);
        ctx.stepPrewarm();
        ctx.fade.update(); ctx.fade2.update();
        if (ctx.returnToWiiMenu && !this.quitting) { this.quitting = true; ctx.fade.startFadeOut(0x19); }
        if (this.quitting) {
            if (ctx.fade.isIdle) { if (ctx.isPortrait) this.wantsSuspend = true; else this.wantsQuit = true; }
            this.updateBGM(); return;
        }
        this.around?.weatherSoundPreCalc();   // vtable +0x20 fn_8000DD24
        // fn_8000DD84: CAround's calc (fn_8001864C) runs every frame before the state PTMF. CAddress drives the
        // globe itself while it owns it (port: AddressScreen.animateGlobe), so it is skipped there.
        if (this.state !== SceneState.address) this.around?.frame();
        this.normal?.stepZoom();   // fn_8000DD84 → fn_800225FC: the hub's zoom sub-state runs whatever the scene state
        switch (this.state) {
            case SceneState.boot: this.stBoot(); break;
            case SceneState.address: this.stAddress(); break;
            case SceneState.normal: this.stNormal(); break;
            case SceneState.globe: this.stGlobe(); break;
            case SceneState.setting: this.stSetting(); break;
            case SceneState.connectError: this.stConnect(); break;
        }
        // fn_8000DD84: the credit's y chases 0x166 with the second line, else 0x16D (ChaseValue 0.1, 5, 1).
        [this.creditY] = chaseValue(this.creditY, (this.creditFlags & 1) ? 0x166 : 0x16D, 0.1, 5, 1);
        this.updateBGM();
        this.around?.weatherSoundPostCalc();  // vtable +0x2C fn_8000DD54
        if (this.transitionMode !== 0) { this.transitionCount += 1; if (this.transitionCount >= this.transitionLength) this.transitionMode = 0; }
    }

    go(s) { this.state = s; this.step = 0; }

    /** Poll an async SaveData call: returns its value once settled (and clears it), else undefined. */
    _poll(start) {
        if (!this._io) { this._io = new Pending(start()); return undefined; }
        if (!this._io.done) return undefined;
        const v = this._io.value; this._io = null;
        return v;
    }

    /** WeatherScene_StBoot (fn_8000FEB4) */
    stBoot() {
        const ctx = this.ctx;
        switch (this.step) {
            case 0:
                ctx.request = 0; this.step = 1;
                // fallthrough
            case 1:
                this.connect.start(); this.step = 2;
                break;
            case 2:
                this.connect.update();
                if (this.connect.isDone) this.step = 3;
                break;
            case 3: {
                const res = this._poll(() => SaveData.load());
                if (res === undefined) break;
                const [r, s] = Array.isArray(res) ? res : [SaveDataLoadResult.nandError, new SaveData()];
                this.loadResult = r; this.save = s;
                switch (r) {
                    case SaveDataLoadResult.ok:
                        if (s.country === ((ctx.countryCode << 24) >>> 0) && ctx.data?.forecast.place(new LocationID(s.location))) this.step = 9;
                        else { this.message.open(3); this.step = 4; }
                        break;
                    // Mobile: no "Is this date and time correct?" — the device clock is always set.
                    case SaveDataLoadResult.noFile: if (ctx.isPortrait) this.step = 9; else { this.message.open(1); this.step = 4; } break;
                    case SaveDataLoadResult.broken: this.message.open(2); this.step = 4; ctx.playSE(0x19); break;
                    default: this.message.open(4); this.step = 4; ctx.playSE(0x19); break;
                }
                break;
            }
            case 4:
                this.message.update();
                if (this.message.isClosed) { this.step = 9; if (this.loadResult === SaveDataLoadResult.ok) this.loadResult = SaveDataLoadResult.noFile; }
                break;
            default:
                this.applySettings();
        }
    }

    /** fn_8000E078: apply save (or defaults from the forecast header), create the screens, enter hub or address. */
    applySettings() {
        const ctx = this.ctx;
        if (this.loadResult === SaveDataLoadResult.ok) {
            ctx.locationID = new LocationID(this.save.location);
            ctx.tempUnit = this.save.tempUnit; ctx.windUnit = this.save.windUnit;
        } else {
            ctx.locationID = new LocationID((ctx.countryCode << 24) >>> 0);
            if (ctx.data?.forecast.header.regionFlag === 1) { ctx.tempUnit = 1; ctx.windUnit = 0; }
            else { ctx.tempUnit = 0; ctx.windUnit = 1; }
        }
        try {
            const ar = new AroundScreen(ctx);
            ar.initOnce();   // fn_8000E384 → fn_80017FC8 (the only call)
            this.around = ar;
            this.address = new AddressScreen(ctx, ar);
            this.normal = new NormalScreen(ctx);
            this.setting = new SettingScreen(ctx);
        } catch (e) {
            this.constructError = e;
            this.message.open(5); this.go(SceneState.connectError); return;
        }
        const sc = (x, y, w, h) => this.scissor(x, y, w, h);
        this.address.drawer = this.d2; this.address.scissor = sc;
        this.normal.scissor = sc;
        this.setting.drawer = this.d2;
        ctx.ui.clearHover();
        if (this.loadResult === SaveDataLoadResult.ok) {
            ctx.request = 2;
            this.go(SceneState.normal);
        } else {
            ctx.request = 1;
            this.address.firstRun = true;
            this.go(SceneState.address);
        }
        ctx.fade.startFadeIn(0x19);
    }

    /** WeatherScene_StAddress (fn_8000E934) */
    stAddress() {
        const ctx = this.ctx, address = this.address;
        if (!address) return;
        switch (this.step) {
            case 0:
                ctx.request = 1;
                this.bgmEnterOption();
                address.start();
                this.step = 1;
                break;
            case 1:
                address.calc();
                if (ctx.fade.isIdle) this.step = 2;
                break;
            case 2:
                address.calc();
                if (ctx.request === 2) { this.step = 3; ctx.fade.startFadeOut(0x19); }
                else if (ctx.request === 4) { this.step = 4; ctx.fade.startFadeOut(0x19); }
                break;
            case 3: {
                address.calc();
                if (!ctx.fade.isIdle) break;
                if (!this._io) this.applyPendingData();   // fully black
                const r = this._poll(() => this.storeSave());
                if (r === undefined) break;
                this.storeResult = typeof r === 'number' ? r : 3;
                if (this.storeResult === 0) {
                    address.firstRun = false;
                    ctx.fade.startFadeIn(0x19); ctx.ui.clearHover();
                    ctx.isTopLevel = true;
                    this.go(SceneState.normal);
                } else { ctx.ui.clearHover(); this.go(SceneState.connectError); }
                break;
            }
            default:
                if (ctx.fade.isIdle) {
                    this.setting?.reset();
                    ctx.fade.startFadeIn(0x19); ctx.ui.clearHover();
                    this.go(SceneState.setting); this.step = 1;   // StFAE4 entered with the fade already running
                }
        }
    }

    // MARK: - External settings (kept from the iPhone build; the web uses the channel's own Settings screen)

    /** The settings currently in effect; null location before the first-run location has been chosen. */
    get currentSettings() {
        const c = this.ctx;
        return { location: (c.locationID.raw & 0xFFFF) !== 0 ? c.locationID.raw : null, temp: c.tempUnit, wind: c.windUnit };
    }

    /** Apply settings changed outside the channel (e.g. Geolocation): store the save and re-enter the hub. */
    applyExternalSettings(location, temp, wind) {
        const ctx = this.ctx;
        if (!(this.state === SceneState.normal || this.state === SceneState.globe) || !ctx.data) return;
        let changed = false, moved = false;
        if (temp !== ctx.tempUnit) { ctx.tempUnit = temp; changed = true; }
        if (wind !== ctx.windUnit) { ctx.windUnit = wind; changed = true; }
        if (location != null && location !== ctx.locationID.raw && ctx.data.forecast.place(new LocationID(location))) {
            ctx.locationID = new LocationID(location); moved = true; changed = true;
        }
        if (!changed) return;
        this.storeSave().then((r) => { this.storeResult = r; });
        if (moved) this.around?.reloadMarkers();
        if (this.state === SceneState.normal && this.step >= 1 && this.step < 4 && this.normal) {
            ctx.isTopLevel = true; ctx.displayLocation = null;
            this.normal.enter(false);
        }
    }

    /** Async: 0 ok, 3 NAND error. */
    storeSave() {
        const ctx = this.ctx, s = this.save;
        s.location = ctx.locationID.raw;
        s.country = (ctx.countryCode << 24) >>> 0;   // stored as country<<24 (lbl_803309FC), verified in Dolphin
        s.tempUnit = ctx.tempUnit >>> 0; s.windUnit = ctx.windUnit >>> 0;
        return s.store();
    }

    /**
     * A background refresh is applied only while the screen is fully black (hub↔globe, settings/address fades), so
     * values and markers never change in view.
     */
    applyPendingData() {
        const fresh = this.ctx.pendingData.take();
        if (!fresh) return;
        this.ctx.data = fresh; this.around?.reloadMarkers();
    }

    /** WeatherScene_StNormal (fn_8000EF08) */
    stNormal() {
        const ctx = this.ctx, normal = this.normal;
        if (!normal) return;
        switch (this.step) {
            case 0:
                this.step = 1;
                ctx.request = 0;   // the request that led here (address confirm / settings back) is consumed
                this.bgmEnterSelf();
                this.creditFlags = ctx.isTopLevel ? 0 : 1;   // StNormal step 0: lbl_803309F8 = (lbl_8032FD00 == 0)
                normal.enter(false);
                // StF660 request 2 put CNormal into fn_80027270: the hub zooms out of the tapped marker.
                if (this.pendingOpenZoom) { this.pendingOpenZoom = false; normal.startOpenZoom(ctx.markerPoint); }
                // fallthrough
            case 1:
                normal.calc();
                if (ctx.request === 5) {   // open globe: dim, then reset the globe to the user's city
                    this.step = 4; ctx.request = 0;   // consumed (AroundScreen posts 3 for "back")
                    ctx.fade2.maxAlpha = 255;   // StNormal: m_pFade2 colour = (0,0,0,0xFF) → a full fade to black
                    ctx.fade2.startFadeOut(0x14);
                    this.t148 = 0xC; this.t144 = 0x28;
                    this.bgmEnterGlobe();
                } else if (ctx.request === 4) {   // settings
                    this.step = 3; ctx.fade.startFadeOut(0x19);
                } else if (ctx.request === 3 && !ctx.isTopLevel) {   // back to the globe (hub was opened from a marker)
                    this.t144 = 0xC; this.step = 2; ctx.request = 0;   // consumed, or CAround reads it as its own back request
                    normal.buttonsVisible = false;                     // 0x8000F39C: +7F9 = 0
                    if (this.around) this.around.layoutsVisible = true;   // 0x8000F3A4
                    this.bgmEnterGlobe();
                }
                break;
            case 2:
                if (this.t144 > 0) this.t144 -= 1;
                else { ctx.ui.clearHover(); this.go(SceneState.globe); this.step = 1; this.creditFlags = 3; this.around?.enterGlobe(); }   // StF660 step 0
                break;
            case 3:
                if (ctx.fade.isIdle) { ctx.ui.clearHover(); this.go(SceneState.setting); }
                break;
            case 4:
                this.dimAlpha = Math.min(this.dimAlpha + this.t148, 255);
                if (ctx.fade2.isIdle) {
                    if (this.t144 > 0) this.t144 -= 1;
                    else {
                        this.step = 5;
                        this.applyPendingData();   // fully black
                        this.resetGlobeToHome();
                        ctx.fade2.startFadeIn(0x28);
                        if (this.around) this.around.layoutsVisible = true;   // +24F = 1
                        if (!this.globeInitDone) { this.globeInitDone = true; this.around?.enterForAddress(ctx.displayLocation ?? ctx.locationID); }   // +13C → fn_8001812C
                        this.creditFlags = 3;   // StNormal 0x8000F3C4
                    }
                }
                break;
            default:
                this.dimAlpha = Math.max(this.dimAlpha - this.t148, 0);   // the passive CAround frame keeps the globe/markers current
                if (ctx.fade2.isIdle) { this.dimAlpha = 0; ctx.ui.clearHover(); this.go(SceneState.globe); this.step = 1; this.creditFlags = 3; this.around?.enterGlobe(); }
        }
    }

    resetGlobeToHome() {
        const p = this.ctx.data?.forecast.place(this.ctx.locationID);
        if (!p) return;
        const g = this.ctx.globeScene.globe;
        g.reset([p.latitudeDegrees, p.longitudeDegrees, 0], 0);
        g.setTiltIndex(0, false);
        g.setTiltIndexImmediate(0);
        g.camera.twist = 0;
    }

    /** WeatherScene_StF660 — the globe (CAround). */
    stGlobe() {
        const ctx = this.ctx, around = this.around;
        if (!around) return;
        switch (this.step) {
            case 0: case 1:
                // (CAround's frame already ran this frame, from calc().)
                if (ctx.request === 3) {
                    around.leaveGlobe(false);   // +A4 = fn_80018C9C
                    // back to the hub
                    this.step = 2; ctx.request = 2;
                    ctx.fade2.maxAlpha = 255;   // StF660: m_pFade2 colour = (0,0,0,0xFF)
                    ctx.fade2.startFadeOut(0xC);
                    ctx.isTopLevel = true;
                    ctx.displayLocation = null;
                    this.bgmEnterSelf();
                    this.t144 = 0x1E;
                    ctx.startPage = this.startPageForGlobeMode();
                } else if (ctx.request === 6) {
                    // a marker was chosen (AroundScreen.selectedLocation): show that city's pages (hub not top level)
                    ctx.request = 0;
                    ctx.startPage = this.startPageForGlobeMode();
                    ctx.isTopLevel = false;
                    ctx.displayLocation = around.selectedLocation;
                    around.layoutsVisible = false;   // 0x8000F6A4
                    around.leaveGlobe(true);         // +250 = 1, +A4 = fn_80018C9C
                    ctx.ui.clearHover();
                    this.pendingOpenZoom = true;     // fn_80025C40(CNormal, fn_80027270)
                    this.go(SceneState.normal);
                }
                break;
            case 2:
                if (ctx.fade2.isIdle) {
                    if (this.t144 > 0) this.t144 -= 1;
                    else {
                        this.step = 3;
                        around.layoutsVisible = false;   // 0x8000F9F4
                        this.creditFlags = 0;            // 0x8000F960
                        this.creditY = 365;              // 0x8000F948: lbl_801D6F7C.y = 365
                        ctx.fade2.startFadeIn(0x19);
                        ctx.isTopLevel = true;
                        ctx.startPage = this.startPageForGlobeMode();
                        this.applyPendingData();   // fully black
                        this.normal?.enter(true);
                    }
                }
                break;
            default:
                if (ctx.fade2.isIdle) { ctx.ui.clearHover(); this.go(SceneState.normal); this.step = 1; }
        }
    }

    /** Hub start page from the globe display mode (non-JP: current 0–1 → 1, today 2–3 → 2, tomorrow 4–5 → 3). */
    startPageForGlobeMode() {
        const m = this.ctx.globeMode;
        if (this.ctx.lang === Lang.jp) return m < 6 ? 2 : 1;
        if (m < 2) return 1;
        if (m < 4) return 2;
        if (m < 6) return 3;
        return 1;
    }

    /** WeatherScene_StFAE4 — settings (CSetting). */
    stSetting() {
        const ctx = this.ctx, setting = this.setting;
        if (!setting) return;
        switch (this.step) {
            case 0:
                this.bgmEnterOption();
                setting.reset();
                ctx.fade.startFadeIn(0x19);
                this.step = 1;
                break;
            case 1:
                setting.calc();
                if (ctx.fade.isIdle) { this.step = 2; setting.startInteractive(); ctx.request = 0; }
                break;
            case 2:
                setting.calc();
                if (ctx.request === 1) {   // change city
                    this.step = 4; ctx.fade.startFadeOut(0x19); setting.startPassive(); this.settingsChangeCity = true;
                } else if (ctx.request === 2) {   // back (save if changed)
                    this.step = 3; ctx.fade.startFadeOut(0x19); setting.startPassive();
                }
                break;
            case 3: {
                setting.calc();
                if (!ctx.fade.isIdle) break;
                // StFAE4 step 3: store only when the location or a unit changed.
                const s = this.save;
                if (this._io || s.location !== ctx.locationID.raw || s.tempUnit !== (ctx.tempUnit >>> 0) || s.windUnit !== (ctx.windUnit >>> 0)) {
                    const r = this._poll(() => this.storeSave());
                    if (r === undefined) break;
                    this.storeResult = typeof r === 'number' ? r : 3;
                    if (this.storeResult !== 0) { this.go(SceneState.connectError); return; }
                }
                this.applyPendingData();   // fully black
                ctx.fade.startFadeIn(0x19);
                ctx.isTopLevel = true;
                this.go(SceneState.normal);
                break;
            }
            default:
                setting.calc();
                if (ctx.fade.isIdle) {
                    ctx.fade.startFadeIn(0x19);   // StFAE4 step 4
                    if (this.address) this.address.firstRun = false;
                    ctx.request = 1;
                    this.go(SceneState.address);
                }
        }
    }

    /** WeatherScene_StConnect (fn_80010114) */
    stConnect() {
        if (this.step === 0) {
            this.message.open(this.storeResult === 3 ? 4 : 5);
            this.ctx.playSE(0x19);
            this.step = 1;
        }
        this.message.update();
    }

    // MARK: - BGM (fn_8000ED20 / fn_8000F4B8 / fn_8000E7FC / fn_8000DD84)

    get bgmIDs() { return this.ctx.isDaytime ? [30, 28, 29, 34] : [33, 31, 32, 34]; }
    _bgm(i) { return this.ctx.sound?.bgmHandles?.[i] ?? null; }

    bgmStart(i) {
        const s = this.ctx.sound, h = this._bgm(i);
        if (!s || !h) return;
        if (!s.isAttached(h)) { s.startSound(h, this.bgmIDs[i]); s.setVolume(h, this.bgmCur[i]); }
        else s.pause(h, false);
    }

    /** fn_8000ED20 — entering the hub ("SELF"). */
    bgmEnterSelf() {
        const d = this.dayIdx, s = this.ctx.sound;
        if (this.ctx.isTopLevel) {
            const h0 = this._bgm(0);
            if (s && h0 && !s.isAttached(h0)) {
                s.startSound(h0, this.bgmIDs[0]);
                this.bgmCur[0] = 1; this.bgmTarget[0] = 1; s.setVolume(h0, 1);
            } else {
                if (s && h0) s.pause(h0, false);
                this.bgmTarget[0] = 1; this.bgmStep[0] = this.fadeIn[d][0];
            }
            this.bgmTarget[1] = 0; this.bgmStep[1] = this.fadeOut[d][1];
        } else {
            if (s) { const h1 = this._bgm(1), h2 = this._bgm(2); if (h1) s.pause(h1, false); if (h2) s.pause(h2, false); }
            this.bgmTarget[0] = 0; this.bgmStep[0] = this.fadeOut[d][0];
            this.bgmTarget[1] = 1; this.bgmStep[1] = this.fadeIn[d][1];
        }
        this.bgmTarget[2] = 0; this.bgmStep[2] = this.fadeOut[d][2];
        this.bgmTarget[3] = 0; this.bgmStep[3] = this.fadeOut[d][Math.min(this.bgmMode, 3)];
    }

    /** fn_8000F4B8 — entering the globe group (forecast + globe layers). */
    bgmEnterGlobe() {
        const d = this.dayIdx;
        this.bgmMode = 2;
        this.bgmTarget[0] = 0; this.bgmStep[0] = this.fadeOut[d][0];
        this.bgmStart(1); this.bgmStart(2);
        this.bgmTarget[1] = 1; this.bgmStep[1] = this.fadeIn[d][1];
        this.bgmTarget[2] = 1; this.bgmStep[2] = this.fadeIn[d][2];
        this.bgmTarget[3] = 0; this.bgmStep[3] = this.fadeOut[d][this.bgmMode];
    }

    /** fn_8000E7FC — entering settings / city select ("OPTION"). */
    bgmEnterOption() {
        const d = this.dayIdx;
        this.bgmMode = 3;
        this.bgmStart(3);
        this.bgmTarget[1] = 0; this.bgmStep[1] = this.fadeOut[d][1];
        this.bgmTarget[0] = 0; this.bgmStep[0] = this.fadeOut[d][0];
        this.bgmTarget[2] = 0; this.bgmStep[2] = this.fadeOut[d][2];
        this.bgmTarget[3] = 1; this.bgmStep[3] = this.fadeIn[d][this.bgmMode];
    }

    /** fn_8000DD84 tail: move each layer toward its target (fn_800369A8), apply volume, pause silent layers. */
    updateBGM() {
        const s = this.ctx.sound;
        if (!s || !s.bgmHandles) return;
        const H = s.bgmHandles, c = this.bgmCur, t = this.bgmTarget;
        for (let i = 0; i < 4; i++) {
            if (!s.isAttached(H[i])) continue;
            if (c[i] < t[i]) c[i] = Math.min(c[i] + this.bgmStep[i], t[i]);
            else if (c[i] > t[i]) c[i] = Math.max(c[i] - this.bgmStep[i], t[i]);
            s.setVolume(H[i], c[i]);
        }
        if (c[0] === 0 && s.isAttached(H[0])) s.pause(H[0], true);
        if (c[1] === 0 && c[2] === 0) {
            if (s.isAttached(H[1])) s.pause(H[1], true);
            if (s.isAttached(H[2])) s.pause(H[2], true);
        }
        if (c[3] === 0 && s.isAttached(H[3])) s.pause(H[3], true);
    }

    // MARK: - System_Frame transition overlay

    /**
     * Start a System_Frame overlay. mode 1 black fade, 2 captured-frame cross-fade, 3/4 zoom cross-fade
     * (texcoord inset 0.1·e; mode 3 inverts alpha). The current frame is captured at the end of this frame.
     */
    startTransition(mode, frames) {
        this.transitionMode = mode; this.transitionLength = Math.max(frames, 1); this.transitionCount = 0;
        if (mode >= 2) this.pendingCapture = true;
    }

    // MARK: - Render

    /** Logical (0..W × 0..H) rect → enc scissor rect (off-screen scene target pixels). */
    scissor(x, y, w, h) {
        const sx = this.viewportSize[0] / this.ctx.screenWidth, sy = this.viewportSize[1] / LogicalScreen.height;
        const x0 = Math.max(0, Math.trunc(x * sx)), y0 = Math.max(0, Math.trunc(y * sy));
        const x1 = Math.min(Math.trunc(this.viewportSize[0]), Math.trunc((x + w) * sx)), y1 = Math.min(Math.trunc(this.viewportSize[1]), Math.trunc((y + h) * sy));
        return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
    }

    ensureTargets(w, h) { this.frame.ensure(w, h); }

    /**
     * Draws the whole frame: scene into an off-screen target, then composite + overlay into the canvas at
     * `viewport` ({originX, originY, width, height} in canvas pixels — the letterboxed logical screen; the shell
     * clears the canvas black first = the bars).
     */
    render(viewport) {
        const gx = this.ctx.gx;
        const w = Math.max(Math.round(viewport.width), 1), h = Math.max(Math.round(viewport.height), 1);
        this.viewportSize = [w, h]; this.viewportOrigin = [viewport.originX, viewport.originY];
        this.ensureTargets(w, h);
        gx.beginFrame();
        const enc = this.frame.beginScene();
        enc.setViewport({ originX: 0, originY: 0, width: w, height: h });
        this.drawScene(enc);
        enc.endEncoding();
        if (this.pendingCapture) { this.frame.capture(); this.pendingCapture = false; }
        const out = this.frame.beginPresent(viewport);
        this.d2.texture(this.frame.frameTexture, 0, 0, this.ctx.screenWidth, LogicalScreen.height, [0, 0, 1, 1], 255, out);
        this.drawTransition(out);
        out.endEncoding();
    }

    /** CScene_Draw: state draw PTMF, then the two CFade quads. */
    drawScene(enc) {
        const ctx = this.ctx, d2 = this.d2;
        switch (this.state) {
            case SceneState.boot:
                if (this.step >= 4) this.message.draw(enc, d2); else this.connect.draw(enc, d2, this.weatherTPL);
                break;
            case SceneState.address:
                this.address?.draw(enc);
                break;
            case SceneState.normal:
                // step 4: the hub dims while the overlay fades in; step 5: the reset globe shows as it fades out.
                // WeatherScene_StE6C8: GlobeScreen_Draw, then the hub (fn_80023E58) over it.
                this.around?.draw(enc);
                // (not on the frame between a marker tap and StNormal step 0 — the hub isn't entered yet: no flicker)
                if (this.step < 5 && !(this.step === 0 && this.pendingOpenZoom)) this.normal?.draw(enc);
                this.drawCredit(enc);
                break;
            case SceneState.globe:
                this.around?.draw(enc);
                // StE6C8 keeps drawing the hub: it finishes zooming back into the marker over the globe.
                if (this.step >= 3 || this.normal?.zoomActive) this.normal?.draw(enc);
                this.drawCredit(enc);
                break;
            case SceneState.setting:
                this.setting?.draw(enc);
                break;
            case SceneState.connectError:
                this.message.draw(enc, d2);
                break;
        }
        // m_pFade2 (dim) then m_pFade (black)
        const H = LogicalScreen.height, W = ctx.screenWidth;
        if (ctx.fade2.alpha > 0) d2.fillRect(0, 0, W, H, [0, 0, 0, Math.trunc(Math.min(255, ctx.fade2.alpha))], enc);
        if (ctx.fade.alpha > 0) d2.fillRect(0, 0, W, H, [0, 0, 0, Math.trunc(Math.min(255, ctx.fade.alpha))], enc);
        this.drawOverlay(enc);
    }

    /** True when the hub can be re-entered (data loaded, screens built) — else the shell reboots the scene. */
    get canResume() { return !!(this.normal && this.ctx.data); }

    /**
     * Back after "Wii Menu" (desktop: the channel can't leave the browser tab) or a mobile suspend — re-enter the
     * hub from black (StNormal step 0).
     */
    resumeFromSuspend() {
        if (!this.wantsSuspend && !this.wantsQuit) return;
        const ctx = this.ctx;
        this.wantsSuspend = false; this.wantsQuit = false; this.quitting = false; ctx.returnToWiiMenu = false; ctx.request = 0;
        ctx.isTopLevel = true; ctx.displayLocation = null;
        ctx.ui.clearHover();
        ctx.fade.startFadeIn(0x19);
        this.go(SceneState.normal);
    }

    /**
     * WeatherScene_StE6C8 tail: after the hub, Setup2DRender (TEV REG0 white, so opaque whatever the hub's
     * fade) and TPLWeather image 0x18 + bit 1 (JP 0x16) at lbl_801D6F7C = (28 / 36 wide, creditY + lbl_803309D8).
     * lbl_803309D8 = CAround +2AC = +2B0·slide; the globe layout never slides out, so it stays 0. With bit 0,
     * TPLCommon 3 (6 with bit 1) directly below it.
     */
    drawCredit(enc) {
        const ctx = this.ctx;
        // The hub's credit fades with the hub (zooms from a marker); over the globe it is drawn as in the original.
        let alpha = 255;
        if (this.state === SceneState.normal && this.step < 5 && this.normal) {
            alpha = Math.max(0, Math.min(255, Math.trunc(255 * this.normal.globalAlpha)));
            if (alpha === 0) return;
        }
        if (!this.overlaySprites) { try { this.overlaySprites = new SpriteText(ctx); } catch (_) {} }
        const sp = this.overlaySprites;
        if (!sp) return;
        const x = ctx.isWide ? 36 : 28;
        // + lbl_803309D8 (always 0). Portrait: the credit rides with the bottom row (above the strip).
        const y = ctx.isPortrait ? PortraitSlots.pixelBottom(this.creditY) : this.creditY;
        const img = (ctx.lang === Lang.jp ? 0x16 : 0x18) + ((this.creditFlags >> 1) & 1);
        const white = [255, 255, 255, alpha];
        sp.drawImage(false, img, [x, y], 1, 1, white, enc);
        if (this.creditFlags & 1) {
            const h = sp.imageSize(false, img)[1];
            sp.drawImage(true, (this.creditFlags & 2) ? 6 : 3, [x, y + h], 1, 1, white, enc);
        }
    }

    /**
     * fn_8000DCA4 (CWeatherScene vtable +0x38, called by CScene_Draw after the fades): TPLCommon image
     * lbl_8018F64C[lang] centred on screen, TEV REG0 = (+D8..DA = white, alpha = +140 dimAlpha).
     */
    drawOverlay(enc) {
        if (this.dimAlpha <= 0) return;
        if (!this.overlaySprites) { try { this.overlaySprites = new SpriteText(this.ctx); } catch (_) {} }
        const sp = this.overlaySprites;
        if (!sp) return;
        const table = [0x64, 0x66, 0x62, 0x66, 0x65, 0x63, 0x61];   // lbl_8018F64C
        const idx = table[Math.min(this.ctx.lang, table.length - 1)];
        const size = sp.imageSize(true, idx);
        sp.drawImage(true, idx, [0.5 * this.ctx.screenWidth - 0.5 * size[0], LogicalScreen.halfHeight - 0.5 * size[1]], 1, 1,
                     [255, 255, 255, this.dimAlpha], enc);
    }

    /** System_Frame overlay, eased with sin(t·π/2). */
    drawTransition(enc) {
        if (this.transitionMode === 0) return;
        const t = this.transitionCount / this.transitionLength;
        const e = Math.sin(t * Math.PI / 2);
        const W = this.ctx.screenWidth, H = LogicalScreen.height, cap = this.frame.captureTexture;
        switch (this.transitionMode) {
            case 1:
                this.d2.fillRect(0, 0, W, H, [0, 0, 0, Math.trunc(255 * e)], enc);
                break;
            case 2:
                if (cap) this.d2.texture(cap, 0, 0, W, H, [0, 0, 1, 1], Math.trunc(255 * (1 - e)), enc);
                break;
            default:
                if (cap) {
                    const inset = 0.1 * e;
                    const a = this.transitionMode === 3 ? 1 - e : e;
                    this.d2.texture(cap, 0, 0, W, H, [inset, inset, 1 - inset, 1 - inset], Math.trunc(255 * a), enc);
                }
        }
    }
}
