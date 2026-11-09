// Port of Sources/GX/GXTexture.swift — GX texture formats (GXTexFmt) and decoders.
// Semantics follow Dolphin's TextureDecoder_Generic.cpp. Output: Uint8Array RGBA8, row-major.

export const GXTexFmt = Object.freeze({
  i4: 0, i8: 1, ia4: 2, ia8: 3, rgb565: 4, rgb5a3: 5, rgba8: 6, c4: 8, c8: 9, c14x2: 10, cmpr: 14,
});

/** Block (tile) dimensions in texels: [w, h]. */
export function texFmtBlock(f) {
  switch (f) {
    case GXTexFmt.i4: case GXTexFmt.c4: case GXTexFmt.cmpr: return [8, 8];
    case GXTexFmt.i8: case GXTexFmt.ia4: case GXTexFmt.c8: return [8, 4];
    default: return [4, 4];
  }
}
export function texFmtBitsPerPixel(f) {
  switch (f) {
    case GXTexFmt.i4: case GXTexFmt.c4: case GXTexFmt.cmpr: return 4;
    case GXTexFmt.i8: case GXTexFmt.ia4: case GXTexFmt.c8: return 8;
    case GXTexFmt.rgba8: return 32;
    default: return 16;
  }
}
function roundUpGX(n, a) { return Math.ceil(n / a) * a; }
export function texFmtByteSize(f, width, height) {
  const [bw, bh] = texFmtBlock(f);
  return roundUpGX(width, bw) * roundUpGX(height, bh) * texFmtBitsPerPixel(f) / 8;
}

const c5 = v => ((v << 3) | (v >> 2)) & 0xFF;
const c6 = v => ((v << 2) | (v >> 4)) & 0xFF;
const c4 = v => ((v << 4) | v) & 0xFF;
const c3 = v => ((v << 5) | (v << 2) | (v >> 1)) & 0xFF;

function rgb565(v) { return [c5((v >> 11) & 0x1F), c6((v >> 5) & 0x3F), c5(v & 0x1F)]; }
function rgb5a3(v) {
  if (v & 0x8000) return [c5((v >> 10) & 0x1F), c5((v >> 5) & 0x1F), c5(v & 0x1F), 255];
  return [c4((v >> 8) & 0xF), c4((v >> 4) & 0xF), c4(v & 0xF), c3((v >> 12) & 0x7)];
}

/** Dolphin's CMPR palette (incl. the GX quirk: index 3 = midpoint colour with alpha 0 when c0 <= c1). */
export function cmprPalette(c0, c1) {
  const a = rgb565(c0), b = rgb565(c1);
  const mix = (x, y) => ((x * 3 + y * 5) / 8) | 0;
  if (c0 > c1) {
    return [[a[0], a[1], a[2], 255], [b[0], b[1], b[2], 255],
      [mix(b[0], a[0]), mix(b[1], a[1]), mix(b[2], a[2]), 255],
      [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2]), 255]];
  }
  const m = [((a[0] + b[0]) / 2) | 0, ((a[1] + b[1]) / 2) | 0, ((a[2] + b[2]) / 2) | 0];
  return [[a[0], a[1], a[2], 255], [b[0], b[1], b[2], 255], [m[0], m[1], m[2], 255], [m[0], m[1], m[2], 0]];
}

export const GXTextureDecoder = {
  rgb565, rgb5a3, cmprPalette,
  /**
   * Decode to linear RGBA8. `palette` (array of u16 entries) needed for C4/C8/C14X2;
   * paletteFormat 0 IA8, 1 RGB565, 2 RGB5A3.
   */
  decode(src, offset, width, height, format, palette = [], paletteFormat = 2) {
    const out = new Uint8Array(width * height * 4);
    const [bw, bh] = texFmtBlock(format);
    let p = offset | 0;
    const put = (x, y, r, g, b, a) => {
      if (x >= width || y >= height) return;
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    };
    const pal = (i, x, y) => {
      const v = i < palette.length ? palette[i] : 0;
      switch (paletteFormat) {
        case 0: put(x, y, v & 0xFF, v & 0xFF, v & 0xFF, v >> 8); break;
        case 1: { const c = rgb565(v); put(x, y, c[0], c[1], c[2], 255); break; }
        default: { const c = rgb5a3(v); put(x, y, c[0], c[1], c[2], c[3]); }
      }
    };
    const u16 = o => (src[o] << 8) | src[o + 1];

    for (let by = 0; by < height; by += bh) {
      for (let bx = 0; bx < width; bx += bw) {
        switch (format) {
          case GXTexFmt.i4:
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) {
              const v = src[p++];
              const a = c4(v >> 4), b = c4(v & 0xF);
              put(bx + x, by + y, a, a, a, a); put(bx + x + 1, by + y, b, b, b, b);
            }
            break;
          case GXTexFmt.i8:
            for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) { const v = src[p++]; put(bx + x, by + y, v, v, v, v); }
            break;
          case GXTexFmt.ia4:
            for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
              const v = src[p++];
              const i = c4(v & 0xF); put(bx + x, by + y, i, i, i, c4(v >> 4));
            }
            break;
          case GXTexFmt.ia8:
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
              const a = src[p], i = src[p + 1]; p += 2; put(bx + x, by + y, i, i, i, a);
            }
            break;
          case GXTexFmt.rgb565:
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const c = rgb565(u16(p)); p += 2; put(bx + x, by + y, c[0], c[1], c[2], 255); }
            break;
          case GXTexFmt.rgb5a3:
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const c = rgb5a3(u16(p)); p += 2; put(bx + x, by + y, c[0], c[1], c[2], c[3]); }
            break;
          case GXTexFmt.rgba8:
            for (let i = 0; i < 16; i++) {
              const x = i % 4, y = (i / 4) | 0;
              put(bx + x, by + y, src[p + i * 2 + 1], src[p + 32 + i * 2], src[p + 32 + i * 2 + 1], src[p + i * 2]);
            }
            p += 64;
            break;
          case GXTexFmt.c4:
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) {
              const v = src[p++]; pal(v >> 4, bx + x, by + y); pal(v & 0xF, bx + x + 1, by + y);
            }
            break;
          case GXTexFmt.c8:
            for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) { pal(src[p], bx + x, by + y); p++; }
            break;
          case GXTexFmt.c14x2:
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { pal(u16(p) & 0x3FFF, bx + x, by + y); p += 2; }
            break;
          case GXTexFmt.cmpr:
            for (let sub = 0; sub < 4; sub++) {
              const sx = bx + (sub & 1) * 4, sy = by + (sub >> 1) * 4;
              const pl = cmprPalette(u16(p), u16(p + 2));
              for (let y = 0; y < 4; y++) {
                const row = src[p + 4 + y];
                for (let x = 0; x < 4; x++) {
                  const c = pl[(row >> (6 - x * 2)) & 3];
                  put(sx + x, sy + y, c[0], c[1], c[2], c[3]);
                }
              }
              p += 8;
            }
            break;
        }
      }
    }
    return out;
  },
};
