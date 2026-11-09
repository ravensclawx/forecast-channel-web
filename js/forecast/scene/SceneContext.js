import { LytRenderer } from '../render/LytRenderer.js';
import { LogicalScreen } from '../render/LogicalScreen.js';
import { KPad } from '../system/KPad.js';
import { Gestures } from '../system/TouchInput.js';
import { LocationID } from '../data/ForecastFormat.js';
import { UIInput } from '../ui/UIInput.js';
import { UILayout } from '../ui/UILayout.js';
import { Fade } from '../ui/Fade.js';
import { Lang } from '../ui/PaneCtl.js';
import { GlobeScene } from '../game/GlobeScene.js';

/** Slot for data produced asynchronously (the background refresh). */
export class PendingData {
    constructor() { this.value = null; }
    set(v) { this.value = v; }
    take() { const v = this.value; this.value = null; return v; }
}

/**
 * Shared state that the original keeps in globals / the CScene base (d_scene.cpp, d_s_weather.cpp).
 * Every screen gets the same context object.
 * Web: the shell creates the GXWebGL (`gx`) for its canvas and passes it in.
 */
export class SceneContext {
    /** @param {{assets, gx, sound?, isWide?}} o */
    constructor({ assets, gx, sound = null, isWide = true }) {
        this.assets = assets; this.gx = gx; this.sound = sound; this.isWide = isWide;
        this.lyt = new LytRenderer(gx);
        this.lyt.textureProvider = (n) => assets.layoutTexture(n);
        this.lyt.fontProvider = (n) => assets.font(n);
        this.pad = new KPad();
        this.ui = new UIInput(isWide);
        this.ui.playSE = (id) => sound?.playSE(id);

        // Language / region (lbl_80330B36, lbl_80330B3C, lbl_80330B38). US build: English, region US.
        this.lang = Lang.us;
        this.region = 1;
        this.countryCode = 49;          // SYSCONF country (USA = 49)
        // Settings (save data fields) — lbl_803309F0 temp unit (0 °C, 1 °F), lbl_803309F4 wind unit (0 mph, 1 km/h),
        // lbl_80330A00 location ID.
        this.tempUnit = 1;
        this.windUnit = 0;
        this.locationID = new LocationID(0);
        /** City whose pages the hub shows when entered from a globe marker (non-top-level hub); null = locationID. */
        this.displayLocation = null;
        /** lbl_803309D0: screen point (SetOrtho2D px) of the globe marker that opened the city — the zoom centre. */
        this.markerPoint = [0, 0];
        this.isDaytime = true;          // lbl_803309EC (local hour 5..17)
        this.startPage = 1;             // lbl_803309E0
        this.pageCount = 5;             // lbl_803309E4 (4 JP, 5 otherwise)
        this.globeMode = 0;             // lbl_803309E8 (around display mode 0..5)
        this.isTopLevel = true;         // lbl_8032FD00 (hub back = "Wii Menu")
        this.request = 0;               // lbl_8032FCF0 request codes (1 change city … 5 open globe)
        this.returnToWiiMenu = false;   // lbl_80330BB9
        /** Parsed forecast data (lbl_803309B4). */
        this.data = null;
        /** Background refresh result (stale cache shown at boot); applied by WeatherScene when the hub is entered. */
        this.pendingData = new PendingData();
        /** Fades: m_pFade (opaque black), m_pFade2 (dim 0xA0 behind dialogs). */
        this.fade = new Fade(255, true);
        this.fade2 = new Fade(0xA0, false);
        /** The globe (g_pSimpleGlobe + earth model renderer), shared by the hub's globe button, CAround and CAddress. */
        this.globeScene = new GlobeScene(gx, assets, isWide, sound, this.pad);
        const hour = new Date().getHours();
        this.isDaytime = hour >= 5 && hour <= 17;
        /** Touch: this frame's gestures (pinch / two-finger pan / rotation / one-finger drag). Neutral on desktop. */
        this.gestures = new Gestures();
        this._rumble = () => {};
        this._prewarmJobs = [];
        this._prewarmQueued = false;
    }

    get screenWidth() { return this.isWide ? 832 : 608; }
    /** Mobile portrait presentation (LogicalScreen.isPortrait): screens use their portrait arrangements. */
    get isPortrait() { return LogicalScreen.isPortrait; }
    get screenHeight() { return LogicalScreen.height; }
    /** WPAD_RumblePattern → navigator.vibrate on the web (set by the shell). */
    get rumble() { return this._rumble; }
    set rumble(f) { this._rumble = f; this.ui.rumble = f; }

    // MARK: - Prewarm (everything uploaded ahead of first use, a few items per frame from boot)

    /** Queue every layout texture, font sheet and sprite image (`sprites` supplies TPLCommon/TPLWeather). */
    queuePrewarm(sprites) {
        if (this._prewarmQueued) return;
        this._prewarmQueued = true;
        const jobs = [];
        try {
            const arc = this.assets.weatherLayoutArchive();
            const files = arc.files instanceof Map ? [...arc.files.keys()] : Object.keys(arc.files ?? {});
            for (const path of files.sort()) {
                if (path.startsWith('/arc/timg/')) {
                    const name = path.slice('/arc/timg/'.length);
                    jobs.push(() => this.lyt.prewarmTexture(name));
                } else if (path.startsWith('/arc/font/')) {
                    const name = path.slice('/arc/font/'.length);
                    jobs.push(() => { const f = this.assets.font(name); if (f) this.lyt.prewarmFont(f); });
                }
            }
        } catch (_) { /* archive missing: nothing to prewarm */ }
        for (const name of ['font_weather_city.brfnt', 'font_weather_time.brfnt', 'font_weather_timeWW.brfnt']) {
            jobs.push(() => { const f = this.assets.font(name); if (f) this.lyt.prewarmFont(f); });
        }
        jobs.push(() => { const f = this.assets.systemFont(); if (f) this.lyt.prewarmFont(f); });
        if (sprites) jobs.push(...sprites.prewarmJobs());
        this._prewarmJobs = jobs;
    }
    /** Run up to `budget` prewarm items (called once per frame). */
    stepPrewarm(budget = 6) {
        let n = 0;
        while (n < budget && this._prewarmJobs.length) { const j = this._prewarmJobs.shift(); try { j(); } catch (_) {} n += 1; }
    }

    /** Snd_StartSoundHandle(id) */
    playSE(id) { this.sound?.playSE(id); }

    /** Load a UILayout from weather_layout.arc with the current language. */
    layout(name, colorScheme = 0) { return UILayout.fromAssets(this.assets, name, this.lang, colorScheme, this.isWide); }
}
