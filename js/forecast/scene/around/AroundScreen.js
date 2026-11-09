import { SpriteText } from '../../ui/SpriteText.js';
import { TelopText } from '../../ui/TelopText.js';
import { Lang, langSuffix } from '../../ui/PaneCtl.js';
import { CursorState } from '../../ui/Cursor.js';
import { LogicalScreen } from '../../render/LogicalScreen.js';
import { PortraitSlots } from '../../render/PortraitSlots.js';
import { PortraitArrange, flattenTopShine } from '../PortraitArrange.js';
import { Portrait } from '../normal/NormalScreen.js';
import { GlobeScene } from '../../game/GlobeScene.js';
import * as GM from '../../game/GlobeMath.js';
import { TouchMode } from '../../system/TouchInput.js';
import { SoundHandle } from '../../../nw4r/snd/SoundSystem.js';
import { WPAD, has, isPicture, isTextBox, utf16, lytDraw } from '../../ui/bridge.js';

const sameLoc = (a, b) => a != null && b != null && (a.raw ?? a) === (b.raw ?? b);
const byte = (v) => Math.max(0, Math.min(255, Math.trunc(v)));
const d2 = (a, b) => { const x = a[0] - b[0], y = a[1] - b[1]; return x * x + y * y; };

/**
 * Display-mode table for non-JP languages, lbl_80179B98[mode] = {draw PTMF, box-size PTMF, day}:
 *   0 {fn_80019268 icons, fn_8001C074 90×90,  day 2}  CURRENT WEATHER
 *   1 {fn_800198A4 temp,  fn_8001C0B0 digits, day 2}  CURRENT TEMPERATURE
 *   2 {fn_80019268 icons, fn_8001C074,        day 0}  TODAY'S WEATHER
 *   3 {fn_80019734 high,  fn_8001C0B0,        day 0}  TODAY'S HIGH
 *   4 {fn_80019268 icons, fn_8001C074,        day 1}  TOMORROW'S WEATHER
 *   5 {fn_80019734 high,  fn_8001C0B0,        day 1}  TOMORROW'S HIGH
 * Day 2 = current conditions (short.bin), 0 = today, 1 = tomorrow (fn_8000A764).
 */
export const AroundMode = Object.freeze({
    currentWeather: 0, currentTemp: 1, todayWeather: 2, todayHigh: 3, tomorrowWeather: 4, tomorrowHigh: 5,
    day: (m) => [2, 2, 0, 0, 1, 1][m],
    showsNumber: (m) => m % 2 === 1,
});

/**
 * CAround (d_weather_around.cpp, 0x80017548–0x8001C2A4) — the globe screen.
 * Interactive frame = fn_80018C9C (+ fn_8001A758 zoom/grab, fn_80018BE0 camera/markers/light).
 */
export class AroundScreen {
    constructor(ctx) {
        this.ctx = ctx;
        this.around = ctx.layout('around.brlyt');        // +6C: zoom_out, zoom_in, next, back, rot_a, rot_b, reset
        this.belt = ctx.layout('around_belt.brlyt');     // +70: mode title (+ JP-only legend panes kion/rain/high)
        this.markers = [];
        try { this.sprites = new SpriteText(ctx); } catch (_) { this.sprites = null; }
        this.telop = new TelopText(ctx);

        // Touch gesture accumulators (portrait only).
        this.pinchAccum = 1;
        this.pinchDone = false;          // one zoom or tilt step per two-finger gesture
        this.tiltAccum = 0;
        this.twistGesture = null;        // { startHeading, accum }
        /** +A4: true = GlobeScreen_StateNormal (interactive), false = fn_80018C9C (passive, runs under the hub). */
        this.interactive = false;
        /** +250: freeze the markers (set when a marker opened its city, cleared by StF660 step 0). */
        this.freezeMarkers = false;
        // Bars in/out + dim (fn_800181B8)
        this.barsOffScreen = 0;          // +274: frames the pointer has been off screen (or grabbing), ≤ 10
        this.barsIdle = 0;               // +278: frames without pointer motion / bar region / button hover, ≤ 90
        this.barsDim = 0;                // +27C: 0 hovering a button … 15 not (blink ramp + brightness)
        this.pointerHistory = [];        // lbl_801F6C74: the last 10 pointer samples (fn_8003A780)
        // Hovered-marker weather sound: lbl_803309C8 (SE 0x31) and lbl_803309C0 (SE 0x32)
        this.weatherSE = { h31: new SoundHandle(), h32: new SoundHandle() };
        this.weatherSERequested = { h31: false, h32: false };
        // Zoom-out hint (CAround +252 / +2B4 / +309)
        this.zoomHint = true;            // +252: set by the ctor, cleared for good by the first zoom-out.
        this.hintBlink = 0;              // +2B4
        this.hintPhase = 0;              // +309 (u8)
        this._hintColors = undefined;
        this.hintI0Alpha = 0;            // +197
        // Draw lists rebuilt by updateMarkers (CAround +0x0C[11] content by rank, +0x3C[11] bars/labels by rank,
        // +0x08 / +0x38 pulsing (hovered) content / labels, +0x34 / +0x64 the user's city).
        this.contentByRank = Array.from({ length: 11 }, () => []);
        this.labelByRank = Array.from({ length: 11 }, () => []);
        this.pulseContent = []; this.pulseLabel = [];
        this.homeContent = null; this.homeLabel = null;
        // Marker click (fn_80019B90): the nearest visible marker within 50 px of the A press; it opens when A is
        // released without having dragged further than 40 px.
        this.pressCandidate = null; this.pressPos = null;
        /** Touch: a press stops counting as a city tap once a second finger joins, the finger strays, it is held too long. */
        this.pressTainted = false; this.pressFrames = 0;
        this.hoveredMarker = null;
        /** City chosen by clicking a marker (the original posts lbl_8032FCF0 = 2; the port uses request 6). */
        this.selectedLocation = null;
        /**
         * +24F: the globe's own layouts are drawn. Cleared while the hub is up, set again on (re)entry. The earth is
         * always drawn — WeatherScene_StE6C8 draws GlobeScreen_Draw under the hub.
         */
        this.layoutsVisible = false;

        // CAround ctor 0x80017980: fn_800393E8(belt wrapper, "beltB") — every child of beltB except beltB<lang>
        // loses its visible flag.
        const g = this.belt.pane('beltB');
        if (g) { const keep = 'beltB' + langSuffix(ctx.lang); for (const c of g.children) if (c.name !== keep) c.visible = false; }
        if (LogicalScreen.isPortrait) this.placePortrait();
        flattenTopShine(ctx, this.around, ['zoom_out', 'next', 'zoom_in']);
    }

    get globe() { return this.ctx.globeScene.globe; }
    get cityFont() { return this.ctx.assets.font('font_weather_city.brfnt'); }
    get mode() { const m = this.ctx.globeMode; return m >= 0 && m <= 5 ? m : 0; }

