// Port of Sources/NW4R/Lyt/Animation.swift — nw4r::lyt::AnimTransformBasic, RLAN (BRLAN v8) layout animations.
// Supports RLPA (pane SRT), RLVC (vertex colors + pane alpha), RLMC (material colors), RLVI (visibility),
// RLTS (texture SRT) and RLTP (texture pattern).
import { BEReader, RVLError } from '../../rvl/BinaryReader.js';
import { Picture, TextBox, Window } from './Layout.js';

export class LytAnimation {
  constructor(bytes) {
    const r = bytes instanceof BEReader ? bytes : new BEReader(bytes);
    if (r.magic(0) !== 'RLAN') throw RVLError.badMagic(r.magic(0), 'RLAN');
    let o = r.u16(0xC);
    let fs = 0, lp = false, tex = [];
    const cs = [];
    const nBlocks = r.u16(0xE);
    for (let b = 0; b < nBlocks; b++) {
      const magic = r.magic(o), size = r.u32(o + 4);
      if (magic === 'pai1') {
        fs = r.u16(o + 8); lp = r.u8(o + 0xA) !== 0;
        const ntex = r.u16(o + 0xC), ncont = r.u16(o + 0xE), contOff = r.u32(o + 0x10);
        const texBase = o + 0x14;
        tex = [];
        for (let i = 0; i < ntex; i++) tex.push(r.cString(texBase + r.u32(texBase + i * 4)));
        for (let i = 0; i < ncont; i++) {
          const c = o + r.u32(o + contOff + i * 4);
          const name = r.cString(c), n = r.u8(c + 20), isMaterial = r.u8(c + 21) === 1;
          const infos = [];
          for (let j = 0; j < n; j++) {
            const a = c + r.u32(c + 24 + j * 4);
            const nt = r.u8(a + 4), targets = [];
            for (let k = 0; k < nt; k++) {
              const t = a + r.u32(a + 8 + k * 4);
              const curve = r.u8(t + 2), nk = r.u16(t + 4), ko = t + r.u32(t + 8);
              const keys = [];
              for (let q = 0; q < nk; q++) {
                keys.push(curve === 2
                  ? { frame: r.f32(ko + q * 12), value: r.f32(ko + q * 12 + 4), slope: r.f32(ko + q * 12 + 8) }
                  : { frame: r.f32(ko + q * 8), value: r.u16(ko + q * 8 + 4), slope: 0 });
              }
              targets.push({ index: r.u8(t), target: r.u8(t + 1), step: curve !== 2, keys });
            }
            infos.push({ kind: r.magic(a), targets });
          }
          cs.push({ name, isMaterial, infos });
        }
      }
      o += size;
    }
    this.frameSize = fs; this.loop = lp; this.textureNames = tex; this.contents = cs;
  }

  /** nw4r::lyt::detail::GetHermiteCurveValue / GetStepCurveValue */
  static evaluate(t, frame) {
    const k = t.keys;
    if (!k.length) return 0;
    const first = k[0], last = k[k.length - 1];
    if (frame <= first.frame) return first.value;
    if (frame >= last.frame) return last.value;
    let i = 0;
    while (i + 1 < k.length && k[i + 1].frame <= frame) i++;
    const k0 = k[i], k1 = k[i + 1];
    if (t.step) return k0.value;
    if (k0.frame === k1.frame) return k1.value;
    const f = Math.fround;
    const t1 = f(frame - k0.frame), t2 = f(1 / f(k1.frame - k0.frame));
    const t1t1t2 = f(f(t1 * t1) * t2), t1t1t2t2 = f(t1t1t2 * t2);
    const t1t1t1t2t2 = f(t1 * t1t1t2t2), t1t1t1t2t2t2 = f(t1t1t1t2t2 * t2);
    return f(k0.value * (2 * t1t1t1t2t2t2 - 3 * t1t1t2t2 + 1)
      + k1.value * (-2 * t1t1t1t2t2t2 + 3 * t1t1t2t2)
      + k0.slope * (t1t1t1t2t2 - 2 * t1t1t2 + t1)
      + k1.slope * (t1t1t1t2t2 - t1t1t2));
  }

  static u8(v) { return Math.max(0, Math.min(255, Math.trunc(v + 0.5))); }

  /** Apply the animation at `frame` to a layout (AnimTransformBasic::Animate on every bound pane/material). */
  apply(layout, frame) {
    for (const c of this.contents) {
      if (c.isMaterial) {
        const m = layout.materials.find((x) => x.name === c.name);
        if (!m) continue;
        for (const info of c.infos) for (const t of info.targets) this.applyMaterial(info.kind, t, m, LytAnimation.evaluate(t, frame));
      } else {
        const p = layout.find(c.name);
        if (!p) continue;
        for (const info of c.infos) for (const t of info.targets) this.applyPane(info.kind, t, p, LytAnimation.evaluate(t, frame), layout);
      }
    }
  }

  applyPane(kind, t, p, v, layout) {
    switch (kind) {
      case 'RLPA':
        switch (t.target) {
          case 0: p.translate[0] = v; break; case 1: p.translate[1] = v; break; case 2: p.translate[2] = v; break;
          case 3: p.rotate[0] = v; break; case 4: p.rotate[1] = v; break; case 5: p.rotate[2] = v; break;
          case 6: p.scale[0] = v; break; case 7: p.scale[1] = v; break;
          case 8: p.size[0] = v; break; case 9: p.size[1] = v; break;
          default: break;
        }
        break;
      case 'RLVC': {
        if (t.target === 16) { p.alpha = LytAnimation.u8(v); return; }
        const corner = (t.target / 4) | 0, ch = t.target % 4;
        if ((p instanceof Picture || p instanceof Window) && corner < 4) p.vtxColors[corner][ch] = LytAnimation.u8(v);
        break;
      }
      case 'RLVI':
        p.visible = v !== 0;
        break;
      case 'RLMC': case 'RLTS': case 'RLTP': {
        // Material animations addressed through a pane resolve to its material.
        const m = (p instanceof Picture || p instanceof TextBox || p instanceof Window) ? p.material : null;
        if (m) this.applyMaterial(kind, t, m, v);
        break;
      }
      default: break;
    }
  }

  applyMaterial(kind, t, m, v) {
    switch (kind) {
      case 'RLMC': {
        const ch = t.target % 4;
        if (t.target < 4) {
          const c = m.matColor ? m.matColor.slice() : [255, 255, 255, 255];
          c[ch] = LytAnimation.u8(v); m.matColor = c;
        } else if (t.target < 16) {
          m.tevColors[((t.target - 4) / 4) | 0][ch] = Math.max(-1024, Math.min(1023, Math.sign(v) * Math.round(Math.abs(v))));
        } else if (t.target < 32) {
          m.tevKColors[((t.target - 16) / 4) | 0][ch] = LytAnimation.u8(v);
        }
        break;
      }
      case 'RLTS': {
        const i = t.index;
        if (i >= m.texSRTs.length) return;
        const s = m.texSRTs[i];
        switch (t.target) {
          case 0: s.translate[0] = v; break; case 1: s.translate[1] = v; break;
          case 2: s.rotate = v; break;
          case 3: s.scale[0] = v; break; case 4: s.scale[1] = v; break;
          default: break;
        }
        break;
      }
      case 'RLTP': {
        const name = this.textureNames[v | 0];
        if (name !== undefined) m.texturePatternOverride.set(t.index, name); else m.texturePatternOverride.delete(t.index);
        break;
      }
      default: break;
    }
  }
}
