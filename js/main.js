// App shell (replaces ForecastMac/main.swift and iOS GameViewController.swift).
//
// Modes (CONVENTIONS.md "Two modes"), picked once at startup; override with ?mode=desktop|mobile:
//   desktop — fine pointer + landscape window: the original Wii widescreen channel (832×456 logical, 16:9 letterbox),
//             mouse = Wii Remote pointer, Wii cursor drawn, KPad smoothing on.
//   mobile  — the iPhone portrait build (608×1322 logical, letterboxed), touch via TouchInput, no cursor.
//
// Contracts with the other modules (all optional-guarded so a missing module shows a readable overlay):
//   gx = new GXWebGL(gl)                                     js/forecast/render/GXWebGL.js
//   new SceneContext({ assets, gx, sound, isWide })           js/forecast/scene/SceneContext.js
//   new WeatherScene(ctx)                                     js/forecast/scene/WeatherScene.js
//     scene.calc(); scene.render(viewport); scene.touchMode(p) (mobile); scene.cursorState (desktop);
//     scene.wantsQuit / scene.wantsSuspend (→ we just restart the scene, there is no Wii Menu on the web)
//   ctx.gx.beginFrame()   — called once per rendered frame before scene.render (GXMetal.beginFrame)
//   ctx.gx.beginPass(null, { clearColor: null, clearDepth: true }) → enc; enc.setViewport(vp) — cursor overlay
//   new SoundManager(assets) → startOutput() (on first gesture), update() once per game frame
//   new Cursor(assets, ctx.lyt) (Cursor.js, or CursorDraw.js) → cursor.state = scene.cursorState;
//     cursor.draw(ctx.lyt, enc, pointer, twist, 832)
//   viewport = MTLViewport-style { originX, originY, width, height } in canvas pixels, origin TOP-left.
import { Storage } from './forecast/system/Storage.js';
import { LogicalScreen } from './forecast/render/LogicalScreen.js';
import { KPad, PointerSample, WPAD } from './forecast/system/KPad.js';
import { TouchInput, TouchMode } from './forecast/system/TouchInput.js';
import { ESTitle } from './rvl/ES.js';

const canvas = document.getElementById('screen');
const setupEl = document.getElementById('setup');
const overlayEl = document.getElementById('overlay');
const overlayText = document.getElementById('overlay-text');
const replaceBtn = document.getElementById('replace-files');
const HAFE = '0001000248414645';

// ── Mode ────────────────────────────────────────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
function pickMode() {
  const forced = params.get('mode');
  if (forced === 'desktop' || forced === 'mobile') return forced;
  const fine = matchMedia('(pointer: fine)').matches;
  return fine && innerWidth >= innerHeight ? 'desktop' : 'mobile';
}
const mode = pickMode();
const desktop = mode === 'desktop';
const LOGICAL_W = desktop ? 832 : 608;
const LOGICAL_H = desktop ? 456 : 1322;
LogicalScreen.isPortrait = !desktop;
LogicalScreen.height = LOGICAL_H;
LogicalScreen.safeTop = 0; LogicalScreen.safeBottom = 0;
document.body.classList.add(mode);

function showError(msg, err) {
  overlayText.textContent = msg + (err ? `\n\n${err.stack || err}` : '');
  overlayEl.hidden = false;
  replaceBtn.hidden = false;
  console.error(msg, err);
}

