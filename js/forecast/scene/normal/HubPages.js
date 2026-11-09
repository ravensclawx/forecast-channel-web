import { SpriteText } from '../../ui/SpriteText.js';
import { LogicalScreen } from '../../render/LogicalScreen.js';
import { Lang } from '../../ui/PaneCtl.js';
import * as B from '../../ui/bridge.js';

const sameLoc = (a, b) => a != null && b != null && (a.raw ?? a) === (b.raw ?? b);
const clampByte = (v) => Math.max(0, Math.min(255, Math.trunc(v)));

/**
 * lbl_803309BC — the records the hub shows for the selected location:
 * {+0 place, +4 long forecast, +8 summary, +C current conditions (short.bin)}.
 */
export class HubRecord {
    constructor(place, long, summary, current, data) {
        this.place = place; this.long = long; this.summary = summary; this.current = current; this.data = data;
    }

    /** Look up `id` (falls back to the first long-forecast location when the id isn't in the data — preview/test only). */
    static find(data, id) {
        if (!data) return null;
        const f = data.forecast;
        let loc = id;
        if (!f.place(loc) && f.longForecasts[0]?.location) loc = f.longForecasts[0].location;
        return new HubRecord(f.place(loc), f.longForecasts.find(l => sameLoc(l.location, loc)) ?? null,
                             f.summaries.find(s => sameLoc(s.location, loc)) ?? null,
                             data.short.current.find(c => sameLoc(c.location, loc)) ?? null, data);
    }

    /** ForecastFindById → {icon (display code), name} */
    weather(code) {
        if (code == null || code === 0xFFFF) return null;
        const t = this.data.forecast.weatherTypes.find(w => w.code === code);
        return t ? { icon: t.displayCode, name: t.name } : null;
    }
}

/** Strings that live in main.dol (wind direction / unit names), read at runtime from the user's own DOL. */
export class DOLStrings {
    constructor(assets) { this.dol = B.dolImage(B.mainDolBytes(assets)); }

    wstring(address) {
        if (!address) return '';
        const o = this.dol.offset(address);
        if (o == null) return '';
        const r = B.beReader(this.dol.bytes), u = [];
        let p = o;
        while (p + 1 < this.dol.bytes.length) { const c = r.u16(p); if (c === 0) break; u.push(c); p += 2; }
        return B.fromUtf16(u);
    }
    /** Wind direction names: lbl_801994D8 (region US) / lbl_80199748 (EU), [lang][dir 0..16] (stride 0x44). */
    windDirection(dir, lang, region) {
        const base = region === 1 ? 0x801994D8 : 0x80199748;
        return this.wstring(this.dol.u32(base + lang * 0x44 + dir * 4));
    }
    /** Wind unit names: lbl_801999B0 (US) / lbl_80199A70 (EU), [lang][unit]. */
    windUnit(unit, lang, region) {
        const base = region === 1 ? 0x801999B0 : 0x80199A70;
        return this.wstring(this.dol.u32(base + lang * 8 + unit * 4));
    }
    /** Weekday sprite (TPLCommon image) for lang/wday: lbl_80179CFC + lang·0x1C + wday·4. */
    weekdayImage(wday, lang) { return this.dol.u32(0x80179CFC + lang * 0x1C + wday * 4); }
}

