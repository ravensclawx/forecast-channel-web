// Data-layer tests (node): `node tools/test_data.mjs`
//  1. Open-Meteo fixture (3 cities) → ForecastGenerator.build → forecast.bin/short.bin → validate + parse back.
//  2. Parse the Swift-generated cache (~/Library/Application Support/ForecastChannel/wc24dl) with the JS parser.
//  3. Byte parity with Swift: ForecastWriter(parse(swift file)) == swift file; WC24Container.wrap(payload) == swift
//     container (LZ10 encoder); container unwrap round trip.
//  4. ForecastService with an in-memory store: cache, clearStale (6 h rule), loadForBoot.
//  5. SaveData round trip + CRC.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForecastFile, ShortFile, WeatherData, ForecastValidator, WC24Time, LocationID } from '../js/forecast/data/ForecastFormat.js';
import { ForecastGenerator } from '../js/forecast/data/ForecastGenerator.js';
import { OpenMeteo } from '../js/forecast/data/OpenMeteo.js';
import { ForecastWriter, ForecastWriterCommon } from '../js/forecast/data/ForecastWriter.js';
import { WC24Container } from '../js/forecast/data/WC24Container.js';
import { WeatherCodes } from '../js/forecast/data/WeatherCodes.js';
import { CityList } from '../js/forecast/data/CityList.js';
import { ForecastService } from '../js/forecast/data/ForecastService.js';
import { MemoryKV, setDefaultStore } from '../js/forecast/data/KVStore.js';
import { SaveData } from '../js/forecast/scene/SaveData.js';
import { nearestHomeCity } from '../js/forecast/data/Geolocation.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
setDefaultStore(new MemoryKV());

// 1. fixture → generator → parse
{
  const json = readFileSync(join(here, 'fixtures/openmeteo_3cities.json'), 'utf8');
  const data = OpenMeteo.parse(json, 3);
  ok(data.length === 3 && data[0].daily.length === 10 && data[0].hourly.length === 240, 'Open-Meteo fixture parsed (3 cities, 10 days, 240 h)');
  const pick = (name, region) => CityList.all.find(c => c.name === name && (region == null || c.region === region));
  const cities = [pick('Chicago', 'Illinois'), pick('Jackson', 'Mississippi'), pick('London', null)];
  ok(cities.every(Boolean), `fixture cities in catalog: ${cities.map(c => c?.name).join(', ')}`);
  const gen = new ForecastGenerator(cities);
  const now = new Date();
  const out = gen.build(data, now);
  const v = ForecastValidator.validate(out.forecast, out.short, WC24Time.minutes(now), 1, 1);
  ok(v.ok && v.forecast === 0 && v.short === 0, `generated files validate (${v})`);
  const wd = new WeatherData(out.forecast, out.short, { now });
  ok(wd.forecast.longForecasts.length === 2 && wd.forecast.summaries.length === 1 && wd.forecast.places.length === 3, 'long=2 summary=1 places=3');
  const chi = wd.forecast.places.find(p => p.city === 'Chicago');
  const chiLong = wd.forecast.longForecasts.find(l => l.location.raw === chi.id.raw);
  const expHigh = Math.round(data[0].daily[1].tempMax);
  ok(chiLong.today.highC === expHigh, `Chicago today high ${chiLong.today.highC}°C == Open-Meteo ${data[0].daily[1].tempMax}`);
  ok(chiLong.week.length === 7 && wd.forecast.weatherName(chiLong.today.weather) != null, `Chicago 7-day + weather name "${wd.forecast.weatherName(chiLong.today.weather)}"`);
  ok(Math.abs(chi.latitudeDegrees - 41.85) < 0.01, `Chicago latitude ${chi.latitudeDegrees.toFixed(3)}`);
  ok(chiLong.time.utcOffsetMinutes === -360, `Chicago UTC offset ${chiLong.time.utcOffsetMinutes} min`);
  ok(wd.short.current.length === 3, 'short.bin: 3 current entries');
  const ids = wd.forecast.places.map(p => p.id.raw);
  ok(ids.every((v, i) => i === 0 || ids[i - 1] < v), 'places sorted by location ID');
  // container round trip
  const c = out.forecastContainer;
  ok(eqBytes(WC24Container.unwrap(c), out.forecast), `container round trip (${out.forecast.length} → ${c.length} B)`);
}

