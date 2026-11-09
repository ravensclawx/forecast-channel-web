// Port of Sources/Forecast/Data/ForecastFormat.swift.
// forecast.bin / short.bin — the Forecast Channel's WiiConnect24 weather data files.
// Layout and validation recovered from main.dol (decomp/notes/forecast_data.md):
//   fn_8000C734  ValidateWeatherFiles (forecast + short)       → ForecastValidator
//   fn_8001FB94  CWeatherData::SetForecast (table binding)     → ForecastFile
//   fn_800201DC  CWeatherData::SetShort                        → ShortFile
//   fn_8000D1EC / fn_8000D450  day / week entry validators
//   fn_80067D44  CRC-32 (reflected 0xEDB88320, init ~0, final ~)
//   fn_8000D4C8  current time as minutes since 2000-01-01 00:00
// All multi-byte values big-endian. Strings are UTF-16BE, NUL-terminated, at even offsets.

import { BEReader } from '../../rvl/BinaryReader.js';

// MARK: - Shared primitives

export const WC24Time = Object.freeze({
  /** Minutes since 2000-01-01 00:00 (the channel's fn_8000D4C8 clock). `date`: Date or ms timestamp. */
  minutes(date) {
    const s = (typeof date === 'number' ? date : date.getTime()) / 1000;
    return Math.trunc(Math.max(0, (s - 946_684_800) / 60)) >>> 0;
  },
  date(minutes) { return new Date((946_684_800 + minutes * 60) * 1000); },
});

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB8_8320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export const CRC32 = Object.freeze({
  table: crcTable,
  /** CRC-32 of `bytes` (Uint8Array / array), optionally [start, end). */
  checksum(bytes, start = 0, end = bytes.length) {
    let c = 0xFFFF_FFFF;
    for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (~c) >>> 0;
  },
});

/** Swift `Double.rounded()` (schoolbook: halves away from zero). */
export function roundHalfAway(v) { return v < 0 ? -Math.round(-v) : Math.round(v); }
/** Swift `T(clamping:)` for an integer range. */
export function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** 16-bit binary angle (s16) → degrees, as ConvLatLon16ToDeg (fn_8003DFB0): ×360/65536. */
export const BinaryAngle = Object.freeze({
  degrees(v) { return Math.fround(Math.fround(v) * Math.fround(0.005493164)); },
  encode(deg) { return clampInt(roundHalfAway(deg * 65536 / 360), -32768, 32767); },
});

/** Wii location code: [country u8][region u8][city u16]. 0xFE = "no region / no country list". */
export class LocationID {
  constructor(raw) { this.raw = raw >>> 0; Object.freeze(this); }
  static fromParts(country, region, city) {
    return new LocationID(((country & 0xFF) << 24 | (region & 0xFF) << 16 | (city & 0xFFFF)) >>> 0);
  }
  get country() { return this.raw >>> 24; }
  get region() { return (this.raw >>> 16) & 0xFF; }
  get city() { return this.raw & 0xFFFF; }
  equals(o) { return o != null && o.raw === this.raw; }
  get description() {
    const h = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
    return h(this.country, 2) + h(this.region, 2) + h(this.city, 4);
  }
  toString() { return this.description; }
  static compare(a, b) { return a.raw - b.raw; }
}

// MARK: - Records

/** 0x1C-byte day forecast (today / tomorrow), validated by fn_8000D1EC. */
export class DayForecast {
  static size = 0x1C;
  constructor({ weather, slots, highC, highCDiff, lowC, lowCDiff, highF, highFDiff, lowF, lowFDiff, precipitation,
                windDirection, windKmh, windMph, uvIndex, laundryIndex, pollenIndex }) {
    this.weather = weather;                 // 0x00 weather code (→ WeatherType)
    this.slots = slots;                     // 0x02 4× quarter-day weather codes (0xFFFF = none)
    this.highC = highC; this.highCDiff = highCDiff;   // 0x0A, 0x0B (diff vs. previous day)
    this.lowC = lowC; this.lowCDiff = lowCDiff;       // 0x0C, 0x0D
    this.highF = highF; this.highFDiff = highFDiff;   // 0x0E, 0x0F
    this.lowF = lowF; this.lowFDiff = lowFDiff;       // 0x10, 0x11
    this.precipitation = precipitation;     // 0x12 4× % (≤100 or 0xFF)
    this.windDirection = windDirection;     // 0x16 1..16 (16 = N, 1 = NNE …) or 0xFF
    this.windKmh = windKmh; this.windMph = windMph;   // 0x17, 0x18
    this.uvIndex = uvIndex;                 // 0x19 UV table id or 0xFF
    this.laundryIndex = laundryIndex;       // 0x1A laundry table id or 0xFF (validated only in JP region)
    this.pollenIndex = pollenIndex;         // 0x1B pollen table id or 0xFF (validated only in JP region)
  }

