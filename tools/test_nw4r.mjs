// Track C self-test (node): parse every brlyt/brlan, the fonts, earth.brres, the cursor REFF/REFT, and render 5 s of
// the hub BGM with the ported nw4r::snd engine to WAV.
//   node tools/test_nw4r.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assets, Content } from '../js/forecast/system/Assets.js';
import { Layout } from '../js/nw4r/lyt/Layout.js';
import { LytAnimation } from '../js/nw4r/lyt/Animation.js';
import { TPLFile } from '../js/nw4r/lyt/TPL.js';
import { ResFont } from '../js/nw4r/ut/ResFont.js';
import { CharWriter } from '../js/nw4r/ut/CharWriter.js';
import { ResFile } from '../js/nw4r/g3d/ResFile.js';
import { G3DTexMtx } from '../js/nw4r/g3d/TexMtx.js';
import { CX } from '../js/rvl/CX.js';
import { EfEffectFile, EfTextureFile } from '../js/nw4r/ef/EfResource.js';
import { EfEffectSystem } from '../js/nw4r/ef/EfEffect.js';
import { EfDraw } from '../js/nw4r/ef/EfDraw.js';
import { SoundManager, SE } from '../js/forecast/sound/SoundManager.js';
import { SoundHandle } from '../js/nw4r/snd/SoundSystem.js';

const dir = path.join(os.homedir(), 'Library/Application Support/ForecastChannel');
const out = process.argv[2] ?? path.join(process.cwd(), '.qa');
fs.mkdirSync(out, { recursive: true });
const assets = new Assets(new Uint8Array(fs.readFileSync(path.join(dir, 'HAFE.wad'))), new Uint8Array(fs.readFileSync(path.join(dir, 'common-key.bin'))));
let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log('FAIL', msg); } };

// Layouts + animations
const arc = assets.weatherLayoutArchive();
let nL = 0, nA = 0, nT = 0;
for (const [p] of arc.files) {
  const d = arc.file(p);
  if (p.endsWith('.brlyt')) {
    const L = new Layout(d); nL++;
    ok(L.root && L.width > 0, p);
    L.root.calculate(null, 255);
    for (const m of L.materials) m.setupGX(true, 255);
  } else if (p.endsWith('.brlan')) { const a = new LytAnimation(d); nA++; ok(a.frameSize >= 0, p); a; }
  else if (p.endsWith('.tpl')) { const t = new TPLFile(d); nT++; ok(t.images.length > 0 && t.images[0].rgba8.length === t.images[0].width * t.images[0].height * 4, p); }
}
console.log(`layouts ${nL}, animations ${nA}, TPLs ${nT}`);
// BRLANs: the weather layouts have none (animated in code); parse the HOME Menu archive's as a parser test only.
{
  const hbm = assets.hbmArchive('');
  let lyt = null;
  for (const [p] of hbm.files) {
    if (p.endsWith('.brlan')) { const an = new LytAnimation(hbm.file(p)); nA++; ok(an.frameSize > 0, p); if (lyt) an.apply(lyt, 1); }
    else if (p.endsWith('.brlyt') && !lyt) lyt = new Layout(hbm.file(p));
  }
  console.log(`HBM brlan parsed: ${nA}`);
}

// Fonts
for (const name of ['font_weather.brfnt', 'font_weather_city.brfnt', 'font_weather_time.brfnt', 'font_weather_timeWW.brfnt']) {
  const f = assets.font(name);
  ok(f instanceof ResFont, name);
  if (f) {
    const s = f.sheet(f.glyph(0x41).sheet);
    ok(s.length === f.sheetWidth * f.sheetHeight * 4, name + ' sheet');
    const q = CharWriter.layout([0x48, 0x69], f, [24, 28], 0, 0, [200, 40], 4, 0, [255, 255, 255, 255], [255, 255, 255, 255]);
    ok(q.length === 2, name + ' layout');
    CharWriter.setupGX(f.sheetFormat, [0, 0, 0, 0], [255, 255, 255, 255]);
    console.log(`font ${name}: ${f.sheetCount} sheets ${f.sheetWidth}x${f.sheetHeight} fmt ${f.sheetFormat}, 'A' sheet ${f.glyph(0x41).sheet}`);
  }
}
const sys = new ResFont(assets.archive(Content.systemFonts).find('wbf1.brfna'));
const g = sys.glyph(0x57);
const sheet = sys.sheet(g.sheet);
ok(sheet.some((v, i) => i % 4 === 3 && v > 0), 'wbf1 sheet has coverage');
console.log(`wbf1.brfna: ${sys.sheetCount} sheets, 'W' on sheet ${g.sheet} cell ${g.cellX},${g.cellY} width ${g.widths.charWidth}`);

