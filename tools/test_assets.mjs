// Assets.js + track C parsers: layouts, textures, fonts, earth; every layout material's GX shader through glslang.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Assets } from '../js/forecast/system/Assets.js';
import { GXShaderGen } from '../js/gx/GXShaderGen.js';
const dir = process.argv[2] || path.join(os.homedir(), 'Library/Application Support/ForecastChannel');
const a = new Assets(new Uint8Array(fs.readFileSync(path.join(dir, 'HAFE.wad'))), new Uint8Array(fs.readFileSync(path.join(dir, 'common-key.bin'))));
let fail = 0; const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
a.validate(); ok(true, 'validate');
ok(a.dol().sections.length > 0, 'dol()');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcmat-'));
const seen = new Map();
for (const name of ['base.brlyt', 'forecast.brlyt', 'base_belt.brlyt', 'around.brlyt', 'day_nWW.brlyt', 'week_nWW.brlyt', 'set.brlyt', 'error0.brlyt']) {
  let L; try { L = a.layout(name); } catch (e) { ok(false, `${name}: ${e.message}`); continue; }
  const mats = L.materials || [];
  let n = 0;
  for (const m of mats) for (const modulate of [false, true]) {
    let st; try { st = m.setupGX(modulate, modulate ? 128 : 255); } catch (e) { ok(false, `${name}/${m.name} setupGX: ${e.message}`); continue; }
    const gx = st && st.numTevStages !== undefined ? st : (st && st.gx) || m.gx;
    if (!gx) continue;
    const key = GXShaderGen.pipelineKey(gx);
    if (seen.has(key)) continue;
    const { vs, fs: frag } = GXShaderGen.generate(gx);
    seen.set(key, `${name}/${m.name}`); n++;
    for (const [ext, src] of [['vert', vs], ['frag', frag]]) {
      const f = path.join(tmp, `${seen.size}.${ext}`); fs.writeFileSync(f, src);
      try { execFileSync('glslangValidator', [f], { stdio: 'pipe' }); } catch (e) { ok(false, `${name}/${m.name}.${ext}: ${String(e.stdout).slice(0, 400)}`); }
    }
  }
  ok(mats.length > 0, `${name}: ${mats.length} materials, ${n} new shader variants`);
  for (const tn of (L.textureNames || []).slice(0, 3)) ok(!!a.layoutTexture(tn), `  texture ${tn}`);
}
ok(seen.size > 0, `${seen.size} distinct shader variants compiled with glslang`);
for (const f of ['font_weather.brfnt', 'font_weather_city.brfnt', 'font_weather_timeWW.brfnt']) ok(!!a.font(f), `font ${f}`);
ok(!!a.systemFont(), 'systemFont wbf1');
let earth; try { earth = a.earthBRRES(); } catch (e) { ok(false, 'earthBRRES ' + e.message); }
ok(!!earth, 'earthBRRES');
console.log(fail ? `${fail} FAILED` : 'all ok'); process.exit(fail ? 1 : 0);
