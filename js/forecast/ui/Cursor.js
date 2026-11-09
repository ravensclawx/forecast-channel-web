// Port of Sources/Forecast/UI/Cursor.swift — the Wii pointer cursor (desktop mode only).
import { LogicalScreen } from '../render/LogicalScreen.js';
import { LytRenderer, IDENTITY4, mat4FromRows } from '../render/LytRenderer.js';
import * as B from './bridge.js';

// nw4r::ef (js/nw4r/ef/*), loaded if present — the cursor is desktop-only and the scene graph must not need it.
let EF = null;
try {
    const [res, eff, draw] = await Promise.all([
        import('../../nw4r/ef/EfResource.js'), import('../../nw4r/ef/EfEffect.js'), import('../../nw4r/ef/EfDraw.js')]);
    EF = { ...res, ...eff, ...draw };
} catch (_) { EF = null; }

/** The game's cursor variable lbl_801D6F98[chan]. */
export const CursorState = Object.freeze({ normal: 0, open: 1, hold: 2, hover: 3, scroll: 4 });

/**
 * The pointer cursor — CErrorSystem (ctor fn_8002C164) and its nw4r::ef cursor effects.
 *
 * - CErrorSystem_ctor loads `nw4r_defcursor_all01.breff/.breft` (content 9) into the effect system.
 * - fn_800101C0 maps the game's cursor variable (lbl_801D6F98: 0 pointer, 1 open hand, 2 grab, 3 over a
 *   button, 4 B-scroll) to a CErrorSystem state: 0/3 → 1, 1 → 3, 2 → 2, 4 → 5, via fn_80032324 → fn_8002C8E8.
 * - fn_8002C304 (from Input_Update, every frame) kills last frame's effects and creates fresh ones per remote:
 *   the shadow `def_cursor_<kind>_sd` at (x+3, 456−y−3) and the hand `def_cursor_<kind>_<n>p` at (x, 456−y),
 *   kind = lbl_8017B4A0[state] → normal/hold/open; runs EffectSystem::Calc once and sets each live
 *   particle's rotate.z to the remote's roll and scales its colours (fn_8002CB1C).
 * - CErrorSystem_Update (System_Frame, after the scene) draws group 0 with an ortho of 0..W × 0..456 (y up) and
 *   an identity view.
 * - State 5 is drawn directly by fn_8002C8E8 from TPLCommon images 2 (black, +3,+3) and 1 (white).
 *
 * The nw4r::ef engine (js/nw4r/ef/*) is imported optionally (top-level await), so the scene graph does not depend on it.
 */
export class Cursor {
    /** lbl_8017B4A0: CErrorSystem state → effect kind (−1 = drawn by fn_8002C8E8). */
    static kindForState = [0, 0, 1, 2, 2, -1];
    static sdNames = ['def_cursor_normal_sd', 'def_cursor_hold_sd', 'def_cursor_open_sd'];       // lbl_8019B810
    static handNames = ['normal', 'hold', 'open'].map(k => [1, 2, 3, 4].map(n => `def_cursor_${k}_${n}p`));   // lbl_8019B920

    /** True when the nw4r::ef modules loaded. */
    static get available() { return EF != null; }

    /** Cursor(assets:renderer:) — `_renderer` (LytRenderer) is passed again to draw(); throws without nw4r::ef. */
    constructor(assets, _renderer = null, ef = EF) {
        if (!ef) throw new Error('nw4r::ef not available (js/nw4r/ef/*)');
        this.state = CursorState.normal;
        this.visible = true;
        /** Player number shown on the hand (def_cursor_*_<n>p); the channel is single-remote here. */
        this.channel = 0;
        this.ef = ef;
        const arc = B.weatherArchive(assets);
        const ff = arc.find('nw4r_defcursor_all01.breff.LZ'), tf = arc.find('nw4r_defcursor_all01.breft.LZ');
        if (!ff || !tf) throw new Error('missing nw4r_defcursor_all01');
        this.system = new ef.EfEffectSystem(new ef.EfEffectFile(B.uncompressIfNeeded(ff)), new ef.EfTextureFile(B.uncompressIfNeeded(tf)));
        const c = arc.find('TPLCommon.tpl.LZ');
        this.common = c ? B.tplFile(B.uncompressIfNeeded(c)) : null;
        this.textures = new Map();
        this.commonTextures = new Map();
        /** Effects alive since the last fn_8002C304 (CErrorSystem +0x30/+0x40/+0x50 per channel). */
        this.effects = [];
    }

    /** fn_800101C0: game cursor variable → CErrorSystem state. */
    static errorSystemState(s) {
        switch (s) {
            case CursorState.scroll: return 5;
            case CursorState.open: return 3;
            case CursorState.hold: return 2;
            default: return 1;
        }
    }

    /**
     * fn_8002C304 for one remote: recreate the cursor effects, Calc once, apply the roll (fn_8002CB1C).
     * `pointer` is in the SetOrtho2D space (x 0..W, y 0..456 down); `roll` in radians (clockwise positive on screen).
     */
    updateEffects(state, pointer, roll) {
        this.effects = [];   // fn_80085150: kill last frame's
        const kind = Cursor.kindForState[state];
        if (kind < 0) return;
        const x = pointer[0], y = LogicalScreen.height - pointer[1];
        // State 4 (unused by this channel's fn_800101C0) adds a jittered second hand; not reachable.
        const sd = this.system.createEffect(Cursor.sdNames[kind]);
        if (sd) { sd.translate = [3 + x, y - 3, 0]; this.effects.push(sd); }
        const hand = this.system.createEffect(Cursor.handNames[kind][Math.min(this.channel, 3)]);
        if (hand) { hand.translate = [x, y, 0]; this.effects.push(hand); }
        // fn_80085B54 / fn_80085A4C: EffectSystem::Calc(group 0).
        for (const fx of this.effects) fx.calc();
        // fn_8002CB1C(effect, roll, scale 1.0): rotate.z and colour × scale on every live particle.
        for (const fx of this.effects) for (const pm of fx.particleManagers) for (const p of pm.particles) if (p.alive) p.parameter.rotate[2] = roll;
    }

