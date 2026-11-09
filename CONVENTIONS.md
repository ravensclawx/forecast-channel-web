# forecast-channel-web — porting conventions

A line-by-line JavaScript port of `forecast-channel-ios` (Swift + Metal, the earlier native version) to plain
HTML + ES modules + WebGL2 + Web Audio. **No frameworks, no bundler, no build step**: `index.html` loads
`js/main.js` as `<script type="module">`; it must run from any static host (and `python3 -m http.server`).

## Mapping rules
- One Swift file → one JS module at the mirrored path (`Sources/NW4R/Lyt/Layout.swift` → `js/nw4r/lyt/Layout.js`,
  `Sources/Forecast/Scene/Normal/HubPages.swift` → `js/forecast/scene/normal/HubPages.js`). Same class, method,
  property and enum names (camelCase as in Swift), same decomp comments (function names/addresses). Named exports.
- Swift structs → JS classes (copy where Swift relies on value semantics: `.clone()`), enums → frozen objects or
  string constants, optionals → `null`, `SIMD2/3/4<Float>` → plain arrays `[x, y]` / `Float32Array` where hot.
  Integer maths that relies on Swift wrapping/truncation must use `| 0`, `Math.trunc`, `>>> 0`, `Math.imul`.
- Matrices: `js/gx/mat.js` provides column-major 4×4 helpers mirroring the simd calls used (`mul`, `translate`,
  `scale`, `rotX/Y/Z`, `perspective`, `lookAt`, `transformPoint`). Same conventions as the Swift code.
- `MTLRenderCommandEncoder enc` parameters stay as a parameter named `enc`: it is the **frame drawing context**
  (`js/forecast/render/GXWebGL.js` — the WebGL2 replacement for `GXMetal`). Screens never touch `gl` directly.
- Textures are `WebGLTexture` wrapped as `{ tex, width, height, logicalWidth, logicalHeight }`.
- Logging: no console spam in hot paths.

## Platform (web) decisions
- **Layout follows the window, live** (wide → widescreen, tall → portrait with the window's own height; see js/main.js). Originally: **two modes, chosen at startup** (`js/main.js`): **mobile** (coarse pointer / narrow screen) = the iPhone portrait
  build below; **desktop** (fine pointer, landscape window) = the original Wii widescreen channel exactly like the Mac
  app (`ForecastMac`): logical 832 × 456 (`isWide = true`, `LogicalScreen.isPortrait = false`, height 456),
  letterboxed 16:9 with black bars, mouse = Wii Remote pointer (left = A, right = B, wheel = +/−, arrow keys =
  d-pad, Esc = B, Enter = A, 1/2 keys), KPad smoothing on, and the **original Wii cursor** (port `Cursor.swift` +
  `Sources/NW4R/Ef/*` → `js/forecast/ui/Cursor.js`, `js/nw4r/ef/*`). HOME Menu/manual still excluded. Every
  `isPortrait` branch in the Swift code must be kept so both modes work from the same modules.
- **Mobile: portrait, letterboxed**: the logical screen is 608 × 1322 (the iPhone layout) scaled to fit the browser
  window width/height with **black bars** (top/bottom or sides). `LogicalScreen.isPortrait = true`,
  `safeTop = safeBottom = 0`. **No edge extension** of the button rows (`PortraitArrange.extendBodies`,
  `edgeStrip`, hit extension) — leave those out. Everything else of the portrait arrangement stays.
- Input: Pointer Events → `TouchInput` (same logic as iOS). No cursor drawn. Mouse works as one finger.
  Wheel = pinch (desktop convenience).
- Audio: Web Audio (AudioWorklet or ScriptProcessor fallback) running the ported NW4R sound engine at 32 kHz;
  audio starts on the first user gesture.
- Storage: IndexedDB (`js/forecast/system/Storage.js`): the user's WAD + common key (bring your own — chosen with
  `<input type=file>` on first run, never uploaded), the save file (`SaveData`), the forecast cache.
- WAD decrypt: AES-128-CBC without padding — implement with WebCrypto (append a crafted padding block) or a small
  pure-JS AES. LZ/Huffman/U8 in JS.
- Weather: Open-Meteo fetched from the browser (same generator logic → `forecast.bin`/`short.bin` bytes → parsed by
  the same `ForecastFormat` code). Cache 6 h in IndexedDB.
- Settings: the iPhone used iOS Settings; the web build uses the **channel's own Settings screen** again (top-right
  "Settings" button enabled), plus browser Geolocation for the closest city when allowed.
- Upscaled textures: not used (bilinear filtering of the originals).
- Excluded: HOME Menu, Operations Guide manual, Wii cursor, Mac/iOS shells, dev tools (fcdump, fcdata, …).

## Legal
No Nintendo data, keys, screenshots or extracted assets in this repository. The page asks the visitor for their own
`HAFE` v7 WAD and common key.
