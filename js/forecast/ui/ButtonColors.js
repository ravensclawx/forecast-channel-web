/**
 * Button colour schemes. Every screen's CLayout passes the table lbl_801D7060 (4 × 0x3C) to its CPaneCtls
 * (CLayout_ctor r6 → CPaneCtl +04); it is filled by the static initialiser fn_80010728 from .sdata2 constants.
 * (InitButtonColorSchemes / lbl_801F6B68 is only CPaneCtl's fallback for a NULL table — red hover — and no
 * screen uses it.) Offsets: +00/+04 body normal c0/c1, +08/+0C icon normal, +10 text normal, +14/+18 body
 * pressed/hover, +1C/+20 icon pressed, +24 text pressed, +28/+2C body selected, +30/+34 icon selected, +38 text
 * selected. Alpha bytes are 0 in the table; CPaneCtl_PreDraw writes alpha separately. Colours are [r, g, b, a].
 */
const c = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
//   +00 body n c0  +04 c1      +08 icon n   +0C          +10 text n   +14 body p   +18 body p c1
//   +1C icon p     +20         +24 text p   +28 body s   +2C          +30 icon s   +34          +38 text s
function scheme(text, hover, textHover) {
    return [0x00000000, 0xFFFFFF00, 0x00000000, 0xFFFFFF00, text, 0x00000000, hover,
            0xFFFFFF00, 0x00000000, textHover, 0xC1000000, 0xC1000000, 0xFFFFFF00, 0xFFFFFF00, 0x00000000].map(c);
}
const schemes = [
    scheme(0x00000000, 0x00C0FF00, 0xFFFFFF00),   // 0: black text, light-blue hover
    scheme(0xFFFFFF00, 0xFFFFFF00, 0x00000000),   // 1: white text, white hover
    scheme(0xFFFFFF00, 0x00C0FF00, 0xFFFFFF00),   // 2: white text, light-blue hover
    scheme(0x00000000, 0x59DDFF00, 0xFFFFFF00),   // 3: black text, cyan hover
    ...Array.from({ length: 12 }, () => Array.from({ length: 15 }, () => [0, 0, 0, 0])),
];

export const ButtonColors = {
    schemes,
    /** Word index by byte offset. */
    at(scheme, off) { return schemes[Math.min(Math.max(scheme, 0), 15)][off >> 2].slice(); },
    /** fn_800370F8: per-channel lerp a→b by n/max (integer maths). */
    lerp(a, b, n, max) {
        if (!(max > 0)) return a.slice();
        const o = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) o[i] = (a[i] + Math.trunc((b[i] - a[i]) * n / max)) & 0xFF;
        return o;
    },
};