/** Common page object (fn_8001C334 base ctor; vtable {dtor, init, ?, ?, draw +0x10, calc +0x14, isAvailable +0x18}). */
export class HubPage {
    constructor(hub, name, index, title) {
        this.hub = hub; this.ctx = hub.ctx;
        const ctx = this.ctx;
        this.layout = ctx.layout(name);                          // +04
        this.noService = ctx.layout('life_no_service.brlyt');    // +A0
        this.titleIndex = title;                                 // +8C (belt title)
        this.scrollTarget = hub.pageSpacing * index;             // +14 (456·index)
        this.offset = [0, 0];                                    // +08/+0C
        this.alphaFactor = 1;                                    // +88
        this.alpha = 255;                                        // +94
        this.anchors = {};          // screen-space (y down) for offset 0
        this.rects = {};            // bounding panes: [centre x, centre y, w, h] (screen space)
        /** Portrait: per-anchor sprite scale multipliers (icons / numbers drawn bigger in the taller band). */
        this.portraitScale = {};
        /** Portrait: icons fitted (by their layer bounds) into a box and centred on their anchor. */
        this.portraitIconBox = {};
        /** Portrait: draw-flag overrides for telops (e.g. the wind text centred instead of right-aligned). */
        this.portraitFlags = {};
        this.bandCentre = 0;
        this.windY = NaN;
        /** Portrait: per-frame layout-space y for anchors/rects (the day pages re-flow around the icon's size). */
        this.yOverride = {};
        if (ctx.isPortrait) {
            const c = hub.portrait.bandCentre;
            this.noService.placeAll([0, c]);
            this.arrangePortrait(c);
        }
        // Pane_GetScreenCenter for every empty anchor / bounding pane.
        const k = ctx.isWide ? 1.3684211 : 1;
        B.calculate(this.layout.layout.root);
        B.walk(this.layout.layout.root, (p) => {
            const c = hub.sprites.screenPoint(SpriteText.layoutCenter(p));
            this.anchors[p.name] = c;
            if (B.isBounding(p)) this.rects[p.name] = [c[0], c[1], p.size[0] * k, p.size[1]];
        });
        if (ctx.isPortrait) for (const n of ['telop', 'wind_telop']) this.widenRect(n, 560);
    }

    /** Portrait arrangement of this page's panes around the content band centre `c` (layout space). */
    arrangePortrait(_c) {}

    /** Move a root pane group to an absolute layout position (portrait). */
    moveTo(name, x, y) {
        const p = this.layout.find(name);
        if (!p) return;
        const a = p.authored;   // UILayout.place offsets are relative to the brlyt position
        this.layout.place({ [name]: [(x ?? a[0]) - a[0], y - a[1]] });
    }
    /** Shift a nested (non-root) pane and optionally stretch it vertically. */
    nested(name, { y = null, scaleY = null, x = null, scale = null } = {}) {
        const p = this.layout.pane(name);
        if (!p) return;
        if (y != null) p.translate[1] = y;
        if (x != null) p.translate[0] = x;
        if (scaleY != null) p.scale[1] *= scaleY;
        if (scale != null) { p.scale[0] *= scale; p.scale[1] *= scale; }
        this.layout.relayout();
    }
    k(name) { return this.portraitScale[name] ?? 1; }
    /** Widen bounding rects used for fitting telops (portrait text is larger and centred). */
    widenRect(name, w) { if (this.rects[name]) this.rects[name][2] = w; }

    /** Anchor in screen space with this page's scroll offset applied (sp10 = x + unk8, sp14 = y − unkC). */
    at(name) {
        const a0 = this.anchors[name];
        if (!a0) return null;
        const a = a0.slice();
        const y = this.yOverride[name];
        if (y != null) a[1] = LogicalScreen.halfHeight - y;
        return [a[0] + this.offset[0], a[1] - this.offset[1]];
    }
    /** Per-frame portrait re-flow hook (called from calc). */
    portraitReflow() {}

    get isAvailable() { return true; }
    get noServiceIndex() { return 0; }

    /** vtable +0x14 calc */
    calc(o, a) {
        this.offset = o; this.alphaFactor = a;
        if (this.ctx.isPortrait) this.portraitReflow();
        this.layout.update(); this.noService.update();
    }

    /** vtable +0x10 draw */
    draw(enc) {
        const a = this.alphaFactor * this.alpha;
        if (!(a > 0) || !(Math.abs(this.offset[1]) < this.hub.pageSpacing)) return;
        if (this.isAvailable) {
            this.hub.drawLayout(this.layout, enc, this.offset[1], clampByte(a));
            this.drawData(enc, clampByte(255 * this.alphaFactor));
        } else {
            const t = this.noService.find('text'); if (t) t.textIndex = this.noServiceIndex;
            this.hub.drawLayout(this.noService, enc, this.offset[1], clampByte(a));
        }
    }

    drawData(_enc, _alpha) {}

