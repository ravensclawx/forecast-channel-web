// Column-major 4×4 matrix + small vector helpers, mirroring the simd calls used across the Swift code.
//
// API (all matrices are Float32Array(16), COLUMN-MAJOR like simd_float4x4: element (row r, column c) = m[c*4 + r];
// m.columns.3 (translation) = m[12..14]). Functions return NEW arrays unless named *Into.
//   identity()                         matrix_identity_float4x4
//   clone(m)
//   fromRows(r0, r1, r2, r3)           simd_float4x4(rows: [SIMD4…])  (rows given as 4-element arrays)
//   fromColumns(c0, c1, c2, c3)        simd_float4x4(columns)
//   column(m, c) / row(m, r)           → [4]
//   mul(a, b)                          a * b   (matrix product; applies b first)
//   mulVec4(m, v)                      m * SIMD4  → [4]
//   transformPoint(m, [x,y,z])         m * (x,y,z,1)  → [x,y,z] (no perspective divide)
//   transformDir(m, [x,y,z])           m * (x,y,z,0)  → [x,y,z]
//   translate(x, y, z)                 translation matrix
//   scale(x, y, z = 1)                 scale matrix
//   rotX(rad) / rotY(rad) / rotZ(rad)  right-handed rotation matrices (same as simd_quatf(angle:axis:) for unit axes)
//   rotAxis(rad, [x,y,z])              simd_float4x4(simd_quatf(angle:axis:))
//   transpose(m), invert(m)            (invert returns identity if singular)
//   perspectiveGL(fovyRad, aspect, near, far)   GL clip space (z ∈ [-w, w])
//   orthoGL(left, right, bottom, top, near, far)
//   mtx34Rows(m)                       → [[4],[4],[4]] first three rows (GX 3×4 matrix form used by GXShaderGen)
// Vectors are plain arrays: add, sub, scaleV, dot, cross, length, normalize.
// Clip-space note: the Swift/Metal code produced Metal clip z (0..1). When porting a projection, use the GL variants
// here (or post-multiply with metalToGLClip()) — the GL backend expects GL clip space.

export function identity() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function clone(m) { return new Float32Array(m); }
export function fromRows(r0, r1, r2, r3 = [0, 0, 0, 1]) {
  const m = new Float32Array(16), rows = [r0, r1, r2, r3];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = rows[r][c];
  return m;
}
export function fromColumns(c0, c1, c2, c3) {
  const m = new Float32Array(16);
  m.set(c0, 0); m.set(c1, 4); m.set(c2, 8); m.set(c3, 12);
  return m;
}
export function column(m, c) { return [m[c * 4], m[c * 4 + 1], m[c * 4 + 2], m[c * 4 + 3]]; }
export function row(m, r) { return [m[r], m[4 + r], m[8 + r], m[12 + r]]; }

export function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return o;
}
export function mulVec4(m, v) {
  const [x, y, z, w] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}
export function transformPoint(m, p) { const v = mulVec4(m, [p[0], p[1], p[2], 1]); return [v[0], v[1], v[2]]; }
export function transformDir(m, p) { const v = mulVec4(m, [p[0], p[1], p[2], 0]); return [v[0], v[1], v[2]]; }

export function translate(x, y, z) { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; }
export function scale(x, y, z = 1) { const m = identity(); m[0] = x; m[5] = y; m[10] = z; return m; }
export function rotX(a) { const m = identity(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
export function rotY(a) { const m = identity(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
export function rotZ(a) { const m = identity(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
export function rotAxis(a, axis) {
  const [x, y, z] = normalize(axis), c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return fromRows(
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0],
    [0, 0, 0, 1]);
}
export function transpose(m) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c];
  return o;
}
export function invert(m) {
  const a = m, o = new Float32Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity();
  det = 1 / det;
  o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
  o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
  o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
  o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
  o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
  o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
  o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
  o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
  o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return o;
}
export function perspectiveGL(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}
export function orthoGL(l, r, b, t, n, f) {
  const m = identity();
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
  return m;
}
/** Converts a Metal clip-space projection (z ∈ [0, w]) to GL (z ∈ [-w, w]): z' = 2z − w. Use as mul(metalToGLClip(), P). */
export function metalToGLClip() { return fromRows([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 2, -1], [0, 0, 0, 1]); }
export function mtx34Rows(m) { return [row(m, 0), row(m, 1), row(m, 2)]; }

// vectors
export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const scaleV = (a, s) => a.map(v => v * s);
export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = a => Math.hypot(...a);
export function normalize(a) { const l = length(a) || 1; return a.map(v => v / l); }
