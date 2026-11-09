// Port of Sources/NW4R/Ef/EfDraw.swift — nw4r::ef::DrawStrategyImpl + DrawBillboardStrategy (type 3, option 0).
// DOL: InitTev fn_8009A78C, InitTexture fn_8009A71C, InitColor fn_8009AA38, SetupGP fn_8009ACE8,
// DrawNormalBillboard fn_8009C06C (via fn_8009D420).
//
// Produces EfDrawPackets: { gx: GXState, texMtx: [Mtx34 per texmap (3 rows of 4)], textures: [{texture, wrapS, wrapT}],
// quad: [{position:[x,y,z] (view space, y up), texCoord:[s,t]} ×4 in GX_QUADS order] }. Track B submits them (Cursor.js).
import { GXState } from '../../gx/GXState.js';
import { EfDrawFlags } from './EfResource.js';

const COLOR0 = 0, ALPHA0 = 2, COLOR0A0 = 4, COLOR1A1 = 5;
/** Billboard texcoord table (billboard_tex0_u8): (0,1) (0,0) (1,0) (1,1). */
const billboardTexCoords = [[0, 1], [0, 0], [1, 0], [1, 1]];
const ident4 = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
const mul4 = (a, b) => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};

export const EfDraw = {
  /** EffectSystem::Draw for one particle manager. `view` is DrawInfo's view matrix (identity for the cursor). */
  draw(pm, view = null, textures) {
    const res = pm.resource;
    if (res.desc.ptclType !== 3 || res.desc.typeOption !== 0) return [];   // only normal billboards are ported
    const ds = res.draw;
    if (ds.flags & EfDrawFlags.hidden) return [];
    const V = view ?? ident4();

    // InitTexture: texmap slots for layer 1, layer 2, indirect.
    const texmapMap = [-1, -1, -1];
    let numTexmap = 0;
    if (ds.flags & EfDrawFlags.tex1Enable) { texmapMap[0] = 0; numTexmap++; }
    if (ds.flags & EfDrawFlags.tex2Enable) { texmapMap[1] = numTexmap; numTexmap++; }
    if (ds.flags & EfDrawFlags.texIndEnable) { texmapMap[2] = numTexmap; numTexmap++; }

    // DrawNormalBillboard
    const viewMtx = mul4(V, pm.globalMtx);
    const vx = Math.hypot(viewMtx[0], viewMtx[1], viewMtx[2]);
    const vy = Math.hypot(viewMtx[4], viewMtx[5], viewMtx[6]);
    const mag = Math.sqrt(V[4] * V[4] + V[5] * V[5]);
    const [rs, rc] = mag === 0 ? [0, 1] : [-V[4] / mag, V[5] / mag];
    const pivot = ds.pivot;

    const out = [];
    // Draw order: elders first unless FLAG_DRAW_ORDER (youngers first).
    const order = (ds.flags & EfDrawFlags.drawOrder) ? pm.particles.slice().reverse() : pm.particles;
    for (const p of order) {
      if (!p.alive) continue;
      const s = p.drawSize(ds);
      if (!(s[0] >= Number.EPSILON && s[1] >= Number.EPSILON)) continue;
      // GX state per particle (Swift copied the struct; here it is rebuilt).
      const g = new GXState();
      g.setNumTexGens(numTexmap);
      EfDraw.initTev(g, ds, texmapMap);
      const [useColor1, useColor2] = EfDraw.initColor(g, ds);
      // SetupGP: _SetupACmp, _SetupTevReg, _SetupTexture.
      g.setAlphaCompare(ds.aCmpComp0, p.parameter.aCmpRef0, ds.aCmpOp, ds.aCmpComp1, p.parameter.aCmpRef1);
      EfDraw.setupTevReg(g, p, ds, useColor1, useColor2);
      const mtx = Array.from({ length: Math.max(numTexmap, 1) }, () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]);
      const texs = [];
      for (let layer = 0; layer < 3; layer++) {
        if (texmapMap[layer] < 0) continue;
        const t = textures.textures.get(res.particle.textureNames[layer]);
        if (!t) continue;
        const slot = texmapMap[layer];
        const wrapS = (p.parameter.textureWrap >> (layer * 4)) & 3;
        const wrapT = (p.parameter.textureWrap >> (layer * 4 + 2)) & 3;
        while (texs.length <= slot) texs.push({ texture: t, wrapS, wrapT });
        texs[slot] = { texture: t, wrapS, wrapT };
        mtx[slot] = EfDraw.textureMatrix(p, layer, wrapS, wrapT);
        g.setTexCoordGen(slot, 1, 4);   // GX_TG_MTX2x4, GX_TG_TEX0, GX_TEXMTX0 + slot·3
      }
      out.push({ gx: g, texMtx: mtx, textures: texs, quad: EfDraw.billboardQuad(p, viewMtx, vx, vy, rc, rs, s, pivot) });
    }
    return out;
  },

  /** DrawStrategyImpl::InitTev (fn_8009A78C). Alpha op read from the colour-op table (library bug, also in the DOL). */
  initTev(gx, ds, texmapMap) {
    gx.setNumTevStages(ds.numTevs);
    gx.setTevSwapModeTable(0, 0, 1, 2, 3);
    for (let i = 0; i < ds.numTevs; i++) {
      const st = ds.tev[i];
      gx.setTevDirect(i);
      gx.setTevColorIn(i, st.color.a, st.color.b, st.color.c, st.color.d);
      gx.setTevAlphaIn(i, st.alpha.a, st.alpha.b, st.alpha.c, st.alpha.d);
      const op = st.colorOp;
      gx.setTevColorOp(i, op.op, op.bias, op.scale, op.clamp !== 0, op.out);
      gx.setTevAlphaOp(i, op.op, op.bias, op.scale, op.clamp !== 0, op.out);
      gx.setTevKColorSel(i, st.kColorSel);
      gx.setTevKAlphaSel(i, st.kAlphaSel);
      gx.setTevSwapMode(i, 0, 0);
      const slot = i === 0 ? texmapMap[0] : texmapMap[1];
      if (slot < 0) gx.setTevOrder(i, 0xFF, 0xFF, 4);
      else gx.setTevOrder(i, slot, slot, 4);
    }
    gx.setNumIndStages(0);
    gx.setBlendMode(ds.blend.type, ds.blend.src, ds.blend.dst, ds.blend.op);
    gx.setZMode((ds.flags & EfDrawFlags.zCompEnableTest) !== 0, ds.zCompareFunc, (ds.flags & EfDrawFlags.zCompEnableUpdate) !== 0);
  },

  /** DrawStrategyImpl::InitColor (fn_8009AA38): one channel, material colour from the register (white). */
  initColor(gx, ds) {
    gx.setNumChans(1);
    gx.setChanCtrl(COLOR0, false, 0, 0);
    gx.setChanCtrl(ALPHA0, false, 0, 0);
    gx.setChanCtrl(COLOR1A1, false, 0, 0);
    gx.setChanMatColor(COLOR0A0, 0xFFFFFFFF);
    gx.setChanAmbColor(COLOR0A0, 0);
    let use1 = false, use2 = false;
    for (const c of ds.tevColorInput) if (c === 1 || c === 2) { use1 = true; use2 = true; }   // (library bug: use2 tests 1/2 too)
    for (const c of ds.tevKColorInput) {
      if (c === 1 || c === 2) use1 = true;
      if (c === 3 || c === 4) use2 = true;
    }
    return [use1, use2];
  },

  /** DrawStrategyImpl::_SetupTevReg — particle colour layers into TEV registers / konst colours per ColorInput. */
  setupTevReg(gx, p, ds, use1, use2) {
    for (const [layer, use, priID, secID] of [[0, use1, 1, 2], [1, use2, 3, 4]]) {
      if (!use) continue;
      const [pri, sec] = p.drawColor(layer, ds);
      for (let i = 0; i < 3; i++) {
        if (ds.tevColorInput[i] === priID) gx.setTevColor(1 + i, pri);
        if (ds.tevColorInput[1] === secID) gx.setTevColor(1 + i, sec);   // library typo: [1], not [i]
      }
      for (let i = 0; i < 4; i++) {
        if (ds.tevKColorInput[i] === priID) gx.setTevKColor(i, pri);
        if (ds.tevKColorInput[i] === secID) gx.setTevKColor(i, sec);
      }
    }
  },

  /** DrawStrategyImpl::_SetupTexture texture matrix (3 rows of 4; rows 0/1 used as the 2x4). */
  textureMatrix(p, layer, wrapS, wrapT) {
    const pr = p.parameter;
    const rev = (pr.textureReverse >> (layer * 2)) & 3;
    let scaleS = wrapS === 2 ? 2 : 1, scaleT = wrapT === 2 ? 2 : 1;
    if (rev === 1 || rev === 3) scaleS -= scaleS * 2;
    if (rev === 2 || rev === 3) scaleT -= scaleT * 2;
    let transS = rev === 1 || rev === 3 ? 1 : 0, transT = rev === 2 || rev === 3 ? 1 : 0;
    if (wrapS === 2) transS *= 2;
    if (wrapT === 2) transT *= 2;
    // 3×3 row-major helpers; each step: m = work · m.
    const m3 = (a, b) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c]));
    const t = (x, y) => [[1, 0, x], [0, 1, y], [0, 0, 1]];
    let m = t(pr.textureTranslate[layer][0], pr.textureTranslate[layer][1]);
    const r = pr.textureRotate[layer];
    if (r !== 0) {
      m = m3(t(-0.5, -0.5), m);
      m = m3([[Math.cos(r), -Math.sin(r), 0], [Math.sin(r), Math.cos(r), 0], [0, 0, 1]], m);
      m = m3(t(0.5, 0.5), m);
    }
    m = m3(t(-0.5, -0.5), m);
    m = m3([[pr.textureScale[layer][0], 0, 0], [0, pr.textureScale[layer][1], 0], [0, 0, 1]], m);
    m = m3(t(0.5, 0.5), m);
    m = m3([[scaleS, 0, transS], [0, scaleT, transT], [0, 0, 1]], m);
    // Rows of the 2x4 matrix applied to (s, t, 1, 1): (m00, m01, 0, m02)
    return [[m[0][0], m[0][1], 0, m[0][2]], [m[1][0], m[1][1], 0, m[1][2]], [0, 0, 1, 0]];
  },

  /** DrawBillboardStrategy::DispParticle_Normal + DispPolygon (GX_QUADS: P−D0, P−D1, P+D0, P+D1). */
  billboardQuad(p, viewMtx, vx, vy, rc, rs, s, pivot) {
    const rotZ = p.parameter.rotate[2];
    const P = p.parameter.position;
    const pos = [
      viewMtx[0] * P[0] + viewMtx[4] * P[1] + viewMtx[8] * P[2] + viewMtx[12],
      viewMtx[1] * P[0] + viewMtx[5] * P[1] + viewMtx[9] * P[2] + viewMtx[13],
      viewMtx[2] * P[0] + viewMtx[6] * P[1] + viewMtx[10] * P[2] + viewMtx[14],
    ];
    const [px, py] = pivot, [sx, sy] = s;
    const vxrc = vx * rc, vxrs = vx * rs, vyrc = vy * rc, vyrs = vy * rs;
    const sr = Math.sin(-rotZ), cr = Math.cos(-rotZ);
    const crsx = cr * sx, srsx = sr * sx, crsy = cr * sy, srsy = sr * sy;
    const e0 = (px - crsx * px) - srsy * py;
    const e1 = (py + srsx * px) - crsy * py;
    const p0 = [vxrc * e0 + vyrs * e1 + pos[0], vxrs * e0 - vyrc * e1 + pos[1], pos[2]];
    const d0 = [vxrc * crsx - vxrc * srsy - vyrs * srsx - vyrs * crsy, vxrs * crsx - vxrs * srsy + vyrc * srsx + vyrc * crsy, 0];
    const d1 = [vxrc * crsx + vxrc * srsy - vyrs * srsx + vyrs * crsy, vxrs * crsx + vxrs * srsy + vyrc * srsx - vyrc * crsy, 0];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    return [
      { position: sub(p0, d0), texCoord: billboardTexCoords[0] }, { position: sub(p0, d1), texCoord: billboardTexCoords[1] },
      { position: add(p0, d0), texCoord: billboardTexCoords[2] }, { position: add(p0, d1), texCoord: billboardTexCoords[3] },
    ];
  },
};
