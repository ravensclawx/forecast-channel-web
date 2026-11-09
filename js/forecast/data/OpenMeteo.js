// Port of Sources/Forecast/Data/OpenMeteo.swift.
// Open-Meteo forecast client (https://open-meteo.com — free, no API key, open source; data CC-BY 4.0).
// Batches many coordinates per request (comma-separated latitude/longitude lists). Runs in the browser with
// fetch() (Open-Meteo sends CORS headers). The User-Agent header can't be set from a page, so none is sent.

const dailyVars = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,uv_index_max';
const hourlyVars = 'weather_code,precipitation_probability';
const currentVars = 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day';

const sleep = ms => new Promise(res => setTimeout(res, ms));

export class OpenMeteoError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const OpenMeteo = {
  dailyVars, hourlyVars, currentVars,

  /** Open-Meteo counts a multi-location request as `locations × weight`; 14 variables over ≤14 days ⇒ 1.4.
   *  Free tier: 600 calls/minute, 5,000/hour, 10,000/day. We stay under `maxWeightPerMinute`. */
  weightPerLocation: 1.4,
  maxWeightPerMinute: 480,
  /** Per-request timeout (the Swift session: 20 s request / 60 s resource). */
  requestTimeoutMs: 20_000,
  /** Injectable for tests (node) — defaults to the global fetch. */
  fetchImpl: (...a) => globalThis.fetch(...a),

  /** `locs`: [{latitude, longitude}] */
  url(locs) {
    const f = v => v.toFixed(4);
    const q = [
      ['latitude', locs.map(l => f(l.latitude)).join(',')],
      ['longitude', locs.map(l => f(l.longitude)).join(',')],
      ['current', currentVars],
      ['hourly', hourlyVars],
      ['daily', dailyVars],
      ['timezone', 'auto'],
      ['past_days', '1'],
      ['forecast_days', '9'],
      ['wind_speed_unit', 'kmh'],
    ].map(([k, v]) => `${k}=${v}`).join('&');
    return `https://api.open-meteo.com/v1/forecast?${q}`;
  },

  /** Fetch forecasts for `locs` in batches (paced for the free tier); results align with input order.
   *  `progress(done, total)` optional. Bounded timeouts so a stalled connection can never hang the boot screen. */
  async fetch(locs, { batch = 60, progress = null } = {}) {
    const out = [];
    const sent = [];   // [timestamp ms, weight]
    let i = 0;
    while (i < locs.length) {
      const chunk = locs.slice(i, Math.min(i + batch, locs.length));
      const w = chunk.length * this.weightPerLocation;
      // rolling one-minute budget
      for (;;) {
        const now = Date.now();
        while (sent.length && now - sent[0][0] >= 60_000) sent.shift();
        if (sent.reduce((a, s) => a + s[1], 0) + w <= this.maxWeightPerMinute) break;
        const wait = 60_000 - (now - sent[0][0]) + 500;
        await sleep(Math.max(wait, 500));
      }
      const url = this.url(chunk);
      let attempt = 0;
      for (;;) {
        let status = 0, text = '';
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.requestTimeoutMs);
        try {
          const resp = await this.fetchImpl(url, { signal: ctl.signal, cache: 'no-store' });
          status = resp.status;
          text = await resp.text();
        } finally { clearTimeout(timer); }
        if (status === 200) { out.push(...this.parse(text, chunk.length)); break; }
        attempt++;
        // 429 = rate limited (minute/hour/day budget). One minute-window retry at most; then fail so the
        // caller falls back to the cache instead of sitting on the boot screen.
        if (attempt >= 4 || status === 400 || (status === 429 && attempt >= 2)) throw new OpenMeteoError(status, text.slice(0, 300));
        // 429 = rate limited: wait out the minute window; otherwise short backoff
        await sleep(status === 429 ? 61_000 : attempt * 2_000);
      }
      sent.push([Date.now(), w]);
      i += chunk.length;
      progress?.(i, locs.length);
    }
    return out;
  },

  /** Parse a response body (JSON array for multi-location, object for one). → [Forecast]
   *  Forecast: { utcOffsetSeconds, current: {temperature, weatherCode, windSpeed, windDirection, isDay},
   *              daily: [{date, weatherCode, tempMax, tempMin, precipMax, windSpeedMax, windDirection, uvMax}],
   *              hourly: [{time, weatherCode, precip}] }   (missing values = null)
   *  daily index 0 = yesterday (past_days=1), 1 = today, 2 = tomorrow, …; hourly local time from yesterday 00:00. */
  parse(text, expected) {
    const json = typeof text === 'string' ? JSON.parse(text) : text;
    const items = Array.isArray(json) ? json : (json && typeof json === 'object' ? [json] : []);
    if (items.length !== expected) throw new OpenMeteoError(-1, `expected ${expected} results, got ${items.length}`);
    const d = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const n = v => (typeof v === 'number' && Number.isFinite(v)) ? Math.trunc(v) : null;
    return items.map(o => {
      const arr = (section, key) => (o?.[section]?.[key]) ?? [];
      const cur = o.current ?? {};
      const current = { temperature: d(cur.temperature_2m), weatherCode: n(cur.weather_code), windSpeed: d(cur.wind_speed_10m),
        windDirection: d(cur.wind_direction_10m), isDay: (n(cur.is_day) ?? 1) === 1 };
      const dt = arr('daily', 'time');
      const daily = dt.map((t, i) => {
        const a = k => { const x = arr('daily', k); return i < x.length ? x[i] : null; };
        return { date: typeof t === 'string' ? t : '', weatherCode: n(a('weather_code')), tempMax: d(a('temperature_2m_max')),
          tempMin: d(a('temperature_2m_min')), precipMax: d(a('precipitation_probability_max')),
          windSpeedMax: d(a('wind_speed_10m_max')), windDirection: d(a('wind_direction_10m_dominant')), uvMax: d(a('uv_index_max')) };
      });
      const ht = arr('hourly', 'time'), hc = arr('hourly', 'weather_code'), hp = arr('hourly', 'precipitation_probability');
      const hourly = ht.map((t, i) => ({ time: typeof t === 'string' ? t : '', weatherCode: i < hc.length ? n(hc[i]) : null, precip: i < hp.length ? d(hp[i]) : null }));
      return { utcOffsetSeconds: n(o.utc_offset_seconds) ?? 0, current, daily, hourly };
    });
  },
};
