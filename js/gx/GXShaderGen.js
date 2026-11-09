// Port of Sources/GX/GXShaderGen.swift — generates GLSL ES 3.00 (WebGL2) that reproduces GX's fixed-function
// pipeline for a given GXState. The pixel side is a line-by-line port of the Swift generator (itself Dolphin's
// PixelShaderGen integer TEV: lerp with c+(c>>7), rounding bias, s24 texcoords, indirect matrices, swap tables,
// konst selectors, alpha test). The vertex side ports VertexShaderGen's XF texgen path.
//
// ── Output contract (for the WebGL backend, js/forecast/render/GXWebGL.js) ──────────────────────────────────────
//   GXShaderGen.generate(state) → { vs, fs }   (complete #version 300 es sources)
//   Attributes (layout locations):  0 a_pos vec3 · 1 a_nrm vec3 · 2 a_clr0 vec4 · 3..10 a_tex0..a_tex7 vec2.
//     Interleaved vertex = 26 floats (GXShaderGen.vertexStride = 104 bytes): pos3 nrm3 clr4 tex 8×2 — same as Metal.
//   Uniforms — the Swift buffers, packed:
//     uniform vec4  u_vs[62];  = GXMetal.vertexUniforms layout:
//        [0..3] proj columns (column-major mat4, **GL clip space**: z in [-w, w]), [4..6] posMtx rows (3×4),
//        [7..9] nrmMtx rows, [10..33] preMtx (8 × 3 rows), [34..57] postMtx (8 × 3 rows),
//        [58,59] matColor0/1 (0..1), [60,61] ambColor0/1 (0..1).
//     uniform ivec4 u_fs[33];  = GXMetal.fragmentUniforms layout:
//        [0..3] konst, [4..7] tevRegs (prev,c0,c1,c2), [8..15] texDims per texmap (w,h,0,0),
//        [16..23] coordDims per texcoord, [24..29] indMtx (row0/row1, .w = shift), [30,31] indScale, [32] alphaRef.
//     uniform sampler2D t0..t7  (texture units 0..7; bind a 1×1 white texture to unused units).
//   GXShaderGen.vertexUniforms(...) / fragmentUniforms(...) build those arrays (Float32Array / Int32Array) —
//   ports of the GXMetal static helpers, so the backend only uploads them.
//   GXShaderGen.pipelineKey(state) → string; states with equal keys share one program (uniform-only fields masked,
//   like GXMetal.pipeline(_:)).
//   Note: the fragment shader outputs straight (non-premultiplied) RGBA 0..1; blending/depth come from
//   state.blendMode / state.zMode (fixed-function, set by the backend).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const VS_DEFS = `
uniform vec4 u_vs[62];
#define U_PROJ mat4(u_vs[0], u_vs[1], u_vs[2], u_vs[3])
#define U_POS(i) u_vs[4 + (i)]
#define U_NRM(i) u_vs[7 + (i)]
#define U_PRE(i) u_vs[10 + (i)]
#define U_POST(i) u_vs[34 + (i)]
#define U_MAT(i) u_vs[58 + (i)]
#define U_AMB(i) u_vs[60 + (i)]
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec4 a_clr0;
layout(location = 3) in vec2 a_tex0; layout(location = 4) in vec2 a_tex1; layout(location = 5) in vec2 a_tex2;
layout(location = 6) in vec2 a_tex3; layout(location = 7) in vec2 a_tex4; layout(location = 8) in vec2 a_tex5;
layout(location = 9) in vec2 a_tex6; layout(location = 10) in vec2 a_tex7;
out vec4 v_col0; out vec4 v_col1;
out vec3 v_tex0; out vec3 v_tex1; out vec3 v_tex2; out vec3 v_tex3; out vec3 v_tex4; out vec3 v_tex5; out vec3 v_tex6; out vec3 v_tex7;
`;

const FS_DEFS = `
uniform ivec4 u_fs[33];
#define U_KONST(i) u_fs[(i)]
#define U_TEVREG(i) u_fs[4 + (i)]
#define U_TEXDIMS(i) u_fs[8 + (i)]
#define U_COORDDIMS(i) u_fs[16 + (i)]
#define U_INDMTX(i) u_fs[24 + (i)]
#define U_INDSCALE(i) u_fs[30 + (i)]
#define U_ALPHAREF u_fs[32]
uniform sampler2D t0; uniform sampler2D t1; uniform sampler2D t2; uniform sampler2D t3;
uniform sampler2D t4; uniform sampler2D t5; uniform sampler2D t6; uniform sampler2D t7;
in vec4 v_col0; in vec4 v_col1;
in vec3 v_tex0; in vec3 v_tex1; in vec3 v_tex2; in vec3 v_tex3; in vec3 v_tex4; in vec3 v_tex5; in vec3 v_tex6; in vec3 v_tex7;
out vec4 fragColor;
int idot(ivec3 a, ivec3 b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
int iround(float x) { return int(roundEven(x)); }
ivec4 iround(vec4 x) { return ivec4(roundEven(x)); }
`;

// MARK: Vertex

function vertexShader(s) {
  let o = `
void main() {
    vec4 p = vec4(a_pos, 1.0);
    vec3 vp = vec3(dot(U_POS(0), p), dot(U_POS(1), p), dot(U_POS(2), p));
    gl_Position = U_PROJ * vec4(vp, 1.0);
    vec3 n = normalize(vec3(dot(U_NRM(0).xyz, a_nrm), dot(U_NRM(1).xyz, a_nrm), dot(U_NRM(2).xyz, a_nrm)));
`;
  // Color channels (unlit path + ambient when lighting enabled).
  for (let c = 0; c < 2; c++) {
    const cc = s.chanColorCtrl[c], ac = s.chanAlphaCtrl[c];
    const mat = `(${(cc & 1) === 1 ? 'a_clr0' : `U_MAT(${c})`})`;
    const lit = ((cc >>> 1) & 1) === 1;
    const amb = `(${((cc >>> 6) & 1) === 1 ? 'a_clr0' : `U_AMB(${c})`})`;
    const rgb = lit ? `${mat}.rgb * clamp(${amb}.rgb, 0.0, 1.0)` : `${mat}.rgb`;
    const amat = `(${(ac & 1) === 1 ? 'a_clr0' : `U_MAT(${c})`})`;
    const aamb = `(${((ac >>> 6) & 1) === 1 ? 'a_clr0' : `U_AMB(${c})`})`;
    const a = ((ac >>> 1) & 1) === 1 ? `${amat}.a * clamp(${aamb}.a, 0.0, 1.0)` : `${amat}.a`;
    o += `    v_col${c} = vec4(${rgb}, ${a});\n`;
  }
  for (let i = 0; i < 8; i++) {
    if (i >= s.numTexGens) { o += `    v_tex${i} = vec3(0.0);\n`; continue; }
    const g = s.texGen(i);
    o += '    {\n        vec4 coord = vec4(0.0, 0.0, 1.0, 1.0);\n';
    if (g.sourceRow === 0) o += '        coord.xyz = a_pos;\n';
    else if (g.sourceRow === 1) o += '        coord.xyz = a_nrm;\n';
    else if (g.sourceRow === 2) o += '        coord = a_clr0;\n';
    else if (g.sourceRow >= 5 && g.sourceRow <= 12) o += `        coord.xy = a_tex${g.sourceRow - 5};\n`;
    else o += `        // unsupported source row ${g.sourceRow}\n`;
    if (!g.inputABC1) o += '        coord.z = 1.0;\n';
    switch (g.type) {
      case 0: {
        const m = i * 3;
        if (g.projectionSTQ) o += `        vec3 r = vec3(dot(coord, U_PRE(${m})), dot(coord, U_PRE(${m + 1})), dot(coord, U_PRE(${m + 2})));\n`;
        else o += `        vec3 r = vec3(dot(coord, U_PRE(${m})), dot(coord, U_PRE(${m + 1})), 1.0);\n`;
        if (g.normalize) o += '        r = normalize(r);\n';
        o += `        vec4 P0 = U_POST(${m}), P1 = U_POST(${m + 1}), P2 = U_POST(${m + 2});
        r = vec3(dot(P0.xyz, r) + P0.w, dot(P1.xyz, r) + P1.w, dot(P2.xyz, r) + P2.w);
        if (r.z == 0.0) r.xy = clamp(r.xy / 2.0, vec2(-1.0), vec2(1.0));
        v_tex${i} = r;
`;
        break;
      }
      case 2: o += `        v_tex${i} = vec3(v_col0.rg, 1.0);\n`; break;
      case 3: o += `        v_tex${i} = vec3(v_col1.rg, 1.0);\n`; break;
      default: o += `        v_tex${i} = coord.xyz; // emboss texgen: TODO light-space shift\n`;
    }
    o += '    }\n';
  }
  o += '}\n';
  return o;
}