    /** Marker scale (CAround +0x298): non-JP 0.26 + 0.2/√dist; JP min(0.24 + 0.6/√dist, 0.6). */
    get markerScale() {
        const d = Math.max(this.globe.dist, 0.0001);
        return this.ctx.lang === Lang.jp ? Math.min(0.24 + 0.6 / Math.sqrt(d), 0.6) : 0.26 + 0.2 / Math.sqrt(d);
    }

    // MARK: - Portrait

    /**
     * Portrait arrangement: the top row (Zoom − / Next / Zoom +) at the top with the mode belt under it; the bottom
     * row (End / tilt / tilt / Restore) and the JP legend in the thumb zone. The globe fills the screen.
     */
    placePortrait() {
        const ctx = this.ctx, around = this.around;
        // No Wii-Remote glyphs on mobile: the ⊖ / ⊕ go, so the captions say which way and centre.
        for (const n of ['zoom_outI', 'zoom_inI']) { const p = around.pane(n); if (p) p.suppressed = true; }
        for (const [n, s] of [['zoom_outT', 'Zoom Out'], ['zoom_inT', 'Zoom In']]) {
            const t = around.pane(n + langSuffix(ctx.lang));
            if (isTextBox(t)) { if (ctx.lang === Lang.us) t.text = utf16(s); t.translate[0] = 0; }
        }
        // Same rows as the hub (NormalScreen Portrait): identical top / bottom bar heights across screens.
        const hub = Portrait.current;
        const top = [0, hub.topShift], bottom = [0, hub.bottomShift];
        around.place({ zoom_out: top, next: top, zoom_in: top, back: bottom, rot_a: bottom, rot_b: bottom, reset: bottom });
        const b = {};
        for (const p of this.belt.panes) b[p.name] = p.authored[1] > 0 ? top : bottom;
        this.belt.place(b);
        PortraitArrange.extendBodies(around, ['zoom_out', 'next', 'zoom_in'], true);          // web: no-op
        PortraitArrange.extendBodies(around, ['back', 'rot_a', 'rot_b', 'reset'], false);     // web: no-op
    }

    /** The marker play band (originally 63..393 px on the 456 screen: between the top and bottom button rows). */
    static get bandTop() { return LogicalScreen.isPortrait ? PortraitSlots.pixelTop(63) : 63; }
    static get bandBottom() { return LogicalScreen.isPortrait ? PortraitSlots.pixelBottom(393) : 393; }

    /**
     * Pinch = the Zoom buttons' request (one index step per ×1.25 / ×0.8), two-finger vertical pan = the tilt
     * buttons' request (one step per 50 units, fingers up = tilt toward the horizon), two-finger rotation = the
     * Wii Remote twist while grabbing (fn_800405E4: past ±30° the heading follows the twist).
     */
    applyTouchGestures() {
        const g = this.ctx.gestures, globe = this.globe, around = this.around;
        if (g.fingers < 2) { this.pinchAccum = 1; this.pinchDone = false; this.tiltAccum = 0; this.twistGesture = null; return; }
        if (!this.twistGesture) {
            this.twistGesture = { startHeading: globe.camera.twist, accum: 0 };
            globe.velLat = 0; globe.velLon = 0; globe.inertiaActive = false;
        }
        // One pinch = one zoom step (like one press of a Zoom button); lift the fingers to zoom again.
        this.pinchAccum *= g.pinch;
        if (!this.pinchDone && this.pinchAccum >= 1.25) {
            this.pinchDone = true;
            if (globe.zoomIdx > 0) { globe.reqZoomIn = true; around.find('zoom_in')?.flash(); }
        } else if (!this.pinchDone && this.pinchAccum <= 0.8) {
            this.pinchDone = true;
            if (globe.zoomIdx < 9) { globe.reqZoomOut = true; around.find('zoom_out')?.flash(); this.zoomHint = false; }
        }
        // One two-finger gesture = one step: whichever of zoom / tilt crosses its threshold first fires once.
        this.tiltAccum += g.panY;
        if (!this.pinchDone && this.tiltAccum <= -50) {
            this.pinchDone = true;
            if (globe.tiltIdx < 5) { globe.reqTiltUp = true; around.find('rot_a')?.flash(); }
        } else if (!this.pinchDone && this.tiltAccum >= 50) {
            this.pinchDone = true;
            if (globe.tiltIdx > 0) { globe.reqTiltDown = true; around.find('rot_b')?.flash(); }
        }
        const t = this.twistGesture;
        if (t) {
            t.accum += g.rotation;
            if (Math.abs(t.accum) > 30) {
                globe.camera.orienting = false;
                globe.camera.twist = GM.chaseAngle(globe.camera.twist, GM.wrap360(t.accum + t.startHeading), 0.1, 180, 1.0);
            }
        }
    }

    // MARK: - Markers

    /** CAround_ctor: one CCityMarker per place in the forecast data (strings built as in fn_800079A4). */
    buildMarkers() {
        const data = this.ctx.data;
        if (!data || !this.sprites) { this.markers = []; return; }
        this.markers = data.forecast.places.map(p => new CityMarker(p, data, this.sprites));
        const f = this.cityFont;
        if (f) for (const m of this.markers) m.measureLabel(this.telop, f);
    }

    /** Rebuild markers after new forecast data arrives. */
    reloadMarkers() { this.buildMarkers(); this.updateMarkers(false); }

    /**
     * Per-frame UI state that calc() also applies (WeatherScene may draw before the first calc()).
     * fn_8001B030 (non-JP branch): belt title = mode; the JP legend panes kion/rain/high are never shown.
     */
    applyModeUI() {
        const b = this.belt.find('belt'); if (b) b.textIndex = this.ctx.globeMode;
        if (this.ctx.lang !== Lang.jp) for (const n of ['kion', 'rain', 'high']) this.belt.find(n)?.resetPos();
        this.applyResetButton();
    }

    /**
     * fn_80017FC8 — called once, from fn_8000E384 (WeatherScene applySettings): globe at the user's city with
     * zoom index 0, marker strings, CLayout_Reset of both layouts, then one fn_8001BDCC hint step.
     */
    initOnce() {
        if (!this.markers.length) this.buildMarkers();
        const p = this.ctx.data?.forecast.place(this.ctx.locationID);
        const latLon = [p?.latitudeDegrees ?? GlobeScene.defaultHome[0], p?.longitudeDegrees ?? GlobeScene.defaultHome[1], 0];
        this.globe.setZoomIndex(0);
        this.globe.initialize(latLon);
        this.around.reset(); this.belt.reset();
        this.updateZoomHint();
        // Port-only: the scene may draw before the first CAround frame runs; give the camera/markers valid state.
        this.primeForDraw();
    }