  static read(r, o) {
    return new DayForecast({
      weather: r.u16(o), slots: [0, 1, 2, 3].map(i => r.u16(o + 2 + i * 2)),
      highC: r.s8(o + 0xA), highCDiff: r.s8(o + 0xB), lowC: r.s8(o + 0xC), lowCDiff: r.s8(o + 0xD),
      highF: r.s8(o + 0xE), highFDiff: r.s8(o + 0xF), lowF: r.s8(o + 0x10), lowFDiff: r.s8(o + 0x11),
      precipitation: [0, 1, 2, 3].map(i => r.u8(o + 0x12 + i)),
      windDirection: r.u8(o + 0x16), windKmh: r.u8(o + 0x17), windMph: r.u8(o + 0x18),
      uvIndex: r.u8(o + 0x19), laundryIndex: r.u8(o + 0x1A), pollenIndex: r.u8(o + 0x1B),
    });
  }

  write(w) {
    w.u16(this.weather); for (let i = 0; i < 4; i++) w.u16(i < this.slots.length ? this.slots[i] : 0xFFFF);
    for (const v of [this.highC, this.highCDiff, this.lowC, this.lowCDiff, this.highF, this.highFDiff, this.lowF, this.lowFDiff]) w.s8(v);
    for (let i = 0; i < 4; i++) w.u8(i < this.precipitation.length ? this.precipitation[i] : 0xFF);
    w.u8(this.windDirection); w.u8(this.windKmh); w.u8(this.windMph); w.u8(this.uvIndex); w.u8(this.laundryIndex); w.u8(this.pollenIndex);
  }
}

/** 8-byte extended-forecast day, validated by fn_8000D450. */
export class WeekForecast {
  static size = 8;
  constructor({ weather, highC, lowC, highF, lowF, precipitation }) {
    this.weather = weather;                       // 0x00
    this.highC = highC; this.lowC = lowC;         // 0x02, 0x03
    this.highF = highF; this.lowF = lowF;         // 0x04, 0x05
    this.precipitation = precipitation;           // 0x06 (≤100 or 0xFF)
  }
  static read(r, o) {
    return new WeekForecast({ weather: r.u16(o), highC: r.s8(o + 2), lowC: r.s8(o + 3), highF: r.s8(o + 4), lowF: r.s8(o + 5), precipitation: r.u8(o + 6) });
  }
  write(w) { w.u16(this.weather); w.s8(this.highC); w.s8(this.lowC); w.s8(this.highF); w.s8(this.lowF); w.u8(this.precipitation); w.u8(0); }
}

/** Timestamps on a per-city entry: `localTime` is the city's wall clock and `fileTime` the generation time
 *  (both minutes since 2000). fn_8002054C uses (localTime − fileTime) as the city's UTC offset. */
export class EntryTime {
  constructor(localTime, fileTime) { this.localTime = localTime >>> 0; this.fileTime = fileTime >>> 0; }
  get utcOffsetMinutes() { return this.localTime - this.fileTime; }
}

/** 0x80-byte "long" forecast (home-country cities): today, tomorrow, 7-day. */
export class LongForecast {
  static size = 0x80;
  constructor({ location, time, status = 0, today, tomorrow, week }) {
    this.location = location;   // 0x00
    this.time = time;           // 0x04, 0x08
    this.status = status;       // 0x0C (≤5 or 0xFF; generators write 0)
    this.today = today;         // 0x10
    this.tomorrow = tomorrow;   // 0x2C
    this.week = week;           // 0x48 7×8
  }
}

/** 0x48-byte "summary" forecast (international cities): today + tomorrow. */
export class SummaryForecast {
  static size = 0x48;
  constructor({ location, time, status = 0, today, tomorrow }) {
    this.location = location; this.time = time; this.status = status; this.today = today; this.tomorrow = tomorrow;
  }
}