// MARK: Fragment

const cIn = ['prev.rgb', 'prev.aaa', 'c0.rgb', 'c0.aaa', 'c1.rgb', 'c1.aaa', 'c2.rgb', 'c2.aaa',
  'textemp.rgb', 'textemp.aaa', 'rastemp.rgb', 'rastemp.aaa', 'ivec3(255)', 'ivec3(128)', 'konsttemp.rgb', 'ivec3(0)'];
const aIn = ['prev.a', 'c0.a', 'c1.a', 'c2.a', 'textemp.a', 'rastemp.a', 'konsttemp.a', '0'];
const cOut = ['prev.rgb', 'c0.rgb', 'c1.rgb', 'c2.rgb'];
const aOut = ['prev.a', 'c0.a', 'c1.a', 'c2.a'];
const swz = ['r', 'g', 'b', 'a'];
const kfix = [255, 223, 191, 159, 128, 96, 64, 32];

function kselC(k) {
  if (k >= 0 && k <= 7) return `ivec3(${kfix[k]})`;
  if (k >= 0xC && k <= 0xF) return `U_KONST(${k - 0xC}).rgb`;
  if (k >= 0x10 && k <= 0x1F) {
    const c = swz[(k - 0x10) >> 2], i = (k - 0x10) % 4;
    return `U_KONST(${i}).${c}${c}${c}`;
  }
  return 'ivec3(0)';
}
function kselA(k) {
  if (k >= 0 && k <= 7) return `${kfix[k]}`;
  if (k >= 0x10 && k <= 0x1F) return `U_KONST(${(k - 0x10) % 4}).${swz[(k - 0x10) >> 2]}`;
  return '0';
}

