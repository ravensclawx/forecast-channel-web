// Key/value persistence for the data layer (forecast cache, save file).
//
// Uses track A's js/forecast/system/Storage.js when it provides async get/put/delete (also accepted: set/remove,
// either as named exports or on a `Storage` / default export object). Otherwise falls back to a small IndexedDB
// store of its own ("forecast-channel-data" / "kv"), and to memory when IndexedDB doesn't exist (node tests).
// Values are structured-cloneable (Uint8Array, plain objects, numbers).

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k); }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
}

class IndexedDBKV {
  constructor(name = 'forecast-channel-data', store = 'kv') { this.name = name; this.store = store; this.db = null; }
  open() {
    if (this.db) return this.db;
    this.db = new Promise((res, rej) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.store);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return this.db;
  }
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(this.store, mode);
      const r = fn(t.objectStore(this.store));
      t.oncomplete = () => res(r?.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  get(k) { return this.tx('readonly', s => s.get(k)); }
  put(k, v) { return this.tx('readwrite', s => s.put(v, k)).then(() => undefined); }
  delete(k) { return this.tx('readwrite', s => s.delete(k)).then(() => undefined); }
}

function adapt(o) {
  if (!o) return null;
  const get = o.get, put = o.put ?? o.set, del = o.delete ?? o.remove;
  if (typeof get !== 'function' || typeof put !== 'function' || typeof del !== 'function') return null;
  return { get: k => get.call(o, k), put: (k, v) => put.call(o, k, v), delete: k => del.call(o, k) };
}

let shared = null;

/** The shared store (resolved once). */
export async function defaultStore() {
  if (shared) return shared;
  let s = null;
  try {
    const m = await import('../system/Storage.js');
    s = adapt(m) ?? adapt(m.Storage) ?? adapt(m.default) ?? adapt(m.storage);
  } catch { /* not available yet */ }
  if (!s) s = typeof indexedDB !== 'undefined' ? new IndexedDBKV() : new MemoryKV();
  shared = s;
  return s;
}

/** Tests: force a specific store (e.g. `new MemoryKV()`). */
export function setDefaultStore(s) { shared = s; }

export { MemoryKV, IndexedDBKV };
