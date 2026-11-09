// Port of Sources/Forecast/Data/ForecastWriter.swift.
// Serializes forecast.bin / short.bin in the original layout (inverse of ForecastFile / ShortFile).
// Table order follows the layout observed in served files: header, long, summary, weather types, UV, laundry,
// pollen, places, then the UTF-16 text pool.

import { CRC32, WeekForecast } from './ForecastFormat.js';
import { BEWriter } from './WC24Container.js';

export class ForecastWriterCommon {
  constructor({ issued, expires, countryCode = 49, language = 1, regionFlag = 1 }) {
    this.issued = issued >>> 0; this.expires = expires >>> 0;
    this.countryCode = countryCode;   // 49 = USA
    this.language = language;         // 1 = English
    this.regionFlag = regionFlag;     // 0 JP, 1 US, 2 EU
  }
}

function header(w, c, kind) {
  w.u32(0); w.u32(0); w.u32(0);               // version, size, crc (patched)
  w.u32(c.issued); w.u32(c.expires);
  w.u8(c.countryCode); w.u32(c.language); w.u8(c.regionFlag); w.u8(kind); w.u8(0);
}

function finish(w) {
  w.pad(4);
  w.put32(w.count, 4);
  w.put32(CRC32.checksum(w.bytes, 0xC), 8);
  return w.toArray();
}

const emptyWeek = () => new WeekForecast({ weather: 0xFFFF, highC: 0, lowC: 0, highF: 0, lowF: 0, precipitation: 0xFF });

export const ForecastWriter = Object.freeze({
  Common: ForecastWriterCommon,

  forecastBin(c, { long, summaries, weatherTypes, uv, laundry, pollen, places, message = null }) {
    const w = new BEWriter(64 * 1024);
    header(w, c, 1);                           // 0x00..0x1B
    const tablesAt = w.count;                  // 0x1C: message off, then 7×(count, off)
    for (let i = 0; i < 15; i++) w.u32(0);     // → 0x58
    const counts = [];                         // [count, table offset]

    const longOff = w.count;
    for (const e of long) {
      w.u32(e.location.raw); w.u32(e.time.localTime); w.u32(e.time.fileTime); w.u8(e.status); w.u8(0); w.u8(0); w.u8(0);
      e.today.write(w); e.tomorrow.write(w);
      for (let i = 0; i < 7; i++) (i < e.week.length ? e.week[i] : emptyWeek()).write(w);
    }
    counts.push([long.length, long.length === 0 ? 0 : longOff]);
    const sumOff = w.count;
    for (const e of summaries) {
      w.u32(e.location.raw); w.u32(e.time.localTime); w.u32(e.time.fileTime); w.u8(e.status); w.u8(0); w.u8(0); w.u8(0);
      e.today.write(w); e.tomorrow.write(w);
    }
    counts.push([summaries.length, summaries.length === 0 ? 0 : sumOff]);

    // id tables with text offsets patched after the pool is written
    const textRefs = [];
    const wtOff = w.count;
    for (const t of weatherTypes) { w.u16(t.code); w.u16(t.displayCode); textRefs.push([w.count, t.name]); w.u32(0); }
    counts.push([weatherTypes.length, wtOff]);
    for (const table of [uv, laundry, pollen]) {
      const off = w.count;
      for (const t of table) { w.u8(t.id); w.u8(0); w.u8(0); w.u8(0); textRefs.push([w.count, t.text]); w.u32(0); }
      counts.push([table.length, table.length === 0 ? 0 : off]);
    }
    const plOff = w.count;
    const placeRefs = [];
    for (const p of places) {
      w.u32(p.id.raw);
      placeRefs.push([w.count, p.city]); w.u32(0);
      placeRefs.push([w.count, p.region]); w.u32(0);
      placeRefs.push([w.count, p.country]); w.u32(0);
      w.s16(p.latitude); w.s16(p.longitude); w.u8(p.zoom1); w.u8(p.zoom2); w.u16(0);
    }
    counts.push([places.length, plOff]);

    // text pool (UTF-16BE, even offsets; identical strings shared)
    const pool = new Map();
    const text = s => {
      const o = pool.get(s);
      if (o !== undefined) return o;
      const at = w.count; w.utf16(s); pool.set(s, at); return at;
    };
    let messageOff = 0;
    if (message != null) messageOff = text(message);
    for (const [at, s] of textRefs) w.put32(text(s), at);
    for (const [at, s] of placeRefs) if (s != null && s.length > 0) w.put32(text(s), at);

    w.put32(messageOff, tablesAt);
    counts.forEach(([n, off], i) => { w.put32(n, tablesAt + 4 + i * 8); w.put32(off, tablesAt + 8 + i * 8); });
    return finish(w);
  },

  shortBin(c, current) {
    const w = new BEWriter(16 * 1024);
    header(w, c, 0);
    w.u32(current.length); w.u32(0x24);
    for (const e of current) {
      w.u32(e.location.raw); w.u32(e.time.localTime); w.u32(e.time.fileTime);
      w.u16(e.weather); w.u8(e.unknownE); w.s8(e.tempC); w.s8(e.tempF);
      w.u8(e.windDirection); w.u8(e.windKmh); w.u8(e.windMph); w.u16(0); w.u16(0xFFFF);
    }
    return finish(w);
  },
});
