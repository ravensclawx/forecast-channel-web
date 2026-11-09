// Headless scene-graph test for track E (scenes, UI, globe game): node tools/test_scene.mjs [assetDir]
// Builds SceneContext + WeatherScene against a stub WebGL2 context with the developer's own WAD + common key
// (default ~/Library/Application Support/ForecastChannel/{HAFE.wad,common-key.bin}; nothing is read from the repo),
// forecast data generated from tools/fixtures/openmeteo_3cities.json, and an in-memory save store. It then drives
// every scene state (boot → address → hub → pages/6-hour popup → globe → marker city → back → settings → address)
// in both modes (desktop 832×456 wide, mobile 608×1322 portrait), calling calc() + render() every frame.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || path.join(os.homedir(), 'Library/Application Support/ForecastChannel');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };

// Module graph first: catches import/export name mismatches even without assets.
const mods = {};
for (const m of ['ui/bridge', 'ui/Fade', 'ui/ButtonColors', 'ui/UIInput', 'ui/PaneCtl', 'ui/UILayout', 'ui/SpriteText', 'ui/TelopText', 'ui/Cursor',
                 'game/GlobeMath', 'game/GlobeCamera', 'game/SimpleGlobe', 'game/GlobeScene',
                 'scene/PortraitArrange', 'scene/SceneContext', 'scene/Connect', 'scene/Message', 'scene/normal/HubPages',
                 'scene/normal/NormalScreen', 'scene/around/AroundScreen', 'scene/address/AddressScreen', 'scene/setting/SettingScreen',
                 'scene/WeatherScene']) {
    try { mods[m] = await import(`../js/forecast/${m}.js`); ok(true, `import ${m}`); }
    catch (e) { ok(false, `import ${m}: ${e.message}`); }
}
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }

// Pure logic checks (no assets).
{
    const { chaseValue, wrap180, approachAngle } = mods['game/GlobeMath'];
    ok(chaseValue(10, 0, 0.1, 100, 0.001)[0] === 9, 'chaseValue step');
    ok(wrap180(270) === -90, 'wrap180');
    ok(approachAngle(359.999, 0) === 0, 'approachAngle snap');
    const { ButtonColors } = mods['ui/ButtonColors'];
    ok(ButtonColors.at(0, 0x18).join() === '0,192,255,0', 'ButtonColors scheme 0 hover');
    const { Fade } = mods['ui/Fade'];
    const f = new Fade(255, true); f.startFadeIn(4); for (let i = 0; i < 4; i++) f.update();
    ok(f.isIdle && f.alpha === 0, 'Fade in');
    const { CityMarker } = mods['scene/around/AroundScreen'];
    ok(CityMarker.temperatureColor(-30).join() === '255,255,255,255' && CityMarker.temperatureColor(40).join() === '189,0,0,255', 'temperatureColor ends');
    const { HubDate } = mods['scene/normal/HubPages'];
    const d = new HubDate(0); ok(d.year === 2000 && d.month === 0 && d.day === 1 && d.weekday === 6, 'HubDate epoch = Sat 2000-01-01');
}

const wadPath = path.join(dir, 'HAFE.wad'), keyPath = path.join(dir, 'common-key.bin');
if (!fs.existsSync(wadPath) || !fs.existsSync(keyPath)) {
    console.log(`skip scene run: no ${wadPath} / common-key.bin (bring your own)`);
    console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
}

const { Assets } = await import('../js/forecast/system/Assets.js');
const { GXWebGL } = await import('../js/forecast/render/GXWebGL.js');
const { LogicalScreen } = await import('../js/forecast/render/LogicalScreen.js');
const { PointerSample, WPAD } = await import('../js/forecast/system/KPad.js');
const { Gestures } = await import('../js/forecast/system/TouchInput.js');
const { MemoryKV, setDefaultStore } = await import('../js/forecast/data/KVStore.js');
const { OpenMeteo } = await import('../js/forecast/data/OpenMeteo.js');
const { CityList } = await import('../js/forecast/data/CityList.js');
const { ForecastGenerator } = await import('../js/forecast/data/ForecastGenerator.js');
const { WeatherData } = await import('../js/forecast/data/ForecastFormat.js');
const { SceneContext } = mods['scene/SceneContext'];
const { WeatherScene, SceneState } = mods['scene/WeatherScene'];

