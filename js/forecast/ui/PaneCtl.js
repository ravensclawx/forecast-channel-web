import { ButtonColors } from './ButtonColors.js';
import { materialOf, isTextBox, findPane, xform } from './bridge.js';

/** Language suffixes (GetLangSuffix, lbl_80330138..50): 0 JP, 1 US/English, 2 GE, 3 FR, 4 SP, 5 IT, 6 DU. */
export const Lang = Object.freeze({ jp: 0, us: 1, ge: 2, fr: 3, sp: 4, it: 5, du: 6 });
const SUFFIX = ['JP', 'US', 'GE', 'FR', 'SP', 'IT', 'DU'];
export const langSuffix = (l) => SUFFIX[l] ?? 'US';

/** CPaneCtl (0xA0) — per top-level pane wrapper: companion panes, hover/press state, colouring. fn_80037184..fn_800389C4. */
export class PaneCtl {
    /** CPaneCtl ctor (fn_80037184) */
    constructor(p, lang, defaultScheme) {
        this.pane = p;                                    // +08
        const n = p.name;
        const child = (s) => findPane(p, n + s);
        this.body = child('B') ?? p;                      // +10 (PB, falls back to P)
        const langOrSelf = (g) => {
            if (!g) return null;
            const l = findPane(g, g.name + langSuffix(lang));
            if (l) { for (const c of g.children ?? []) c.visible = c === l; return l; }
            return g;
        };
        this.icon = langOrSelf(child('I'));               // +14 (PI<lang> | PI)
        this.text = langOrSelf(child('T'));               // +18 (PT<lang> | PT)
        this.pressFrame0 = child('F0'); this.pressFrame1 = child('F1');   // +1C/+20 (PF0/PF1)
        // CPaneCtl ctor user-data scan (8 chars): 'd' disabled, 'f'/'F' fixed, 'c'/'C' + digit = colour scheme.
        const ud = String(p.userData ?? '').slice(0, 8);
        let dis = false, fix = false, sch = defaultScheme;
        for (let i = 0; i < ud.length; i++) {
            const ch = ud[i];
            if (ch === 'd') dis = true;
            else if (ch === 'f' || ch === 'F') fix = true;
            else if (ch === 'c' || ch === 'C') { i += 1; if (i < ud.length && ud[i] >= '0' && ud[i] <= '9') sch = ud.charCodeAt(i) - 0x30; }
        }
        this.disabled = dis;                              // +98 ('d' user data)
        this.fixed = fix;                                 // +90 ('f'/'F' user data)
        this.scheme = sch;                                // +6C
        this.baseTranslate = [...p.translate];            // +4C (portrait placement moves it; see UILayout.place)
        /** The brlyt position (portrait offsets are relative to it). */
        this.authored = [...p.translate];
        this.hitRect = [0, 0, 0, 0];                      // +3C..+48 x0,y0,x1,y1 (layout space, y up)
        this.alpha = 255;                                 // +70 (layout fade)
        this.brightness = 255;                            // +74
        this.hoverRamp = 0;                               // +78 (0..12)
        this.pressTimer = 0;                              // +7C (18-frame press)
        this.textIndex = 0;                               // +80
        this.pendingTextIndex = 0;                        // +84 (applied when the press ends)
        this.blinkRamp = 0; this.blinkMax = 1;            // +88/+8C
        this.keepPressed = false;                         // +92
        this.hidden = false;                              // +94
        this.hoveredThisFrame = false;                    // +95
        this.pressing = false;                            // +96
        this.selected = false;                            // +97
        /** +38: the text colour computed by the last PreDraw. */
        this.lastTextColor = [0, 0, 0, 255];
        this.slideOffset = 0;                             // +9C
        /** Optional text-colour override (+30): (textBox, color) => color */
        this.textColorHook = null;
    }

    get name() { return this.pane.name; }