// Earth BRRES
const lz = assets.archive(Content.earth).file('/earth.brres.LZ');
const rf = new ResFile(CX.uncompressIfNeeded(lz));
for (const [n, m] of rf.models) {
  console.log(`model ${n}: ${m.shapes.length} shapes, ${m.materials.length} materials, ${m.bones.length} bones, opa ${m.drawOpa.length}, xlu ${m.drawXlu.length}, verts ${m.shapes.reduce((s, x) => s + x.vertices.length / 26, 0)}`);
  for (const mat of m.materials) G3DTexMtx.srt(mat.srt[0], mat.texMtxMode, mat.srtFlags & 0xF);
}
for (const [n, t] of rf.textures) { ok(t.rgba8().length === t.width * t.height * 4, 'tex ' + n); }
console.log(`textures ${rf.textures.size}`);

// Cursor effects (content 9, like Cursor.swift)
{
  const w = assets.archive(Content.weather);
  const fx = new EfEffectSystem(new EfEffectFile(CX.uncompressIfNeeded(w.find('nw4r_defcursor_all01.breff.LZ'))),
    new EfTextureFile(CX.uncompressIfNeeded(w.find('nw4r_defcursor_all01.breft.LZ'))));
  const names = [...fx.effects.emitters.keys()];
  let pk = 0;
  for (const n of ['def_cursor_normal_sd', 'def_cursor_normal_1p', 'def_cursor_hold_1p', 'def_cursor_open_4p']) {
    const e = fx.createEffect(n);
    ok(e, 'effect ' + n);
    if (!e) continue;
    e.translate = [100, 200, 0];
    for (let f = 0; f < 3; f++) e.calc();
    for (const pm of e.particleManagers) for (const pkt of EfDraw.draw(pm, null, fx.textures)) { pk++; ok(pkt.quad.length === 4 && pkt.textures.length > 0, 'packet ' + n); }
  }
  console.log(`ef: ${names.length} emitters, ${fx.textures.textures.size} textures, packets ${pk}`);
  ok(pk > 0, 'ef packets');
}

// Sound: render 5 s of the hub BGM (SELF, morning) to WAV
const sm = new SoundManager(assets);
const h = new SoundHandle();
ok(sm.startSound(h, SE.bgmMorningSelf), 'start BGM');
const secs = 5, total = 32000 * secs;
const L = new Float32Array(total), R = new Float32Array(total);
let done = 0, next = 0;
while (done < total) {
  const c = Math.min(96, total - done);
  sm.system.render(c, L, R, done);
  done += c;
  if (done >= next) { sm.update(); next += 32000 / 60; }
}
let sum = 0, peak = 0;
for (let i = 0; i < total; i++) { sum += L[i] * L[i] + R[i] * R[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const rms = Math.sqrt(sum / (2 * total));
console.log(`BGM bgmMorningSelf: ${secs}s rms ${rms.toFixed(4)} peak ${peak.toFixed(3)}`);
ok(rms > 0.005, 'BGM audible');
const wav = Buffer.alloc(44 + total * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + total * 4, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(32000, 24); wav.writeUInt32LE(128000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) { wav.writeInt16LE(Math.round(L[i] * 32767), 44 + i * 4); wav.writeInt16LE(Math.round(R[i] * 32767), 46 + i * 4); }
fs.writeFileSync(path.join(out, 'js_bgm.wav'), wav);
// SEs
for (const id of [SE.comButton, SE.earthZoom1, SE.cancel]) { sm.playSE(id); ok(sm.seHandle.isAttached, 'SE ' + id); }
console.log(fail ? `${fail} FAILURES` : 'all ok');
process.exit(fail ? 1 : 0);
