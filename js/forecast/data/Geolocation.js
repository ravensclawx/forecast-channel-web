// Browser geolocation → nearest home-country city of the channel's catalog (the iPhone shell's "Current Location",
// GameViewController.locationManager(_:didUpdateLocations:)). Used when the visitor hasn't chosen a city.

import { ForecastGenerator } from './ForecastGenerator.js';

let catalog = null;
/** Home-country cities with their location IDs: [{ id: LocationID, lat, lon, city }]. */
function homeCatalog() {
  if (catalog) return catalog;
  const g = new ForecastGenerator();
  const ids = g.locationIDs();
  catalog = g.cities.map((c, i) => ({ c, id: ids[i] })).filter(x => x.c.isHome)
    .map(({ c, id }) => ({ id, lat: c.latitude, lon: c.longitude, city: c }));
  return catalog;
}

/** Nearest catalog city by great-circle distance. → { id: LocationID, city: CatalogCity } */
export function nearestHomeCity(latitude, longitude) {
  const la1 = latitude * Math.PI / 180;
  const d = (a, b) => {
    const la2 = a * Math.PI / 180, dl = (b - longitude) * Math.PI / 180;
    return Math.acos(Math.min(1, Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl)));
  };
  let best = null, bd = Infinity;
  for (const e of homeCatalog()) { const v = d(e.lat, e.lon); if (v < bd) { bd = v; best = e; } }
  return best ? { id: best.id, city: best.city } : null;
}

/** Ask the browser for the position (may prompt). Resolves to the nearest city, or null when unavailable/denied. */
export function locateNearestCity({ timeout = 10_000, maximumAge = 30 * 60_000 } = {}) {
  return new Promise(resolve => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) { resolve(null); return; }
    geo.getCurrentPosition(
      p => resolve(nearestHomeCity(p.coords.latitude, p.coords.longitude)),
      () => resolve(null),
      { enableHighAccuracy: false, timeout, maximumAge });
  });
}
