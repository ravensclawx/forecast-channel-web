// Port of Sources/Forecast/UI/Cursor.swift (the CErrorSystem / nw4r::ef drawing) — desktop (Wii widescreen) only.
// The game-side state enum is in Cursor.js (CursorState).
//
// - CErrorSystem_ctor loads `nw4r_defcursor_all01.breff/.breft` (content 9) into the effect system.
// - fn_800101C0 maps the game's cursor variable (lbl_801D6F98: 0 pointer, 1 open hand, 2 grab, 3 over a
//   button, 4 B-scroll) to a CErrorSystem state: 0/3 → 1, 1 → 3, 2 → 2, 4 → 5, via fn_80032324 → fn_8002C8E8.
// - fn_8002C304 (from Input_Update, every frame) kills last frame's effects and creates fresh ones per remote:
//   the shadow `def_cursor_<kind>_sd` at (x+3, 456−y−3) and the hand `def_cursor_<kind>_<n>p` at (x, 456−y),
//   kind = lbl_8017B4A0[state] → normal/hold/open; runs EffectSystem::Calc once and sets each live
//   particle's rotate.z to the remote's roll (fn_8002CB1C).
// - CErrorSystem_Update (System_Frame, after the scene) draws group 0 with an ortho of 0..W × 0..456 (y up) and
//   an identity view.
// - State 5 is drawn directly by fn_8002C8E8 from TPLCommon images 2 (black, +3,+3) and 1 (white).
//
//   const cursor = new CursorDraw(assets, ctx.lyt);   // after the scene, in the canvas pass:
//   cursor.state = scene.cursorState; cursor.draw(ctx.lyt, enc, ctx.pad.pointer, twistDegrees, 832);

import { CX } from '../../rvl/CX.js';
import { TPLFile } from '../../nw4r/lyt/TPL.js';
import { EfEffectFile, EfTextureFile } from '../../nw4r/ef/EfResource.js';
import { EfEffectSystem } from '../../nw4r/ef/EfEffect.js';
import { EfDraw } from '../../nw4r/ef/EfDraw.js';
import { Content } from '../system/Assets.js';
import { LogicalScreen } from '../render/LogicalScreen.js';
import { LytRenderer, mat4FromRows, IDENTITY4 } from '../render/LytRenderer.js';
import { CursorState } from './Cursor.js';

export class CursorDraw {
    static State = CursorState;
    /** lbl_8017B4A0: CErrorSystem state → effect kind (−1 = drawn by fn_8002C8E8). */
    static kindForState = [0, 0, 1, 2, 2, -1];
    static sdNames = ['def_cursor_normal_sd', 'def_cursor_hold_sd', 'def_cursor_open_sd'];   // lbl_8019B810
    static handNames = ['normal', 'hold', 'open'].map(k => [1, 2, 3, 4].map(n => `def_cursor_${k}_${n}p`));   // lbl_8019B920