    /** pointer: logical px (0..W, 0..H, y down); twist degrees (Wii Remote roll, clockwise positive). */
    draw(r, enc, pointer, twist, screenWidth) {
        if (!this.visible) return;
        // nw4r_math_Atan2FIdx(h.y, h.x) · 2π/256 of the horizon vector (cos, sin) = the roll angle.
        const roll = twist * Math.PI / 180;
        const st = Cursor.errorSystemState(this.state);
        this.updateEffects(st, pointer, roll);
        if (st === 5) { this.drawScrollCursor(r, enc, pointer, roll, screenWidth); return; }
        // CErrorSystem_Update: C_MTXOrtho(456, 0, 0, W, −100, 100), identity view, EffectSystem::Draw(group 0).
        const proj = mat4FromRows([[2 / screenWidth, 0, 0, -1], [0, 2 / LogicalScreen.height, 0, -1], [0, 0, -1 / 1000, 0.5], [0, 0, 0, 1]]);
        for (const fx of this.effects) for (const pm of fx.particleManagers) {
            for (const pkt of this.ef.EfDraw.draw(pm, null, this.system.textures)) this.submit(r, enc, pkt, proj);
        }
    }

    texture(r, t) {
        let m = this.textures.get(t.name);
        if (!m) { m = r.gx.makeTexture(t.rgba8, t.width, t.height, t.name); this.textures.set(t.name, m); }
        return m;
    }

    /** GXBegin(GX_QUADS) of one ef draw packet. */
    submit(r, enc, pkt, proj) {
        const gx = r.gx;
        const verts = new Float32Array(6 * 26);
        let k = 0;
        for (const i of [0, 1, 2, 0, 2, 3]) {
            const q = pkt.quad[i];
            verts[k] = q.position[0]; verts[k + 1] = q.position[1]; verts[k + 2] = q.position[2];
            verts[k + 6] = 1; verts[k + 7] = 1; verts[k + 8] = 1; verts[k + 9] = 1;
            verts[k + 10] = q.texCoord[0]; verts[k + 11] = q.texCoord[1];
            k += 26;
        }
        enc.setCullMode('none');
        // GXInitTexObjLOD: GX_LINEAR / GX_LINEAR (mipmap ≤ 1).
        const texs = pkt.textures.map(t => this.texture(r, t.texture));
        const samps = pkt.textures.map(t => gx.sampler(t.wrapS, t.wrapT, 1, 1));
        const dims = pkt.textures.map(t => [t.texture.width, t.texture.height]);
        gx.submit(enc, pkt.gx, verts, proj, IDENTITY4, pkt.texMtx ?? [], [], texs, samps, dims);
    }

    /**
     * fn_8002C8E8 state 5: Setup2DRender + SetOrtho2D; position matrix fn_80031484(scale 1, horizon (cos, sin),
     * translate) loaded to PNMTX1; TEVREG0 black → TPLCommon image 2 at (+3,+3), then white → image 1, both
     * drawn by fn_80031BE8 at (−32, −32) with the image's own size.
     */
    drawScrollCursor(r, enc, pointer, roll, screenWidth) {
        if (!this.common) return;
        const c = Math.cos(roll), s = Math.sin(roll);
        for (const [img, off, color] of [[2, 3, [0, 0, 0, 255]], [1, 0, [255, 255, 255, 255]]]) {
            if (img >= this.common.images.length) continue;
            const im = this.common.images[img];
            let tex = this.commonTextures.get(img);
            if (!tex) { tex = r.makeTexture(im, `TPLCommon.${img}`); this.commonTextures.set(img, tex); }
            const t = [pointer[0] + off, pointer[1] + off];
            const xf = (p) => [c * p[0] - s * p[1] + t[0], s * p[0] + c * p[1] + t[1]];
            const w = im.width, h = im.height;
            const corners = [[-32, -32], [-32 + w, -32], [-32, -32 + h], [-32 + w, -32 + h]].map(xf);
            Cursor.drawScreenTriangles(r, tex, corners, color, screenWidth, enc);
        }
    }

    /**
     * A textured quad with arbitrary corners (TL, TR, BL, BR) in SetOrtho2D pixels: Setup2DRender TEV
     * (TEXC·C0 + C1, TEXA·A0 + A1 with C1 = 0).
     */
    static drawScreenTriangles(r, tex, c, color, screenWidth, enc) {
        const state = LytRenderer.spriteGX(color);
        const uv = [[0, 0], [1, 0], [0, 1], [1, 1]];
        const verts = new Float32Array(6 * 26);
        let k = 0;
        for (const i of [0, 1, 2, 1, 3, 2]) {
            verts[k] = c[i][0]; verts[k + 1] = c[i][1]; verts[k + 6] = 1; verts[k + 7] = 1; verts[k + 8] = 1; verts[k + 9] = 1;
            verts[k + 10] = uv[i][0]; verts[k + 11] = uv[i][1];
            k += 26;
        }
        enc.setCullMode('none');
        r.gx.submit(enc, state, verts, LytRenderer.ortho2D(screenWidth), IDENTITY4, [], [], [tex], [r.gx.sampler(0, 0, 1, 1)],
                    [[tex.width, tex.height]]);
    }
}
