// Port of Sources/Forecast/System/Assets.swift — opens the channel's own title contents from the visitor's WAD,
// replacing the SDK's CNTOpen / ARCOpen paths that main.dol uses. Content indices are the TMD indices of HAFE v7.
// Web: built from the WAD + common-key bytes (from IndexedDB, see Storage.js) instead of files on disk.
import { ESTitle } from '../../rvl/ES.js';
import { CX } from '../../rvl/CX.js';
import { ARCArchive } from '../../rvl/ARC.js';
import { DOLImage } from '../../rvl/DOL.js';
import { RVLError } from '../../rvl/BinaryReader.js';
import { Layout } from '../../nw4r/lyt/Layout.js';
import { TPLFile } from '../../nw4r/lyt/TPL.js';
import { ResFont } from '../../nw4r/ut/ResFont.js';
import { ResFile } from '../../nw4r/g3d/ResFile.js';

export const Content = Object.freeze({
  banner: 0, mainDol: 1, opera: 2, operaRes: 3, icon: 4, bannerArc: 5,
  homeButton: 6, systemFonts: 7, earth: 8, weather: 9, html: 10, extra: 11,
});

/** The Forecast Channel (USA) title ID. */
export const HAFE_TITLE_ID = '0001000248414645';

export class Assets {
  /**
   * @param {Uint8Array} wad   the visitor's Forecast Channel WAD
   * @param {Uint8Array} key   the 16-byte Wii common key
   */
  constructor(wad, key) {
    if (!key || key.length !== 16) throw RVLError.missing('16-byte Wii common key');
    this.title = new ESTitle(wad, key);
    if (this.title.titleIDHex !== HAFE_TITLE_ID) throw new RVLError(`This WAD is title ${this.title.titleIDHex}, not the Forecast Channel (USA) ${HAFE_TITLE_ID}.`);
    this.layoutArc = null;
    this.fontCache = new Map();
    this.tplCache = new Map();
    this.hbmArcs = new Map();
    this.sysFont = undefined;
    this.dolImage = null;
  }

  /** From already-decrypted contents ({index: Uint8Array}) — the site's bundled assets/content_<n>.bin. */
  static fromContents(contents) {
    const a = Object.create(Assets.prototype);
    a.title = {
      titleIDHex: HAFE_TITLE_ID,
      content(i) { const c = contents[i]; if (!c) throw RVLError.missing(`content ${i}`); return c; },
      archive(i) { return new ARCArchive(this.content(i)); },
    };
    a.layoutArc = null; a.fontCache = new Map(); a.tplCache = new Map(); a.hbmArcs = new Map();
    a.sysFont = undefined; a.dolImage = null;
    return a;
  }

  /** Throws if the key can't decrypt the WAD (content hash check). */
  validate() { this.title.content(Content.mainDol); return true; }

  /** Decrypted content by TMD index. */
  content(index) { return this.title.content(index); }
  archive(c) { return this.title.archive(c); }

  /** main.dol (content 1) for runtime constant tables. */
  dol() {
    if (!this.dolImage) this.dolImage = new DOLImage(this.content(Content.mainDol));
    return this.dolImage;
  }
  /** Raw main.dol bytes. */
  dolBytes() { return this.content(Content.mainDol); }

  /** weather_layout.arc.LZ (content 9): /arc/blyt, /arc/timg, /arc/font. */
  weatherLayoutArchive() {
    if (this.layoutArc) return this.layoutArc;
    const lz = this.archive(Content.weather).find('weather_layout.arc.LZ');
    if (!lz) throw RVLError.missing('weather_layout.arc.LZ');
    this.layoutArc = new ARCArchive(CX.uncompressIfNeeded(lz));
    return this.layoutArc;
  }

  /** Raw .brlyt bytes. */
  layoutBytes(name) {
    const d = this.weatherLayoutArchive().file(`/arc/blyt/${name}`);
    if (!d) throw RVLError.missing(name);
    return d;
  }
  /** Parsed nw4r::lyt Layout. */
  layout(name) { return new Layout(this.layoutBytes(name)); }

  /** Layout texture by txl1 name (looked up in /arc/timg like the lyt ArcResourceAccessor) → TPLFile image or null. */
  layoutTexture(name) {
    let t = this.tplCache.get(name);
    if (t === undefined) {
      try {
        const d = this.weatherLayoutArchive().file(`/arc/timg/${name}`);
        t = d ? new TPLFile(d) : null;
      } catch { t = null; }
      this.tplCache.set(name, t);
    }
    return t ? t.images[0] : null;
  }

  /** Fonts: layout-archive fonts (/arc/font) or the standalone *.brfnt.LZ files in content 9. */
  font(name) {
    if (this.fontCache.has(name)) return this.fontCache.get(name);
    let data = null;
    try { data = this.weatherLayoutArchive().file(`/arc/font/${name}`); } catch { data = null; }
    if (!data) { try { data = this.archive(Content.weather).find(name.endsWith('.LZ') ? name : name + '.LZ'); } catch { data = null; } }
    let f = null;
    if (data) { try { f = new ResFont(CX.uncompressIfNeeded(data)); } catch { f = null; } }
    if (f) this.fontCache.set(name, f);
    return f;
  }

  /** HOME Button Menu archives in content 6 ("HomeButton3/LZ77_homeBtn[_ENG].arc"). (Web build doesn't use the HBM.) */
  hbmArchive(suffix = '_ENG') {
    if (this.hbmArcs.has(suffix)) return this.hbmArcs.get(suffix);
    const lz = this.archive(Content.homeButton).file(`/HomeButton3/LZ77_homeBtn${suffix}.arc`);
    if (!lz) throw RVLError.missing(`homeBtn${suffix}`);
    const a = new ARCArchive(CX.uncompressIfNeeded(lz));
    this.hbmArcs.set(suffix, a);
    return a;
  }

  /** The console system font wbf1.brfna (nw4r::ut::ArchiveFont), in the title's content 7. */
  systemFont() {
    if (this.sysFont !== undefined) return this.sysFont;
    let f = null;
    try {
      const d = this.archive(Content.systemFonts).find('wbf1.brfna');
      if (d) f = new ResFont(d);
    } catch { f = null; }
    this.sysFont = f;
    return f;
  }

  /** "/earth.brres.LZ" out of content 8, CXUncompressLZ-ed → g3d ResFile. */
  earthBRRES() {
    const lz = this.archive(Content.earth).file('/earth.brres.LZ');
    if (!lz) throw RVLError.missing('/earth.brres.LZ');
    return new ResFile(CX.uncompressIfNeeded(lz));
  }
}
