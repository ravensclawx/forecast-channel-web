// App shell (replaces ForecastMac/main.swift and iOS GameViewController.swift).
//
// Fully dynamic: the layout follows the window, live.
//   wide window (aspect ≥ 1)  → the original Wii widescreen channel: 832×456 logical, letterboxed 16:9.
//   tall window (aspect < 1)  → the iPhone portrait build: 608 logical wide, height = the window's own aspect
//                               (clamped 1000…1500 logical, letterboxed beyond that), so phones fill the screen.
//   Resizing / rotating rebuilds the scene in the new layout (forecast data and settings carry over).
// Input follows the device actually used, per event:
//   mouse → the Wii Remote pointer (hover, left = A, right = B, wheel = +/− in widescreen / pinch in portrait);
//   touch / pen → the iPhone touch model (TouchInput: taps, swipes, globe grab, pinch, two-finger tilt);
//   keyboard always: arrows = d-pad, Enter = A, Esc = B, =/- = +/−, 1/2.
// Overrides: ?layout=wide|tall forces a layout.
import { Storage } from './forecast/system/Storage.js';
import { LogicalScreen } from './forecast/render/LogicalScreen.js';
import { PointerSample, WPAD } from './forecast/system/KPad.js';
import { TouchInput, TouchMode } from './forecast/system/TouchInput.js';
import { ESTitle } from './rvl/ES.js';

const canvas = document.getElementById('screen');
const setupEl = document.getElementById('setup');
const overlayEl = document.getElementById('overlay');
const overlayText = document.getElementById('overlay-text');
const replaceBtn = document.getElementById('replace-files');
const HAFE = '0001000248414645';
const params = new URLSearchParams(location.search);

function showError(msg, err) {
  overlayText.textContent = msg + (err ? `\n\n${err.stack || err}` : '');
  overlayEl.hidden = false;
  replaceBtn.hidden = false;
  console.error(msg, err);
}

