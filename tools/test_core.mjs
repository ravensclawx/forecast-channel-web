// Track A core test (node): decrypt the visitor's WAD with the common key, open the archives, decode TPLs,
// generate GX shaders. Usage: node tools/test_core.mjs [dir-with-HAFE.wad-and-common-key.bin]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ESTitle } from '../js/rvl/ES.js';
import { CX, CXHuffman } from '../js/rvl/CX.js';
import { ARCArchive } from '../js/rvl/ARC.js';
import { DOLImage } from '../js/rvl/DOL.js';
import { BEReader } from '../js/rvl/BinaryReader.js';
import { GXTextureDecoder, GXTexFmt } from '../js/gx/GXTexture.js';
import { GXState, GXTevColorArg as C, GXTevAlphaArg as A } from '../js/gx/GXAPI.js';
import { GXShaderGen } from '../js/gx/GXShaderGen.js';
import * as mat from '../js/gx/mat.js';

const dir = process.argv[2] || path.join(os.homedir(), 'Library/Application Support/ForecastChannel');
const wad = new Uint8Array(fs.readFileSync(path.join(dir, 'HAFE.wad')));
const key = new Uint8Array(fs.readFileSync(path.join(dir, 'common-key.bin')));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

let t0 = performance.now();
const title = new ESTitle(wad, key);
ok(title.titleIDHex === '0001000248414645', `title ${title.titleIDHex} v${title.titleVersion}, ${title.contents.length} contents`);
const dolBytes = title.content(1);
ok(dolBytes.length > 0x100000, `main.dol decrypted + SHA-1 verified (${dolBytes.length} bytes, ${(performance.now() - t0).toFixed(0)} ms)`);
const dol = new DOLImage(dolBytes);
ok(dol.sections.length > 3 && dol.offset(0x80004000) !== null, `DOL sections: ${dol.sections.length}`);

t0 = performance.now();
const weather = title.archive(9);
ok(weather.files.size > 5, `content 9 U8: ${[...weather.files.keys()].slice(0, 6).join(', ')} …`);
const lz = weather.find('weather_layout.arc.LZ');
const layoutArc = new ARCArchive(CX.uncompressIfNeeded(lz));
ok(layoutArc.file('/arc/blyt/forecast.brlyt') !== null, `weather_layout.arc: ${layoutArc.files.size} files (${(performance.now() - t0).toFixed(0)} ms)`);
const brlyt = layoutArc.file('/arc/blyt/base.brlyt');
ok(new BEReader(brlyt).magic(0) === 'RLYT', 'base.brlyt magic RLYT');

// TPL decode (minimal TPL header walk, same as nw4r/lyt/TPL)
function decodeTPL(bytes) {
  const r = new BEReader(bytes);
  if (r.u32(0) !== 0x0020AF30) throw new Error('not TPL');
  const n = r.u32(4), table = r.u32(8), out = [];
  for (let i = 0; i < n; i++) {
    const ih = r.u32(table + i * 8), ph = r.u32(table + i * 8 + 4);
    const h = r.u16(ih), w = r.u16(ih + 2), fmt = r.u32(ih + 4), data = r.u32(ih + 8);
    let palette = [], palFmt = 2;
    if (ph) { const count = r.u16(ph); palFmt = r.u32(ph + 4); const pd = r.u32(ph + 8); for (let k = 0; k < count; k++) palette.push(r.u16(pd + k * 2)); }
    out.push({ w, h, fmt, rgba: GXTextureDecoder.decode(bytes, data, w, h, fmt, palette, palFmt) });
  }
  return out;
}
const fmts = new Map();
let tplCount = 0, nonEmpty = 0;
for (const [p] of layoutArc.files) {
  if (!p.startsWith('/arc/timg/')) continue;
  const imgs = decodeTPL(layoutArc.file(p));
  for (const im of imgs) {
    tplCount++;
    fmts.set(im.fmt, (fmts.get(im.fmt) || 0) + 1);
    if (im.rgba.length === im.w * im.h * 4 && im.rgba.some(v => v !== 0)) nonEmpty++;
  }
}
ok(tplCount >= 20 && nonEmpty === tplCount, `decoded ${tplCount} layout TPL images, all non-empty; formats ${[...fmts].map(([f, c]) => `${Object.keys(GXTexFmt).find(k => GXTexFmt[k] === f)}×${c}`).join(' ')}`);