/** Weather type: data code → display (icon) code + localized name.
 *  Display code: low 15 bits select the icon (0x00–0x7E; <0x64 static path fn_80020AD4, ≥0x64 animated),
 *  bit 15 = night variant. Looked up by fn_800203F0 (returns 0xFFFF when the code is unknown). */
export class WeatherType {
  static size = 8;
  constructor(code, displayCode, name) { this.code = code; this.displayCode = displayCode; this.name = name; }
}

/** UV / laundry / pollen index text entries (u8 id, 3 pad, u32 text offset). */
export class IndexText {
  static size = 8;
  constructor(id, text) { this.id = id; this.text = text; }
}

/** 0x18-byte location. */
export class Place {
  static size = 0x18;
  constructor({ id, city, region = null, country = null, latitude, longitude, zoom1, zoom2 }) {
    this.id = id;                     // 0x00
    this.city = city;                 // 0x04 (required)
    this.region = region;             // 0x08 (state / province, optional)
    this.country = country;           // 0x0C (optional)
    this.latitude = latitude;         // 0x10 binary angle
    this.longitude = longitude;       // 0x12 binary angle
    this.zoom1 = zoom1;               // 0x14 (≤9) globe marker rank: shown when rank ≥ zoom index
    this.zoom2 = zoom2;               // 0x15 (≤3)
  }
  get latitudeDegrees() { return BinaryAngle.degrees(this.latitude); }
  get longitudeDegrees() { return BinaryAngle.degrees(this.longitude); }
}

/** 0x18-byte current conditions (short.bin) — used by the globe's "now" markers. */
export class CurrentWeather {
  static size = 0x18;
  constructor({ location, time, weather, unknownE = 0, tempC, tempF, windDirection, windKmh, windMph }) {
    this.location = location;         // 0x00
    this.time = time;                 // 0x04, 0x08
    this.weather = weather;           // 0x0C (0xFFFF = none)
    this.unknownE = unknownE;         // 0x0E (≤99 or 0xFF; generators write 0)
    this.tempC = tempC; this.tempF = tempF;   // 0x0F, 0x10
    this.windDirection = windDirection;       // 0x11 (≤16)
    this.windKmh = windKmh; this.windMph = windMph;   // 0x12, 0x13
  }
}

/** Common 0x20-byte header prefix. */
export class WeatherFileHeader {
  constructor(r) {
    this.version = r.u32(0);          // 0x00 (upper 16 bits must be 0 → else -3)
    this.size = r.u32(4);             // 0x04 total size
    this.crc = r.u32(8);              // 0x08 CRC-32 of [0x0C, size)
    this.issued = r.u32(0xC);         // 0x0C generation time (min since 2000)
    this.expires = r.u32(0x10);       // 0x10 data older than now → -2
    this.countryCode = r.u8(0x14);    // 0x14 Wii country code (049 = USA)
    this.language = r.u8(0x18);       // 0x18 low byte of u32 at 0x15; must equal the console language (lbl_80330B36)
    this.regionFlag = r.u8(0x19);     // 0x19 (≤2) 0 JP, 1 US, 2 EU (matches lbl_80330B3C)
    this.kind = r.u8(0x1A);           // 0x1A (≤1) forecast=1, short=0
  }
}

// MARK: - Validation (fn_8000C734)

/** Result of fn_8000C734 for each file: 0 ok, -1 corrupt, -2 expired, -3 unsupported version. */
export class ValidationResult {
  constructor(forecast, short, hasMessage) { this.forecast = forecast; this.short = short; this.hasMessage = hasMessage; }
  /** forecast.bin carried a message (header 0x1C ≠ 0) — channel shows it instead of data (returns 1 early). */
  get ok() { return (this.forecast === 0 && this.short === 0) || (this.hasMessage && this.forecast === 0); }
  get description() { return `forecast=${this.forecast} short=${this.short}${this.hasMessage ? ' (message)' : ''}`; }
  toString() { return this.description; }
}

