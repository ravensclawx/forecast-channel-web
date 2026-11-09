# Forecast Channel for the Web

**forecast-channel-web** by RavensClawX

The Wii Forecast Channel, in your browser. A plain HTML + JavaScript (ES modules) port of
[forecast-channel-ios](https://github.com/RavensClawX/forecast-channel-ios), itself a decompilation-based rebuild of
the original channel. No frameworks, no build step: WebGL2 for graphics (the Wii's TEV pipeline translated to GLSL),
Web Audio for the channel's own music and sound effects, IndexedDB for the save and forecast cache.

> **Bring your own WAD.** This repository contains no Nintendo code, assets or keys. On first visit the page asks for
> your own copy of the Forecast Channel (USA, `HAFE` v7, `.wad`) and your Wii common key. They are decrypted and
> stored only in your browser (IndexedDB) and are never uploaded.

## Controls

An authentic port of the original widescreen channel (no HOME Menu). The picture scales to your window with black
bars; the layout never changes.

- Mouse = Wii Remote: the Wii hand cursor, left click = A, right click = B, scroll wheel = +/− (globe zoom).
- Keyboard: arrows = d-pad, Enter = A, Esc = B, =/- = +/−.
- "Wii Menu" returns to the hub (there is no Wii Menu in a browser).

## Run it

Any static file server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It can be hosted as-is on GitHub Pages or any static host. Weather comes straight from
[Open-Meteo](https://open-meteo.com) (free, no key) and is cached for 6 hours.

## Layout

```
index.html, css/app.css, js/main.js   page shell: first-run setup, modes, input, frame loop
js/rvl/       WAD/ES decryption (AES-128-CBC), U8 archives, LZ/Huffman, DOL
js/gx/        GX state model, texture decoders, TEV → GLSL ES 3.00 shader generator, matrices
js/nw4r/      lyt (layouts/animations), ut (fonts), g3d (earth model), ef (cursor effects), snd (sound engine)
js/forecast/  the channel: render (WebGL2 backend), ui, scene (hub, globe, city lists, settings…), game (globe),
              data (forecast.bin generator/parser, Open-Meteo, cache), sound (Web Audio output)
tools/        node tests against your own WAD (not needed to run the site)
```

See `CONVENTIONS.md` for how the Swift sources map to the JavaScript modules.

## Credits

- Weather data: [Open-Meteo](https://open-meteo.com) (CC BY 4.0). City data: [GeoNames](https://www.geonames.org) (CC BY 4.0).
- Globe marker ranks from the original channel's city lists, as preserved by RiiConnect24's File-Maker.
- Built on the reverse-engineering in forecast-channel-ios (decomp-toolkit, m2c, Dolphin as reference).

## Disclaimer

Not affiliated with or endorsed by Nintendo. Wii and Forecast Channel are trademarks of Nintendo. You must own the
channel to use this.

License: TBD by the author.
