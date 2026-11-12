/**
 * 文档站内工具用的纯前端摘要算法。
 *
 * 这里只放「浏览器里必须自己算」的两个：MD5 与 SHA-1 原文。
 * 不引第三方包 —— 站点只有 vitepress 一个依赖，工具页也不该为一个哈希
 * 多装一个 crypto 库。SHA-256/512 直接走 WebCrypto（`subtle.digest`）。
 */

const encoder = new TextEncoder();

/** UTF-8 编码，和 Node 侧 `createHash(...).update(str)` 的默认行为一致。 */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** 字节转小写 hex。 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** `floor(abs(sin(i + 1)) * 2^32)`，RFC 1321 的常量表。 */
const TABLE = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  return table;
})();

/** MD5，输入字节、输出小写 hex。 */
export function md5(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  // 补 0x80 + 若干 0 + 8 字节长度，凑成 64 字节的整数倍
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const block = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) block[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + TABLE[i]! + block[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << SHIFT[i]!) | (sum >>> (32 - SHIFT[i]!)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return toHex(out);
}

/** 字符串 MD5，等价 Node 的 `createHash('md5').update(s, 'utf8').digest('hex')`。 */
export function md5Hex(text: string): string {
  return md5(utf8(text));
}

/** WebCrypto 摘要，返回原始字节。浏览器与 Node 18+ 都提供。 */
async function webDigest(algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512', bytes: Uint8Array) {
  const buffer = await crypto.subtle.digest(algorithm, bytes as unknown as BufferSource);
  return new Uint8Array(buffer);
}

/** SHA-1 的**原始字节**（不是 hex）—— gpro 派生要用它再 md5 一次。 */
export function sha1Raw(text: string): Promise<Uint8Array> {
  return webDigest('SHA-1', utf8(text));
}

/** SHA-1 hex。 */
export async function sha1Hex(text: string): Promise<string> {
  return toHex(await sha1Raw(text));
}

/** SHA-256 hex。 */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  return toHex(await webDigest('SHA-256', typeof bytes === 'string' ? utf8(bytes) : bytes));
}