export const ForecastValidator = Object.freeze({
  /** `now`: minutes since 2000 (fn_8000D4C8). `language`: console language (header 0x18 must match).
   *  `regionType`: lbl_80330B3C (0 JP, 1 US, 2 EU) — laundry/pollen ids are only checked for JP. */
  validate(f, s, now, language, regionType) {
    let e = 0, es = 0;
    if (f.length < 0x58 || s.length < 0x24) return new ValidationResult(-1, -1, false);
    const r = new BEReader(f), rs = new BEReader(s);
    const size = r.u32(4);
    const u = o => r.u32(o);
    // table offsets must be 4-aligned
    for (const o of [0x24, 0x2C, 0x34, 0x3C, 0x44, 0x4C, 0x54]) if ((u(o) & 3) !== 0) e = -1;
    if ((rs.u32(0x20) & 3) !== 0) es = -1;
    if (e !== 0 || es !== 0) return new ValidationResult(e, es, false);

    if ((r.u32(0) & 0xFFFF_0000) !== 0) e = -3;
    if (size !== f.length) e = -1;
    if (r.u32(8) !== CRC32.checksum(f, 0xC, Math.min(size, f.length))) e = -1;
    if (e === -1) return new ValidationResult(e, es, false);
    if (r.u32(0x10) < now && e === 0) e = -2;
    if (r.u8(0x18) !== language) e = -1;
    const msg = r.u32(0x1C);
    if (msg >= size || (msg & 1) !== 0) e = -1;
    if (msg !== 0 && e === 0) return new ValidationResult(0, 0, true);
    if (r.u8(0x19) > 2) e = -1;
    if (r.u8(0x1A) > 1) e = -1;
    const tables = [[0x20, 0x24, 0x80], [0x28, 0x2C, 0x48], [0x30, 0x34, 8], [0x38, 0x3C, 8], [0x40, 0x44, 8], [0x48, 0x4C, 8], [0x50, 0x54, 0x18]];
    for (const [count, off, stride] of tables) if (u(off) + u(count) * stride > size) e = -1;
    if (e !== 0) return new ValidationResult(e, es, false);

    const nLong = u(0x20), longOff = u(0x24), nSum = u(0x28), sumOff = u(0x2C);
    const nWT = u(0x30), wtOff = u(0x34), nUV = u(0x38), uvOff = u(0x3C);
    const nLa = u(0x40), laOff = u(0x44), nPo = u(0x48), poOff = u(0x4C), nPl = u(0x50), plOff = u(0x54);
    // place id → occurrence count (the Swift filter().count == 1 checks)
    const placeCount = new Map();
    for (let i = 0; i < nPl; i++) { const id = r.u32(plOff + i * 0x18); placeCount.set(id, (placeCount.get(id) ?? 0) + 1); }
    const once = id => placeCount.get(id) === 1;
    const wtCodes = new Set(), uvIDs = new Set(), laIDs = new Set(), poIDs = new Set();
    for (let i = 0; i < nWT; i++) wtCodes.add(r.u16(wtOff + i * 8));
    for (let i = 0; i < nUV; i++) uvIDs.add(r.u8(uvOff + i * 8));
    for (let i = 0; i < nLa; i++) laIDs.add(r.u8(laOff + i * 8));
    for (let i = 0; i < nPo; i++) poIDs.add(r.u8(poOff + i * 8));
    const okCode = c => c === 0xFFFF || wtCodes.has(c);
    const pct = (v, max) => v <= max || v === 0xFF;

    const day = o => {                                     // fn_8000D1EC
      let res = 0;
      if (!okCode(r.u16(o))) res = -1;
      for (let i = 0; i < 4; i++) if (!okCode(r.u16(o + 2 + i * 2))) res = -1;
      for (let i = 0; i < 4; i++) if (!pct(r.u8(o + 0x12 + i), 100)) res = -1;
      if (!pct(r.u8(o + 0x16), 16)) res = -1;
      if (r.u8(o + 0x19) !== 0xFF && !uvIDs.has(r.u8(o + 0x19))) res = -1;
      if (regionType === 0) {
        if (r.u8(o + 0x1A) !== 0xFF && !laIDs.has(r.u8(o + 0x1A))) res = -1;
        if (r.u8(o + 0x1B) !== 0xFF && !poIDs.has(r.u8(o + 0x1B))) res = -1;
      }
      return res;
    };
    const week = o => (okCode(r.u16(o)) && pct(r.u8(o + 6), 100)) ? 0 : -1;   // fn_8000D450
    const first = v => { if (e === 0) e = v; };
    for (let i = 0; i < nLong; i++) {
      const o = longOff + i * 0x80;
      if (!once(r.u32(o))) e = -1;
      if (!pct(r.u8(o + 0xC), 5)) e = -1;
      for (let d = 0; d < 2; d++) first(day(o + 0x10 + d * 0x1C));
      for (let w = 0; w < 7; w++) first(week(o + 0x48 + w * 8));
    }
    for (let i = 0; i < nSum; i++) {
      const o = sumOff + i * 0x48;
      if (!once(r.u32(o))) e = -1;
      if (!pct(r.u8(o + 0xC), 5)) e = -1;
      for (let d = 0; d < 2; d++) first(day(o + 0x10 + d * 0x1C));
    }
    // id tables: unique ids, even in-bounds text offsets
    for (const [n, off, key] of [[nWT, wtOff, 2], [nUV, uvOff, 1], [nLa, laOff, 1], [nPo, poOff, 1]]) {
      const k = j => key === 2 ? r.u16(off + j * 8) : r.u8(off + j * 8);
      for (let i = 0; i < n; i++) {
        const o = off + i * 8, ki = k(i);
        for (let j = 0; j < n; j++) if (j !== i && k(j) === ki) e = -1;
        const t = r.u32(o + 4); if (t >= size || (t & 1) !== 0) e = -1;
      }
    }
    const longIDs = new Set(), sumIDs = new Set();
    for (let i = 0; i < nLong; i++) longIDs.add(r.u32(longOff + i * 0x80));
    for (let i = 0; i < nSum; i++) sumIDs.add(r.u32(sumOff + i * 0x48));
    const nShort = rs.u32(0x1C), shortOff = rs.u32(0x20);
    const shortIDs = new Set();
    // (guarded: the Swift Set(…) reads within the file — bound the loop by the file so a corrupt count can't hang)
    for (let i = 0; i < nShort && shortOff + i * 0x18 + 4 <= s.length; i++) shortIDs.add(rs.u32(shortOff + i * 0x18));
    for (let i = 0; i < nPl; i++) {
      const o = plOff + i * 0x18, id = r.u32(o);
      if (!once(id)) e = -1;
      if (!(longIDs.has(id) || sumIDs.has(id) || shortIDs.has(id))) e = -1;
      for (const t of [r.u32(o + 4), r.u32(o + 8), r.u32(o + 0xC)]) if (t >= size || (t & 1) !== 0) e = -1;
      if (r.u8(o + 0x14) > 9 || r.u8(o + 0x15) > 3) e = -1;
    }

    // short.bin
    if ((rs.u32(0) & 0xFFFF_0000) !== 0) es = -3;
    if (rs.u32(4) !== s.length) es = -1;
    if (rs.u32(8) !== CRC32.checksum(s, 0xC)) es = -1;
    if (rs.u32(0x10) < now && es === 0) es = -2;
    if (rs.u8(0x18) !== language) es = -1;
    if (shortOff + nShort * 0x18 > rs.u32(4)) es = -1;
    if (es !== 0) return new ValidationResult(e, es, false);
    for (let i = 0; i < nShort; i++) {
      const o = shortOff + i * 0x18;
      if (!once(rs.u32(o))) es = -1;
      const c = rs.u16(o + 0xC);
      if (c !== 0xFFFF && !wtCodes.has(c)) es = -1;
      if (!pct(rs.u8(o + 0xE), 0x63)) es = -1;
      if (!pct(rs.u8(o + 0x11), 0x10)) es = -1;
    }
    return new ValidationResult(e, es, false);
  },
});

