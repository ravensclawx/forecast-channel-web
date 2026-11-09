// Port of Sources/Forecast/Scene/SaveData.swift.
// SaveData_Load (fn_8000BAD4) / SaveData_Store (fn_8000BCCC): NAND "noerase/savedata.dat", 0x20 bytes.
//   +0 'HAF0'  +4 country  +8 location ID  +C temp unit (0 °C, 1 °F)  +10 wind unit (0 mph, 1 km/h)  +1C CRC32(0..1B)
// Stored in IndexedDB under the key "noerase/savedata.dat" as the same 0x20-byte Uint8Array.
// The country field holds code<<24 (0x31000000 for the USA), as the original writes it.

import { CRC32 } from '../data/ForecastFormat.js';
import { defaultStore } from '../data/KVStore.js';

/** Load result codes as returned by SaveData_Load. */
export const SaveDataLoadResult = Object.freeze({ ok: 0, noFile: 1, broken: 2, nandError: 3 });

export class SaveData {
  static size = 0x20;
  static key = 'noerase/savedata.dat';
  static LoadResult = SaveDataLoadResult;
  /** Injectable store ({get, put, delete}); defaults to KVStore.defaultStore(). */
  static store = null;

  constructor({ country = 0, location = 0, tempUnit = 0, windUnit = 0 } = {}) {
    this.country = country >>> 0; this.location = location >>> 0; this.tempUnit = tempUnit >>> 0; this.windUnit = windUnit >>> 0;
  }
  clone() { return new SaveData(this); }
  equals(o) { return o && o.country === this.country && o.location === this.location && o.tempUnit === this.tempUnit && o.windUnit === this.windUnit; }

  static async _store() { return SaveData.store ?? await defaultStore(); }

  /** Parse 0x20 bytes → [LoadResult, SaveData]. */
  static parse(b) {
    if (b == null) return [SaveDataLoadResult.noFile, new SaveData()];
    b = b instanceof Uint8Array ? b : new Uint8Array(b);
    if (b.length !== SaveData.size) return [SaveDataLoadResult.broken, new SaveData()];
    const u32 = o => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    if (CRC32.checksum(b, 0, 0x1C) !== u32(0x1C)) return [SaveDataLoadResult.broken, new SaveData()];
    if (b[0] !== 0x48 || b[1] !== 0x41 || b[2] !== 0x46 || b[3] !== 0x30) return [SaveDataLoadResult.broken, new SaveData()];
    return [SaveDataLoadResult.ok, new SaveData({ country: u32(4), location: u32(8), tempUnit: u32(0xC), windUnit: u32(0x10) })];
  }

  /** Async: → [LoadResult, SaveData]. */
  static async load() {
    let b;
    try { b = await (await SaveData._store()).get(SaveData.key); } catch { return [SaveDataLoadResult.nandError, new SaveData()]; }
    return SaveData.parse(b ?? null);
  }

  bytes() {
    const b = new Uint8Array(SaveData.size);
    b.set([0x48, 0x41, 0x46, 0x30], 0);   // 'HAF0'
    const put = (o, v) => { b[o] = (v >>> 24) & 0xFF; b[o + 1] = (v >>> 16) & 0xFF; b[o + 2] = (v >>> 8) & 0xFF; b[o + 3] = v & 0xFF; };
    put(4, this.country); put(8, this.location); put(0xC, this.tempUnit); put(0x10, this.windUnit);
    put(0x1C, CRC32.checksum(b, 0, 0x1C));
    return b;
  }

  /** Store result: 0 ok, 3 NAND error (anything else the original maps to "unable to save"). Async. */
  async store() {
    try { await (await SaveData._store()).put(SaveData.key, this.bytes()); return 0; } catch { return 3; }
  }

  /** Delete the save (first run again). */
  static async erase() { try { await (await SaveData._store()).delete(SaveData.key); } catch { /* ignore */ } }
}
