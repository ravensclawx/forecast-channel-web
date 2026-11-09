import * as LS from '../render/LogicalScreen.js';
import { WPAD, has } from './bridge.js';

const halfHeight = () => LS.LogicalScreen?.halfHeight ?? (LS.LogicalScreen?.height ?? 456) / 2;

/** d_scene.cpp input helpers: UI_UpdateHover (fn_8003DAD0), UI_ButtonTrig (fn_8003DEAC), UI_ClearHover (fn_8003DD50). */
export class UIInput {
    constructor(isWide) {
        this.isWide = isWide;
        this.hovered = null;                  // lbl_801F72F0[chan]
        this.playSE = () => {};
        this.rumble = () => {};               // WPAD_RumblePattern(ch, 3, 0x14) — web: navigator.vibrate (shell)
    }

    /** Pointer (logical px, y down) → layout space (origin centre, y up), scaled to the 608 design width. */
    toLayout(p) {
        const w = this.isWide ? 832 : 608;
        let x = p[0] - w / 2;
        if (this.isWide) x *= 608 / 832;
        const h = halfHeight();
        return [x, Math.min(Math.max(h - p[1], -h), h)];
    }

    /** UI_UpdateHover(layout, hoverSE) */
    updateHover(layout, pad, hoverSE = 0x28) {
        let hit = null;
        if (pad.pointerValid) { const q = this.toLayout(pad.pointer); hit = layout.hitTest(q[0], q[1]); }
        if (hit !== this.hovered) {
            this.hovered?.press();                 // release the old wrapper (its press timer runs out)
            this.hovered = hit;
            if (hit && !(hit.fixed || hit.disabled || hit.hidden)) { this.playSE(hoverSE); this.rumble(3, 0x14); }
        }
        const h = this.hovered;
        if (h) {
            if (has(pad.trig, WPAD.a)) h.press();
            h.setHover();
        }
    }

    /** UI_ButtonTrig(paneName, mask): true when the hovered wrapper named `name` is enabled and `mask` was triggered. */
    buttonTrig(name, pad, mask = WPAD.a) {
        const h = this.hovered;
        if (!h || h.name !== name || h.disabled || !has(pad.trig, mask)) return false;
        h.flash();
        return true;
    }

    /** Held variant used for zoom/tilt buttons (LayoutButtonHeld). */
    buttonHeld(name, pad, mask = WPAD.a) {
        const h = this.hovered;
        if (!h || h.name !== name || h.disabled) return false;
        return has(pad.hold, mask);
    }

    /** UI_ClearHover */
    clearHover() { this.hovered = null; }
}