// MARK: - Parsed files (fn_8001FB94 / fn_800201DC)

const errorNames = {
  0x2: 'MEM_ERROR_WeatherForecasts_e', 0x3: 'MEM_ERROR_WeatherSummary_e', 0x4: 'MEM_ERROR_WeatherType_e',
  0x5: 'MEM_ERROR_Places_e', 0x7: 'MEM_ERROR_UVIndex_e', 0x8: 'MEM_ERROR_LaundryIndex_e', 0x9: 'MEM_ERROR_PollenIndex_e',
  0xA: 'ERROR_MESSAGE_e', 0xB: 'ERROR_NumForecasts_e', 0xC: 'ERROR_NumWeatherTypes_e', 0xD: 'ERROR_NumPlaces_e',
  0xE: 'ERROR_ShortNumNowWeathers_e', 0xF: 'ERROR_ForecastArrayAddr_e', 0x10: 'ERROR_SummaryForecastArrayAddr_e',
  0x11: 'ERROR_WeatherTypesArrayAddr_e', 0x12: 'ERROR_PlaceArrayAddr_e', 0x13: 'ERROR_WeatherTypeNameAddr_e',
  0x14: 'ERROR_ShortNowWeatherArrayAddr_e', 0x15: 'UVIndex text', 0x16: 'LaundryIndex text', 0x17: 'PollenIndex text',
};

