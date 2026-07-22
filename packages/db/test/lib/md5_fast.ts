/**
 * 极简 MD5，专为爆破热路径：输入是 str(ts)（≤10 ASCII 数字，单块），输出前 8
 * 字节的 hex（16 个 ASCII 字符）写进调用方给的 out 数组。零堆分配、无 Buffer。
 *
 * 只处理「消息长度 < 56 字节」的单块情形——时间戳字符串最多 10 位，恒成立。
 */

const HEX = new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102]); // "0123..9a..f"

// 复用的单块缓冲（64 字节 = 16×u32）。
const M = new Int32Array(16);

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/**
 * 计算 md5(str(ts))，把摘要前 8 字节的十六进制（16 ASCII 字符）写入 out[0..16]。
 * out 必须至少 16 字节，由调用方复用。
 */
export function md5Hex16(ts: number, out: Uint8Array): void {
  // 1) 十进制 ASCII 编码 ts 到单块 M（小端 u32），并加 MD5 padding。
  M.fill(0);
  // itoa：把 ts 转十进制字节，先反向写再定位。ts 是 u32 正整数。
  let n = ts >>> 0;
  const digits = new Uint8Array(10);
  let len = 0;
  if (n === 0) { digits[len++] = 48; }
  else { while (n > 0) { digits[len++] = 48 + (n % 10); n = Math.floor(n / 10); } }
  // digits 目前是低位在前，反转写入消息字节。
  const bytes = new Uint8Array(64);
  for (let i = 0; i < len; i++) bytes[i] = digits[len - 1 - i]!;
  bytes[len] = 0x80; // padding 起始位
  // 位长度（len*8）写到最后 8 字节（小端），len<56 恒成立。
  const bitLen = len * 8;
  bytes[56] = bitLen & 0xff;
  bytes[57] = (bitLen >>> 8) & 0xff;
  // 高位恒 0。
  for (let i = 0; i < 16; i++) {
    M[i] = (bytes[i * 4]!) | (bytes[i * 4 + 1]! << 8) | (bytes[i * 4 + 2]! << 16) | (bytes[i * 4 + 3]! << 24);
  }

  // 2) MD5 单块压缩。
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const a0 = a, b0 = b, c0 = c, d0 = d;

  // Round 1
  a = b + rotl((a + ((b & c) | (~b & d)) + M[0]! + 0xd76aa478) | 0, 7); a |= 0;
  d = a + rotl((d + ((a & b) | (~a & c)) + M[1]! + 0xe8c7b756) | 0, 12); d |= 0;
  c = d + rotl((c + ((d & a) | (~d & b)) + M[2]! + 0x242070db) | 0, 17); c |= 0;
  b = c + rotl((b + ((c & d) | (~c & a)) + M[3]! + 0xc1bdceee) | 0, 22); b |= 0;
  a = b + rotl((a + ((b & c) | (~b & d)) + M[4]! + 0xf57c0faf) | 0, 7); a |= 0;
  d = a + rotl((d + ((a & b) | (~a & c)) + M[5]! + 0x4787c62a) | 0, 12); d |= 0;
  c = d + rotl((c + ((d & a) | (~d & b)) + M[6]! + 0xa8304613) | 0, 17); c |= 0;
  b = c + rotl((b + ((c & d) | (~c & a)) + M[7]! + 0xfd469501) | 0, 22); b |= 0;
  a = b + rotl((a + ((b & c) | (~b & d)) + M[8]! + 0x698098d8) | 0, 7); a |= 0;
  d = a + rotl((d + ((a & b) | (~a & c)) + M[9]! + 0x8b44f7af) | 0, 12); d |= 0;
  c = d + rotl((c + ((d & a) | (~d & b)) + M[10]! + 0xffff5bb1) | 0, 17); c |= 0;
  b = c + rotl((b + ((c & d) | (~c & a)) + M[11]! + 0x895cd7be) | 0, 22); b |= 0;
  a = b + rotl((a + ((b & c) | (~b & d)) + M[12]! + 0x6b901122) | 0, 7); a |= 0;
  d = a + rotl((d + ((a & b) | (~a & c)) + M[13]! + 0xfd987193) | 0, 12); d |= 0;
  c = d + rotl((c + ((d & a) | (~d & b)) + M[14]! + 0xa679438e) | 0, 17); c |= 0;
  b = c + rotl((b + ((c & d) | (~c & a)) + M[15]! + 0x49b40821) | 0, 22); b |= 0;

  // Round 2
  a = b + rotl((a + ((b & d) | (c & ~d)) + M[1]! + 0xf61e2562) | 0, 5); a |= 0;
  d = a + rotl((d + ((a & c) | (b & ~c)) + M[6]! + 0xc040b340) | 0, 9); d |= 0;
  c = d + rotl((c + ((d & b) | (a & ~b)) + M[11]! + 0x265e5a51) | 0, 14); c |= 0;
  b = c + rotl((b + ((c & a) | (d & ~a)) + M[0]! + 0xe9b6c7aa) | 0, 20); b |= 0;
  a = b + rotl((a + ((b & d) | (c & ~d)) + M[5]! + 0xd62f105d) | 0, 5); a |= 0;
  d = a + rotl((d + ((a & c) | (b & ~c)) + M[10]! + 0x02441453) | 0, 9); d |= 0;
  c = d + rotl((c + ((d & b) | (a & ~b)) + M[15]! + 0xd8a1e681) | 0, 14); c |= 0;
  b = c + rotl((b + ((c & a) | (d & ~a)) + M[4]! + 0xe7d3fbc8) | 0, 20); b |= 0;
  a = b + rotl((a + ((b & d) | (c & ~d)) + M[9]! + 0x21e1cde6) | 0, 5); a |= 0;
  d = a + rotl((d + ((a & c) | (b & ~c)) + M[14]! + 0xc33707d6) | 0, 9); d |= 0;
  c = d + rotl((c + ((d & b) | (a & ~b)) + M[3]! + 0xf4d50d87) | 0, 14); c |= 0;
  b = c + rotl((b + ((c & a) | (d & ~a)) + M[8]! + 0x455a14ed) | 0, 20); b |= 0;
  a = b + rotl((a + ((b & d) | (c & ~d)) + M[13]! + 0xa9e3e905) | 0, 5); a |= 0;
  d = a + rotl((d + ((a & c) | (b & ~c)) + M[2]! + 0xfcefa3f8) | 0, 9); d |= 0;
  c = d + rotl((c + ((d & b) | (a & ~b)) + M[7]! + 0x676f02d9) | 0, 14); c |= 0;
  b = c + rotl((b + ((c & a) | (d & ~a)) + M[12]! + 0x8d2a4c8a) | 0, 20); b |= 0;

  // Round 3
  a = b + rotl((a + (b ^ c ^ d) + M[5]! + 0xfffa3942) | 0, 4); a |= 0;
  d = a + rotl((d + (a ^ b ^ c) + M[8]! + 0x8771f681) | 0, 11); d |= 0;
  c = d + rotl((c + (d ^ a ^ b) + M[11]! + 0x6d9d6122) | 0, 16); c |= 0;
  b = c + rotl((b + (c ^ d ^ a) + M[14]! + 0xfde5380c) | 0, 23); b |= 0;
  a = b + rotl((a + (b ^ c ^ d) + M[1]! + 0xa4beea44) | 0, 4); a |= 0;
  d = a + rotl((d + (a ^ b ^ c) + M[4]! + 0x4bdecfa9) | 0, 11); d |= 0;
  c = d + rotl((c + (d ^ a ^ b) + M[7]! + 0xf6bb4b60) | 0, 16); c |= 0;
  b = c + rotl((b + (c ^ d ^ a) + M[10]! + 0xbebfbc70) | 0, 23); b |= 0;
  a = b + rotl((a + (b ^ c ^ d) + M[13]! + 0x289b7ec6) | 0, 4); a |= 0;
  d = a + rotl((d + (a ^ b ^ c) + M[0]! + 0xeaa127fa) | 0, 11); d |= 0;
  c = d + rotl((c + (d ^ a ^ b) + M[3]! + 0xd4ef3085) | 0, 16); c |= 0;
  b = c + rotl((b + (c ^ d ^ a) + M[6]! + 0x04881d05) | 0, 23); b |= 0;
  a = b + rotl((a + (b ^ c ^ d) + M[9]! + 0xd9d4d039) | 0, 4); a |= 0;
  d = a + rotl((d + (a ^ b ^ c) + M[12]! + 0xe6db99e5) | 0, 11); d |= 0;
  c = d + rotl((c + (d ^ a ^ b) + M[15]! + 0x1fa27cf8) | 0, 16); c |= 0;
  b = c + rotl((b + (c ^ d ^ a) + M[2]! + 0xc4ac5665) | 0, 23); b |= 0;

  // Round 4
  a = b + rotl((a + (c ^ (b | ~d)) + M[0]! + 0xf4292244) | 0, 6); a |= 0;
  d = a + rotl((d + (b ^ (a | ~c)) + M[7]! + 0x432aff97) | 0, 10); d |= 0;
  c = d + rotl((c + (a ^ (d | ~b)) + M[14]! + 0xab9423a7) | 0, 15); c |= 0;
  b = c + rotl((b + (d ^ (c | ~a)) + M[5]! + 0xfc93a039) | 0, 21); b |= 0;
  a = b + rotl((a + (c ^ (b | ~d)) + M[12]! + 0x655b59c3) | 0, 6); a |= 0;
  d = a + rotl((d + (b ^ (a | ~c)) + M[3]! + 0x8f0ccc92) | 0, 10); d |= 0;
  c = d + rotl((c + (a ^ (d | ~b)) + M[10]! + 0xffeff47d) | 0, 15); c |= 0;
  b = c + rotl((b + (d ^ (c | ~a)) + M[1]! + 0x85845dd1) | 0, 21); b |= 0;
  a = b + rotl((a + (c ^ (b | ~d)) + M[8]! + 0x6fa87e4f) | 0, 6); a |= 0;
  d = a + rotl((d + (b ^ (a | ~c)) + M[15]! + 0xfe2ce6e0) | 0, 10); d |= 0;
  c = d + rotl((c + (a ^ (d | ~b)) + M[6]! + 0xa3014314) | 0, 15); c |= 0;
  b = c + rotl((b + (d ^ (c | ~a)) + M[13]! + 0x4e0811a1) | 0, 21); b |= 0;
  a = b + rotl((a + (c ^ (b | ~d)) + M[4]! + 0xf7537e82) | 0, 6); a |= 0;
  d = a + rotl((d + (b ^ (a | ~c)) + M[11]! + 0xbd3af235) | 0, 10); d |= 0;
  c = d + rotl((c + (a ^ (d | ~b)) + M[2]! + 0x2ad7d2bb) | 0, 15); c |= 0;
  b = c + rotl((b + (d ^ (c | ~a)) + M[9]! + 0xeb86d391) | 0, 21); b |= 0;

  a = (a + a0) | 0;
  b = (b + b0) | 0;
  // 只需前 8 字节 = a, b（小端）。转 16 个 hex ASCII 写入 out。
  writeHexLE(a >>> 0, out, 0);
  writeHexLE(b >>> 0, out, 8);
}

/** 把一个 u32 按小端 4 字节的 hex（8 ASCII）写进 out[off..off+8]。 */
function writeHexLE(v: number, out: Uint8Array, off: number): void {
  for (let byte = 0; byte < 4; byte++) {
    const b = (v >>> (byte * 8)) & 0xff;
    out[off + byte * 2] = HEX[(b >>> 4) & 0xf]!;
    out[off + byte * 2 + 1] = HEX[b & 0xf]!;
  }
}