    /** fn_8001C89C: fitted telop text with shadow in a bounding rect. */
    telop(s, name, { flags = 0x111, scale = 1, alpha, color = SpriteText.white } = {}, enc) {
        const r0 = this.rects[name], f = this.hub.telopFont;
        if (!r0 || !f) return;
        const r = r0.slice();
        const yo = this.yOverride[name];
        if (yo != null) r[1] = LogicalScreen.halfHeight - yo;
        const sc = scale * this.k(name);
        const fl = this.portraitFlags[name] ?? flags;
        const c = color.slice(); c[3] = alpha;
        const sh = SpriteText.shadow.slice(); sh[3] = alpha;
        const hO = (fl >> 4) & 3;
        const x = r[0] + this.offset[0] + (hO === 0 ? -r[2] / 2 : hO === 2 ? r[2] / 2 : 0);
        // Width-only fit: in the original (Dolphin reference) single-line telops are never shrunk by the
        // CalcStringHeight branch — "SSE 10 mph" draws at scale 1.0 in the 28 px wind_telop box.
        this.hub.telop.drawFitted(s, f, [x, r[1] - this.offset[1]], [r[2], Infinity], [sc, sc], fl, c, sh, enc);
    }

    /**
     * Temperature-style number: digits (or "--") + optional suffix glyphs (0xFF9F = degree, 'C' / 'F'),
     * centred on the anchor in the large sprite font (fn_8003F088). Shadow colour lbl_80330A20.
     */
    number(v, name, { scale = 1, color = SpriteText.white, suffix = [], alpha } = {}, enc) {
        const p = this.at(name);
        if (!p) return;
        const sc = scale * this.k(name);
        const c = color.slice(); c[3] = alpha;
        const sh = SpriteText.shadow.slice(); sh[3] = alpha;
        const sp = this.hub.sprites;
        const s = (v != null ? sp.formatInt(v) : [0x2D, 0x2D]).concat(suffix);
        const q = p.slice();
        // fn_800145B8: a single glyph is nudged right by half a digit width (record 0x21).
        if (s.length === 1 && sp.records[0x21]) q[0] += sc * 0.5 * sp.records[0x21].w;
        // Portrait: optical centring — the digits centre on the anchor and the unit (°) hangs to the right.
        if (this.ctx.isPortrait && suffix.length) q[0] += sc * 0.5 * sp.width(suffix, SpriteText.Table.large);
        sp.drawCentered(s, q, sc, sc, c, sh, SpriteText.Table.large, enc);
    }
    /** Degree glyph only, for both units (verified against the original in Dolphin: "34°"). */
    get tempSuffix() { return [0xFF9F]; }

    icon(code, name, { scale = 1, alpha } = {}, enc) {
        const p = this.at(name);
        if (!p) return;
        let sc = scale * this.k(name);
        const w = code != null ? this.hub.record?.weather(code) : null;
        const shown = w?.icon ?? 0x7FFF;
        let centre = p;
        const box = this.portraitIconBox[name];
        const b = box ? this.hub.sprites.iconBounds(shown) : null;
        if (box && b) {
            const size = [b.max[0] - b.min[0], b.max[1] - b.min[1]];
            sc = Math.min(box[0] / Math.max(size[0], 1), box[1] / Math.max(size[1], 1));
            centre = [p[0] - (b.min[0] + b.max[0]) / 2 * sc, p[1] - (b.min[1] + b.max[1]) / 2 * sc];   // the composition's own centre on the anchor
        }
        this.hub.sprites.drawWeatherIcon(shown, centre, alpha, sc, enc);
    }

    /** fn_8001D3C8 / fn_8001E9E8: "<direction> <speed> <unit>" right-aligned in `wind_telop`. */
    windText(direction, kmh, mph) {
        if (direction === 0xFF) return null;
        const ctx = this.ctx;
        const speed = ctx.windUnit === 0 ? mph : kmh;
        const dir = this.hub.strings.windDirection(direction, ctx.lang, ctx.region);
        const unit = this.hub.strings.windUnit(ctx.windUnit, ctx.lang, ctx.region);
        if (direction === 0) return dir;                     // calm
        return speed === 0xFF ? `${dir} -- ${unit}` : `${dir} ${speed} ${unit}`;
    }
}

