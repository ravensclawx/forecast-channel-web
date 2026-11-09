// App shell — an authentic port of the Wii Forecast Channel (replaces ForecastMac/main.swift).
//
// Always the original widescreen channel: 832×456 logical, letterboxed 16:9 in the window (the picture scales with the
// window; the layout never changes). The mouse is the Wii Remote: pointer with the channel's own IR smoothing, the
// animated Wii hand cursor (nw4r::ef), left button = A, right button = B, wheel = +/−; keyboard: arrows = d-pad,
// Enter = A, Esc = B, =/- = +/−, 1/2. No HOME Menu. "Wii Menu" fades back in on the hub (there is no Wii Menu here).
import { Storage } from './forecast/system/Storage.js';
import { LogicalScreen } from './forecast/render/LogicalScreen.js';
import { PointerSample, WPAD } from './forecast/system/KPad.js';
import { ESTitle } from './rvl/ES.js';

const canvas = document.getElementById('screen');
const setupEl = document.getElementById('setup');
const overlayEl = document.getElementById('overlay');
const overlayText = document.getElementById('overlay-text');
const replaceBtn = document.getElementById('replace-files');
const HAFE = '0001000248414645';
const params = new URLSearchParams(location.search);
const LW = 832, LH = 456;
LogicalScreen.isPortrait = false;
LogicalScreen.height = LH;
LogicalScreen.safeTop = 0; LogicalScreen.safeBottom = 0;
document.body.classList.add('desktop');

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

// ── Letterbox: the 16:9 picture centred in the window ──────────────────────────────────────────────────────
let box = { left: 0, top: 0, width: 1, height: 1 }, viewport = { originX: 0, originY: 0, width: 1, height: 1 };
function sizeCanvas() {
  const W = innerWidth, H = innerHeight, dpr = Math.min(devicePixelRatio || 1, 3);
  let w = W, h = W * 9 / 16;
  if (h > H) { h = H; w = H * 16 / 9; }
  box = { left: Math.round((W - w) / 2), top: Math.round((H - h) / 2), width: Math.round(w), height: Math.round(h) };
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  viewport = { originX: Math.round(box.left * dpr), originY: Math.round(box.top * dpr), width: Math.round(box.width * dpr), height: Math.round(box.height * dpr) };
}
function toLogical(clientX, clientY) {
  const x = (clientX - box.left) / box.width * LW, y = (clientY - box.top) / box.height * LH;
  return { p: [x, y], inside: x >= 0 && y >= 0 && x <= LW && y <= LH };
}

// ── Boot ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  sizeCanvas();
  addEventListener('resize', sizeCanvas);
  // The channel's assets ship with the site (assets/content_<n>.bin, extracted by tools/extract_assets.mjs).
  // Fallback: the visitor's own WAD + key (the setup screen) if they're missing.
  let bundled = null;
  try {
    const ids = [1, 6, 7, 8, 9];
    const rs = await Promise.all(ids.map(i => fetch(`assets/content_${i}.bin`)));
    if (rs.every(r => r.ok)) {
      bundled = {};
      const bufs = await Promise.all(rs.map(r => r.arrayBuffer()));
      ids.forEach((id, k) => { bundled[id] = new Uint8Array(bufs[k]); });
    }
  } catch {}
  const { wad, key } = bundled ? {} : await loadOrAskFiles();

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
  try { ({ CursorDraw: Cursor } = await import('./forecast/ui/CursorDraw.js')); } catch (e) { console.warn('cursor unavailable', e); }

  let assets, ctx, scene, sound = null, cursor = null;
  try {
    assets = bundled ? Assets.fromContents(bundled) : new Assets(wad, key);
    if (SoundManager) { try { sound = new SoundManager(assets); } catch (e) { console.warn('SoundManager failed', e); } }
    const gx = new GXWebGL(gl);
    ctx = new SceneContext({ assets, gx, sound, isWide: true });
    ctx.pad.smoothPointer = true;   // the channel's KPAD pointer smoothing (fn_8002F9CC)
    scene = new WeatherScene(ctx);
    if (Cursor) { try { cursor = new Cursor(assets, ctx.lyt); } catch (e) { console.warn('Cursor failed', e); } }
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

  // ── Input: ForecastMac's mapping ─────────────────────────────────────────────────────────────────────────────
  let held = 0, pulse = 0, pointer = [LW / 2, LH / 2], pointerInside = false, scrollAccum = 0;
  const track = e => { const t = toLogical(e.clientX, e.clientY); pointer = t.p; pointerInside = t.inside; };
  canvas.addEventListener('pointermove', track);
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); track(e);
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    if (e.button === 0) held |= WPAD.a; else if (e.button === 2) held |= WPAD.b;
  });
  canvas.addEventListener('pointerup', e => { if (e.button === 0) held &= ~WPAD.a; else if (e.button === 2) held &= ~WPAD.b; });
  canvas.addEventListener('pointerleave', () => { pointerInside = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    scrollAccum += -e.deltaY * (e.deltaMode === 0 ? 0.05 : 1);   // scrollingDeltaY · (precise ? 0.05 : 1)
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
  // The OS pointer is hidden over the picture: the Wii hand cursor is drawn instead.
  canvas.style.cursor = cursor ? 'none' : 'default';

  // ── Frame loop: fixed 60 Hz game ticks, rendered once per animation frame ─────────────────────────────────
  const STEP = 1000 / 60;
  let last = performance.now(), acc = 0, failed = false;
  function tick() {
    ctx.pad.update(new PointerSample(pointer, pointerInside, held | pulse, 0));
    pulse = 0;
    if (scene.wantsQuit && scene.canResume) {
      scene.resumeFromSuspend();          // "Wii Menu": no Wii Menu in a browser — back to the hub
    } else if (scene.wantsQuit || scene.wantsSuspend) {
      ctx.data = null;                    // an error box's button: restart the channel (fresh download attempt)
      if (ctx.pendingData && ctx.pendingData.take) ctx.pendingData.take();
      scene = new WeatherScene(ctx);
      return;
    }
    scene.calc();
    if (sound) sound.update();            // fn_80041F54, once per game frame
  }
  function frame(now) {
    if (failed) return;
    requestAnimationFrame(frame);
    acc += Math.min(now - last, 250); last = now;
    try {
      let steps = 0;
      while (acc >= STEP && steps < 4) { tick(); acc -= STEP; steps++; }
      if (steps === 4) acc = 0;
      ctx.gx.beginFrame?.();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1); gl.clearDepth(1);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);   // the letterbox bars
      scene.render(viewport);
      if (cursor && pointerInside) {
        // Overlay pass: the cursor (CErrorSystem draws after the scene).
        const enc = ctx.gx.beginPass(null, { clearColor: null, clearDepth: true });
        enc.setViewport(viewport);
        cursor.state = scene.cursorState;
        cursor.draw(ctx.lyt, enc, ctx.pad.pointer, ctx.pad.twist, LW);
        enc.endEncoding();
      }
    } catch (e) {
      failed = true;
      showError('The channel stopped because of an error.', e);
    }
  }
  requestAnimationFrame(t => { last = t; frame(t); });
}

// ── Full screen: F toggles ─────────────────────────────────────────────────────────────────────────────────────
addEventListener('keydown', e => {
  if ((e.key !== 'f' && e.key !== 'F') || e.metaKey || e.ctrlKey || e.altKey || !setupEl.hidden) return;
  const root = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  else { const r = (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root); r?.catch?.(() => {}); }
});

boot().catch(e => showError('Startup failed.', e));
