/**
 * Synchronous crypto for SNMPv3 USM (the simulation runs synchronously, so Web
 * Crypto's async API cannot be used): MD5 (RFC 1321), SHA-1 (FIPS 180-4), HMAC
 * (RFC 2104), AES-128 block encryption (FIPS 197) and CFB-128 (RFC 3826 §3.1.3).
 * Inputs/outputs are byte arrays.
 */

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

/** Merkle–Damgård padding: 0x80, zeros, 64-bit length (little or big endian). */
function pad(msg: number[], littleEndian: boolean): number[] {
  const bits = msg.length * 8;
  const out = [...msg, 0x80];
  while (out.length % 64 !== 56) out.push(0);
  const lenBytes: number[] = [];
  for (let i = 0; i < 8; i++) lenBytes.push(Math.floor(bits / 2 ** (8 * i)) & 0xff);
  out.push(...(littleEndian ? lenBytes : lenBytes.reverse()));
  return out;
}

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: number[]): number[] {
  const m = pad(data, true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const w = new Array<number>(16);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = m[off + 4 * i] | (m[off + 4 * i + 1] << 8) | (m[off + 4 * i + 2] << 16) | (m[off + 4 * i + 3] << 24);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const t = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + w[g]) | 0, MD5_S[i])) | 0;
      a = t;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  return [a0, b0, c0, d0].flatMap((x) => [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff]);
}

export function sha1(data: number[]): number[] {
  const m = pad(data, false);
  let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Array<number>(80);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0, (h[4] + e) | 0];
  }
  return h.flatMap((x) => [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff]);
}

export type HashFn = (d: number[]) => number[];

export function hmac(hash: HashFn, key: number[], data: number[]): number[] {
  let k = key.length > 64 ? hash(key) : [...key];
  k = [...k, ...new Array(64 - k.length).fill(0)];
  const inner = hash([...k.map((b) => b ^ 0x36), ...data]);
  return hash([...k.map((b) => b ^ 0x5c), ...inner]);
}

// ---------------------------------------------------------------- AES-128

const SBOX: number[] = (() => {
  const s = new Array<number>(256);
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();

const xtime = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

function expandKey(key: number[]): number[][] {
  const w: number[][] = [];
  for (let i = 0; i < 4; i++) w.push(key.slice(4 * i, 4 * i + 4));
  let rcon = 1;
  for (let i = 4; i < 44; i++) {
    let t = [...w[i - 1]];
    if (i % 4 === 0) {
      t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
      rcon = xtime(rcon);
    }
    w.push(w[i - 4].map((b, j) => b ^ t[j]));
  }
  return w;
}

/** Encrypt one 16-byte block with a 16-byte key. */
export function aes128EncryptBlock(key: number[], block: number[]): number[] {
  const w = expandKey(key);
  let s = block.map((b, i) => b ^ w[Math.floor(i / 4)][i % 4]);
  for (let round = 1; round <= 10; round++) {
    s = s.map((b) => SBOX[b]);
    // ShiftRows (state is column-major: index = 4*col + row).
    const t = new Array<number>(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[4 * c + r] = s[4 * ((c + r) % 4) + r];
    s = t;
    if (round !== 10) {
      for (let c = 0; c < 4; c++) {
        const [a0, a1, a2, a3] = s.slice(4 * c, 4 * c + 4);
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[4 * c] = a0 ^ all ^ xtime(a0 ^ a1);
        s[4 * c + 1] = a1 ^ all ^ xtime(a1 ^ a2);
        s[4 * c + 2] = a2 ^ all ^ xtime(a2 ^ a3);
        s[4 * c + 3] = a3 ^ all ^ xtime(a3 ^ a0);
      }
    }
    s = s.map((b, i) => b ^ w[4 * round + Math.floor(i / 4)][i % 4]);
  }
  return s;
}

/** AES-128 CFB-128 (RFC 3826 §3.1.3/3.1.4): `encrypt` false decrypts. No padding. */
export function aes128Cfb(key: number[], iv: number[], data: number[], encrypt: boolean): number[] {
  const out: number[] = [];
  let feedback = iv;
  for (let off = 0; off < data.length; off += 16) {
    const ks = aes128EncryptBlock(key, feedback);
    const chunk = data.slice(off, off + 16);
    const res = chunk.map((b, i) => b ^ ks[i]);
    out.push(...res);
    feedback = encrypt ? res : chunk;
    if (feedback.length < 16) break;
  }
  return out;
}