// TPLWeather / TPLCommon (sprite sheets in content 9)
for (const name of ['TPLWeather.tpl.LZ', 'TPLCommon.tpl.LZ']) {
  const d = weather.find(name);
  if (!d) { ok(false, name + ' missing'); continue; }
  const imgs = decodeTPL(CX.uncompressIfNeeded(d));
  ok(imgs.length > 10, `${name}: ${imgs.length} images`);
}

// earth.brres (content 8), system font (content 7, RFNA with Huffman/LZ sheets)
const earth = title.archive(8).file('/earth.brres.LZ');
ok(new BEReader(CX.uncompressIfNeeded(earth)).magic(0) === 'bres', 'earth.brres decompressed (bres)');
const wbf1 = title.archive(7).find('wbf1.brfna');
ok(wbf1 && new BEReader(wbf1).magic(0) === 'RFNA', `wbf1.brfna (${wbf1 && wbf1.length} bytes)`);
{
  // first compressed glyph sheet of the RFNA decodes through CXHuffman or CX LZ
  const r = new BEReader(wbf1);
  let finf = r.u16(0xC);
  while (finf + 8 <= wbf1.length && r.magic(finf) !== 'FINF') finf += r.u32(finf + 4);
  const tglp = r.u32(finf + 0x10) - 8;
  const compressed = (r.u16(tglp + 18) & 0x8000) !== 0;
  const image = r.u32(tglp + 28), n = r.u32(image), stream = wbf1.subarray(image + 4, image + 4 + n);
  const raw = (stream[0] & 0xF0) === 0x20 ? CXHuffman.uncompress(stream) : CX.uncompressLZ(stream);
  ok(compressed && raw.length >= r.u32(tglp + 12), `RFNA sheet 0 decompressed (${raw.length} ≥ ${r.u32(tglp + 12)})`);
}