    /** Hit rectangle = PR (or PB) pane rect transformed into layout space. */
    computeHitRect() {
        const r = findPane(this.pane, this.pane.name + 'R') ?? this.body;
        const o = r.vertexOrigin, s = r.size, m = r.globalMtx;
        const pts = [[o[0], o[1]], [o[0] + s[0], o[1]], [o[0], o[1] - s[1]], [o[0] + s[0], o[1] - s[1]]].map(q => xform(m, q[0], q[1]));
        this.hitRect = [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])),
                        Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))];
    }

    contains(x, y) { const h = this.hitRect; return x >= h[0] && x <= h[2] && y >= h[1] && y <= h[3]; }

    /** CPaneCtl_Update (fn_80037B64) */
    update() {
        if (this.hidden) return;
        if (this.hoveredThisFrame) { if (this.hoverRamp < 12) this.hoverRamp += 1; this.hoveredThisFrame = false; }
        else if (this.hoverRamp > 0) this.hoverRamp -= 1;
        if (this.pressing) {
            if (this.pressTimer > 0) { this.pressTimer -= 1; if (this.pressTimer === 0) this.textIndex = this.pendingTextIndex; }
            if (this.pressTimer === 0) this.pressing = false;
            if (this.pressTimer === 9) this.hoverRamp = 12;
        } else if (this.pressTimer > 1) this.pressTimer -= 1;
    }

    /** CPaneCtl_SetHoverTree (fn_80038768) */
    setHover() { if (this.fixed || this.disabled || this.hidden) return; this.hoveredThisFrame = true; }
    /**
     * CPaneCtl_Press (fn_800389C4): sets the "pressing" flag (+96) and the hover flag (+95) of the *child*
     * wrappers (+24/+28, enabled and shown ones only) — never its own. The timer is untouched: with a zero timer
     * this releases the wrapper on the next Update (used on hover-leave). A disabled wrapper pressed every frame
     * (CNormal_StInteractive off the top level) therefore keeps its normal body colour with text/icon hidden.
     */
    press() { if (this.fixed) return; this.pressing = true; }
    /** CPaneCtl_Flash(p, on) (fn_80038990): the 18-frame press animation (UI_ButtonTrig / hardware buttons). */
    flash(on = true) {
        if (this.fixed || this.disabled || this.hidden) return;
        this.pressing = on; this.pressTimer = 0x12;
    }
    /** CPaneCtl_ResetPos: hide, clear hover/press, restore the base position. */
    resetPos() {
        this.hoveredThisFrame = false; this.hoverRamp = 0; this.pressing = false; this.pressTimer = 0; this.hidden = true;
        this.pane.translate = [...this.baseTranslate];
    }

    /** Pane_SetTevColorRec: TEV colour 0/1 RGB on every material in the subtree (skips user data 'F'). */
    static setTevColor(p, c, reg) {
        if (String(p.userData ?? '').startsWith('F')) return;
        const m = materialOf(p);
        if (m?.tevColors?.[reg]) for (let i = 0; i < 3; i++) m.tevColors[reg][i] = c[i];
        for (const ch of p.children ?? []) PaneCtl.setTevColor(ch, c, reg);
    }
    /**
     * Pane_SetAlphaRec: material element 0xB (TEV colour 1 alpha) on the pane and three levels of descendants.
     * Pane alpha itself is never touched (verified against the original in Dolphin).
     */
    static setAlpha(p, a, depth = 0) {
        const v = Math.max(0, Math.min(255, Math.trunc(a)));
        const m = materialOf(p);
        if (m?.tevColors?.[1]) m.tevColors[1][3] = v;
        if (depth < 3) for (const c of p.children ?? []) PaneCtl.setAlpha(c, a, depth + 1);
    }
    /** fn_80036BA4: text colours of every TextBox in the subtree. */
    static setTextColor(p, c) {
        if (String(p.userData ?? '').startsWith('F')) return;
        if (isTextBox(p)) { p.topColor = c.slice(); p.bottomColor = c.slice(); }
        for (const ch of p.children ?? []) PaneCtl.setTextColor(ch, c);
    }

    /** Pick [c0, c1] from the scheme for a role (offsets: normal, pressed/hover, selected). */
    _colors(normal, pressed, sel, hasBlink) {
        const s = this.scheme, BC = ButtonColors;
        if (this.selected) return [BC.at(s, sel), BC.at(s, sel + 4)];
        if (this.keepPressed && this.pressTimer > 0) return [BC.at(s, pressed), BC.at(s, pressed + 4)];
        if (this.hoverRamp > 0) {
            return [BC.lerp(BC.at(s, normal), BC.at(s, pressed), this.hoverRamp, 12),
                    BC.lerp(BC.at(s, normal + 4), BC.at(s, pressed + 4), this.hoverRamp, 12)];
        }
        if (this.pressTimer > 0) return [BC.at(s, pressed), BC.at(s, pressed + 4)];
        if (hasBlink && this.blinkRamp > 0) {
            return [BC.lerp(BC.at(s, normal), BC.at(s, pressed), this.blinkRamp, this.blinkMax),
                    BC.lerp(BC.at(s, normal + 4), BC.at(s, pressed + 4), this.blinkRamp, this.blinkMax)];
        }
        return [BC.at(s, normal), BC.at(s, normal + 4)];
    }

    /** CPaneCtl_PreDraw (fn_80037C20) */
    preDraw() {
        const pane = this.pane;
        pane.visible = !this.hidden;
        if (this.hidden) return;
        // +99 defaults to 1: fixed ('f'/'F') wrappers keep their authored alpha.
        if (!this.fixed) PaneCtl.setAlpha(pane, this.alpha);
        // Text variant: show child #textIndex of the PT<lang> group, hide its siblings.
        let textPane = null;
        const t = this.text;
        if (t) {
            textPane = t;
            const kids = t.children ?? [];
            if (this.textIndex >= 0 && kids.length > 0) {
                kids.forEach((c, i) => { c.visible = i === this.textIndex; if (i === this.textIndex) textPane = c; });
            }
        }
        if (!this.fixed) {
            const a = Math.trunc(this.alpha * Math.min(this.brightness + 0x80, 255) / 255);
            let iconAlpha = a, textAlpha = a;
            let [b0, b1] = this._colors(0x00, 0x14, 0x28, false);
            if (this.brightness < 255) {
                b0 = ButtonColors.lerp(b0, [255, 255, 255, 0], 255 - this.brightness, 255);
                b1 = ButtonColors.lerp(b1, [255, 255, 255, 0], 255 - this.brightness, 255);
            }
            PaneCtl.setTevColor(this.body, b0, 0); PaneCtl.setTevColor(this.body, b1, 1);
            PaneCtl.setAlpha(this.body, Math.trunc(this.alpha * this.brightness / 255));
            const icon = this.icon;
            if (icon && !String(icon.userData ?? '').startsWith('F')) {
                if (this.disabled && !this.selected) iconAlpha = 0;
                const [i0, i1] = this._colors(0x08, 0x1C, 0x30, true);
                PaneCtl.setTevColor(icon, i0, 0); PaneCtl.setTevColor(icon, i1, 1);
                PaneCtl.setAlpha(icon, iconAlpha);
            }
            if (textPane) {
                if (this.disabled && !this.selected) textAlpha = 0;
                let c = this._colors(0x10, 0x24, 0x38, true)[0];
                c[3] = Math.max(0, Math.min(255, textAlpha));
                this.lastTextColor = c.slice();   // +38: also read by draws that write text themselves (CSetting city name)
                if (this.textColorHook && isTextBox(textPane)) c = this.textColorHook(textPane, c) ?? c;
                PaneCtl.setTextColor(textPane, c);
            }
            if (this.pressFrame0 && this.pressFrame1) { this.pressFrame0.visible = this.pressTimer <= 0; this.pressFrame1.visible = this.pressTimer > 0; }
        }
        // Press dip: 18·(1 − sin(π/2·(14 − min(t,14))/14)), or a fixed 12 while latched.
        let dip = 0;
        if (this.pressTimer > 0 && !this.pressFrame0) {
            if (this.keepPressed) dip = 12;
            else { const tt = 14 - Math.min(this.pressTimer, 14); dip = 18 * (1 - Math.sin(1.5708 * tt / 14)); }
        }
        const b = this.baseTranslate;
        pane.translate = [b[0], b[1] + this.slideOffset - dip, b[2]];
    }
}
