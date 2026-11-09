/** CFade (0x64): full-screen black quad. m_pFade = opaque, m_pFade2 = dim to 0xA0 behind dialogs. */
export class Fade {
    static State = Object.freeze({ idle: 'idle', fadeIn: 'fadeIn', fadeOut: 'fadeOut' });

    constructor(maxAlpha = 255, startOpaque = true) {
        this.state = Fade.State.idle;
        /** CFade +13: the quad colour's alpha (m_pFade2 starts at 0xA0; the hub↔globe transitions set it to 0xFF). */
        this.maxAlpha = maxAlpha;
        this.alpha = startOpaque ? maxAlpha : 0;   // 0..maxAlpha (255-scale)
        this.frames = 1; this.counter = 0;
    }

    /** CFade_StartFadeOut(frames): to black. */
    startFadeOut(frames) { this.state = Fade.State.fadeOut; this.frames = Math.max(frames, 1); this.counter = 0; }
    /** CFade_StartFadeIn(frames): from black. */
    startFadeIn(frames) { this.state = Fade.State.fadeIn; this.frames = Math.max(frames, 1); this.counter = 0; }

    get isIdle() { return this.state === Fade.State.idle; }

    update() {
        switch (this.state) {
            case Fade.State.fadeOut:
                this.counter += 1; this.alpha = this.maxAlpha * this.counter / this.frames;
                if (this.counter >= this.frames) { this.alpha = this.maxAlpha; this.state = Fade.State.idle; }
                break;
            case Fade.State.fadeIn:
                this.counter += 1; this.alpha = this.maxAlpha * (1 - this.counter / this.frames);
                if (this.counter >= this.frames) { this.alpha = 0; this.state = Fade.State.idle; }
                break;
            default: break;
        }
    }
}