    /**
     * fn_8001BECC (+ WeatherScene_StF660 step 0, +250 = 0) — every globe entry: +24F = 1, CLayout_Reset(+6C)
     * only (the belt keeps its state), CAround state = GlobeScreen_StateNormal. The camera is not touched.
     */
    enterGlobe() {
        this.freezeMarkers = false;
        this.layoutsVisible = true;
        this.around.reset();
        this.interactive = true;
    }

    /** WeatherScene_StF660 leaving the globe: passive; a marker click also sets +250 (markers frozen). */
    leaveGlobe(markerChosen) {
        this.interactive = false;
        if (markerChosen) this.freezeMarkers = true;
    }

    /** fn_8001864C — CAround's calc, run every frame by fn_8000DD84 before WeatherScene's own state. */
    frame() {
        if (this.interactive) this.calc(); else this.passiveCalc();
        this.updateZoomHint();
    }

    /**
     * fn_80018C9C: no hover (+248 = 0), every wrapper pressed (fn_80039DB4), both layouts updated, reset/limit
     * buttons recomputed, then GlobeScreen_CalcGlobe (camera, poles, markers, light) without input or inertia.
     */
    passiveCalc() {
        const globe = this.globe;
        this.hoveredMarker = null; this.pressCandidate = null; this.pressPos = null;
        this.around.panes.forEach(p => p.press());
        this.around.update(); this.belt.update();
        this.applyResetButton();
        this.applyLimits();
        globe.syncDist();
        globe.calcCamera(this.ctx.globeScene.earth.materials);
        globe.calcPoles();
        this.updateMarkers(false);
        globe.updateLight();
    }

    // MARK: - Bars in/out + dim (fn_800181B8, GlobeScreen_StateNormal)

    /**
     * +2B0 (CAround ctor): how far the belt rides up as the top row slides out — to 34 px below the screen top
     * (19 in widescreen); portrait: just under the safe area.
     */
    get beltSlideDistance() {
        const b = this.belt.find('belt');
        if (!b) return 0;
        const r = b.hitRect;
        const top = (r[1] + r[3]) / 2 + Math.abs(r[3] - r[1]) / 2;   // belt top, layout y
        if (LogicalScreen.isPortrait) return Math.max(0, PortraitSlots.safeTopY - top);
        return Math.max(0, (LogicalScreen.halfHeight - top) - (this.ctx.isWide ? 19 : 34));
    }

    /**
     * GlobeScreen_StateNormal: +2AC = +2B0 · slideCount / slideMax, then fn_8003A434(belt, +2AC): every belt
     * wrapper moves away from the centre (+9C = ±value by the sign of its y).
     */
    slideBelt() {
        const v = this.beltSlideDistance * this.around.slideCount / Math.max(this.around.slideMax, 1);
        for (const p of this.belt.panes) p.slideOffset = v * (p.pane.translate[1] > 0 ? 1 : -1);
    }

    /**
     * fn_800181B8: the bars slide out (fn_8003A2D0(around, 30)) once the pointer has been off screen / grabbing for
     * 10 frames or idle for 90 (not moving > 30 px over its last 10 samples, outside the 63..393 band, no button
     * hovered), and back in (fn_8003A2A4(around, 15)) otherwise. Off a button the wrappers dim: brightness
     * 0x20 + 223·sin(π/2·(15−27C)/15) and blink ramp 27C/15 toward the pressed colours — fn_8003A328.
     */
    updateBars(pad) {
        const around = this.around, globe = this.globe;
        // Mobile (user choice on the iPhone): the globe's bars always stay in, at full brightness.
        if (LogicalScreen.isPortrait) {
            around.slideIn(15); this.barsDim = 0;
            for (const w of around.panes) { w.brightness = 255; w.blinkRamp = 0; w.blinkMax = 0xF; }
            return;
        }
        const W = this.ctx.screenWidth;
        let offScreenNow = true, active = false;
        // Exactly the original: the bars are bright only while a button is pointed at; the rest of the time — the
        // pointer is on the globe — they are dimmed see-through with inverted (white) labels and icons.
        const hovering = this.ctx.ui.hovered != null;
        const valid = pad.pointerValid;
        if (globe.grabbing) offScreenNow = true;   // fn_800181B8: a grabbing remote counts as off (+274 → 10)
        if (!globe.grabbing && valid) {
            const p = pad.pointer;
            this.pointerHistory.push(p.slice()); if (this.pointerHistory.length > 10) this.pointerHistory.shift();
            const old = this.pointerHistory[0];
            if (old) {
                const inX = (x) => x >= -16 && x < W + 16;
                if (inX(p[0]) && inX(old[0]) && d2(p, old) > 900) active = true;
                else if (p[1] <= AroundScreen.bandTop || p[1] > AroundScreen.bandBottom) active = true;
            }
            if (p[0] >= -16 && p[0] < W + 16) offScreenNow = false;
        }
        if (hovering) active = true;
        this.barsOffScreen = offScreenNow ? Math.min(this.barsOffScreen + 1, 10) : 0;
        this.barsIdle = active ? 0 : Math.min(this.barsIdle + 1, 0x5A);
        if (this.barsOffScreen < 10 && this.barsIdle < 0x5A) around.slideIn(15); else around.slideOut(30);
        this.barsDim = hovering ? Math.max(this.barsDim - 1, 0) : Math.min(this.barsDim + 1, 0xF);
        const s = Math.sin(Math.PI / 2 * (0xF - this.barsDim) / 15);
        const brightness = 0x20 + Math.trunc((255 - 0x20) * s);
        for (const w of around.panes) { w.brightness = brightness; w.blinkRamp = this.barsDim; w.blinkMax = 0xF; }
    }

    /** The reset wrapper (+74) is disabled and pressed while the globe is already at its reset orientation. */
    applyResetButton() {
        const r = this.around.find('reset');
        if (!r) return;
        if (this.globe.canReset()) r.disabled = false; else { r.disabled = true; r.press(); }
    }

    /** fn_80018568: zoom_out disabled at zoom ≥ 9, zoom_in at ≤ 0, rot_b at tilt ≤ 0, rot_a at tilt ≥ 5; disabled = pressed. */
    applyLimits() {
        const set = (name, off) => {
            const w = this.around.find(name);
            if (!w) return;
            if (off) { w.disabled = true; w.press(); } else w.disabled = false;
        };
        const g = this.globe;
        set('zoom_out', g.zoomIdx >= 9);
        set('zoom_in', g.zoomIdx <= 0);
        set('rot_b', g.tiltIdx <= 0);
        set('rot_a', g.tiltIdx >= 5);
    }

