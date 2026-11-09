// Port of Sources/NW4R/G3D/TexMtx.swift — nw4r::g3d texture-matrix calculation (decomp/notes/nw4r_g3d_texmtx.md):
//   fn_800A7388 LoadResTexSrt → fn_800AAD34 CalcTexMtx → fn_800AEE14 Maya / fn_800AF9B0 XSI / fn_800B0610 3dsMax
//   fn_800A5040 CalcEnvMtx (mapMode 1 env-camera, 3 env-light)
// Mtx34 = 3 rows × 4 columns: [[r0x,r0y,r0z,r0w],[…],[…]]. simd 4×4 matrices are column-major Float32Array(16).

const identity = () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];

function inverse4(m) {
  const a = m, inv = new Float32Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  const d = det === 0 ? 0 : 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= d;
  return inv;
}
function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const G3DTexMtx = {
  get identity() { return identity(); },
  /** Camera::GetEnvironmentTexMtx default (Camera::Init sets 0.5/0.5/0.5/0.5): C */
  get envC() { return [[0.5, 0, 0, 0.5], [0, -0.5, 0, 0.5], [0, 0, 0, 1]]; },

  /** SRT matrix for a layer. `flags` is that layer's 4-bit nibble: bit1 scale==1, bit2 rot==0, bit3 trans==0. */
  srt(s, mode, flags) {
    if (((flags >>> 1) & 7) === 7) return identity();
    const r = s.rotation * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    const Sx = s.scale[0], Sy = s.scale[1], Tx = s.translation[0], Ty = s.translation[1];
    switch (mode) {
      case 0: // Maya (fn_800AE644)
        return [[Sx * c, Sx * sn, 0, Sx * (-0.5 * c - (0.5 * sn - 0.5) - Tx)],
                [-Sy * sn, Sy * c, 0, 1 + Sy * (Ty + (-0.5 * c + 0.5 * sn - 0.5))],
                [0, 0, 1, 0]];
      case 1: // XSI (fn_800AF2F0)
        return [[Sx * c, -Sx * sn, 0, Sx * sn - Sx * c * Tx - Sx * sn * Ty],
                [Sy * sn, Sy * c, 0, 1 - Sy * c - Sy * sn * Tx + Sy * c * Ty],
                [0, 0, 1, 0]];
      default: // 3dsMax (fn_800AFF00)
        return [[Sx * c, Sx * sn, 0, 0.5 + (-Sx * c * (0.5 + Tx) + Sx * sn * (Ty - 0.5))],
                [-Sy * sn, Sy * c, 0, 0.5 + (Sy * sn * (0.5 + Tx) + Sy * c * (Ty - 0.5))],
                [0, 0, 1, 0]];
    }
  },

  /** SRT' — translation moved from column 3 into column 2 (rows 0, 1). */
  srtForEnv(m) { return [[m[0][0], m[0][1], m[0][3], 0], [m[1][0], m[1][1], m[1][3], 0], [0, 0, 1, 0]]; },

  mul(a, b) {
    const row = (r) => [
      r[0] * b[0][0] + r[1] * b[1][0] + r[2] * b[2][0],
      r[0] * b[0][1] + r[1] * b[1][1] + r[2] * b[2][1],
      r[0] * b[0][2] + r[1] * b[1][2] + r[2] * b[2][2],
      r[0] * b[0][3] + r[1] * b[1][3] + r[2] * b[2][3] + r[3],
    ];
    return [row(a[0]), row(a[1]), row(a[2])];
  },

  /** column-major 4×4 → Mtx34 */
  fromSimd(m) {
    return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]]];
  },
  zeroTranslation(m) { return [[m[0][0], m[0][1], m[0][2], 0], [m[1][0], m[1][1], m[1][2], 0], [m[2][0], m[2][1], m[2][2], 0]]; },

  /**
   * fn_800A5040 CalcEnvMtx — the "Env" term.
   * @param camRef, lightRef  int8 refs; curView: column-major 4×4; refViews: Map<int, mat4>;
   * light: { enabled, useDirection, viewPos:[3], viewDir:[3] } or null.
   */
  calcEnv(camRef, lightRef, curView, refViews, light) {
    if (camRef >= 0 && refViews && refViews.has(camRef)) {
      const m = this.zeroTranslation(this.fromSimd(mul4(refViews.get(camRef), inverse4(curView))));
      return this.mul(this.envC, m);
    }
    if (lightRef >= 0 && light && light.enabled) {
      const iv = inverse4(curView);
      const R = (v) => [iv[0] * v[0] + iv[4] * v[1] + iv[8] * v[2], iv[1] * v[0] + iv[5] * v[1] + iv[9] * v[2], iv[2] * v[0] + iv[6] * v[1] + iv[10] * v[2]];
      let v = light.useDirection ? R(light.viewDir) : R(light.viewPos).map((x) => -x);
      v = norm3(v);
      let up = [0, 1, 0];
      if (Math.abs(v[0]) < 1e-6 && Math.abs(v[2]) < 1e-6) up = [0, 0, v[1] > 0 ? 1 : -1];
      const rr = norm3(cross3(v, up)), u = cross3(rr, v);
      const basis = [[...rr, 0], [...u, 0], [-v[0], -v[1], -v[2], 0]];
      return this.mul(this.envC, this.zeroTranslation(this.mul(basis, this.fromSimd(iv))));
    }
    return this.envC; // camRef −1 (current camera) or light disabled → camera sphere map
  },
};