/** Page 0 — UV index (d_weather_a_other.cpp, life_nWW.brlyt; fn_8001199C). */
export class UVPage extends HubPage {
    get day() { return this.hub.record?.long?.today ?? this.hub.record?.summary?.today ?? null; }
    get uv() {
        const d = this.day;
        if (!d || d.uvIndex === 0xFF) return null;
        return this.hub.record?.data.forecast.uvIndex.find(u => u.id === d.uvIndex) ?? null;
    }
    get isAvailable() { return this.hub.record?.long != null && this.uv != null; }
    get noServiceIndex() { return this.hub.record?.long == null ? 0 : 5; }
    /** Portrait: the sun-and-sunglasses picture moves above the "UV Index" box; the box keeps its art. */
    arrangePortrait(c) {
        // The UV box group is authored at x = +40: shift everything 40 left so the box is centred, and stack the
        // sun-and-sunglasses picture (×2.6) above it; the pair is centred vertically in the band.
        const sunH = 112 * 2.6, boxH = 147, gap = 46;
        const top = c + (sunH + gap + boxH) / 2;
        const sunY = top - sunH / 2, headerTop = top - sunH - gap;
        const groupY = headerTop - 18;                   // life_bB0 header (36 tall) is centred on life_b
        this.layout.placeAll([-40, groupY - 39]);
        this.nested('life_bI', { y: sunY - groupY, x: 0, scale: 2.6 });
        this.portraitScale = { 'life_b_1-1': 1.25, 'life_b_1-10': 1.25, 'life_b_1-100': 1.25 };
    }
    drawData(enc, alpha) {
        const uv = this.uv;
        if (!uv) return;
        this.telop(uv.text, 'life_b_telop', { alpha }, enc);
        // UV value: digits on the life_b_1-1 / -10 / -100 anchors (ones, tens, hundreds).
        const digits = String(uv.id).split('').map(Number);
        const names = ['life_b_1-1', 'life_b_1-10', 'life_b_1-100'];
        digits.reverse().forEach((d, i) => { if (i < names.length) this.number(d, names[i], { alpha }, enc); });
    }
}

/**
 * Portrait arrangement of day_nWW (Current / Today / Tomorrow): one centred column that fills the content
 * band — weather icon (fitted into 420×255 by its own layer bounds, so a small moon reads as large as a cloud
 * bank), temperature ×2.3, condition ×1.7, and the wind strip widened into a full-width ribbon with the wind text
 * centred on it. The column re-flows every frame around the icon's real height so the gaps stay even.
 */
export function arrangeDayPortrait(p, c) {
    p.bandCentre = c;
    p.moveTo('icon', 0, c); p.moveTo('kion_do_cnt', 0, c); p.moveTo('kion_doF_cnt', 0, c); p.moveTo('telop', 0, c);
    p.moveTo('belt_wind', 304, c); p.moveTo('wind_telop', 120, c);   // wind_telop: o=5, 240 wide → centre x = 0
    // belt_windB spans −280…0 from the right screen edge (solid 200 + fade 80): stretch it across the width.
    p.nested('belt_windB', { scaleY: 1.4 });
    const b = p.layout.pane('belt_windB');
    if (b) { b.scale[0] = 608 / 280; p.layout.relayout(); }
    p.portraitScale = { kion_do_cnt: 2.3, kion_doF_cnt: 2.3, telop: 1.7, wind_telop: 1.4 };
    p.portraitIconBox = { icon: [420, 255] };
    p.portraitFlags = { wind_telop: 0x111 };
}

/** The day-page column for an icon of display code `shown`: icon, gap, temperature, gap, condition, gap, wind. */
export function reflowDayPortrait(p, iconCode) {
    const w = iconCode != null ? p.hub.record?.weather(iconCode) : null;
    const shown = w?.icon ?? 0x7FFF;
    let iconH = 260;
    const b = p.hub.sprites.iconBounds(shown), box = p.portraitIconBox.icon;
    if (b && box) {
        const s = [b.max[0] - b.min[0], b.max[1] - b.min[1]];
        iconH = s[1] * Math.min(box[0] / Math.max(s[0], 1), box[1] / Math.max(s[1], 1));
    }
    const tempH = 142, condH = 48, windH = 53;
    const gaps = [56, 36, 58];
    const total = iconH + tempH + condH + windH + gaps.reduce((a, v) => a + v, 0);
    let y = p.bandCentre + total / 2;
    const next = (h, gap) => { const m = y - h / 2; y -= h + gap; return m; };
    const iconY = next(iconH, gaps[0]), tempY = next(tempH, gaps[1]), condY = next(condH, gaps[2]), windY = next(windH, 0);
    p.yOverride = { icon: iconY, kion_do_cnt: tempY, kion_doF_cnt: tempY, telop: condY, wind_telop: windY + 1 };
    if (p.windY !== windY) {
        p.windY = windY;
        p.moveTo('belt_wind', 304, windY);
    }
}