    /** fn_8001812C — used by CAddress to fly to a candidate city. */
    enterForAddress(location) {
        if (!this.markers.length) this.buildMarkers();
        const p = this.ctx.data?.forecast.place(location);
        this.globe.setZoomIndex(0);
        this.globe.initialize([p?.latitudeDegrees ?? 0, p?.longitudeDegrees ?? 0, 0]);
        this.resetMarkerState();
        this.primeForDraw();
    }

    /** The markers' fades persist across globe visits. */
    resetMarkerState() { this.pressCandidate = null; this.pressPos = null; }

    /** Make draw() valid before the first calc(): camera, mode UI and marker positions. */
    primeForDraw() {
        this.globe.syncDist();
        this.globe.calcCamera(this.ctx.globeScene.earth.materials);
        this.applyModeUI();
        this.updateMarkers(false);
    }

    // MARK: - Frame

    calc() {
        const ctx = this.ctx, pad = ctx.pad, ui = ctx.ui, globe = this.globe, around = this.around;
        globe.reqZoomOut = false; globe.reqZoomIn = false; globe.reqTiltUp = false; globe.reqTiltDown = false;
        this.applyModeUI();
        around.update(); this.belt.update();
        this.slideBelt();
        ui.updateHover(around, pad);
        this.updateBars(pad);   // fn_800181B8
        ctx.globeScene.stars?.update(globe.velLat, globe.velLon);   // GlobeScreen_StateNormal → fn_8002EF14
        this.applyLimits();     // fn_800181B8 → fn_80018568

        if (ui.buttonTrig('back', pad)) {
            ctx.playSE(0x26); globe.velLat = 0; globe.velLon = 0; globe.inertiaActive = false;
            ctx.request = 3;
            return;
        }
        const hn = ui.hovered?.name;
        const trigA = has(pad.trig, WPAD.a);
        // GlobeScreen_StateNormal 0x80018854/0x80018884: the first zoom-out (button or −) ends the hint (+252 = 0).
        if (hn === 'zoom_out' && !(ui.hovered?.disabled ?? true) && trigA) this.zoomHint = false;
        else if (has(pad.trig, WPAD.minus)) this.zoomHint = false;
        if (ui.buttonHeld('zoom_out', pad)) globe.reqZoomOut = true; else if (has(pad.trig, WPAD.minus)) { globe.reqZoomOut = true; around.find('zoom_out')?.flash(); }
        if (ui.buttonHeld('zoom_in', pad)) globe.reqZoomIn = true; else if (has(pad.trig, WPAD.plus)) { globe.reqZoomIn = true; around.find('zoom_in')?.flash(); }
        if (ui.buttonHeld('rot_a', pad)) globe.reqTiltUp = true; else if (has(pad.trig, WPAD.up)) { globe.reqTiltUp = true; around.find('rot_a')?.flash(); }
        if (ui.buttonHeld('rot_b', pad)) globe.reqTiltDown = true; else if (has(pad.trig, WPAD.down)) { globe.reqTiltDown = true; around.find('rot_b')?.flash(); }
        // Held buttons repeat only on trigger in the original's request flags.
        if (!trigA && (hn === 'zoom_out' || hn === 'zoom_in')) { globe.reqZoomOut = false; globe.reqZoomIn = false; }
        if (hn === 'zoom_out' && trigA) globe.reqZoomOut = true;
        if (hn === 'zoom_in' && trigA) globe.reqZoomIn = true;
        if ((hn === 'rot_a' || hn === 'rot_b') && !trigA) { globe.reqTiltUp = false; globe.reqTiltDown = false; }
        // Touch: a tap is a one-frame press, too short for the held buttons' pressed look — give Zoom/tilt the same
        // press animation End and Next get from UI_ButtonTrig.
        if (LogicalScreen.isPortrait && trigA && ui.hovered && !ui.hovered.disabled &&
            ['zoom_out', 'zoom_in', 'rot_a', 'rot_b'].includes(hn)) ui.hovered.flash();
        // fn_8001B030: Next / d-pad RIGHT advance, LEFT go back (SE 0x2C, wraps at 6)
        if (ui.buttonTrig('next', pad) || has(pad.trig, WPAD.right)) {
            ctx.globeMode = (ctx.globeMode + 1) % 6; ctx.playSE(0x2C);
            if (has(pad.trig, WPAD.right)) around.find('next')?.flash();
            this.applyModeUI();
        } else if (has(pad.trig, WPAD.left)) {
            ctx.globeMode = (ctx.globeMode + 5) % 6; ctx.playSE(0x2C);
            this.applyModeUI();
        }
        if (!globe.camera.orienting && ui.buttonTrig('reset', pad)) { ctx.playSE(0x13); globe.setTiltIndex(0, true); }

        if (LogicalScreen.isPortrait) this.applyTouchGestures();
        globe.updateInertia(ui.hovered != null);
        // fn_8001A758: zoom, grab loop, tilt
        globe.updateZoom();
        globe.syncDist();
        const y = pad.pointer[1];
        if (ui.hovered == null && pad.pointerValid && y > AroundScreen.bandTop && y < AroundScreen.bandBottom && globe.tryBeginGrab(pad)) ctx.playSE(0x15);
        if (globe.updateGrab(pad) === 'released') {
            ctx.sound?.updateRotateSound?.(Math.sqrt(globe.velLat * globe.velLat + globe.velLon * globe.velLon));
        }
        globe.updateTilt();
        // fn_80018BE0
        globe.calcCamera(ctx.globeScene.earth.materials);
        globe.calcPoles();
        this.updateMarkers(true);
        globe.updateLight();
    }

    // MARK: - Hovered-marker weather sound (fn_8001BF20 → fn_800105AC → fn_8003B204)

    /** lbl_80179C50: volume by zoom index (SimpleGlobe +9C). */
    static hoverFalloff = [1.0, 0.89, 0.78, 0.67, 0.56, 0.45, 0.34, 0.23, 0.12, 0.06];

    /** fn_8000DD24 (scene vtable +0x20, before the calc) clears the "requested this frame" flags. */
    weatherSoundPreCalc() { this.weatherSERequested = { h31: false, h32: false }; }
    /** fn_8000DD54 (+0x2C, after it) stops a playing handle nobody requested. */
    weatherSoundPostCalc() {
        const snd = this.ctx.sound;
        if (!snd) return;
        if (!this.weatherSERequested.h32 && snd.isAttached?.(this.weatherSE.h32)) snd.stop(this.weatherSE.h32, 0);
        if (!this.weatherSERequested.h31 && snd.isAttached?.(this.weatherSE.h31)) snd.stop(this.weatherSE.h31, 0);
    }