/** Texture sampling helper per map: GX coords are s24 fixed point with 7 fractional bits over texture size. */
function sample(map, uv) {
  return `iround(255.0 * texture(t${map}, vec2(${uv}) / vec2(U_TEXDIMS(${map}).xy * 128)))`;
}

function fragmentShader(s) {
  let o = `
void main() {
    ivec4 prev = U_TEVREG(0), c0 = U_TEVREG(1), c1 = U_TEVREG(2), c2 = U_TEVREG(3);
    ivec4 rastemp = ivec4(0), textemp = ivec4(0), konsttemp = ivec4(0), rawtextemp = ivec4(0);
    ivec3 tevcoord = ivec3(0); ivec2 wrappedcoord = ivec2(0), tempcoord = ivec2(0);
    int alphabump = 0;
    ivec4 tevin_a, tevin_b, tevin_c, tevin_d;
    const ivec3 comp16 = ivec3(1, 256, 0), comp24 = ivec3(1, 256, 65536);
`;
  for (let i = 0; i < Math.max(s.numTexGens, 1); i++) {
    if (i < s.numTexGens) {
      o += `    ivec2 fixpoint_uv${i} = ivec2((v_tex${i}.z == 0.0 ? v_tex${i}.xy : v_tex${i}.xy / v_tex${i}.z) * vec2(U_COORDDIMS(${i}).xy * 128));\n`;
    } else {
      o += '    ivec2 fixpoint_uv0 = ivec2(0);\n';
    }
  }
  // Indirect texture lookups
  const usedInd = new Set();
  for (let n = 0; n < s.numTevStages; n++) { const st = s.tevStage(n); if ((st.ind & 3) < s.numIndStages) usedInd.add(st.ind & 3); }
  for (let i = 0; i < s.numIndStages; i++) {
    if (!usedInd.has(i)) continue;
    let { map, coord } = s.indRef(i);
    if (coord >= s.numTexGens) coord = 0;
    const [ss, ts] = s.indScale(i);
    o += `    tempcoord = fixpoint_uv${coord} >> ivec2(${ss}, ${ts});\n`;
    o += `    ivec3 iindtex${i} = ${sample(map, 'tempcoord')}.abg;\n`;
  }

  for (let n = 0; n < s.numTevStages; n++) o += stage(s, n);

  // Last stage's destination is what reaches the EFB.
  const last = s.tevStage(s.numTevStages - 1);
  const lcd = (last.cc >>> 22) & 3, lad = (last.ac >>> 22) & 3;
  if (lcd !== 0) o += `    prev.rgb = ${cOut[lcd]};\n`;
  if (lad !== 0) o += `    prev.a = ${aOut[lad]};\n`;
  o += '    prev = prev & 255;\n';
  o += alphaTest(s);
  o += '    fragColor = vec4(prev) / 255.0;\n}\n';
  return o;
}