/** Error codes returned by fn_8001FB94 / fn_800201DC (0x18 = success); names from main.dol's error strings.
 *  kind: 'code' (code, name) | 'invalid' (validation) | 'container' (message). */
export class WeatherDataError extends Error {
  constructor(kind, { code = 0, name = '', validation = null, message = '' } = {}) {
    const desc = kind === 'code' ? `0x${code.toString(16).toUpperCase().padStart(2, '0')} ${name}`
      : kind === 'invalid' ? `validation failed: ${validation}` : `container: ${message}`;
    super(desc);
    this.kind = kind; this.code = code; this.codeName = name; this.validation = validation;
  }
  static e(c) { return new WeatherDataError('code', { code: c, name: errorNames[c] ?? '?' }); }
  static invalid(v) { return new WeatherDataError('invalid', { validation: v }); }
  static container(s) { return new WeatherDataError('container', { message: s }); }
}

export function utf16String(r, o) {
  const units = [];
  let p = o;
  while (p + 1 < r.data.length) { const u = r.u16(p); if (u === 0) break; units.push(u); p += 2; }
  let s = '';
  for (let i = 0; i < units.length; i += 4096) s += String.fromCharCode.apply(null, units.slice(i, i + 4096));
  return s;
}

const toBytes = b => b instanceof Uint8Array ? b : new Uint8Array(b);

export class ForecastFile {
  /** fn_8001FB94. Throws the same error codes the channel would report. */
  constructor(bytes) {
    const r = new BEReader(toBytes(bytes));
    const u = o => r.u32(o);
    this.header = new WeatherFileHeader(r);
    this.message = null;
    this.longForecasts = []; this.summaries = []; this.weatherTypes = [];
    this.uvIndex = []; this.laundryIndex = []; this.pollenIndex = []; this.places = [];
    if (u(0x1C) !== 0) { this.message = utf16String(r, u(0x1C)); return; }
    if (u(0x20) === 0 && u(0x28) === 0) throw WeatherDataError.e(0xB);
    if (u(0x20) !== 0 && u(0x24) === 0) throw WeatherDataError.e(0xF);
    if (u(0x28) !== 0 && u(0x2C) === 0) throw WeatherDataError.e(0x10);
    if (u(0x30) === 0) throw WeatherDataError.e(0xC);
    if (u(0x34) === 0) throw WeatherDataError.e(0x11);
    if (u(0x50) === 0) throw WeatherDataError.e(0xD);
    if (u(0x54) === 0) throw WeatherDataError.e(0x12);

    const entryTime = o => new EntryTime(r.u32(o + 4), r.u32(o + 8));
    for (let i = 0; i < u(0x20); i++) {
      const o = u(0x24) + i * 0x80;
      const week = [];
      for (let w = 0; w < 7; w++) week.push(WeekForecast.read(r, o + 0x48 + w * 8));
      this.longForecasts.push(new LongForecast({ location: new LocationID(r.u32(o)), time: entryTime(o), status: r.u8(o + 0xC),
        today: DayForecast.read(r, o + 0x10), tomorrow: DayForecast.read(r, o + 0x2C), week }));
    }
    for (let i = 0; i < u(0x28); i++) {
      const o = u(0x2C) + i * 0x48;
      this.summaries.push(new SummaryForecast({ location: new LocationID(r.u32(o)), time: entryTime(o), status: r.u8(o + 0xC),
        today: DayForecast.read(r, o + 0x10), tomorrow: DayForecast.read(r, o + 0x2C) }));
    }
    for (let i = 0; i < u(0x30); i++) {                                    // fn_80028A50
      const o = u(0x34) + i * 8;
      if (r.u32(o + 4) === 0) throw WeatherDataError.e(0x13);
      this.weatherTypes.push(new WeatherType(r.u16(o), r.u16(o + 2), utf16String(r, u(o + 4))));
    }
    const indexTable = (n, off, err) => {
      const out = [];
      for (let i = 0; i < u(n); i++) {
        const o = u(off) + i * 8;
        if (r.u32(o + 4) === 0) throw WeatherDataError.e(err);
        out.push(new IndexText(r.u8(o), utf16String(r, u(o + 4))));
      }
      return out;
    };
    this.uvIndex = indexTable(0x38, 0x3C, 0x15);                  // fn_80028A78
    this.laundryIndex = indexTable(0x40, 0x44, 0x16);             // fn_80020F74
    this.pollenIndex = indexTable(0x48, 0x4C, 0x17);              // fn_80027D80
    for (let i = 0; i < u(0x50); i++) {                           // fn_80027D3C
      const o = u(0x54) + i * 0x18;
      const reg = u(o + 8), cty = u(o + 0xC);
      this.places.push(new Place({ id: new LocationID(r.u32(o)), city: utf16String(r, u(o + 4)),
        region: reg !== 0 ? utf16String(r, reg) : null, country: cty !== 0 ? utf16String(r, cty) : null,
        latitude: r.s16(o + 0x10), longitude: r.s16(o + 0x12), zoom1: r.u8(o + 0x14), zoom2: r.u8(o + 0x15) }));
    }
    this._placeByID = new Map(this.places.map(p => [p.id.raw, p]));
    this._typeByCode = new Map();
    for (const t of this.weatherTypes) if (!this._typeByCode.has(t.code)) this._typeByCode.set(t.code, t);
  }