    /**
     * fn_8001BF20: only in the weather-icon modes (lbl_803309E8 = mode; non-JP 0/2/4, JP 0/3). The hovered
     * marker's weather → weather table entry → its display code → fn_800105AC with volume lbl_80179C50[zoom].
     */
    hoverWeatherSound(m) {
        const ctx = this.ctx, modeIdx = ctx.globeMode;
        const allowed = ctx.lang === Lang.jp ? (modeIdx === 0 || modeIdx === 3) : (modeIdx === 0 || modeIdx === 2 || modeIdx === 4);
        if (!allowed) return;
        const code = m.weatherCode(AroundMode.day(this.mode));
        if (code == null) return;
        const t = ctx.data?.forecast.weatherTypes.find(w => w.code === code);
        if (!t) return;
        const fo = AroundScreen.hoverFalloff;
        const vol = fo[Math.max(0, Math.min(this.globe.zoomIdx, fo.length - 1))];
        // fn_800105AC (compare tree read from the asm — m2c's "default" case is wrong; the default is silence):
        // SE 0x31 only for the rain codes; 0x5/0x9/0xE/0x12/0x7D play SE 0x31 and SE 0x32.
        const c = t.displayCode & 0x7FFF;
        const both = new Set([0x5, 0x9, 0xE, 0x12, 0x7D]);
        const rainOnly = [0x3, 0x7, 0xC, 0x10, 0x1F, 0x20, 0x67, 0x69, 0x6C].includes(c)
            || (c >= 0x13 && c <= 0x19) || (c >= 0x6E && c <= 0x73) || (c >= 0x77 && c <= 0x79);
        if (rainOnly || both.has(c)) { this.startWeatherSE(this.weatherSE.h31, 0x31, vol); this.weatherSERequested.h31 = true; }
        if (both.has(c)) { this.startWeatherSE(this.weatherSE.h32, 0x32, vol); this.weatherSERequested.h32 = true; }
    }

    /** fn_8003B204(handle, id, volume, pitch 1, pan 0): start if not playing, then set volume/pitch/pan. */
    startWeatherSE(h, id, vol) {
        const snd = this.ctx.sound;
        if (!snd) return;
        if (!snd.isAttached?.(h)) snd.startSound?.(h, id);
        snd.setVolume?.(h, vol); snd.setPitch?.(h, 1); snd.setPan?.(h, 0);
    }

    // MARK: - Zoom-out hint (CAround +252 / +2B4 / +309, fn_8001BDCC + the zoom_out wrapper hook fn_8001C250)

    /**
     * +294 (zoom_outI0 TEV colour 1 alpha) and +190/+194, +198/+19C (zoom_outI0 / zoom_outI1 authored C0/C1),
     * captured once from the material like the ctor's fn_800370AC / fn_80036E94.
     */
    get hintColors() {
        if (this._hintColors !== undefined) return this._hintColors;
        const p0 = this.around.layout.root.find('zoom_outI0'), p1 = this.around.layout.root.find('zoom_outI1');
        const m0 = isPicture(p0) ? p0.material : null, m1 = isPicture(p1) ? p1.material : null;
        this._hintColors = m0 && m1
            ? { i0: [m0.tevColors[0].slice(), m0.tevColors[1].slice()], i1: [m1.tevColors[0].slice(), m1.tevColors[1].slice()], alpha: m0.tevColors[1][3] }
            : null;
        return this._hintColors;
    }

    /** fn_8001BDCC: while the hint is on, ping-pong +2B4 by 0.05 and show zoom_outI0 with alpha +294·+2B4. */
    updateZoomHint() {
        const i0 = this.around.layout.root.find('zoom_outI0');
        if (!i0) return;
        if (this.zoomHint) {
            if (this.hintPhase !== 0) {
                this.hintBlink -= 0.05;
                if (this.hintBlink < 0) { this.hintBlink = 0; this.hintPhase = (this.hintPhase - 1) & 0xFF; }
            } else {
                this.hintBlink += 0.05;
                if (this.hintBlink > 1) { this.hintBlink = 1; this.hintPhase = (this.hintPhase + 1) & 0xFF; }
            }
            this.hintI0Alpha = Math.trunc((this.hintColors?.alpha ?? 255) * this.hintBlink);
            i0.visible = true;
        } else {
            this.hintPhase = 0; this.hintBlink = 0;
            i0.visible = false;
        }
    }

    /**
     * fn_8001C250 (zoom_out +34, called by CPaneCtl_PreDraw after the scheme colours): while the hint is on,
     * zoom_outI0/I1 get their authored colours back (I0's colour-1 alpha = the blink).
     */
    applyHintColors() {
        const c = this.hintColors;
        if (!this.zoomHint || !c) return;
        const m0 = this.around.layout.root.find('zoom_outI0')?.material, m1 = this.around.layout.root.find('zoom_outI1')?.material;
        if (!m0 || !m1) return;
        m0.tevColors[0] = c.i0[0].slice(); m0.tevColors[1] = c.i0[1].slice(); m0.tevColors[1][3] = this.hintI0Alpha;
        m1.tevColors[0] = c.i1[0].slice(); m1.tevColors[1] = c.i1[1].slice();
    }