function stage(s, n) {
  const st = s.tevStage(n);
  let o = `\n    // TEV stage ${n}\n`;
  const texcoord = st.texCoord < s.numTexGens ? st.texCoord : 0;
  const ind = st.ind;
  const bt = ind & 3, fmt = (ind >>> 2) & 3, bias = (ind >>> 4) & 7, bs = (ind >>> 7) & 3;
  const mtxIndex = (ind >>> 9) & 3, mtxID = (ind >>> 11) & 3;
  const sw = (ind >>> 13) & 7, tw = (ind >>> 16) & 7, addPrev = ((ind >>> 20) & 1) === 1;
  const hasInd = bt < s.numIndStages;

  if (hasInd && bs !== 0) {
    o += `    alphabump = (iindtex${bt}.${['', 'x', 'y', 'z'][bs]} << ${['0', '5', '4', '3'][fmt]}) & 248;\n`;
  }
  if (hasInd && mtxIndex !== 0) {
    o += `    ivec3 iindtevcrd${n} = iindtex${bt} >> ${['0', '3', '4', '5'][fmt]};\n`;
    if (bias !== 0) {
      const add = fmt === 0 ? '-128' : '1';
      const fields = ['', 'x', 'y', 'xy', 'z', 'xz', 'yz', 'xyz'][bias];
      o += `    iindtevcrd${n}.${fields} += ${add};\n`;
    }
    const m = 2 * (mtxIndex - 1);
    if (mtxID === 0) {
      o += `    ivec2 indtevtrans${n} = ivec2(idot(U_INDMTX(${m}).xyz, iindtevcrd${n}), idot(U_INDMTX(${m + 1}).xyz, iindtevcrd${n})) >> 3;\n`;
    } else if (mtxID === 1) {
      o += `    ivec2 indtevtrans${n} = ivec2(fixpoint_uv${texcoord} * iindtevcrd${n}.xx) >> 8;\n`;
    } else {
      o += `    ivec2 indtevtrans${n} = ivec2(fixpoint_uv${texcoord} * iindtevcrd${n}.yy) >> 8;\n`;
    }
    o += `    if (U_INDMTX(${m}).w >= 0) indtevtrans${n} >>= U_INDMTX(${m}).w; else indtevtrans${n} <<= -U_INDMTX(${m}).w;\n`;
  } else {
    o += `    ivec2 indtevtrans${n} = ivec2(0);\n`;
  }
  const wrapStart = ['(256<<7)', '(128<<7)', '(64<<7)', '(32<<7)', '(16<<7)'];
  const wrap = (w, c) => {
    if (w === 0) return `fixpoint_uv${texcoord}.${c}`;
    if (w >= 6) return '0';
    return `(fixpoint_uv${texcoord}.${c} & (${wrapStart[w - 1]} - 1))`;
  };
  o += `    wrappedcoord = ivec2(${wrap(sw, 'x')}, ${wrap(tw, 'y')});\n`;
  o += addPrev ? `    tevcoord.xy += wrappedcoord + indtevtrans${n};\n` : `    tevcoord.xy = wrappedcoord + indtevtrans${n};\n`;
  o += '    tevcoord.xy = (tevcoord.xy << 8) >> 8;\n';

  const cc = st.cc, ac = st.ac;
  const ca = (cc >>> 12) & 0xF, cb = (cc >>> 8) & 0xF, cc_ = (cc >>> 4) & 0xF, cd = cc & 0xF;
  const aa = (ac >>> 13) & 7, ab = (ac >>> 10) & 7, ac_ = (ac >>> 7) & 7, ad = (ac >>> 4) & 7;
  const rswap = s.swapTable(ac & 3), tswap = s.swapTable((ac >>> 2) & 3);

  const usesRas = [ca, cb, cc_, cd].some(v => v === 10 || v === 11) || [aa, ab, ac_, ad].includes(5);
  if (usesRas) {
    let ras;
    switch (st.colorChan) {
      case 0: ras = 'iround(v_col0 * 255.0)'; break;
      case 1: ras = 'iround(v_col1 * 255.0)'; break;
      case 5: ras = 'ivec4(alphabump)'; break;
      case 6: ras = 'ivec4(alphabump | (alphabump >> 5))'; break;
      default: ras = 'ivec4(0)';
    }
    o += `    rastemp = (${ras}).${rswap.map(i => swz[i]).join('')};\n`;
  }
  if (st.texEnable && s.numTexGens > 0) {
    o += `    rawtextemp = ${sample(st.texMap, 'tevcoord.xy')};\n`;
    o += `    textemp = rawtextemp.${tswap.map(i => swz[i]).join('')};\n`;
  } else if (s.numTexGens === 0) {
    o += '    textemp = ivec4(0);\n';
  } else {
    o += '    textemp = ivec4(255);\n';
  }
  if ([ca, cb, cc_, cd].includes(14) || [aa, ab, ac_, ad].includes(6)) {
    o += `    konsttemp = ivec4(${kselC(st.kcsel)}, ${kselA(st.kasel)});\n`;
  }
  o += `    tevin_a = ivec4(${cIn[ca]}, ${aIn[aa]}) & ivec4(255);\n`;
  o += `    tevin_b = ivec4(${cIn[cb]}, ${aIn[ab]}) & ivec4(255);\n`;
  o += `    tevin_c = ivec4(${cIn[cc_]}, ${aIn[ac_]}) & ivec4(255);\n`;
  o += `    tevin_d = ivec4(${cIn[cd]}, ${aIn[ad]});\n`;

  o += `    ${cOut[(cc >>> 22) & 3]} = clamp(${combiner(cc, false)}, `;
  o += ((cc >>> 19) & 1) === 1 ? 'ivec3(0), ivec3(255));\n' : 'ivec3(-1024), ivec3(1023));\n';
  o += `    ${aOut[(ac >>> 22) & 3]} = clamp(${combiner(ac, true)}, `;
  o += ((ac >>> 19) & 1) === 1 ? '0, 255);\n' : '-1024, 1023);\n';
  return o;
}