  /** fn_800203F0: data weather code → display code (0xFFFF if unknown). */
  displayCode(code) { return this._typeByCode?.get(code)?.displayCode ?? 0xFFFF; }
  weatherName(code) { return this._typeByCode?.get(code)?.name ?? null; }
  /** `id`: LocationID or raw u32. */
  place(id) { const raw = typeof id === 'number' ? id >>> 0 : id.raw; return this._placeByID?.get(raw) ?? null; }
}

export class ShortFile {
  /** fn_800201DC */
  constructor(bytes) {
    const r = new BEReader(toBytes(bytes));
    this.header = new WeatherFileHeader(r);
    const n = r.u32(0x1C), off = r.u32(0x20);
    if (n === 0) throw WeatherDataError.e(0xE);
    if (off === 0) throw WeatherDataError.e(0x14);
    this.current = [];
    for (let i = 0; i < n; i++) {
      const o = off + i * 0x18;
      this.current.push(new CurrentWeather({ location: new LocationID(r.u32(o)), time: new EntryTime(r.u32(o + 4), r.u32(o + 8)),
        weather: r.u16(o + 0xC), unknownE: r.u8(o + 0xE), tempC: r.s8(o + 0xF), tempF: r.s8(o + 0x10),
        windDirection: r.u8(o + 0x11), windKmh: r.u8(o + 0x12), windMph: r.u8(o + 0x13) }));
    }
  }
}

/** Validated pair, as the channel holds them after a successful download (CWeatherData). */
export class WeatherData {
  /** Load raw (decompressed) forecast/short bytes exactly as the channel does: validate (fn_8000C734), then bind.
   *  Options: { now: Date, language: 1, regionType: 1, allowExpired: false }. */
  constructor(forecast, short, { now = new Date(), language = 1, regionType = 1, allowExpired = false } = {}) {
    const f = toBytes(forecast), s = toBytes(short);
    const v = ForecastValidator.validate(f, s, WC24Time.minutes(now), language, regionType);
    if (allowExpired) { if (v.forecast === -2) v.forecast = 0; if (v.short === -2) v.short = 0; }
    if (!v.ok) throw WeatherDataError.invalid(v);
    this.validation = v;
    this.forecast = new ForecastFile(f);
    this.short = new ShortFile(s);
    /** Raw (decompressed) bytes — kept so the service can cache/re-wrap them. */
    this.forecastBytes = f; this.shortBytes = s;
  }
}