// Stub WebGL2: every call recorded; status queries succeed.
let draws = 0;
const gl = new Proxy({ drawingBufferWidth: 1664, drawingBufferHeight: 912 }, {
    get(t, p) {
        if (p in t) return t[p];
        if (typeof p === 'string' && p === p.toUpperCase()) return p;
        return (...a) => {
            if (p === 'getShaderParameter' || p === 'getProgramParameter' || p === 'checkFramebufferStatus') return p === 'checkFramebufferStatus' ? 'FRAMEBUFFER_COMPLETE' : true;
            if (p === 'drawArrays' || p === 'drawElements') draws++;
            if (p === 'getError') return 0;
            if (p.startsWith('create') || p === 'getUniformLocation') return { id: p };
            return undefined;
        };
    },
});

setDefaultStore(new MemoryKV());
const assets = new Assets(new Uint8Array(fs.readFileSync(wadPath)), new Uint8Array(fs.readFileSync(keyPath)));
const om = OpenMeteo.parse(fs.readFileSync(path.join(here, 'fixtures/openmeteo_3cities.json'), 'utf8'), 3);
const pick = (name, region) => CityList.all.find(c => c.name === name && (region == null || c.region === region));
const out = new ForecastGenerator([pick('Chicago', 'Illinois'), pick('Jackson', 'Mississippi'), pick('London', null)]).build(om, new Date());
const data = new WeatherData(out.forecast, out.short, { now: new Date() });
const service = { loadForBoot: async () => data };
const chicago = data.forecast.places.find(p => p.city === 'Chicago');

