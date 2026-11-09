// IndexedDB persistence for the web build (replaces the Mac/iOS Application Support folder).
// Keys used: 'wad', 'key' (the visitor's own files — never uploaded), 'save' (SaveData, 0x20 bytes),
// 'forecast', 'short' (downloaded/generated forecast.bin/short.bin), plus anything else callers like.
// Every record is { value: Uint8Array | any, time: ms since epoch }.

const DB_NAME = 'forecast-channel-web';
const STORE = 'blobs';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const r = fn(st);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const Storage = {
  /** Store bytes/values under `key` with the current time. */
  async put(key, value) { await tx('readwrite', st => st.put({ value, time: Date.now() }, key)); },
  /** → { value, time } or null */
  async getRecord(key) { const r = await tx('readonly', st => st.get(key)); return r || null; },
  /** → value or null */
  async get(key) { const r = await Storage.getRecord(key); return r ? r.value : null; },
  /** → ms timestamp or null */
  async time(key) { const r = await Storage.getRecord(key); return r ? r.time : null; },
  async delete(key) { await tx('readwrite', st => st.delete(key)); },
  async keys() { return (await tx('readonly', st => st.getAllKeys())) || []; },
};

/** Synchronous mirror for code ported from synchronous Swift (SaveData load/store): preload once, write through. */
export class SyncStore {
  constructor() { this.map = new Map(); }
  async preload(keys) {
    for (const k of keys) { const r = await Storage.getRecord(k); if (r) this.map.set(k, r); }
    return this;
  }
  get(key) { const r = this.map.get(key); return r ? r.value : null; }
  time(key) { const r = this.map.get(key); return r ? r.time : null; }
  /** Updates the mirror immediately and persists asynchronously (errors logged once). */
  put(key, value) {
    this.map.set(key, { value, time: Date.now() });
    Storage.put(key, value).catch(e => console.warn('Storage.put failed', key, e));
  }
  delete(key) { this.map.delete(key); Storage.delete(key).catch(() => {}); }
}