    /** CAround_UpdateMarkers (fn_80019B90). */
    updateMarkers(input) {
        if (this.freezeMarkers) return;   // +250: early return before any CityMarker_Calc
        const ctx = this.ctx, scale = this.markerScale, cam = this.globe.camera, pad = ctx.pad;
        const minRank = this.globe.zoomIdx;
        for (const m of this.markers) m.calc(cam, minRank, ctx.locationID, scale, ctx.screenWidth);
        // Hover (+0x248: enabled when no button is hovered and the globe is not being dragged): the nearest
        // visible marker within 50 px of the pointer (pointer inside the 63..393 play band) gets flag 4.
        this.hoveredMarker = null;
        const hoverEnabled = input && ctx.ui.hovered == null && !this.globe.grabbing && pad.pointerValid;
        if (hoverEnabled && pad.pointer[1] > AroundScreen.bandTop && pad.pointer[1] < AroundScreen.bandBottom) {
            let best = 2500;
            for (const m of this.markers) if (m.flags & 1) { const q = d2(m.screen, pad.pointer); if (q < best) { best = q; this.hoveredMarker = m; } }
            if (this.hoveredMarker) this.hoveredMarker.flags |= 4;
        }
        // Click
        if (input) {
            if (has(pad.trig, WPAD.a) && ctx.ui.hovered == null) {
                this.pressPos = pad.pointer.slice();
                this.pressTainted = false;
                this.pressFrames = 0;
                let best = 2500;
                this.pressCandidate = null;
                for (const m of this.markers) if (m.flags & 1) { const q = d2(m.screen, pad.pointer); if (q < best) { best = q; this.pressCandidate = m; } }
                // Touch: a finger on a city's name label (right of its icon) picks that city too.
                if (LogicalScreen.isPortrait && !this.pressCandidate) {
                    const p = pad.pointer;
                    for (const m of this.markers) {
                        if (!(m.flags & 1) || !m.labelListed) continue;
                        const r = m.textRect;
                        if (p[0] >= r[0] - 10 && p[0] <= r[2] + 10 && p[1] >= r[1] - 12 && p[1] <= r[3] + 12) { this.pressCandidate = m; break; }
                    }
                }
            }
            // Touch: a finger resting on a marker is its hover (touch-down = the pointer arriving) until it travels
            // past the click radius — pulse, label bar, hover SEs, as the Wii Remote pointer would give.
            const c = this.pressCandidate, p0 = this.pressPos;
            if (LogicalScreen.isPortrait && has(pad.hold, WPAD.a) && !this.pressTainted && c && p0 &&
                d2(pad.pointer, p0) < 1600 && (c.flags & 1)) {
                this.hoveredMarker = c; c.flags |= 4;
            }
            if (LogicalScreen.isPortrait && p0 && c) {
                this.pressFrames += 1;
                // real fingers wobble: 28 logical units (~18 pt) and ¾ s are still a tap; a second finger never is
                if (ctx.gestures.fingers >= 2 || (pad.pointerValid && d2(pad.pointer, p0) > 28 * 28) || this.pressFrames > 45) this.pressTainted = true;
            }
            if (has(pad.release, WPAD.a) && c && p0) {
                if (d2(pad.pointer, p0) < 1600 && (c.flags & 1) && !this.pressTainted) {
                    ctx.playSE(0x25);
                    this.globe.velLat = 0; this.globe.velLon = 0; this.globe.inertiaActive = false;
                    this.selectedLocation = c.place.id;
                    ctx.markerPoint = c.screen.slice();   // CAround_UpdateMarkers: lbl_803309D0 = marker +1F8/+1FC
                    ctx.request = 6;
                }
                this.pressCandidate = null; this.pressPos = null;
            }
        }
        // Label de-clutter (fn_8001ACFC) over the label-listed markers (fn_8000A0E0, previous-frame state).
        const listed = this.markers.filter(m => m.labelListed);
        for (let i = 0; i < listed.length - 1; i++) {
            for (let j = i + 1; j < listed.length; j++) if (CityMarker.overlapHidesFirst(listed[i], listed[j])) listed[i].flags |= 2;
        }
        // Per-marker update (fn_800083F0 / fn_80008518 / fn_80009F24) and the draw lists.
        for (let r = 0; r < 11; r++) { this.contentByRank[r] = []; this.labelByRank[r] = []; }
        this.pulseContent = []; this.pulseLabel = []; this.homeContent = null; this.homeLabel = null;
        const labelScaleBase = Math.min(2.5 * scale, 1.1);
        const playSE = (id) => ctx.playSE(id);
        for (const m of this.markers) {
            m.updateHover(playSE);
            if (!(m.flags & 1)) continue;
            m.updateLabelFade();
            if (m.flags & 4) this.hoverWeatherSound(m);   // fn_8001BF20
            const p = CityMarker.pulseCurve(m.pulse);
            const box = this.boxSize(m);
            if (p > 0) {
                m.placeLabel([m.screen[0] + 0.5 * box[0] * (0.2 * p + scale), m.screen[1]], labelScaleBase + 0.1 * p);
                if (m.labelListed) this.pulseLabel.push(m);
                this.pulseContent.push(m);
            } else {
                m.placeLabel([m.screen[0] + 0.5 * box[0] * scale, m.screen[1]], labelScaleBase);
                if (m.labelListed) { if (m.isHome) this.homeLabel = m; else this.labelByRank[Math.min(m.rank, 10)].push(m); }
                if (m.isHome) this.homeContent = m; else this.contentByRank[Math.min(m.rank, 10)].push(m);
            }
        }
    }

    /** fn_8001BFF8 → the mode's box-size PTMF: icons fn_8000A7E0 (90×90); numbers fn_8000A82C (20 + string size). */
    boxSize(m) {
        if (!AroundMode.showsNumber(this.mode) || !this.sprites) return [90, 90];
        const s = this.sprites.stringSize(m.temperatureString(AroundMode.day(this.mode), this.ctx.tempUnit));
        return [s[0] + 20, s[1] + 20];
    }

    /** Touch: a touch on the globe's buttons presses on release; anywhere else it grabs the globe. */
    touchMode(p) {
        const q = this.ctx.ui.toLayout(p);
        if (this.around.hitTest(q[0], q[1]) || this.belt.hitTest(q[0], q[1])) return TouchMode.pressOnRelease;
        return TouchMode.grab;
    }

    get cursorState() {
        if (this.globe.grabbing) return CursorState.hold;
        if (this.ctx.ui.hovered != null || this.hoveredMarker != null) return CursorState.normal;
        const y = this.ctx.pad.pointer[1];
        return this.ctx.pad.pointerValid && y > AroundScreen.bandTop && y < AroundScreen.bandBottom ? CursorState.open : CursorState.normal;
    }

    // MARK: - Draw

    drawGlobe(enc) { this.ctx.globeScene.draw(enc); }

    /** GlobeScreen_Draw (fn_80017548 area) */
    draw(enc) {
        this.drawGlobe(enc);
        // Under the hub (a city opened from a marker) the original shows the bare earth — no markers (Wii capture).
        if (!this.layoutsVisible) return;
        this.drawMarkers(enc);
        this.belt.draw(this.ctx.lyt, enc);
        // CLayout_Draw(+6C) with the zoom_out wrapper's post-colour hook (fn_8001C250).
        if (this.around.visible) {
            void this.hintColors;
            this.around.panes.forEach(p => p.preDraw());
            this.applyHintColors();
            lytDraw(this.ctx.lyt, this.around.layout, enc, 608, this.around.locationAdjust);
        }
    }

    /**
     * The mode draw PTMF (fn_80019268 / fn_800198A4 / fn_80019734): bars by rank → content by rank → pulsing
     * bars → labels by rank → pulsing content (scale + 0.2·pulse) → pulsing labels. The user's city goes
     * after the ranked ones.
     */
    drawMarkers(enc) {
        if (!this.sprites) return;
        const scale = this.markerScale;
        const bars = this.labelByRank.flat(), contents = this.contentByRank.flat();
        if (this.homeLabel) bars.push(this.homeLabel);
        if (this.homeContent) contents.push(this.homeContent);
        for (const m of bars) this.drawBars(m, enc);
        for (const m of contents) this.drawContent(m, scale, enc);
        for (const m of this.pulseLabel) this.drawBars(m, enc);
        for (const m of bars) this.drawLabel(m, enc);
        for (const m of this.pulseContent) this.drawContent(m, scale + 0.2 * CityMarker.pulseCurve(m.pulse), enc);
        for (const m of this.pulseLabel) this.drawLabel(m, enc);
    }

