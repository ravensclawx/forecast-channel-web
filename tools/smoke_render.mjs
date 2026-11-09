// Node smoke test of track B renderers with a stub WebGL2 context and the WAD/key from ~/Library/Application Support/ForecastChannel (dev machine only): node tools/smoke_render.mjs
import fs from 'node:fs';
import os from 'node:os';
const dir = os.homedir() + '/Library/Application Support/ForecastChannel/';
const { Assets } = await import('../js/forecast/system/Assets.js');
const { GXWebGL } = await import('../js/forecast/render/GXWebGL.js');
const { LytRenderer } = await import('../js/forecast/render/LytRenderer.js');
const { G3DRenderer } = await import('../js/forecast/render/G3DRenderer.js');
const { SceneFrame } = await import('../js/forecast/render/SceneFrame.js');
const { SceneDraw2D } = await import('../js/forecast/scene/address/SceneDraw2D.js');
const { StarField } = await import('../js/forecast/game/StarField.js');
const { GlobeCamera } = await import('../js/forecast/game/GlobeCamera.js');
const { LogicalScreen } = await import('../js/forecast/render/LogicalScreen.js');
// Stub WebGL2: every call recorded; status queries succeed.
const counts = {};
let shaders = 0, draws = 0, uploads = 0;
const gl = new Proxy({ drawingBufferWidth: 1664, drawingBufferHeight: 912 }, {
  get(t, p) {
    if (p in t) return t[p];
    if (typeof p === 'string' && p === p.toUpperCase()) return p;   // constants
    return (...a) => {
      counts[p] = (counts[p] || 0) + 1;
      if (p === 'getShaderParameter' || p === 'getProgramParameter') return true;
      if (p === 'shaderSource') shaders++;
      if (p === 'drawArrays' || p === 'drawElements') draws++;
      if (p === 'texImage2D') uploads++;
      if (p === 'getError') return 0;
      if (p.startsWith('create') || p === 'getUniformLocation') return { id: p };
      return undefined;
    };
  }
});
const assets = new Assets(new Uint8Array(fs.readFileSync(dir + 'HAFE.wad')), new Uint8Array(fs.readFileSync(dir + 'common-key.bin')));
for (const [portrait, H, W] of [[false, 456, 832], [true, 1322, 608]]) {
  LogicalScreen.isPortrait = portrait; LogicalScreen.height = H;
  const gx = new GXWebGL(gl), lyt = new LytRenderer(gx);
  lyt.textureProvider = n => assets.layoutTexture(n); lyt.fontProvider = n => assets.font(n);
  const d2 = new SceneDraw2D(gx, lyt, W);
  const frame = new SceneFrame(gx); frame.ensure(1664, 912);
  gx.beginFrame();
  const enc = frame.beginScene();
  const adj = portrait ? null : [1 / 1.3684211, 1];
  for (const n of ['base.brlyt', 'forecast.brlyt', 'base_belt.brlyt', 'day_nWW.brlyt', 'week_nWW.brlyt', 'around.brlyt', 'set.brlyt', 'error0.brlyt'])
    lyt.draw(assets.layout(n), enc, 608, undefined, adj);
  const earth = new G3DRenderer(gx, assets.earthBRRES(), 'earth');
  const cam = new GlobeCamera(!portrait); cam.initialize([35, -90, 0]); cam.calc();
  const sc = G3DRenderer.Scene(); sc.view = cam.viewMtx; sc.projection = cam.projMtx; sc.cameras = { 0: cam.viewMtx };
  earth.draw(enc, sc);
  const stars = new StarField(gx, assets); stars.update(0, 0); stars.draw(enc, cam.viewMtx, W / 456, 40);
  d2.fillRect(0, 0, W, H, [0, 0, 0, 128], enc);
  const font = assets.systemFont();
  d2.text([0x48, 0x69], font, 100, 100, [1, 1], [255, 255, 255, 255], undefined, undefined, true, enc);
  frame.capture();
  const out = frame.beginPresent({ originX: 0, originY: 0, width: 1664, height: 912 });
  d2.texture(frame.frameTexture, 0, 0, W, H, [0, 0, 1, 1], 255, out);
  if (!portrait) {
    try {
      const { CursorDraw: Cursor } = await import('../js/forecast/ui/CursorDraw.js');
      const c = new Cursor(assets, lyt);
      for (const st of [0, 1, 2, 4]) { c.state = st; c.draw(lyt, out, [400, 200], 15, W); }
      console.log('cursor ok');
    } catch (e) { console.log('cursor:', e.message.split('\n')[0]); }
  }
  console.log(`${portrait ? 'portrait' : 'wide'}: programs=${shaders / 2} draws=${draws} uploads=${uploads}`);
}