// 2 + 3. Swift cache files
const dir = join(homedir(), 'Library/Application Support/ForecastChannel/wc24dl');
const fPath = join(dir, '1_049_forecast.bin'), sPath = join(dir, '1_049_short.bin');
if (existsSync(fPath) && existsSync(sPath)) {
  const fc = new Uint8Array(readFileSync(fPath)), sc = new Uint8Array(readFileSync(sPath));
  const f = WC24Container.unwrap(fc), s = WC24Container.unwrap(sc);
  const wd = new WeatherData(f, s, { allowExpired: true });
  const ff = wd.forecast;
  ok(ff.places.length === CityList.all.length, `Swift cache: ${ff.places.length} places (catalog ${CityList.all.length}), ${ff.longForecasts.length} long, ${ff.summaries.length} summary, ${wd.short.current.length} current`);
  const jackson = ff.place(0x31190001);
  ok(jackson?.city === 'Jackson' && jackson.region === 'Mississippi', `Swift cache: 31190001 = ${jackson?.city}, ${jackson?.region}`);
  const jl = ff.longForecasts.find(l => l.location.raw === 0x31190001);
  console.log(`     Jackson today ${jl.today.highF}°F/${jl.today.lowF}°F "${ff.weatherName(jl.today.weather)}", week[0] ${jl.week[0].highF}°F`);
  // location IDs match the JS generator's assignment for the same catalog
  const ids = new ForecastGenerator().locationIDs();
  const byName = new Map(CityList.all.map((c, i) => [ids[i].raw, c]));
  ok(ff.places.every(p => byName.get(p.id.raw)?.name === p.city), 'JS locationIDs() match the Swift-generated place table');
  // writer parity: re-serialize the parsed Swift file
  const hdr = ff.header;
  const common = new ForecastWriterCommon({ issued: hdr.issued, expires: hdr.expires, countryCode: hdr.countryCode, language: hdr.language, regionFlag: hdr.regionFlag });
  const f2 = ForecastWriter.forecastBin(common, { long: ff.longForecasts, summaries: ff.summaries, weatherTypes: ff.weatherTypes,
    uv: ff.uvIndex, laundry: ff.laundryIndex, pollen: ff.pollenIndex, places: ff.places });
  ok(eqBytes(f2, f), `ForecastWriter re-serializes the Swift forecast.bin byte-for-byte (${f.length} B)`);
  const s2 = ForecastWriter.shortBin(new ForecastWriterCommon({ issued: wd.short.header.issued, expires: wd.short.header.expires }), wd.short.current);
  ok(eqBytes(s2, s), `ForecastWriter re-serializes the Swift short.bin byte-for-byte (${s.length} B)`);
  ok(eqBytes(WC24Container.wrap(f), fc), `LZ10 + container identical to Swift (${fc.length} B)`);
  ok(eqBytes(WC24Container.wrap(s), sc), `short container identical to Swift (${sc.length} B)`);
  // weather-type table identical to the generator's
  const wt = WeatherCodes.table;
  ok(wt.length === ff.weatherTypes.length && wt.every((t, i) => t.code === ff.weatherTypes[i].code && t.name === ff.weatherTypes[i].name), 'WeatherCodes.table matches the Swift table');
  // ranks: the Swift cache predates generator v2 ranks or not — just report
  const chi = ff.places.find(p => p.city === 'Chicago' && p.region === 'Illinois');
  const r = ForecastGenerator.rank(CityList.all.find(c => c.name === 'Chicago' && c.region === 'Illinois'));
  console.log(`     Chicago rank: Swift cache zoom1=${chi.zoom1}, JS rank()=${r[0]}`);
} else console.log('skip: no Swift cache at', dir);

// 4. ForecastService (no network: offline → fallbacks)
{
  const store = new MemoryKV();
  const svc = new ForecastService({ store });
  ok((await svc.cached()) === null, 'service: empty cache → null');
  ok(await svc.needsRefresh(), 'service: needsRefresh with no cache');
  // seed the store with the fixture build
  const json = readFileSync(join(here, 'fixtures/openmeteo_3cities.json'), 'utf8');
  const cities = ['Chicago', 'Jackson', 'London'].map((n, i) => CityList.all.find(c => c.name === n && (i === 2 || c.isHome)));
  const out = new ForecastGenerator(cities).build(OpenMeteo.parse(json, 3));
  await store.put(svc.cacheKey, { forecast: out.forecastContainer, short: out.shortContainer, time: Date.now(), version: ForecastService.generatorVersion });
  const c = await svc.cached();
  ok(c?.forecast.places.length === 3, 'service: cached() parses the stored containers');
  ok(!(await svc.needsRefresh()), 'service: fresh cache needs no refresh');
  ok((await svc.clearStale()) === false && (await svc.cached()) !== null, 'service: clearStale keeps a fresh cache');
  ok((await svc.clearStale({ now: Date.now() + 6 * 3600 * 1000 + 1 })) === true && (await svc.cached()) === null, 'service: clearStale deletes after 6 h');
  ForecastService.offline = true;
  let threw = null;
  try { await svc.loadForBoot(); } catch (e) { threw = e; }
  ok(threw?.offline && ForecastService.nwc24Code(threw) === -9, 'service: no cache + offline → throws (nwc24 -9)');
  await store.put(svc.cacheKey, { forecast: out.forecastContainer, short: out.shortContainer, time: Date.now() - 7 * 3600 * 1000, version: 2 });
  const b = await svc.loadForBoot(() => {});
  ok(b?.forecast.places.length === 3, 'service: stale cache returned immediately by loadForBoot');
  await new Promise(r => setTimeout(r, 10));
  ForecastService.offline = false;
}

// 5. SaveData
{
  const [r0] = await SaveData.load();
  ok(r0 === SaveData.LoadResult.noFile, 'save: noFile initially');
  const sd = new SaveData({ country: 49 << 24 >>> 0, location: 0x31190001, tempUnit: 1, windUnit: 0 });
  ok((await sd.store()) === 0, 'save: store ok');
  const [r1, back] = await SaveData.load();
  ok(r1 === 0 && back.equals(sd) && back.country === 0x31000000, 'save: load round trip (country 0x31000000)');
  // compare with the Swift-written save if present
  const real = join(homedir(), 'Library/Application Support/ForecastChannel/noerase/savedata.dat');
  if (existsSync(real)) {
    const [rr, rs] = SaveData.parse(new Uint8Array(readFileSync(real)));
    ok(rr === 0 && eqBytes(rs.bytes(), new Uint8Array(readFileSync(real))), `save: Swift save parses and re-encodes identically (location ${rs.location.toString(16)})`);
  }
  const bad = sd.bytes(); bad[9] ^= 1;
  ok(SaveData.parse(bad)[0] === SaveData.LoadResult.broken, 'save: CRC mismatch → broken');
}

// 6. Geolocation nearest city
{
  const n = nearestHomeCity(41.88, -87.63);
  ok(n?.city.name === 'Chicago' && new LocationID(n.id.raw).equals(n.id), `geolocation: (41.88, -87.63) → ${n?.city.name} ${n?.id}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