    /** fn_80008AF4: the two gradient bars behind the label (only while hovered: alpha 255·chase). */
    drawBars(m, enc) {
        const a = m.barAlpha;
        if (!this.sprites || a <= 0) return;
        const clear = [255, 255, 255, 0], cyan = [0x80, 0xFF, 0xFF, a];
        this.sprites.drawGradientRect(m.barLeft, [clear, clear, cyan, cyan], enc);
        this.sprites.drawGradientRect(m.barRight, [cyan, cyan, clear, clear], enc);
    }

    /**
     * fn_80008B3C: city name in the city font, white, alpha = labelHide(+26C) · alpha(+27F), drawn with draw
     * flag 0x100 (left origin, vertically centred) at scale +24C.
     */
    drawLabel(m, enc) {
        const f = this.cityFont;
        if (!f) return;
        const a = byte(m.labelHide * m.alpha27F);
        if (a <= 0) return;
        this.telop.draw(m.place.city, f, m.labelPos, TelopText.style({ scale: [m.labelScale, m.labelScale], flags: 0x100 }), [255, 255, 255, a], enc);
    }

    /**
     * Content: weather icon (fn_80020574 via fn_800203F0) or temperature (fn_800095A8 current / fn_80009478 high):
     * a backing pass in #202020 then the digits in the temperature colour.
     */
    drawContent(m, scale, enc) {
        const data = this.ctx.data;
        if (!this.sprites || !data) return;
        const a = m.alpha27D;
        if (a <= 0) return;
        const mode = this.mode, day = AroundMode.day(mode);
        if (AroundMode.showsNumber(mode)) {
            const s = m.temperatureString(day, this.ctx.tempUnit);
            // fn_800095A8 → fn_8003F088(str, pos, main = temperature colour, shadow = lbl_80330A38 #202020):
            // the #202020 shadow at (+2,+2) first, then the digits in the temperature colour.
            const main = CityMarker.temperatureColor(m.celsius(day)); main[3] = a;
            this.sprites.drawCenteredTwoPass(s, m.screen, scale, [0x20, 0x20, 0x20, a], main, SpriteText.Table.large, enc);
        } else {
            const code = m.weatherCode(day);
            const t = code != null ? data.forecast.weatherTypes.find(w => w.code === code) : null;
            if (t) this.sprites.drawWeatherIcon(t.displayCode, m.screen, a, scale, enc);
        }
    }
}

/** CCityMarker (ctor fn_80006FC0, Calc fn_80007630, label/box fn_800085D8..fn_8000A0E0). */
export class CityMarker {
    constructor(place, data, sprites) {
        this.place = place;
        const lat = place.latitudeDegrees * Math.PI / 180, lon = place.longitudeDegrees * Math.PI / 180;
        /** +1C8: 3·(sinλcosφ, sinφ, cosλcosφ) */
        this.position = [3 * Math.sin(lon) * Math.cos(lat), 3 * Math.sin(lat), 3 * Math.cos(lon) * Math.cos(lat)];
        this.screen = [0, 0];        // +1F8
        this.rank = 0;               // +280: place rank, 9 for the user's city
        this.isHome = false;
        this.flags = 0;              // +230: 1 visible, 2 label hidden (de-clutter), 4 hovered
        // Initial values as stored by CityMarker_ctor (0x8000714C..): +258/+25C = 0, +260/+264/+268/+26C = 1.
        this.fade = 0;               // +258 rank fade ±0.05
        this.bandFade = 0;           // +25C play-band fade ±0.1, floor 0.3 (fn_8000A690)
        this.alpha27D = 0;           // +27D content alpha
        this.depthLabel = 1;         // +264 label depth fade ±0.05
        this.edgeFade = 1;           // +268 play-area fade ±0.2
        this.selectFade = 1;         // +260 selection fade
        this.labelHide = 1;          // +26C de-clutter fade ±0.1
        this.alpha27F = 0;           // +27F label alpha
        this.pulse = 0;              // +23C angle 0..0x8000
        this.hoverChase = 0;         // +274
        this.labelPos = [0, 0];      // +208/+20C
        this.labelScale = 1;         // +24C
        this.textRect = [0, 0, 0, 0];   // +15C..+168
        this.barLeft = [0, 0, 0, 0]; this.barRight = [0, 0, 0, 0];   // +16C / +17C
        this.labelSize = [0, 0];     // unscaled label width/height

        // fn_800079A4 strings: [day 0, day 1] × [°C, °F] highs; the current temperature (+0xE4/+0xEE).
        const dash = [0x2D, 0x2D];   // lbl_8032F558
        const lf = data.forecast.longForecasts.find(l => sameLoc(l.location, place.id));
        const sf = lf ? null : data.forecast.summaries.find(s => sameLoc(s.location, place.id));
        const days = lf ? [lf.today, lf.tomorrow] : sf ? [sf.today, sf.tomorrow] : null;
        const fmt = (v) => v > -128 ? sprites.formatInt(v) : dash;
        this.highText = [0, 1].map(i => days ? [fmt(days[i].highC), fmt(days[i].highF)] : [dash, dash]);
        this.highC = [0, 1].map(i => days && days[i].highC > -128 ? days[i].highC : null);
        this.dayWeather = [0, 1].map(i => days ? days[i].weather : null);
        const cur = data.short.current.find(c => sameLoc(c.location, place.id));
        this.currentText = cur ? [fmt(cur.tempC), fmt(cur.tempF)] : [dash, dash];
        this.currentC = cur && cur.tempC > -128 ? cur.tempC : null;
        this.currentWeather = cur && cur.weather !== 0xFFFF ? cur.weather : null;
    }

    get barAlpha() { return byte(255 * this.hoverChase); }

    temperatureString(day, unit) { return day === 2 ? this.currentText[Math.min(unit, 1)] : this.highText[day][Math.min(unit, 1)]; }
    celsius(day) { return (day === 2 ? this.currentC : this.highC[day]) ?? -128; }
    /** fn_8000A764 */
    weatherCode(day) { return day === 2 ? this.currentWeather : this.dayWeather[day]; }

    measureLabel(t, f) { this.labelSize = [t.width(this.place.city, f), t.height(this.place.city, f)]; }

    /** fn_80035FF8: 0.5 − 0.5·cos(angle) for a u16 angle (0x8000 = half turn) → 0..1. */
    static pulseCurve(v) { return 0.5 - 0.5 * Math.cos(v / 65536 * 2 * Math.PI); }

