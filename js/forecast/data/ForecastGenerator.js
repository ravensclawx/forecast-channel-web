// Port of Sources/Forecast/Data/ForecastGenerator.swift.
// Builds forecast.bin + short.bin (original binary formats) from Open-Meteo data for a city catalog,
// standing in for Nintendo's weather.wapp.wii.com server.

import { WC24Time, LocationID, EntryTime, DayForecast, WeekForecast, LongForecast, SummaryForecast, CurrentWeather,
  Place, BinaryAngle, roundHalfAway, clampInt } from './ForecastFormat.js';
import { CityList } from './CityList.js';
import { WiiCountry } from './CityCatalog.js';
import { MarkerRanks } from './MarkerRanks.js';
import { WeatherCodes } from './WeatherCodes.js';
import { OpenMeteo } from './OpenMeteo.js';
import { ForecastWriter, ForecastWriterCommon } from './ForecastWriter.js';
import { WC24Container } from './WC24Container.js';

export class ForecastGeneratorOptions {
  constructor() {
    this.countryCode = 49;          // USA
    this.language = 1;              // English
    this.regionFlag = 1;            // US
    /** How long the generated files stay valid (header 0x10). Nintendo's files expired ~63 min after issue;
     *  we refresh less often (free-API budget), so validity = refresh interval + 63 min. */
    this.validityMinutes = 3 * 60 + 63;
  }
}

export class ForecastGeneratorOutput {
  constructor(forecast, short) { this.forecast = forecast; this.short = short; }   // decompressed files (Uint8Array)
  get forecastContainer() { return WC24Container.wrap(this.forecast); }
  get shortContainer() { return WC24Container.wrap(this.short); }
}

// Swift numeric helpers
const isNum = v => typeof v === 'number' && Number.isFinite(v);
/** Int8(clamping: Int(v.rounded())) */
const s8 = v => isNum(v) ? clampInt(roundHalfAway(v), -128, 127) : 0;
const f = c => c == null ? null : c * 9 / 5 + 32;
/** UInt8(clamping: Int(v.rounded())), 0xFF when missing */
const pct = v => isNum(v) ? clampInt(roundHalfAway(v), 0, 255) : 0xFF;
const u8 = v => isNum(v) ? clampInt(roundHalfAway(v), 0, 255) : 0;

/** Swift `String.folding(options: [.diacriticInsensitive, .caseInsensitive])` + lowercased. */
function norm(s) { return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); }
/** Swift String `<` (Unicode scalar order) for the state list sort. */
function scalarCompare(a, b) {
  const A = [...a], B = [...b];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i].codePointAt(0), y = B[i].codePointAt(0);
    if (x !== y) return x - y;
  }
  return A.length - B.length;
}

export class ForecastGenerator {
  constructor(cities = CityList.all, options = new ForecastGeneratorOptions()) { this.cities = cities; this.options = options; }

  /** Assign Wii location codes: home cities [country][state#][city#], others [wii country|FE][FE][global#]. */
  locationIDs() {
    const states = [...new Set(this.cities.filter(c => c.isHome && c.region != null).map(c => c.region))].sort(scalarCompare);
    const perState = new Map();
    let intl = 0;
    return this.cities.map(c => {
      if (c.isHome && c.region != null) {
        const si = states.indexOf(c.region);
        if (si >= 0) {
          const n = (perState.get(c.region) ?? 0) + 1;
          perState.set(c.region, n);
          return LocationID.fromParts(this.options.countryCode, si + 1, n);
        }
      }
      intl++;
      return LocationID.fromParts(WiiCountry.code(c.iso2), 0xFE, intl);
    });
  }

  async fetchAndBuild({ now = new Date(), progress = null } = {}) {
    const data = await OpenMeteo.fetch(this.cities.map(c => ({ latitude: c.latitude, longitude: c.longitude })), { progress });
    return this.build(data, now);
  }

  // MARK: - Assembly

  /** Quarter-day slots 00–06, 06–12, 12–18, 18–24 local: most significant WMO code (highest number) and max precip. */
  static slots(fc, dayIndex) {
    if (dayIndex >= fc.daily.length) return { codes: [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF], precip: [0xFF, 0xFF, 0xFF, 0xFF] };
    const date = fc.daily[dayIndex].date;
    const hours = fc.hourly.filter(h => h.time.startsWith(date));
    const codes = [], precip = [];
    for (let q = 0; q < 4; q++) {
      const h = hours.filter(x => {
        const hh = x.time.slice(11, 13);
        if (!/^\d+$/.test(hh)) return false;
        return Math.trunc(parseInt(hh, 10) / 6) === q;
      });
      const wmos = h.map(x => x.weatherCode).filter(v => v != null);
      codes.push(wmos.length ? WeatherCodes.code(Math.max(...wmos), q === 0 || q === 3) : 0xFFFF);
      const ps = h.map(x => x.precip).filter(v => v != null);
      precip.push(ps.length ? pct(Math.max(...ps)) : 0xFF);
    }
    return { codes, precip };
  }