// ── First run: the visitor's own WAD + common key ───────────────────────────────────────────────────────────────
async function loadOrAskFiles() {
  if (params.get('setup') !== '1') {
    const [wad, key] = await Promise.all([Storage.get('wad'), Storage.get('key')]);
    if (wad && key) return { wad: new Uint8Array(wad), key: new Uint8Array(key) };
  }
  return new Promise(resolve => {
    setupEl.hidden = false;
    const wadIn = document.getElementById('wad-input'), keyIn = document.getElementById('key-input');
    const wadName = document.getElementById('wad-name'), keyName = document.getElementById('key-name');
    const err = document.getElementById('setup-error'), start = document.getElementById('setup-start');
    const update = () => {
      wadName.textContent = wadIn.files[0] ? wadIn.files[0].name : 'No file chosen';
      keyName.textContent = keyIn.files[0] ? keyIn.files[0].name : 'No file chosen';
      start.disabled = !(wadIn.files[0] && keyIn.files[0]);
      err.textContent = '';
    };
    wadIn.addEventListener('change', update); keyIn.addEventListener('change', update);
    start.addEventListener('click', async () => {
      start.disabled = true; err.textContent = 'Checking…';
      try {
        const wad = new Uint8Array(await wadIn.files[0].arrayBuffer());
        const key = new Uint8Array(await keyIn.files[0].arrayBuffer());
        if (key.length !== 16) throw new Error('The common key file must be exactly 16 bytes.');
        const t = new ESTitle(wad, key);
        if (t.titleIDHex !== HAFE) throw new Error(`That WAD is title ${t.titleIDHex}, not the Forecast Channel (USA, ${HAFE}).`);
        t.content(1);   // decrypt + SHA-1 check: proves the key is right
        await Storage.put('wad', wad); await Storage.put('key', key);
        setupEl.hidden = true;
        if (params.get('setup') === '1') history.replaceState(null, '', location.pathname);
        resolve({ wad, key });
      } catch (e) {
        err.textContent = e.message.includes('hash mismatch') ? 'That key can\'t decrypt this WAD — check the common key.' : e.message;
        start.disabled = false;
      }
    });
  });
}
replaceBtn.addEventListener('click', () => { location.search = '?setup=1'; });

// ── Letterbox ───────────────────────────────────────────────────────────────────────────────────────────────────
let viewport = { originX: 0, originY: 0, width: 1, height: 1 };
let letterbox = { left: 0, top: 0, width: 1, height: 1 };   // CSS px
function layoutCanvas() {
  const W = innerWidth, H = innerHeight, aspect = desktop ? 16 / 9 : LOGICAL_W / LOGICAL_H;
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  letterbox = { left: Math.round((W - w) / 2), top: Math.round((H - h) / 2), width: Math.round(w), height: Math.round(h) };
  // The canvas covers the whole window (black bars are part of it) so pointer events outside the picture still land.
  const dpr = Math.min(devicePixelRatio || 1, 3);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  viewport = {
    originX: Math.round(letterbox.left * dpr),
    originY: Math.round(letterbox.top * dpr),
    width: Math.round(letterbox.width * dpr),
    height: Math.round(letterbox.height * dpr),
  };
}
/** CSS client point → logical screen point (y down) and whether it is inside the picture. */
function toLogical(clientX, clientY) {
  const x = (clientX - letterbox.left) / letterbox.width * LOGICAL_W;
  const y = (clientY - letterbox.top) / letterbox.height * LOGICAL_H;
  return { p: [x, y], inside: x >= 0 && y >= 0 && x <= LOGICAL_W && y <= LOGICAL_H };
}

