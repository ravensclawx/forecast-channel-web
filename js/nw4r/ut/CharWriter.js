// Port of Sources/NW4R/Ut/CharWriter.swift — nw4r::ut::CharWriter / TextWriter: GX setup
// (fn_800D3C7C / fn_800D5180) and text layout.
import { GXState } from '../../gx/GXState.js';
import { GXTexFmt } from '../../gx/GXTexture.js';
import { CA, AA } from '../lyt/Layout.js';

const COLOR0A0 = 4, COLOR1A1 = 5;

export const CharWriter = {
  /**
   * CharWriter::SetupGX. `minColor`/`maxColor` = color mapping (black / white) as [r,g,b,a];
   * default [0,0,0,0] / [255,255,255,255].
   */
  setupGX(sheetFormat, minColor, maxColor) {
    const gx = new GXState();
    gx.setTevSwapModeTable(0, 0, 1, 2, 3);
    gx.setZMode(false, 7, false);
    gx.setNumChans(1);
    gx.setChanCtrl(COLOR0A0, false, 0, 1);
    gx.setChanCtrl(COLOR1A1, false, 0, 0);
    gx.setNumTexGens(1);
    gx.setTexCoordGen(0, 1, 4);
    gx.setNumIndStages(0);
    gx.setBlendMode(1, 4, 5, 0xF);
    gx.setAlphaCompare(7, 0, 0, 7, 0);
    const isDefaultMapping = minColor.every((v) => v === 0) && maxColor.every((v) => v === 255);
    if (!isDefaultMapping) {
      // fn_800D5180 SetupGXWithColorMapping
      gx.setNumTevStages(2);
      gx.setTevDirect(0); gx.setTevDirect(1);
      gx.setTevSwapMode(0, 0, 0); gx.setTevSwapMode(1, 0, 0);
      gx.setTevOrder(0, 0, 0, 0xFF);
      gx.setTevColor(1, minColor); gx.setTevColor(2, maxColor);
      gx.setTevColorIn(0, CA.c0, CA.c1, CA.texc, CA.zero);
      gx.setTevAlphaIn(0, AA.a0, AA.a1, AA.texa, AA.zero);
      gx.setTevColorOp(0, 0, 0, 0, true, 0);
      gx.setTevAlphaOp(0, 0, 0, 0, true, 0);
      gx.setTevOrder(1, 0xFF, 0xFF, 4);
      gx.setTevColorIn(1, CA.zero, CA.cprev, CA.rasc, CA.zero);
      gx.setTevAlphaIn(1, AA.zero, AA.aprev, AA.rasa, AA.zero);
      gx.setTevColorOp(1, 0, 0, 0, true, 0);
      gx.setTevAlphaOp(1, 0, 0, 0, true, 0);
      return gx;
    }
    gx.setNumTevStages(1);
    gx.setTevDirect(0);
    gx.setTevSwapMode(0, 0, 0);
    gx.setTevOrder(0, 0, 0, 4);
    const i4 = GXTexFmt?.i4 ?? 0, i8 = GXTexFmt?.i8 ?? 1;
    if (sheetFormat === i4 || sheetFormat === i8) {
      // color = rasterized; alpha = texture intensity × rasterized alpha
      gx.setTevColorIn(0, CA.zero, CA.zero, CA.zero, CA.rasc);
      gx.setTevAlphaIn(0, AA.zero, AA.texa, AA.rasa, AA.zero);
      gx.setTevColorOp(0, 0, 0, 0, true, 0);
      gx.setTevAlphaOp(0, 0, 0, 0, true, 0);
    } else {
      gx.setTevOp(0, 0); // GX_MODULATE
    }
    return gx;
  },

  /**
   * TextBox text layout: lines measured with the font's char widths and the box's spacing, block placed by
   * textPosition (H = %3, V = /3), lines aligned by textAlignment (0 = follow H). Coordinates are pane-local
   * (y up), relative to the pane rectangle's top-left.
   * Returns quads: { rect:[x0,y0,x1,y1], uv:[u0,v0,u1,v1], sheet, top:[rgba], bottom:[rgba] }.
   */
  layout(text, font, fontSize, charSpace, lineSpace, boxSize, textPosition, textAlignment, top, bottom) {
    const sx = fontSize[0] / Math.max(font.width, 1), sy = fontSize[1] / Math.max(font.height, 1);
    const lineHeight = font.lineFeed * sy + lineSpace;
    const lines = [[]];
    for (const c of text) { if (c === 0x0A) lines.push([]); else lines[lines.length - 1].push(c); }
    const lineWidth = (l) => {
      if (!l.length) return 0;
      let w = 0;
      for (const c of l) w += font.glyph(c).widths.charWidth * sx + charSpace;
      return w - charSpace;
    };
    const widths = lines.map(lineWidth);
    const blockW = widths.length ? Math.max(...widths) : 0;
    const blockH = lines.length * lineHeight - lineSpace;
    const hPos = textPosition % 3, vPos = (textPosition / 3) | 0;
    const blockX = hPos === 0 ? 0 : (hPos === 1 ? (boxSize[0] - blockW) / 2 : boxSize[0] - blockW);
    const blockY = vPos === 0 ? 0 : (vPos === 1 ? (boxSize[1] - blockH) / 2 : boxSize[1] - blockH);
    const align = textAlignment === 0 ? hPos : textAlignment - 1;
    const quads = [];
    lines.forEach((l, i) => {
      let x = blockX + (align === 0 ? 0 : (align === 1 ? (blockW - widths[i]) / 2 : blockW - widths[i]));
      const y = blockY + i * lineHeight;
      for (const c of l) {
        const g = font.glyph(c);
        const gw = g.widths.glyphWidth;
        const left = x + g.widths.left * sx;
        const h = font.cellHeight * sy;
        // 1-texel pad each side (blank cell gutter) so magnified, filtered glyph edges aren't cut flat.
        const pad = 0.5;
        quads.push({
          rect: [left - pad * sx, -y, left + (gw + pad) * sx, -(y + h)],
          uv: [(g.cellX - pad) / font.sheetWidth, g.cellY / font.sheetHeight,
               (g.cellX + gw + pad) / font.sheetWidth, (g.cellY + font.cellHeight) / font.sheetHeight],
          sheet: g.sheet, top, bottom,
        });
        x += g.widths.charWidth * sx + charSpace;
      }
    });
    return quads;
  },
};