// ── First run: the visitor's own WAD + common key ───────────────────────────────────────────────────────────────
async function loadOrAskFiles() {
  // The channel files ship with the site (data/). The setup screen below is only a fallback if they're missing.
  try {
    const [w, k] = await Promise.all([fetch('data/HAFE.wad'), fetch('data/common-key.bin')]);
    if (w.ok && k.ok) return { wad: new Uint8Array(await w.arrayBuffer()), key: new Uint8Array(await k.arrayBuffer()) };
  } catch {}

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

// ── Layout (recomputed on every resize) ─────────────────────────────────────────────────────────────────────
/** Logical screen + letterbox for a window of W×H CSS px. */
function computeLayout(W, H) {
  const force = params.get('layout') ?? ({ desktop: 'wide', mobile: 'tall' })[params.get('mode')];
  const wide = force ? force === 'wide' : W >= H;
  let lw, lh;
  if (wide) { lw = 832; lh = 456; }
  else { lw = 608; lh = Math.round(Math.min(1500, Math.max(1000, 608 * H / W))); }
  const aspect = wide ? 16 / 9 : lw / lh;
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  return { wide, lw, lh, box: { left: Math.round((W - w) / 2), top: Math.round((H - h) / 2), width: Math.round(w), height: Math.round(h) } };
}
let L = computeLayout(innerWidth, innerHeight);
let viewport = { originX: 0, originY: 0, width: 1, height: 1 };
function sizeCanvas() {
  const W = innerWidth, H = innerHeight, dpr = Math.min(devicePixelRatio || 1, 3);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const b = L.box;
  viewport = { originX: Math.round(b.left * dpr), originY: Math.round(b.top * dpr), width: Math.round(b.width * dpr), height: Math.round(b.height * dpr) };
}
function applyLogicalScreen() {
  LogicalScreen.isPortrait = !L.wide;
  LogicalScreen.height = L.lh;
  LogicalScreen.safeTop = 0; LogicalScreen.safeBottom = 0;
  document.body.classList.toggle('desktop', L.wide); document.body.classList.toggle('mobile', !L.wide);
}
/** CSS client point → logical point (y down) and whether it is inside the picture. */
function toLogical(clientX, clientY) {
  const b = L.box;
  const x = (clientX - b.left) / b.width * L.lw, y = (clientY - b.top) / b.height * L.lh;
  return { p: [x, y], inside: x >= 0 && y >= 0 && x <= L.lw && y <= L.lh };
}

// ── Boot ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  applyLogicalScreen(); sizeCanvas();
  addEventListener('resize', sizeCanvas);
  const { wad, key } = await loadOrAskFiles();

  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false, depth: true, stencil: false, premultipliedAlpha: false });
  if (!gl) { showError('This browser does not support WebGL2.'); return; }

  let Assets, GXWebGL, SceneContext, WeatherScene, SoundManager = null;
  try {
    ({ Assets } = await import('./forecast/system/Assets.js'));
    ({ GXWebGL } = await import('./forecast/render/GXWebGL.js'));
    ({ SceneContext } = await import('./forecast/scene/SceneContext.js'));
    ({ WeatherScene } = await import('./forecast/scene/WeatherScene.js'));
  } catch (e) { showError('A module of the channel failed to load.', e); return; }
  try { ({ SoundManager } = await import('./forecast/sound/SoundManager.js')); } catch (e) { console.warn('sound unavailable', e); }

  let assets, gx, sound = null;
  try {
    assets = new Assets(wad, key);
    if (SoundManager) { try { sound = new SoundManager(assets); } catch (e) { console.warn('SoundManager failed', e); } }
    // First visit (no save yet): start on the nearest city from the browser's location, like the iPhone app's
    // "Current Location" — declined / unavailable → the channel's own region and city lists.
    try {
      const { SaveData, SaveDataLoadResult } = await import('./forecast/scene/SaveData.js');
      const [res] = await SaveData.load();
      if (res === SaveDataLoadResult.noFile) {
        const { locateNearestCity } = await import('./forecast/data/Geolocation.js');
        const near = await locateNearestCity();
        if (near) await new SaveData({ country: 49 << 24, location: near.id.raw ?? near.id, tempUnit: 1, windUnit: 0 }).store();
      }
    } catch (e) { console.warn('location unavailable', e); }
    gx = new GXWebGL(gl);
  } catch (e) { showError('The channel could not start.', e); return; }

  // One SceneContext + WeatherScene per layout; rebuilt when the window's layout changes.
  let ctx = null, scene = null;
  function build(carry) {
    applyLogicalScreen();
    ctx = new SceneContext({ assets, gx, sound, isWide: L.wide });
    ctx.pad.smoothPointer = false;            // pointer events are exact (no IR jitter to smooth)
    if (carry) { ctx.data = carry.data; ctx.tempUnit = carry.tempUnit; ctx.windUnit = carry.windUnit; ctx.locationID = carry.locationID; }
    scene = new WeatherScene(ctx);
  }
  try { build(null); } catch (e) { showError('The channel could not start.', e); return; }

  let rebuildTimer = 0;
  addEventListener('resize', () => {
    const next = computeLayout(innerWidth, innerHeight);
    const changed = next.wide !== L.wide || next.lh !== L.lh;
    L = next; sizeCanvas();
    if (!changed) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      try {
        const carry = ctx ? { data: ctx.data, tempUnit: ctx.tempUnit, windUnit: ctx.windUnit, locationID: ctx.locationID } : null;
        build(carry);
      } catch (e) { showError('The channel stopped because of an error.', e); }
    }, 200);
  });

  // Audio starts on the first user gesture (browser autoplay rules).
  let audioStarted = false;
  const startAudio = () => {
    if (audioStarted || !sound) return;
    audioStarted = true;
    try { const r = sound.startOutput(); if (r && r.catch) r.catch(e => console.warn('audio', e)); } catch (e) { console.warn('audio', e); }
  };
  addEventListener('pointerdown', startAudio, { capture: true });
  addEventListener('keydown', startAudio, { capture: true });

  // ── Input: mouse = Wii Remote, touch/pen = iPhone touch model, keyboard always ───────────────────────────────
  const touch = new TouchInput();
  let source = 'mouse';                       // which device drove the last input
  let held = 0, pulse = 0, keys = 0, pointer = [0, 0], pointerInside = false, scrollAccum = 0;
  const modeAt = p => (scene && typeof scene.touchMode === 'function' ? scene.touchMode(p) : TouchMode.pressOnRelease);
  const isMouse = e => e.pointerType === 'mouse';

  canvas.addEventListener('pointermove', e => {
    const t = toLogical(e.clientX, e.clientY);
    if (isMouse(e)) { source = 'mouse'; pointer = t.p; pointerInside = t.inside; }
    else touch.moved(e.pointerId, t.p);
  });
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const t = toLogical(e.clientX, e.clientY);
    if (isMouse(e)) {
      source = 'mouse'; pointer = t.p; pointerInside = t.inside;
      if (e.button === 0) held |= WPAD.a; else if (e.button === 2) held |= WPAD.b;
    } else { source = 'touch'; touch.began(e.pointerId, t.p, modeAt); }
  });
  canvas.addEventListener('pointerup', e => {
    if (isMouse(e)) { if (e.button === 0) held &= ~WPAD.a; else if (e.button === 2) held &= ~WPAD.b; }
    else { touch.moved(e.pointerId, toLogical(e.clientX, e.clientY).p); touch.ended(e.pointerId); }
  });
  canvas.addEventListener('pointercancel', e => { if (!isMouse(e)) touch.ended(e.pointerId, true); else held = 0; });
  canvas.addEventListener('pointerleave', e => { if (isMouse(e)) pointerInside = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (L.wide) {
      // ForecastMac: scrollingDeltaY · (precise ? 0.05 : 1) → one +/− pulse per notch
      scrollAccum += -e.deltaY * (e.deltaMode === 0 ? 0.05 : 1);
      if (scrollAccum > 1) { pulse |= WPAD.plus; scrollAccum = 0; } else if (scrollAccum < -1) { pulse |= WPAD.minus; scrollAccum = 0; }
    } else {
      touch.pending.pinch *= Math.exp(-e.deltaY * 0.002);   // portrait: wheel / trackpad = pinch
    }
  }, { passive: false });
  addEventListener('gesturestart', e => e.preventDefault());   // iOS Safari page zoom
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
  addEventListener('keydown', e => { const b = keyBit(e); if (b) { keys |= b; e.preventDefault(); } });
  addEventListener('keyup', e => { const b = keyBit(e); if (b) keys &= ~b; });
  addEventListener('blur', () => { held = 0; keys = 0; });

  // ── Frame loop: fixed 60 Hz game ticks, rendered once per animation frame ─────────────────────────────────
  const STEP = 1000 / 60;
  let last = performance.now(), acc = 0, failed = false;
  function tick() {
    if (source === 'mouse') {
      const s = new PointerSample(pointer, pointerInside, held | keys | pulse, 0);
      ctx.gestures = touch.gestures;
      ctx.pad.update(s);
    } else {
      const s = touch.sample();
      s.held |= keys | pulse;
      ctx.gestures = touch.gestures;
      ctx.pad.update(s);
    }
    pulse = 0;
    if (scene.wantsQuit && scene.canResume) {
      // "Wii Menu": there is no Wii Menu in a browser — fade back in on the hub.
      scene.resumeFromSuspend();
    } else if (scene.wantsQuit || scene.wantsSuspend) {
      // An error box's "Try Again": restart the channel (fresh download attempt).
      ctx.data = null;
      if (ctx.pendingData && ctx.pendingData.take) ctx.pendingData.take();
      scene = new WeatherScene(ctx);
      return;
    }
    scene.calc();
    // The system mouse pointer: a hand over buttons, grab hands on the globe.
    const c = source !== 'mouse' || !pointerInside ? 'default'
      : scene.cursorState === 2 ? 'grabbing' : ctx.ui.hovered ? 'pointer' : scene.cursorState === 1 ? 'grab' : 'default';
    if (canvas.style.cursor !== c) canvas.style.cursor = c;
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
      gx.beginFrame?.();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1); gl.clearDepth(1);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);   // the letterbox bars
      scene.render(viewport);
    } catch (e) {
      failed = true;
      showError('The channel stopped because of an error.', e);
    }
  }
  requestAnimationFrame(t => { last = t; frame(t); });
}

boot().catch(e => showError('Startup failed.', e));