// ── Boot ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  layoutCanvas();
  addEventListener('resize', layoutCanvas);
  const { wad, key } = await loadOrAskFiles();

  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false, depth: true, stencil: false, premultipliedAlpha: false });
  if (!gl) { showError('This browser does not support WebGL2.'); return; }

  let Assets, GXWebGL, SceneContext, WeatherScene, SoundManager = null, Cursor = null;
  try {
    ({ Assets } = await import('./forecast/system/Assets.js'));
    ({ GXWebGL } = await import('./forecast/render/GXWebGL.js'));
    ({ SceneContext } = await import('./forecast/scene/SceneContext.js'));
    ({ WeatherScene } = await import('./forecast/scene/WeatherScene.js'));
  } catch (e) { showError('A module of the channel failed to load.', e); return; }
  try { ({ SoundManager } = await import('./forecast/sound/SoundManager.js')); } catch (e) { console.warn('sound unavailable', e); }
  if (desktop) {
    try { ({ Cursor } = await import('./forecast/ui/Cursor.js')); } catch (e) { console.warn('cursor unavailable', e); }
    if (!Cursor) { try { ({ CursorDraw: Cursor } = await import('./forecast/ui/CursorDraw.js')); } catch (e) { console.warn('cursor unavailable', e); } }
  }

  let assets, ctx, scene, sound = null, cursor = null;
  try {
    assets = new Assets(wad, key);
    if (SoundManager) { try { sound = new SoundManager(assets); } catch (e) { console.warn('SoundManager failed', e); } }
    // Mobile first visit (no save yet): start on the nearest city from the browser's location, like the iPhone
    // app's "Current Location" — declined / unavailable → the channel's own region and city lists.
    if (!desktop) {
      try {
        const { SaveData, SaveDataLoadResult } = await import('./forecast/scene/SaveData.js');
        const [res] = await SaveData.load();
        if (res === SaveDataLoadResult.noFile) {
          const { locateNearestCity } = await import('./forecast/data/Geolocation.js');
          const near = await locateNearestCity();
          if (near) await new SaveData({ country: 49 << 24, location: near.id.raw ?? near.id, tempUnit: 1, windUnit: 0 }).store();
        }
      } catch (e) { console.warn('location unavailable', e); }
    }
    const gx = new GXWebGL(gl);
    ctx = new SceneContext({ assets, gx, sound, isWide: desktop });
    ctx.pad.smoothPointer = desktop;
    scene = new WeatherScene(ctx);
    // Desktop uses the browser's own mouse pointer (no drawn Wii hand), so the pointer is exact — no IR smoothing.
    ctx.pad.smoothPointer = false;
  } catch (e) { showError('The channel could not start.', e); return; }

  // Audio starts on the first user gesture (browser autoplay rules).
  let audioStarted = false;
  const startAudio = () => {
    if (audioStarted || !sound) return;
    audioStarted = true;
    try { const r = sound.startOutput(); if (r && r.catch) r.catch(e => console.warn('audio', e)); } catch (e) { console.warn('audio', e); }
  };
  addEventListener('pointerdown', startAudio, { capture: true });
  addEventListener('keydown', startAudio, { capture: true });

  // ── Input ────────────────────────────────────────────────────────────────────────────────────────────────────
  const touch = new TouchInput();
  let held = 0, pulse = 0, pointer = [LOGICAL_W / 2, LOGICAL_H / 2], pointerInside = false, scrollAccum = 0;

  if (desktop) {
    // ForecastMac mapping: pointer = mouse, A = left button, B = right button / Esc, +/− = wheel or =/-, d-pad = arrows.
    const track = e => {
      const t = toLogical(e.clientX, e.clientY); pointer = t.p;

      pointerInside = t.inside;
    };
    canvas.addEventListener('pointermove', track);
    canvas.addEventListener('pointerdown', e => {
      track(e); canvas.setPointerCapture(e.pointerId);
      if (e.button === 0) held |= WPAD.a; else if (e.button === 2) held |= WPAD.b;
    });
    canvas.addEventListener('pointerup', e => {
      if (e.button === 0) held &= ~WPAD.a; else if (e.button === 2) held &= ~WPAD.b;
    });
    canvas.addEventListener('pointerleave', () => { pointerInside = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      // scrollingDeltaY · (precise ? 0.05 : 1): pixel deltas ≈ precise trackpads, line deltas ≈ wheel notches
      const precise = e.deltaMode === 0;
      scrollAccum += -e.deltaY * (precise ? 0.05 : 1);
      if (scrollAccum > 1) { pulse |= WPAD.plus; scrollAccum = 0; } else if (scrollAccum < -1) { pulse |= WPAD.minus; scrollAccum = 0; }
    }, { passive: false });
    const keyBit = e => {
      switch (e.key) {
        case 'ArrowUp': return WPAD.up; case 'ArrowDown': return WPAD.down;
        case 'ArrowLeft': return WPAD.left; case 'ArrowRight': return WPAD.right;
        case '=': case '+': return WPAD.plus; case '-': case '_': return WPAD.minus;
        case 'Escape': return WPAD.b; case 'Enter': return WPAD.a;
        case '1': return WPAD.one; case '2': return WPAD.two;
        default: return 0;
      }
    };
    addEventListener('keydown', e => { const b = keyBit(e); if (b) { held |= b; e.preventDefault(); } });
    addEventListener('keyup', e => { const b = keyBit(e); if (b) held &= ~b; });
    addEventListener('blur', () => { held = 0; });
  } else {
    const modeAt = p => (scene && typeof scene.touchMode === 'function' ? scene.touchMode(p) : TouchMode.pressOnRelease);
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault(); canvas.setPointerCapture(e.pointerId);
      touch.began(e.pointerId, toLogical(e.clientX, e.clientY).p, modeAt);
    });
    canvas.addEventListener('pointermove', e => { touch.moved(e.pointerId, toLogical(e.clientX, e.clientY).p); });
    canvas.addEventListener('pointerup', e => { touch.moved(e.pointerId, toLogical(e.clientX, e.clientY).p); touch.ended(e.pointerId); });
    canvas.addEventListener('pointercancel', e => { touch.ended(e.pointerId, true); });
    // Desktop convenience on a narrow window: wheel = pinch.
    canvas.addEventListener('wheel', e => { e.preventDefault(); touch.pending.pinch *= Math.exp(-e.deltaY * 0.002); }, { passive: false });
    addEventListener('gesturestart', e => e.preventDefault());   // iOS Safari page zoom
  }

  // ── Frame loop: fixed 60 Hz game ticks (ForecastMac draw order), rendered once per animation frame ──────────
  const STEP = 1000 / 60;
  let last = performance.now(), acc = 0, failed = false;
  function tick() {
    if (desktop) {
      ctx.pad.update(new PointerSample(pointer, pointerInside, held | pulse, 0));
      pulse = 0;
    } else {
      const s = touch.sample();
      ctx.gestures = touch.gestures;
      ctx.pad.update(s);
    }
    if (desktop && scene.wantsQuit && scene.canResume) {
      // Desktop "Wii Menu": there is no Wii Menu in a browser — fade back in on the hub instead of rebooting.
      scene.resumeFromSuspend();
    } else if (scene.wantsQuit || scene.wantsSuspend) {
      // No Wii Menu on the web: an error box's button / quit restarts the channel (fresh download attempt).
      ctx.data = null;
      if (ctx.pendingData && ctx.pendingData.take) ctx.pendingData.take();
      scene = new WeatherScene(ctx);
      return;
    }
    scene.calc();
    // The system pointer becomes a hand over the channel's buttons (and while grabbing the globe).
    if (desktop) {
      const c = !pointerInside ? 'default' : scene.cursorState === 'hold' || scene.cursorState === 2 ? 'grabbing'
        : ctx.ui.hovered ? 'pointer' : (scene.cursorState === 'open' || scene.cursorState === 1) ? 'grab' : 'default';
      if (canvas.style.cursor !== c) canvas.style.cursor = c;
    }
    if (sound) sound.update();   // fn_80041F54, once per game frame
  }
  function frame(now) {
    if (failed) return;
    requestAnimationFrame(frame);
    acc += Math.min(now - last, 250); last = now;
    try {
      let steps = 0;
      while (acc >= STEP && steps < 4) { tick(); acc -= STEP; steps++; }
      if (steps === 4) acc = 0;
      if (ctx.gx && ctx.gx.beginFrame) ctx.gx.beginFrame();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1); gl.clearDepth(1);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);   // the letterbox bars
      scene.render(viewport);
      if (desktop && cursor && pointerInside && ctx.gx && ctx.gx.beginPass) {
        // Overlay pass: the cursor (CErrorSystem draws after the scene).
        const enc = ctx.gx.beginPass(null, { clearColor: null, clearDepth: true });
        enc.setViewport(viewport);
        cursor.state = scene.cursorState;
        cursor.draw(ctx.lyt, enc, ctx.pad.pointer, ctx.pad.twist, 832);
        enc.endEncoding();
      }
    } catch (e) {
      failed = true;
      showError('The channel stopped because of an error.', e);
    }
  }
  requestAnimationFrame(t => { last = t; frame(t); });
}

boot().catch(e => showError('Startup failed.', e));
