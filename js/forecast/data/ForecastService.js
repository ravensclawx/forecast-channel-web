// Port of Sources/Forecast/Data/ForecastService.swift (+ the iPhone shell's startup rule, clearStaleForecast).
// Replacement for the channel's WiiConnect24 download path (CWiiConnect24::downloadWeatherForecast/Short,
// NWC24 tasks 3 = forecast.bin, 4 = short.bin, retry margin 720 min). Instead of weather.wapp.wii.com it
// generates the same files from Open-Meteo, caches them (as WC24 containers, in IndexedDB) and validates them
// with the channel's own rules before handing them to the game.
//
// Cache record (key "wc24dl/<lang>_<country>"): { forecast: Uint8Array (container), short: Uint8Array (container),
// time: ms when written, version: generatorVersion }.

import { WeatherData } from './ForecastFormat.js';
import { ForecastGenerator } from './ForecastGenerator.js';
import { WC24Container } from './WC24Container.js';
import { defaultStore } from './KVStore.js';

export class ForecastService {
  /** Bump when the generator's output changes meaningfully (2: original marker ranks from the channel's city
   *  lists). A cache written by an older generator counts as stale. */
  static generatorVersion = 2;
  /** Test hook (the Swift FC_OFFLINE): simulate no network connection. */
  static offline = false;

  /** `store`: { get, put, delete } (async). Defaults to KVStore.defaultStore(). */
  constructor({ generator = new ForecastGenerator(), store = null } = {}) {
    this.generator = generator;
    this.language = generator.options.language;
    this.countryCode = generator.options.countryCode;
    this.refreshInterval = 6 * 3600 * 1000;   // ms — Open-Meteo free tier: ~850 locations per refresh
    this._store = store;
    this.inFlight = null;
  }

  async store() { return this._store ?? (this._store = await defaultStore()); }

  /** URL the original channel would have used (fn_8000AC44): /<language>/<country:03>/forecast.bin */
  originalURL(file) { return `http://weather.wapp.wii.com/${this.language}/${String(this.countryCode).padStart(3, '0')}/${file}`; }

  get cacheKey() { return `wc24dl/${this.language}_${String(this.countryCode).padStart(3, '0')}`; }

  async record() { try { return (await (await this.store()).get(this.cacheKey)) ?? null; } catch { return null; } }

  /** Cached data if present and parseable (expired data allowed — the caller decides via needsRefresh). */
  async cached() {
    const r = await this.record();
    if (!r?.forecast || !r?.short) return null;
    try {
      return new WeatherData(WC24Container.unwrap(r.forecast), WC24Container.unwrap(r.short),
        { language: this.language, regionType: this.generator.options.regionFlag, allowExpired: true });
    } catch { return null; }
  }

  async needsRefresh(now = Date.now()) {
    const r = await this.record();
    if (!r?.time) return true;
    if ((r.version ?? 1) < ForecastService.generatorVersion) return true;
    return now - r.time >= this.refreshInterval;
  }

  /** Delete the cached forecast (next boot downloads behind "One moment, please."). */
  async clear() { try { await (await this.store()).delete(this.cacheKey); } catch { /* ignore */ } }

  /** The iPhone startup rule (GameViewController.clearStaleForecast): forecasts older than the refresh interval
   *  (6 h) — or a requested reset ("Reset Downloaded Data") — are deleted, so the channel downloads fresh data behind
   *  "One moment, please." instead of showing old data. Call before booting the scene (and on returning to the page
   *  after a long time). Returns true when the cache was cleared. */
  async clearStale({ reset = false, now = Date.now() } = {}) {
    const r = await this.record();
    let stale = reset;
    if (r?.time != null && now - r.time >= this.refreshInterval) stale = true;
    if (stale && r) await this.clear();
    return stale && !!r;
  }

  /** Boot path: never blocks on the network when any cache exists. Resolves to the cached data (fresh or stale)
   *  immediately and, if it is stale, starts a background refresh whose result arrives via `refreshed(data)`.
   *  With no cache at all it waits for a generation (first run / after clearStale). */
  async loadForBoot(refreshed = null) {
    const c = await this.cached();
    if (c) {
      if (await this.needsRefresh() && !this.inFlight) {
        this.load({ force: true }).then(d => refreshed?.(d)).catch(() => {});
      }
      return c;
    }
    return this.load({ force: true });
  }

  /** Current data: cached if fresh, otherwise regenerated (falls back to stale cache on network failure).
   *  `progress(done, total)` optional. */
  async load({ force = false, progress = null } = {}) {
    if (!force && !(await this.needsRefresh())) { const c = await this.cached(); if (c) return c; }
    if (this.inFlight) return this.inFlight;
    const gen = this.generator, lang = this.language, region = gen.options.regionFlag;
    const task = (async () => {
      if (ForecastService.offline) { const e = new Error('The Internet connection appears to be offline.'); e.offline = true; throw e; }
      const out = await gen.fetchAndBuild({ progress });
      const data = new WeatherData(out.forecast, out.short, { language: lang, regionType: region });
      try {
        await (await this.store()).put(this.cacheKey, { forecast: out.forecastContainer, short: out.shortContainer,
          time: Date.now(), version: ForecastService.generatorVersion });
      } catch { /* quota / private mode: still usable this session */ }
      return data;
    })();
    this.inFlight = task;
    try { return await task; } catch (err) {
      const c = await this.cached();
      if (c) return c;
      throw err;
    } finally { this.inFlight = null; }
  }

  /** Map download failures onto the NWC24 result codes CConnect switches on (Connect.swift nwc24Code):
   *  -9 = no connection / timeout, -1 = anything else. */
  static nwc24Code(err) {
    if (err?.offline) return -9;
    if (err?.name === 'AbortError' || err?.name === 'TypeError') return -9;   // fetch network failure / timeout
    return -1;
  }
}
