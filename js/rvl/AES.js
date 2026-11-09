// Small table-based AES-128 (decrypt, CBC, no padding) + SHA-1, for the WAD import path (ES.js).
// Pure JS so it is synchronous and has no padding restrictions (WebCrypto's AES-CBC insists on PKCS#7).

const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
const TD0 = new Uint32Array(256), TD1 = new Uint32Array(256), TD2 = new Uint32Array(256), TD3 = new Uint32Array(256);
(function init() {
  // GF(2^8) log/antilog tables
  const exp = new Uint8Array(256), log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x; log[x] = i;
    x ^= (x << 1) ^ ((x & 0x80) ? 0x11B : 0); x &= 0xFF;
  }
  const mul = (a, b) => (a && b) ? exp[(log[a] + log[b]) % 255] : 0;
  for (let i = 0; i < 256; i++) {
    let v = i ? exp[(255 - log[i]) % 255] : 0;
    let s = v ^ ((v << 1) | (v >> 7)) ^ ((v << 2) | (v >> 6)) ^ ((v << 3) | (v >> 5)) ^ ((v << 4) | (v >> 4));
    s = (s ^ 0x63) & 0xFF;
    SBOX[i] = s; INV[s] = i;
  }
  for (let i = 0; i < 256; i++) {
    const s = INV[i];
    const w = (mul(s, 14) << 24) | (mul(s, 9) << 16) | (mul(s, 13) << 8) | mul(s, 11);
    TD0[i] = w >>> 0;
    TD1[i] = ((w >>> 8) | (w << 24)) >>> 0;
    TD2[i] = ((w >>> 16) | (w << 16)) >>> 0;
    TD3[i] = ((w >>> 24) | (w << 8)) >>> 0;
  }
})();

function expandKey(key) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  let rcon = 1;
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1];
    if (i % 4 === 0) {
      t = ((SBOX[(t >>> 16) & 0xFF] << 24) | (SBOX[(t >>> 8) & 0xFF] << 16) | (SBOX[t & 0xFF] << 8) | SBOX[t >>> 24]) >>> 0;
      t = (t ^ (rcon << 24)) >>> 0;
      rcon = (rcon << 1) ^ ((rcon & 0x80) ? 0x11B : 0);
    }
    w[i] = (w[i - 4] ^ t) >>> 0;
  }
  // Decryption key schedule (equivalent inverse cipher): reverse round order, InvMixColumns on rounds 1..9.
  const dk = new Uint32Array(44);
  for (let r = 0; r <= 10; r++) for (let c = 0; c < 4; c++) {
    let v = w[(10 - r) * 4 + c];
    if (r > 0 && r < 10) v = TD0[SBOX[v >>> 24]] ^ TD1[SBOX[(v >>> 16) & 0xFF]] ^ TD2[SBOX[(v >>> 8) & 0xFF]] ^ TD3[SBOX[v & 0xFF]];
    dk[r * 4 + c] = v >>> 0;
  }
  return dk;
}

/** AES-128-CBC decrypt without padding. `data.length` must be a multiple of 16. Returns a new Uint8Array. */
export function aesCBCDecrypt(key, iv, data) {
  const dk = expandKey(key);
  const out = new Uint8Array(data.length);
  let p0 = ((iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3]) >>> 0;
  let p1 = ((iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7]) >>> 0;
  let p2 = ((iv[8] << 24) | (iv[9] << 16) | (iv[10] << 8) | iv[11]) >>> 0;
  let p3 = ((iv[12] << 24) | (iv[13] << 16) | (iv[14] << 8) | iv[15]) >>> 0;
  for (let o = 0; o + 16 <= data.length; o += 16) {
    const c0 = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
    const c1 = ((data[o + 4] << 24) | (data[o + 5] << 16) | (data[o + 6] << 8) | data[o + 7]) >>> 0;
    const c2 = ((data[o + 8] << 24) | (data[o + 9] << 16) | (data[o + 10] << 8) | data[o + 11]) >>> 0;
    const c3 = ((data[o + 12] << 24) | (data[o + 13] << 16) | (data[o + 14] << 8) | data[o + 15]) >>> 0;
    let s0 = c0 ^ dk[0], s1 = c1 ^ dk[1], s2 = c2 ^ dk[2], s3 = c3 ^ dk[3];
    let k = 4;
    for (let r = 1; r < 10; r++) {
      const t0 = TD0[s0 >>> 24] ^ TD1[(s3 >>> 16) & 0xFF] ^ TD2[(s2 >>> 8) & 0xFF] ^ TD3[s1 & 0xFF] ^ dk[k];
      const t1 = TD0[s1 >>> 24] ^ TD1[(s0 >>> 16) & 0xFF] ^ TD2[(s3 >>> 8) & 0xFF] ^ TD3[s2 & 0xFF] ^ dk[k + 1];
      const t2 = TD0[s2 >>> 24] ^ TD1[(s1 >>> 16) & 0xFF] ^ TD2[(s0 >>> 8) & 0xFF] ^ TD3[s3 & 0xFF] ^ dk[k + 2];
      const t3 = TD0[s3 >>> 24] ^ TD1[(s2 >>> 16) & 0xFF] ^ TD2[(s1 >>> 8) & 0xFF] ^ TD3[s0 & 0xFF] ^ dk[k + 3];
      s0 = t0 >>> 0; s1 = t1 >>> 0; s2 = t2 >>> 0; s3 = t3 >>> 0; k += 4;
    }
    const o0 = ((INV[s0 >>> 24] << 24) | (INV[(s3 >>> 16) & 0xFF] << 16) | (INV[(s2 >>> 8) & 0xFF] << 8) | INV[s1 & 0xFF]) ^ dk[40];
    const o1 = ((INV[s1 >>> 24] << 24) | (INV[(s0 >>> 16) & 0xFF] << 16) | (INV[(s3 >>> 8) & 0xFF] << 8) | INV[s2 & 0xFF]) ^ dk[41];
    const o2 = ((INV[s2 >>> 24] << 24) | (INV[(s1 >>> 16) & 0xFF] << 16) | (INV[(s0 >>> 8) & 0xFF] << 8) | INV[s3 & 0xFF]) ^ dk[42];
    const o3 = ((INV[s3 >>> 24] << 24) | (INV[(s2 >>> 16) & 0xFF] << 16) | (INV[(s1 >>> 8) & 0xFF] << 8) | INV[s0 & 0xFF]) ^ dk[43];
    const w = [o0 ^ p0, o1 ^ p1, o2 ^ p2, o3 ^ p3];
    for (let i = 0; i < 4; i++) {
      const v = w[i] >>> 0;
      out[o + 4 * i] = v >>> 24; out[o + 4 * i + 1] = (v >>> 16) & 0xFF; out[o + 4 * i + 2] = (v >>> 8) & 0xFF; out[o + 4 * i + 3] = v & 0xFF;
    }
    p0 = c0; p1 = c1; p2 = c2; p3 = c3;
  }
  return out;
}

/** SHA-1 digest (Uint8Array(20)). */
export function sha1(msg) {
  const ml = msg.length;
  const total = ((ml + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[ml] = 0x80;
  const bits = ml * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(total - 4, bits >>> 0);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Int32Array(80);
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20), ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setInt32(i * 4, h));
  return out;
}