/** Page 1 — current conditions (fn_80010B7C module, day_nWW.brlyt; fn_80010EB0). */
export class CurrentPage extends HubPage {
    get isAvailable() { const c = this.hub.record?.current; return c != null && c.weather !== 0xFFFF; }
    get noServiceIndex() { return 1; }
    arrangePortrait(c) { arrangeDayPortrait(this, c); }
    portraitReflow() { reflowDayPortrait(this, this.hub.record?.current?.weather ?? null); }
    drawData(enc, alpha) {
        const cur = this.hub.record?.current, ctx = this.ctx;
        if (!cur) return;
        this.icon(cur.weather, 'icon', { alpha }, enc);
        const w = this.hub.record.weather(cur.weather);
        if (w) this.telop(w.name, 'telop', { alpha }, enc);
        const s = this.windText(cur.windDirection, cur.windKmh, cur.windMph);
        if (s) this.telop(s, 'wind_telop', { flags: 0x122, alpha }, enc);
        if (ctx.tempUnit === 0) this.number(cur.tempC <= -128 ? null : cur.tempC, 'kion_do_cnt', { suffix: this.tempSuffix, alpha }, enc);
        else this.number(cur.tempF <= -128 ? null : cur.tempF, ctx.region === 1 ? 'kion_doF_cnt' : 'kion_do_cnt', { suffix: this.tempSuffix, alpha }, enc);
    }
}

/** Pages 2/3 — today / tomorrow (d_weather_base_day.cpp, day_nWW.brlyt; fn_800126B4 → fn_8001E10C). */
export class DayPage extends HubPage {
    constructor(hub, index, tomorrow) {
        super(hub, 'day_nWW.brlyt', index, index);
        this.tomorrow = tomorrow;
    }
    get day() {
        const r = this.hub.record;
        return (this.tomorrow ? (r?.long?.tomorrow ?? r?.summary?.tomorrow) : (r?.long?.today ?? r?.summary?.today)) ?? null;
    }
    get isAvailable() { const d = this.day; return d ? d.weather !== 0xFFFF : false; }
    get noServiceIndex() { return this.tomorrow ? 3 : 2; }
    arrangePortrait(c) { arrangeDayPortrait(this, c); }
    portraitReflow() { reflowDayPortrait(this, this.day?.weather ?? null); }
    drawData(enc, alpha) {
        const d = this.day, ctx = this.ctx;
        if (!d) return;
        this.icon(d.weather, 'icon', { alpha }, enc);
        const w = this.hub.record?.weather(d.weather);
        if (w) this.telop(w.name, 'telop', { alpha }, enc);
        const s = this.windText(d.windDirection, d.windKmh, d.windMph);
        if (s) this.telop(s, 'wind_telop', { flags: 0x122, alpha }, enc);
        // fn_8001230C: non-JP day pages colour the temperature anchors lbl_80330A40.
        const col = ctx.lang === Lang.jp ? SpriteText.white : SpriteText.yellow;
        if (ctx.tempUnit === 0) this.number(d.highC <= -128 ? null : d.highC, 'kion_do_cnt', { color: col, suffix: this.tempSuffix, alpha }, enc);
        else this.number(d.highF <= -128 ? null : d.highF, ctx.region === 1 ? 'kion_doF_cnt' : 'kion_do_cnt', { color: col, suffix: this.tempSuffix, alpha }, enc);
    }
}

/**
 * Page 4 — 5-day (d_weather_a_week.cpp, week_nWW.brlyt; fn_800145B8). Columns a..e start at tomorrow
 * (entry time + 0x5A0 minutes per column) and read week[0..4].
 */