  static day(fc, i) {
    const d = i < fc.daily.length ? fc.daily[i] : null;
    const prev = i - 1 >= 0 && i - 1 < fc.daily.length ? fc.daily[i - 1] : null;
    const sl = ForecastGenerator.slots(fc, i);
    const diff = (a, b) => (a == null || b == null) ? 0 : s8(roundHalfAway(a) - roundHalfAway(b));
    const uv = isNum(d?.uvMax) ? Math.min(clampInt(roundHalfAway(d.uvMax), 0, 255), 12) : 0xFF;
    const kmh = d?.windSpeedMax ?? null;
    return new DayForecast({
      weather: d?.weatherCode != null ? WeatherCodes.code(d.weatherCode) : 0xFFFF, slots: sl.codes,
      highC: s8(d?.tempMax), highCDiff: diff(d?.tempMax, prev?.tempMax),
      lowC: s8(d?.tempMin), lowCDiff: diff(d?.tempMin, prev?.tempMin),
      highF: s8(f(d?.tempMax)), highFDiff: diff(f(d?.tempMax), f(prev?.tempMax)),
      lowF: s8(f(d?.tempMin)), lowFDiff: diff(f(d?.tempMin), f(prev?.tempMin)),
      precipitation: sl.precip, windDirection: WeatherCodes.windDirection(d?.windDirection ?? null),
      windKmh: u8(kmh), windMph: u8(kmh == null ? null : kmh * 0.621371), uvIndex: uv, laundryIndex: 0xFF, pollenIndex: 0xFF,
    });
  }

  /** Globe marker rank (Place.zoom1 ≤9, zoom2 ≤3): CityMarker_Calc shows a marker when zoom1 ≥ the zoom index
   *  (CAround +302 = SimpleGlobe +9C), so most cities must be rank 0 (only fully zoomed in). Ranks come from the
   *  original channel's city lists (MarkerRanks, via RiiConnect24 File-Maker); cities missing there get a rank
   *  from the same sparse distribution (US list: 57% rank 0, 14% 1, 17% 3, 4% 6, a handful 7/9). → [zoom1, zoom2] */
  static rank(c) {
    const place = norm(c.region ?? c.country);
    const names = [norm(c.name)];
    if (names[0].endsWith(' city')) names.push(names[0].slice(0, -5));
    for (const n of names) {
      const r = MarkerRanks.table.get(n + '|' + place) ?? MarkerRanks.table.get(n + '|' + norm(c.country));
      if (r) return [r[0], r[1]];
    }
    const p = c.population;
    if (p >= 8_000_000) return [9, 3];
    if (p >= 3_000_000) return [7, 3];
    if (p >= 1_000_000) return [6, 3];
    if (p >= 400_000) return [3, 3];
    if (p >= 200_000) return [1, 3];
    return [0, 3];
  }

  /** `data`: [OpenMeteo forecast] aligned with `this.cities`. → ForecastGeneratorOutput */
  build(data, now = new Date()) {
    const nowMin = WC24Time.minutes(now);
    const ids = this.locationIDs();
    const long = [], sums = [], cur = [], places = [];
    this.cities.forEach((c, i) => {
      const fc = data[i], id = ids[i];
      const t = new EntryTime(nowMin + Math.trunc(fc.utcOffsetSeconds / 60), nowMin);
      const today = ForecastGenerator.day(fc, 1), tomorrow = ForecastGenerator.day(fc, 2);
      if (c.isHome) {
        const week = [];
        for (let j = 3; j < 10; j++) {
          const d = j < fc.daily.length ? fc.daily[j] : null;
          week.push(new WeekForecast({ weather: d?.weatherCode != null ? WeatherCodes.code(d.weatherCode) : 0xFFFF,
            highC: s8(d?.tempMax), lowC: s8(d?.tempMin),
            highF: s8(f(d?.tempMax)), lowF: s8(f(d?.tempMin)), precipitation: pct(d?.precipMax) }));
        }
        long.push(new LongForecast({ location: id, time: t, today, tomorrow, week }));
      } else {
        sums.push(new SummaryForecast({ location: id, time: t, today, tomorrow }));
      }
      const cc = fc.current;
      const kmh = cc.windSpeed;
      const wd = WeatherCodes.windDirection(cc.windDirection);
      cur.push(new CurrentWeather({ location: id, time: t,
        weather: cc.weatherCode != null ? WeatherCodes.code(cc.weatherCode, !cc.isDay) : 0xFFFF,
        tempC: s8(cc.temperature), tempF: s8(f(cc.temperature)),
        windDirection: wd === 0xFF ? 0 : wd,
        windKmh: u8(kmh), windMph: u8(kmh == null ? null : kmh * 0.621371) }));
      const [z1, z2] = ForecastGenerator.rank(c);
      places.push(new Place({ id, city: c.name, region: c.region, country: c.country,
        latitude: BinaryAngle.encode(c.latitude), longitude: BinaryAngle.encode(c.longitude), zoom1: z1, zoom2: z2 }));
    });
    // The channel binary-searches these tables by location ID (verified in Dolphin: unsorted data resolves the
    // wrong city), so every table is written in ascending ID order.
    long.sort((a, b) => a.location.raw - b.location.raw); sums.sort((a, b) => a.location.raw - b.location.raw);
    cur.sort((a, b) => a.location.raw - b.location.raw); places.sort((a, b) => a.id.raw - b.id.raw);
    const o = this.options;
    const common = new ForecastWriterCommon({ issued: nowMin, expires: nowMin + o.validityMinutes,
      countryCode: o.countryCode, language: o.language, regionFlag: o.regionFlag });
    const forecast = ForecastWriter.forecastBin(common, { long, summaries: sums, weatherTypes: WeatherCodes.table,
      uv: WeatherCodes.uvTable, laundry: [], pollen: [], places });
    const short = ForecastWriter.shortBin(common, cur);
    return new ForecastGeneratorOutput(forecast, short);
  }
}