/** Dolphin WriteTevRegular / compare modes. */
function combiner(v, isAlpha) {
  const comp = isAlpha ? 'a' : 'rgb';
  const bias = (v >>> 16) & 3, op = (v >>> 18) & 1, scale = (v >>> 20) & 3;
  if (bias !== 3) {
    const biasS = ['', ' + 128', ' - 128', ''][bias];
    const sl = ['', ' << 1', ' << 2', ''][scale], sr = ['', '', '', ' >> 1'][scale];
    const lerpBias = scale !== 3 ? (op === 0 ? ' + 128' : ' + 127') : '';
    const opS = op === 0 ? '+' : '-';
    const X = comp;
    const lhs = `(((tevin_d.${X})${biasS})${sl})`;
    const l1 = `(tevin_a.${X}<<8) + (tevin_b.${X}-tevin_a.${X})*(tevin_c.${X}+(tevin_c.${X}>>7))`;
    const l2 = `((${l1})${sl})`;
    const l3 = `((${l2})${lerpBias}) >> 8`;
    return `((${lhs} ${opS} (${l3}))${sr})`;
  }
  const mode = scale, eq = op === 1;
  if (!isAlpha) {
    const gt = ['((tevin_a.r > tevin_b.r) ? tevin_c.rgb : ivec3(0))',
      '((idot(tevin_a.rgb, comp16) > idot(tevin_b.rgb, comp16)) ? tevin_c.rgb : ivec3(0))',
      '((idot(tevin_a.rgb, comp24) > idot(tevin_b.rgb, comp24)) ? tevin_c.rgb : ivec3(0))',
      '(max(sign(tevin_a.rgb - tevin_b.rgb), ivec3(0)) * tevin_c.rgb)'];
    const e = ['((tevin_a.r == tevin_b.r) ? tevin_c.rgb : ivec3(0))',
      '((idot(tevin_a.rgb, comp16) == idot(tevin_b.rgb, comp16)) ? tevin_c.rgb : ivec3(0))',
      '((idot(tevin_a.rgb, comp24) == idot(tevin_b.rgb, comp24)) ? tevin_c.rgb : ivec3(0))',
      '((ivec3(1) - sign(abs(tevin_a.rgb - tevin_b.rgb))) * tevin_c.rgb)'];
    return `tevin_d.rgb + ${(eq ? e : gt)[mode]}`;
  }
  const gt = ['((tevin_a.r > tevin_b.r) ? tevin_c.a : 0)',
    '((idot(tevin_a.rgb, comp16) > idot(tevin_b.rgb, comp16)) ? tevin_c.a : 0)',
    '((idot(tevin_a.rgb, comp24) > idot(tevin_b.rgb, comp24)) ? tevin_c.a : 0)',
    '((tevin_a.a > tevin_b.a) ? tevin_c.a : 0)'];
  const e = ['((tevin_a.r == tevin_b.r) ? tevin_c.a : 0)',
    '((idot(tevin_a.rgb, comp16) == idot(tevin_b.rgb, comp16)) ? tevin_c.a : 0)',
    '((idot(tevin_a.rgb, comp24) == idot(tevin_b.rgb, comp24)) ? tevin_c.a : 0)',
    '((tevin_a.a == tevin_b.a) ? tevin_c.a : 0)'];
  return `tevin_d.a + ${(eq ? e : gt)[mode]}`;
}