    /** @param assets Assets  @param renderer LytRenderer */
    constructor(assets, renderer) {
        this.state = CursorState.normal;
        this.visible = true;
        /** Player number shown on the hand (def_cursor_*_<n>p); single remote. */
        this.channel = 0;
        const arc = assets.archive(Content.weather);
        const ff = arc.find('nw4r_defcursor_all01.breff.LZ'), tf = arc.find('nw4r_defcursor_all01.breft.LZ');
        if (!ff || !tf) throw new Error('missing nw4r_defcursor_all01');
        this.system = new EfEffectSystem(new EfEffectFile(CX.uncompressIfNeeded(ff)), new EfTextureFile(CX.uncompressIfNeeded(tf)));
        const c = arc.find('TPLCommon.tpl.LZ');
        this.common = c ? new TPLFile(CX.uncompressIfNeeded(c)) : null;
        this.renderer = renderer;
        this._textures = new Map();
        this._commonTextures = new Map();
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
     * `pointer` in SetOrtho2D space (x 0..W, y 0..456 down); `roll` in radians.
     */
    updateEffects(state, pointer, roll) {
        this.effects = [];   // fn_80085150: kill last frame's
        const kind = CursorDraw.kindForState[state];
        if (kind < 0) return;
        const x = pointer[0], y = 456 - pointer[1];
        const sd = this.system.createEffect(CursorDraw.sdNames[kind]);
        if (sd) { sd.translate = [3 + x, y - 3, 0]; this.effects.push(sd); }
        const hand = this.system.createEffect(CursorDraw.handNames[kind][Math.min(this.channel, 3)]);
        if (hand) { hand.translate = [x, y, 0]; this.effects.push(hand); }
        // fn_80085B54 / fn_80085A4C: EffectSystem::Calc(group 0).
        for (const fx of this.effects) fx.calc();
        // fn_8002CB1C(effect, roll, scale 1.0): rotate.z on every live particle.
        for (const fx of this.effects) for (const pm of fx.particleManagers) for (const p of pm.particles) {
            if (p.alive) p.parameter.rotate[2] = roll;
        }
    }

    /** pointer: logical px (0..W, 0..456, y down); twist degrees (Wii Remote roll, clockwise positive). */
    draw(r, enc, pointer, twist, screenWidth) {
        if (!this.visible) return;
        const roll = twist * Math.PI / 180;
        const st = CursorDraw.errorSystemState(this.state);
        this.updateEffects(st, pointer, roll);
        if (st === 5) { this.drawScrollCursor(r, enc, pointer, roll, screenWidth); return; }
        // CErrorSystem_Update: C_MTXOrtho(456, 0, 0, W, −100, 100), identity view, EffectSystem::Draw(group 0).
        const proj = mat4FromRows([[2 / screenWidth, 0, 0, -1], [0, 2 / LogicalScreen.height, 0, -1], [0, 0, -1 / 1000, 0.5], [0, 0, 0, 1]]);
        for (const fx of this.effects) for (const pm of fx.particleManagers) {
            for (const pkt of EfDraw.draw(pm, IDENTITY4, this.system.textures)) this.submit(r, enc, pkt, proj);
        }
    }

    _texture(r, t) {
        let m = this._textures.get(t.name);
        if (!m) { m = r.gx.makeTexture(t.rgba8, t.width, t.height, t.name); this._textures.set(t.name, m); }
        return m;
    }

    /** GXBegin(GX_QUADS) of one ef draw packet: { quad: [{position, texCoord}×4], gx, texMtx, textures: [{texture, wrapS, wrapT}] }. */
    submit(r, enc, pkt, proj) {
        const verts = new Float32Array(6 * 26);
        let k = 0;
        for (const i of [0, 1, 2, 0, 2, 3]) {
            const q = pkt.quad[i];
            verts[k] = q.position[0]; verts[k + 1] = q.position[1]; verts[k + 2] = q.position[2];
            verts[k + 6] = 1; verts[k + 7] = 1; verts[k + 8] = 1; verts[k + 9] = 1;
            verts[k + 10] = q.texCoord[0]; verts[k + 11] = q.texCoord[1];
            k += 26;
        }
        const texs = [], samps = [], dims = [];
        for (const t of pkt.textures) {
            texs.push(this._texture(r, t.texture));
            // GXInitTexObjLOD: GX_LINEAR / GX_LINEAR (mipmap ≤ 1).
            samps.push(r.gx.sampler(t.wrapS, t.wrapT, 1, 1));
            dims.push([t.texture.width, t.texture.height]);
        }
        enc.setCullMode('none');
        r.gx.submit(enc, pkt.gx, verts, proj, IDENTITY4, pkt.texMtx ?? [], [], texs, samps, dims);
    }

    /**
     * fn_8002C8E8 state 5: Setup2DRender + SetOrtho2D; position matrix fn_80031484(scale 1, horizon (cos, sin),
     * translate); TEVREG0 black → TPLCommon image 2 at (+3,+3), then white → image 1, both at (−32, −32).
     */
    drawScrollCursor(r, enc, pointer, roll, screenWidth) {
        if (!this.common) return;
        const c = Math.cos(roll), s = Math.sin(roll);
        for (const [img, off, color] of [[2, 3, [0, 0, 0, 255]], [1, 0, [255, 255, 255, 255]]]) {
            if (img >= this.common.images.length) continue;
            const im = this.common.images[img];
            let tex = this._commonTextures.get(img);
            if (!tex) { tex = r.makeTexture(im, `TPLCommon.${img}`); this._commonTextures.set(img, tex); }
            const t = [pointer[0] + off, pointer[1] + off];
            const xf = p => [c * p[0] - s * p[1] + t[0], s * p[0] + c * p[1] + t[1]];
            const w = im.width, h = im.height;
            const corners = [[-32, -32], [-32 + w, -32], [-32, -32 + h], [-32 + w, -32 + h]].map(xf);
            CursorDraw.drawScreenTriangles(r, tex, corners, color, screenWidth, enc);
        }
    }

    /** LytRenderer.drawScreenTriangles (Swift extension): textured quad with arbitrary corners (TL, TR, BL, BR), sprite TEV. */
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