for (const [desktop, W, H] of [[true, 832, 456], [false, 608, 1322]]) {
    const tag = desktop ? 'desktop' : 'mobile';
    LogicalScreen.isPortrait = !desktop; LogicalScreen.height = H; LogicalScreen.safeTop = 0; LogicalScreen.safeBottom = 0;
    setDefaultStore(new MemoryKV());
    let ctx, scene;
    try {
        const gx = new GXWebGL(gl);
        // The real SoundManager (no AudioContext until startOutput) so the BGM / SE / weather-SE paths run too.
        let sound = null;
        try { const { SoundManager } = await import('../js/forecast/sound/SoundManager.js'); sound = new SoundManager(assets); } catch (e) { console.log(`  (no SoundManager: ${e.message})`); }
        ctx = new SceneContext({ assets, gx, sound, isWide: desktop });
        ctx.pad.smoothPointer = desktop;
        scene = new WeatherScene(ctx, service);
        ok(true, `${tag}: SceneContext + WeatherScene constructed (sound ${sound ? 'on' : 'off'})`);
    } catch (e) { ok(false, `${tag}: construct: ${e.stack}`); continue; }
    const viewport = { originX: 0, originY: 0, width: desktop ? 1664 : 608, height: desktop ? 912 : 1322 };
    let frameErr = null;
    // Each frame yields to the event loop so the async parts (forecast load, IndexedDB-style save) settle.
    const tick = () => new Promise(r => setImmediate(r));
    const frame = async (sample = new PointerSample([W / 2, H / 2], false, 0, 0), gestures = new Gestures()) => {
        if (frameErr) return;
        try { ctx.gestures = gestures; ctx.pad.update(sample); scene.calc(); ctx.sound?.update?.(); scene.render(viewport); }
        catch (e) { frameErr = e; ok(false, `${tag}: frame in ${scene.state}/${scene.step}: ${e.stack}`); }
        await tick();
    };
    const run = async (n, s) => { for (let i = 0; i < n; i++) await frame(s); };
    const until = async (cond, max = 600) => { for (let i = 0; i < max && !cond() && !frameErr; i++) await frame(); return cond(); };
    const press = async (bits, p = [W / 2, H / 2]) => { await frame(new PointerSample(p, true, bits, 0)); await frame(new PointerSample(p, true, 0, 0)); };

    // Boot: Connect → SaveData (no file) → (desktop: date/time box) → address (first run).
    ok(await until(() => scene.state !== SceneState.boot || scene.step >= 4, 900), `${tag}: boot reached save check (${scene.state}/${scene.step})`);
    if (scene.state === SceneState.boot && scene.step === 4) {
        ok(desktop && scene.message.type === 1, `${tag}: first-run date/time message`);
        scene.message.state = 4;   // as if "Yes" had been pressed
    }
    ok(await until(() => scene.state === SceneState.address), `${tag}: first run → address`);
    await run(40);
    ok(scene.address.rows.length > 0, `${tag}: address list rows ${scene.address.rows.length}`);
    // Pick Chicago (the confirm "yes" path: request 2 with the location set).
    ctx.locationID = chicago.id; ctx.request = 2;
    ok(await until(() => scene.state === SceneState.normal), `${tag}: address → hub`);
    await run(60);
    ok(scene.normal.record?.place?.city === 'Chicago', `${tag}: hub shows Chicago`);
    const set = scene.normal.forecast.find('set');
    ok(set && !set.disabled, `${tag}: Settings button enabled at top level`);
    // Pages ▼ ▼ (Today), 6-hour popup, then the rest.
    await press(WPAD.down); await run(40); await press(WPAD.down); await run(40);
    ok(ctx.startPage === 3, `${tag}: d-pad down → page ${ctx.startPage}`);
    const bp = scene.normal.bandPixels;
    await press(WPAD.a, desktop ? [W / 2, 228] : [W / 2, bp[1] + bp[3] / 2]); await run(30);
    ok(scene.normal.popup === 2, `${tag}: 6-hour popup open`);
    await press(WPAD.b); await run(30);
    await press(WPAD.down); await run(40); await press(WPAD.up); await run(10); await press(WPAD.up); await run(10); await press(WPAD.up); await run(10); await press(WPAD.up); await run(40);
    ok(ctx.startPage === 0, `${tag}: back to UV page`);
    // Globe.
    ctx.request = 5;
    ok(await until(() => scene.state === SceneState.globe && scene.step === 1, 400), `${tag}: hub → globe`);
    for (let m = 0; m < 6; m++) { await press(WPAD.right); await run(5); }
    await press(WPAD.minus); await run(30); await press(WPAD.plus); await run(30); await press(WPAD.up); await run(30);
    // Drag the globe.
    for (let i = 0; i < 30; i++) await frame(new PointerSample([W / 2 + i * 3, H / 2], true, WPAD.a, 0));
    await run(30);
    ok(scene.around.markers.length === 3, `${tag}: 3 markers`);
    if (!desktop) {
        const g = new Gestures(); g.fingers = 2; g.pinch = 1.4;
        await frame(new PointerSample([W / 2, H / 2], false, 0, 0), g); await run(30);
    }
    // A marker → its city (request 6), zoom open, then Back (zoom close into the marker).
    scene.around.selectedLocation = chicago.id; ctx.markerPoint = [W / 2, H / 2]; ctx.request = 6;
    ok(await until(() => scene.state === SceneState.normal && scene.step === 1 && !scene.normal.zoomActive, 200), `${tag}: marker → city hub (zoom open)`);
    ok(!ctx.isTopLevel && scene.normal.forecast.find('around').disabled, `${tag}: city hub not top level`);
    ctx.request = 3; scene.normal.startCloseZoom(ctx.markerPoint);
    ok(await until(() => scene.state === SceneState.globe && scene.step === 1, 300), `${tag}: city hub → globe`);
    ctx.request = 3;
    ok(await until(() => scene.state === SceneState.normal && scene.step === 1, 400), `${tag}: globe → hub`);
    // Settings → toggle units → change city → address → back.
    ctx.request = 4;
    ok(await until(() => scene.state === SceneState.setting && scene.step === 2, 300), `${tag}: hub → settings`);
    await run(20);
    ctx.request = 1;
    ok(await until(() => scene.state === SceneState.address && scene.step >= 2, 300), `${tag}: settings → address`);
    await run(20);
    ctx.request = 4;
    ok(await until(() => scene.state === SceneState.setting && scene.step === 2, 300), `${tag}: address back → settings`);
    ctx.request = 2;
    ok(await until(() => scene.state === SceneState.normal && scene.step === 1, 300), `${tag}: settings back → hub`);
    // Top-level "Wii Menu" (desktop) sets wantsQuit; mobile's slot is inert.
    if (desktop) {
        ctx.returnToWiiMenu = true;
        ok(await until(() => scene.wantsQuit, 100), `${tag}: Wii Menu → wantsQuit`);
        scene.resumeFromSuspend();
        ok(await until(() => scene.state === SceneState.normal && scene.step === 1, 100), `${tag}: resume → hub`);
    } else {
        ok(scene.normal.forecast.find('back').disabled, `${tag}: bottom-left slot inert at top level`);
    }
    ok(scene.cursorState != null, `${tag}: cursorState ${scene.cursorState}`);
    ok(!frameErr, `${tag}: no frame errors`);
}
ok(draws > 1000, `stub GL draw calls: ${draws}`);
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