function alphaTest(s) {
  const a = s.alphaCompare;
  const f = (mode, ref) => ['(false)', `(prev.a < ${ref})`, `(prev.a == ${ref})`, `(prev.a <= ${ref})`,
    `(prev.a > ${ref})`, `(prev.a != ${ref})`, `(prev.a >= ${ref})`, '(true)'][mode];
  if (a.comp0 === 7 && a.comp1 === 7 && (a.logic === 0 || a.logic === 1)) return '';
  const l0 = f(a.comp0, 'U_ALPHAREF.x'), l1 = f(a.comp1, 'U_ALPHAREF.y');
  // GLSL has no boolean != / == on bool expressions with ^; use explicit forms.
  const expr = [`(${l0} && ${l1})`, `(${l0} || ${l1})`, `(${l0} != ${l1})`, `(${l0} == ${l1})`][a.logic];
  return `    if (!${expr}) discard;\n`;
}

const IDENTITY34 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];

export const GXShaderGen = {
  vertexStride: 104,   // pos3 nrm3 clr4 tex 8x2 (floats) = 26 * 4
  floatsPerVertex: 26,

  /** → { vs, fs } GLSL ES 3.00 sources. */
  generate(s) {
    return { vs: header + VS_DEFS + vertexShader(s), fs: header + FS_DEFS + fragmentShader(s) };
  },

  /** Program cache key: uniform-only fields masked (GXMetal.pipeline). */
  pipelineKey(s) {
    const k = s.clone();
    for (let m = 0; m < 9; m++) k.bp[0x06 + m] &= 0x00C00000;
    k.bp[0xF3] &= ~0xFFFF;
    // blend / z mode are fixed-function GL state, not shader state
    k.bp[0x40] = 0; k.bp[0x41] = 0;
    return k.shaderKey();
  },

  /**
   * Vertex uniforms (GXMetal.vertexUniforms): Float32Array(62*4).
   * proj: Float32Array(16) column-major (GL clip space); posMtx: Float32Array(16) column-major;
   * pre / post: arrays of 3×4 matrices given as [[r0..],[r1..],[r2..]] (rows of 4); missing → identity.
   */
  vertexUniforms(proj, posMtx, pre, post, gx) {
    const vu = new Float32Array(62 * 4);
    vu.set(proj, 0);
    for (let r = 0; r < 3; r++) {
      vu.set([posMtx[r], posMtx[4 + r], posMtx[8 + r], posMtx[12 + r]], (4 + r) * 4);
      vu.set([r === 0 ? 1 : 0, r === 1 ? 1 : 0, r === 2 ? 1 : 0, 0], (7 + r) * 4);
    }
    for (let i = 0; i < 8; i++) {
      const a = (pre && i < pre.length && pre[i]) || IDENTITY34, b = (post && i < post.length && post[i]) || IDENTITY34;
      for (let r = 0; r < 3; r++) { vu.set(a[r], (10 + i * 3 + r) * 4); vu.set(b[r], (34 + i * 3 + r) * 4); }
    }
    const rgba = v => [(v >>> 24) / 255, ((v >>> 16) & 0xFF) / 255, ((v >>> 8) & 0xFF) / 255, (v & 0xFF) / 255];
    vu.set(rgba(gx.chanMatColor[0]), 58 * 4); vu.set(rgba(gx.chanMatColor[1]), 59 * 4);
    vu.set(rgba(gx.chanAmbColor[0]), 60 * 4); vu.set(rgba(gx.chanAmbColor[1]), 61 * 4);
    return vu;
  },

  /** Fragment uniforms (GXMetal.fragmentUniforms): Int32Array(33*4). `dims` = per texmap [w, h] (logical size). */
  fragmentUniforms(gx, dims) {
    const fu = new Int32Array(33 * 4);
    for (let i = 0; i < 4; i++) { fu.set(gx.konst[i], i * 4); fu.set(gx.tevRegs[i], (4 + i) * 4); }
    for (let i = 0; i < 8; i++) { const d = (dims && i < dims.length && dims[i]) || [1, 1]; fu.set([d[0], d[1], 0, 0], (8 + i) * 4); }
    const coordMap = new Array(8).fill(-1);
    for (let s = 0; s < gx.numTevStages; s++) { const st = gx.tevStage(s); if (st.texEnable && coordMap[st.texCoord] < 0) coordMap[st.texCoord] = st.texMap; }
    for (let i = 0; i < gx.numIndStages; i++) { const { map, coord } = gx.indRef(i); if (coordMap[coord] < 0) coordMap[coord] = map; }
    for (let c = 0; c < 8; c++) {
      if (coordMap[c] >= 0) fu.set(fu.subarray((8 + coordMap[c]) * 4, (8 + coordMap[c]) * 4 + 4), (16 + c) * 4);
      else fu.set([1, 1, 0, 0], (16 + c) * 4);
    }
    for (let m = 0; m < 3; m++) {
      const im = gx.indMatrix(m);
      fu.set([...im.row0, im.shift], (24 + m * 2) * 4); fu.set([...im.row1, im.shift], (25 + m * 2) * 4);
    }
    for (let i = 0; i < 4; i++) {
      const [s, t] = gx.indScale(i);
      fu[(30 + (i >> 1)) * 4 + (i & 1) * 2] = s; fu[(30 + (i >> 1)) * 4 + (i & 1) * 2 + 1] = t;
    }
    const ac = gx.alphaCompare;
    fu[32 * 4] = ac.ref0; fu[32 * 4 + 1] = ac.ref1;
    return fu;
  },
};