    /** CityMarker_Calc (fn_80007630) + fn_80008194. */
    calc(camera, minRank, homeID, scale, screenWidth) {
        const look = GM.v3sub(camera.target, camera.eye);
        const lookLen = GM.v3len(look);
        this.screen = camera.project(this.position);
        this.isHome = sameLoc(this.place.id, homeID);
        this.rank = this.isHome ? 9 : this.place.zoom1;
        const facing = GM.v3dot(GM.v3norm(this.position), GM.v3norm(look));
        const target = this.rank >= minRank ? 1 : 0;
        if (this.fade < target) this.fade = Math.min(this.fade + 0.05, target); else if (this.fade > target) this.fade = Math.max(this.fade - 0.05, target);
        this.flags = 0;
        const s = this.screen;
        const onScreen = s[0] >= -50 && s[0] <= screenWidth + 50 && s[1] >= -50 && s[1] <= LogicalScreen.height + 50;
        if (onScreen && facing < 0) {
            const t = GM.v3len(GM.v3sub(camera.eye, this.position)) - lookLen;
            const k = Math.min(facing * -3, 1);
            const depth = t >= 3 ? 0 : (t > 0 ? 255 * Math.cos(Math.PI / 2 * t / 3) : 255);
            this.alpha27D = byte(k * depth * this.fade);
            if (t >= 1) this.depthLabel = Math.max(this.depthLabel - 0.05, 0); else this.depthLabel = Math.min(this.depthLabel + 0.05, 1);
            if (this.alpha27D !== 0) this.flags |= 1;
        } else {
            this.alpha27D = 0; this.depthLabel = 0;
        }
        // fn_80008194: fade out near the play-area edges (x margin 28 / 36 wide; y band 63..393 ± 40·scale)
        const margin = screenWidth > 700 ? 36 : 28;
        const half = 0.5 * 80 * scale;
        const bandTop = AroundScreen.bandTop, bandBottom = AroundScreen.bandBottom;
        if (s[0] < margin || s[1] - half < bandTop || s[0] > screenWidth - margin || s[1] + half > bandBottom) this.edgeFade = Math.max(this.edgeFade - 0.2, 0);
        else this.edgeFade = Math.min(this.edgeFade + 0.2, 1);
        // fn_8000A690: outside the 63..393 band (±40·scale) the content fades to 30 % (from a non-zero value only);
        // inside it returns to 100 %. Scales +27D.
        if (s[1] - half < bandTop || s[1] + half > bandBottom) { if (this.bandFade > 0) this.bandFade = Math.max(this.bandFade - 0.1, 0.3); }
        else if (this.bandFade < 1) this.bandFade = Math.min(this.bandFade + 0.1, 1);
        this.alpha27D = Math.trunc(this.alpha27D * this.bandFade) & 0xFF;
    }

    /** fn_8000A0E0: the label takes part in bars / labels / de-clutter. */
    get labelListed() { return (this.flags & 1) !== 0 && (this.flags & 2) === 0 && this.alpha27F !== 0 && Math.abs(this.labelScale) >= 0.0008; }

    /** fn_800083F0: selection fade and the hover pulse (+0x1800/frame up to 0x8000, SE 1 when it arrives). */
    updateHover(playSE) {
        this.selectFade = Math.min(this.selectFade + 0.1, 1);   // (+230&1 && +238&1) never holds → +260 rises
        if ((this.flags & 1) && (this.flags & 4)) {
            if (this.pulse < 0x8000) { this.pulse += 0x1800; if (this.pulse >= 0x8000) { this.pulse = 0x8000; playSE(1); } }
        } else if (this.pulse > 0) this.pulse = Math.max(this.pulse - 0x1800, 0);
    }

    /** fn_80008518: de-clutter fade and the label alpha (+27F = +268·+264·+27D·+260). */
    updateLabelFade() {
        if (this.flags & 2) this.labelHide = Math.max(this.labelHide - 0.1, 0); else this.labelHide = Math.min(this.labelHide + 0.1, 1);
        this.alpha27F = byte(this.edgeFade * (this.depthLabel * (this.alpha27D * this.selectFade)));
    }

    /** fn_80009F24 + fn_80009FCC: label origin/scale, its text rect, the hover bars and the hover chase. */
    placeLabel(p, scale) {
        this.labelPos = p; this.labelScale = scale;
        const w = this.labelSize[0] * scale, h = this.labelSize[1] * scale;
        let x0 = p[0] - 4, x1 = p[0] + w + 4;
        const y0 = p[1] - 0.5 * h - 4, y1 = p[1] + 0.5 * h + 4;
        this.barLeft = [x0 - 100, y0, x0, y1];
        this.barRight = [x0, y0, x1 + 50, y1];
        if (this.flags & 4) { x0 -= 100; x1 += 50; }
        this.textRect = [x0, y0, x1, y1];
        [this.hoverChase] = GM.chaseValue(this.hoverChase, (this.flags & 4) ? 1 : 0, 0.2, 1.0, 0.05);
    }

    /**
     * fn_8001ACFC: two overlapping label rects — returns true to hide `a` (the earlier one), or hides `b`.
     * Priority: hovered > the user's city > higher rank > later in the list.
     */
    static overlapHidesFirst(a, b) {
        if (a.flags & 2) return false;
        const ra = a.textRect, rb = b.textRect;
        const wa = ra[2] - ra[0], ha = ra[3] - ra[1], wb = rb[2] - rb[0], hb = rb[3] - rb[1];
        const dx = Math.abs((ra[0] + 0.5 * wa) - (rb[0] + 0.5 * wb)), dy = Math.abs((ra[1] + 0.5 * ha) - (rb[1] + 0.5 * hb));
        if (dx > 0.5 * (wa + wb) || dy > 0.5 * (ha + hb)) return false;
        if (a.flags & 4) { b.flags |= 2; return false; }
        if (b.flags & 4) return true;
        if (a.isHome) { b.flags |= 2; return false; }
        if (b.isHome) return true;
        if (a.rank < b.rank) return true;
        b.flags |= 2;
        return false;
    }

    /** fn_800099CC: temperature (°C) → colour, piecewise lerp through the static palette (fn_80009E5C). */
    static palette = [
        [0xFF, 0xFF, 0xFF, 0xFF], [0xBB, 0xFF, 0xFF, 0xFF], [0x00, 0xFF, 0xFF, 0xFF], [0x21, 0xA5, 0xE3, 0xFF],
        [0x00, 0x66, 0xCD, 0xFF], [0x8C, 0xFF, 0x00, 0xFF], [0xFF, 0xFF, 0x00, 0xFF], [0xFF, 0xB6, 0x00, 0xFF],
        [0xFF, 0x8C, 0x00, 0xFF], [0xFF, 0x62, 0x20, 0xFF], [0xBD, 0x00, 0x00, 0xFF]];
    static temperatureColor(t) {
        const segs = [[-12, 6], [-7, 5], [-1, 6], [4, 5], [10, 6], [16, 6], [21, 5], [27, 6], [32, 5]];
        const P = CityMarker.palette;
        if (t <= -18) return P[0].slice();
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (t > s[0]) continue;
            const a = P[i], b = P[i + 1], k = (s[0] - t) / s[1];
            const ch = (c) => byte(b[c] - (b[c] - a[c]) * k);
            return [ch(0), ch(1), ch(2), 255];
        }
        return P[10].slice();
    }
}