// Shader generation: representative states (lyt default TEV, 2-texture blend, konst, indirect, alpha test, globe texgen)
function lytDefault(nTex) {
  const s = new GXState();
  s.setNumChans(1); s.setNumTexGens(nTex); s.setNumTevStages(Math.max(nTex, 1));
  s.setChanCtrl(GXState.color0a0, false, 0, 1);
  for (let i = 0; i < nTex; i++) s.setTexCoordGen(i, 1, 4 + i, false, 125);
  s.setTevOrder(0, nTex ? 0 : 0xFF, nTex ? 0 : 0xFF, 4);
  s.setTevSwapModeTable(0, 0, 1, 2, 3);
  s.setTevColorIn(0, C.c0, C.c1, nTex ? C.texc : C.rasc, C.zero);
  s.setTevAlphaIn(0, A.a0, A.a1, nTex ? A.texa : A.rasa, A.zero);
  s.setTevColorOp(0, 0, 0, 0, true, 0); s.setTevAlphaOp(0, 0, 0, 0, true, 0);
  s.setBlendMode(1, 4, 5, 0); s.setAlphaCompare(7, 0, 0, 7, 0);
  return s;
}
const states = { lyt0: lytDefault(0), lyt1: lytDefault(1) };
{
  const s = lytDefault(2); s.setNumTevStages(2);
  s.setTevOrder(1, 1, 1, 0xFF); s.setTevColorIn(1, C.cprev, C.texc, C.konst, C.zero); s.setTevAlphaIn(1, A.zero, A.aprev, A.texa, A.zero);
  s.setTevKColorSel(1, 0x1C); s.setTevKAlphaSel(1, 0x1C); s.setTevColorOp(1, 0, 0, 0, true, 0); s.setTevAlphaOp(1, 0, 0, 0, true, 0);
  s.setAlphaCompare(4, 10, 0, 7, 0);
  states.blend2 = s;
}
{
  const s = lytDefault(2); s.setNumIndStages(1);
  s.bp[0x27] = (1 | (1 << 3)) >>> 0;        // ind stage 0: map 1, coord 1
  s.bp[0x10] = (0 | (1 << 9) | (3 << 4)) >>> 0;  // stage 0 uses ind stage 0, matrix 0, bias xy
  s.setIndMatrix(0, [0.5, 0, 0], [0, 0.5, 0], 1);
  states.indirect = s;
}
{
  const s = lytDefault(1); s.setTevColorIn(0, C.zero, C.texc, C.rasc, C.zero); s.setTevColorOp(0, 8, 0, 0, true, 0); // compare GT r8
  states.compare = s;
}
let shaderChars = 0;
for (const [name, s] of Object.entries(states)) {
  const { vs, fs } = GXShaderGen.generate(s);
  shaderChars += vs.length + fs.length;
  const balanced = src => (src.match(/\{/g) || []).length === (src.match(/\}/g) || []).length && (src.match(/\(/g) || []).length === (src.match(/\)/g) || []).length;
  ok(vs.startsWith('#version 300 es') && fs.includes('fragColor =') && balanced(vs) && balanced(fs) && !/\bin\./.test(fs + vs) && !/int[234]\(/.test(fs + vs),
     `shader ${name}: vs ${vs.length} B, fs ${fs.length} B, key ${GXShaderGen.pipelineKey(s).length} chars`);
}
// Real GLSL ES 3.00 compile when glslangValidator is installed (brew install glslang).
{
  const { execFileSync } = await import('node:child_process');
  let have = true; try { execFileSync('glslangValidator', ['--version'], { stdio: 'ignore' }); } catch { have = false; }
  if (have) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcgl-'));
    for (const [name, s] of Object.entries(states)) {
      const { vs, fs: frag } = GXShaderGen.generate(s);
      for (const [ext, src] of [['vert', vs], ['frag', frag]]) {
        const f = path.join(tmp, `${name}.${ext}`); fs.writeFileSync(f, src);
        let out = '', good = true;
        try { execFileSync('glslangValidator', [f], { encoding: 'utf8' }); } catch (e) { good = false; out = (e.stdout || '') + (e.stderr || ''); }
        ok(good, `glslang compiles ${name}.${ext}${good ? '' : '\n' + out}`);
      }
    }
  } else console.log('skip glslang (not installed)');
}
fs.writeFileSync('/tmp/fc_shader_lyt1.glsl', Object.values(GXShaderGen.generate(states.lyt1)).join('\n// ---- fragment ----\n'));
fs.writeFileSync('/tmp/fc_shader_indirect.glsl', GXShaderGen.generate(states.indirect).fs);
const vu = GXShaderGen.vertexUniforms(mat.orthoGL(0, 608, 0, 456, -1, 1), mat.identity(), [], [], states.lyt1);
const fu = GXShaderGen.fragmentUniforms(states.lyt1, [[64, 32]]);
ok(vu.length === 248 && fu.length === 132 && fu[8 * 4] === 64 && fu[16 * 4] === 64, 'uniform packing (vs 62×vec4, fs 33×ivec4, coordDims follows texmap)');

// mat sanity
const m = mat.mul(mat.translate(1, 2, 3), mat.scale(2, 2, 2));
ok(JSON.stringify(mat.transformPoint(m, [1, 1, 1])) === JSON.stringify([3, 4, 5]), 'mat.mul/translate/scale');
ok(Math.abs(mat.transformPoint(mat.rotZ(Math.PI / 2), [1, 0, 0])[1] - 1) < 1e-6, 'mat.rotZ right-handed');
ok(mat.transformPoint(mat.mul(mat.invert(m), m), [5, 6, 7]).every((v, i) => Math.abs(v - [5, 6, 7][i]) < 1e-5), 'mat.invert');

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
