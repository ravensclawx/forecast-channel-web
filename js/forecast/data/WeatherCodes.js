// Port of Sources/Forecast/Data/WeatherCodes.swift.
// Weather-type table emitted by our generator, and the WMO (Open-Meteo `weather_code`) → channel mapping.
//
// The channel does not hard-code data codes: forecast.bin carries a table {data code u16, display code u16,
// name offset} and fn_800203F0 maps a forecast's data code to the display code that picks the icon
// (fn_80020574: low 15 bits 0x00–0x7E, bit 15 = night). We therefore use data code == display code.
//
// Display-code meanings for the international (≥0x64) icon set follow the codes the channel was served
// historically (cross-checked against RiiConnect24 File-Maker's condition list, AGPL-3.0, used as a reference
// only — no code or text copied). Names below are our own English strings.

import { WeatherType, IndexText } from './ForecastFormat.js';

const K = (display, name, hasNight) => Object.freeze({ display, name, hasNight });

const sunny = K(0x65, 'Sunny', true);
const partlyCloudy = K(0x66, 'Partly Cloudy', true);
const partlySunnyShowers = K(0x67, 'Partly Sunny with Showers', false);
const partlySunnyFlurries = K(0x68, 'Partly Sunny with Flurries', false);
const cloudy = K(0x6A, 'Cloudy', true);
const mostlyCloudy = K(0x6B, 'Mostly Cloudy', true);
const cloudyShowers = K(0x6C, 'Mostly Cloudy with Showers', true);
const cloudySnow = K(0x6D, 'Mostly Cloudy with Snow', true);
const rain = K(0x6F, 'Rain', false);
const showers = K(0x71, 'Showers', true);
const rainSnow = K(0x72, 'Rain and Snow', false);
const freezingRain = K(0x73, 'Freezing Rain', false);
const snow = K(0x74, 'Snow', false);
const flurries = K(0x76, 'Flurries', true);
const sleet = K(0x79, 'Sleet', false);
const haze = K(0x7A, 'Haze', true);
const fog = K(0x7C, 'Fog', false);
const thunder = K(0x7D, 'Thunderstorms', true);

const all = Object.freeze([sunny, partlyCloudy, partlySunnyShowers, partlySunnyFlurries, cloudy, mostlyCloudy, cloudyShowers,
  cloudySnow, rain, showers, rainSnow, freezingRain, snow, flurries, sleet, haze, fog, thunder]);

/** Night-variant names (clear sky at night reads "Clear", not "Sunny"). */
function nightName(k) {
  switch (k.display) {
    case 0x65: return 'Clear';
    case 0x66: return 'Partly Cloudy';
    default: return k.name;
  }
}

/** WMO 4677 code (as returned by Open-Meteo) → channel kind. */
function kind(wmo) {
  switch (wmo) {
    case 0: return sunny;
    case 1: return sunny;                 // mainly clear
    case 2: return partlyCloudy;
    case 3: return cloudy;
    case 45: case 48: return fog;
    case 51: case 53: case 55: return showers;      // drizzle
    case 56: case 57: case 66: case 67: return freezingRain;
    case 61: case 63: case 65: return rain;
    case 71: case 73: case 75: return snow;
    case 77: return flurries;             // snow grains
    case 80: return partlySunnyShowers;
    case 81: case 82: return showers;
    case 85: return partlySunnyFlurries;
    case 86: return cloudySnow;
    case 95: case 96: case 99: return thunder;
    default: return cloudy;
  }
}

export const WeatherCodes = Object.freeze({
  sunny, partlyCloudy, partlySunnyShowers, partlySunnyFlurries, cloudy, mostlyCloudy, cloudyShowers, cloudySnow,
  rain, showers, rainSnow, freezingRain, snow, flurries, sleet, haze, fog, thunder,
  all,
  nightName,
  kind,

  /** The weather-type table written into forecast.bin (day + night variants). */
  get table() {
    const t = [];
    for (const k of all) {
      t.push(new WeatherType(k.display, k.display, k.name));
      if (k.hasNight) t.push(new WeatherType(k.display | 0x8000, k.display | 0x8000, nightName(k)));
    }
    return t;
  },

  /** Data code for a WMO code, using the night variant where one exists. */
  code(wmo, night = false) {
    const k = kind(wmo);
    return night && k.hasNight ? (k.display | 0x8000) : k.display;
  },

  /** UV index text table (WHO categories) — ids 0…12; days reference round(uv_index_max). */
  get uvTable() {
    const out = [];
    for (let i = 0; i <= 12; i++) {
      const s = i <= 2 ? 'Low' : i <= 5 ? 'Moderate' : i <= 7 ? 'High' : i <= 10 ? 'Very High' : 'Extreme';
      out.push(new IndexText(i, s));
    }
    return out;
  },

  /** Compass bucket used by the channel: 1 = NNE … 15 = NNW, 16 = N. `degrees` may be null. */
  windDirection(degrees) {
    if (degrees == null || !Number.isFinite(degrees)) return 0xFF;
    const i = Math.trunc(((degrees % 360) + 360) % 360 / 22.5 + 0.5) % 16;
    return i === 0 ? 16 : i;
  },
});