export class WeekPage extends HubPage {
    get isAvailable() { return this.hub.record?.long != null; }
    get noServiceIndex() { return 4; }
    /**
     * Portrait: the five columns stretch vertically (body ×2 below the weekday header, dividers spanning header
     * top → body bottom), icons fitted to the column width, numbers ×1.6.
     */
    arrangePortrait(c) {
        // Column art (relative to week_x at the weekday header): header B0 40 tall at 0 (+20…−20), body B1 184 tall
        // centred −112 (−20…−204), left divider B3 224 tall centred −92 (+20…−204). Stretch the body ×f downward from
        // the header's bottom edge and make the divider span exactly header top → body bottom.
        const f = 2.0, head = 74;
        const bodyH = 184 * f;
        const colTop = 20, colBottom = 20 + bodyH;          // below/above the header anchor
        const dy = (c + (colBottom - colTop) / 2) - head;   // centre the whole column in the band
        const inBody = (frac) => head + dy - 20 - bodyH * frac;
        for (const col of ['a', 'b', 'c', 'd', 'e']) {
            this.moveTo(`week_${col}`, null, head + dy);
            this.moveTo(`week_${col}_youbi`, null, head + dy);
            this.moveTo(`week_${col}_icon`, null, inBody(41.0 / 184));
            for (const n of ['H_do_cnt', 'H_cnt']) this.moveTo(`week_${col}${n}`, null, inBody((159.0 / 184 * bodyH - 50 * 1.6) / bodyH));   // original 50-unit high→low gap, at the ×1.6 type size
            for (const n of ['L_do_cnt', 'L_cnt']) this.moveTo(`week_${col}${n}`, null, inBody(159.0 / 184));
            this.nested(`week_${col}B1`, { y: -20 - bodyH / 2, scaleY: f });
            this.nested(`week_${col}B3`, { y: (20 + (-20 - bodyH)) / 2, scaleY: (40 + bodyH) / 224 });
            this.portraitIconBox[`week_${col}_icon`] = [110 - 1 - 2 * 6, 90];   // column inner width − 6 px padding each side
            for (const n of ['H_do_cnt', 'H_cnt', 'L_do_cnt', 'L_cnt']) this.portraitScale[`week_${col}${n}`] = 1.6;
        }
    }
    drawData(enc, alpha) {
        const long = this.hub.record?.long, ctx = this.ctx;
        if (!long) return;
        const cols = ['a', 'b', 'c', 'd', 'e'];
        let minutes = (long.time.localTime + 0x5A0) >>> 0;
        cols.forEach((col, i) => {
            if (i >= long.week.length) return;
            const w = long.week[i];
            const hi = ctx.tempUnit === 0 ? w.highC : w.highF, lo = ctx.tempUnit === 0 ? w.lowC : w.lowF;
            const suffix = ctx.tempUnit === 0 ? '_do_cnt' : '_cnt';
            // fn_80013738 anchor table (names lbl_8019A268+0x498, scales lbl_801797B8): numbers/icons 0.5;
            // high → lbl_80330A40, low → lbl_80330A3C; °C anchors (_do_cnt) carry the degree glyph.
            const deg = ctx.tempUnit === 0 ? [0xFF9F] : [];
            this.number(hi <= -128 ? null : hi, `week_${col}H${suffix}`, { scale: 0.5, color: SpriteText.yellow, suffix: deg, alpha }, enc);
            this.number(lo <= -128 ? null : lo, `week_${col}L${suffix}`, { scale: 0.5, color: SpriteText.lightCyan, suffix: deg, alpha }, enc);
            // Weekday sprite (fn_8001C714: TPLCommon image, shadow at +3,+3). Sat/Sun → lbl_80330A40, else lbl_80330A1C.
            const wday = new HubDate(minutes).weekday;
            const p = this.at(`week_${col}_youbi`);
            if (p) {
                const img = this.hub.strings.weekdayImage(wday, ctx.lang);
                const c = ((wday === 6 || wday === 0) ? SpriteText.yellow : SpriteText.lightGrey).slice(); c[3] = alpha;
                const sh = SpriteText.shadow.slice(); sh[3] = alpha;
                this.hub.sprites.drawImageCentered(img, p, 1, c, sh, 3, enc);
            }
            this.icon(w.weather === 0xFFFF ? null : w.weather, `week_${col}_icon`, { scale: 0.5, alpha }, enc);
            minutes = (minutes + 0x5A0) >>> 0;
        });
    }
}

/** MinutesToDate (fn_800364D8): minutes since 2000-01-01 00:00; wday = (days + 6) % 7 (2000-01-01 was a Saturday). */
export class HubDate {
    constructor(m) {
        const mins = m >>> 0;
        this.minute = mins % 60; this.hour = Math.trunc(mins / 60) % 24;
        const days = Math.trunc(mins / 1440);
        this.weekday = (days + 6) % 7;
        const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
        let y = 2000, d = days;
        while (d >= (leap(y) ? 366 : 365)) { d -= leap(y) ? 366 : 365; y += 1; }
        const ml = [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mo = 0;
        while (d >= ml[mo]) { d -= ml[mo]; mo += 1; }
        this.year = y; this.month = mo; this.day = d + 1;
    }
}
