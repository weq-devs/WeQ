/** 临时排查：用本地账号配置里的真实 d2key，手工 TEA 解一条抓到的帧。用完即删。 */
import { readFileSync } from 'node:fs';

const home = process.env.HOME ?? '';
const cfgPath = `${home}/.config/weq/config/accounts/1707889225_03ed321f.json`;
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const D2KEY_HEX = cfg.session?.d2Key;
if (!D2KEY_HEX) {
  console.error('config 里没有 d2Key');
  process.exit(1);
}

const RAW = process.argv[2] ?? '';
const hexToBytes = (h) =>
  Uint8Array.from(
    h
      .replace(/[^0-9a-f]/gi, '')
      .match(/../g)
      .map((b) => parseInt(b, 16)),
  );
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ch = (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.');
const DELTA = 0x9e3779b9;
const ROUNDS = 16;
const keyWords = (k) => [0, 1, 2, 3].map((i) => be32(k, i * 4));
function decryptBlock(x, y, k) {
  let sum = (DELTA * ROUNDS) >>> 0;
  for (let i = 0; i < ROUNDS; i++) {
    y = (y - (((x + sum) ^ ((x << 4) + k[2]) ^ ((x >>> 5) + k[3])) >>> 0)) >>> 0;
    x = (x - (((y + sum) ^ ((y << 4) + k[0]) ^ ((y >>> 5) + k[1])) >>> 0)) >>> 0;
    sum = (sum - DELTA) >>> 0;
  }
  return [x, y];
}
function teaDecryptRaw(data, key) {
  const k = keyWords(key);
  const out = new Uint8Array(data.length);
  let plainXor = 0n;
  let prevXor = 0n;
  const rd = (o) => (BigInt(be32(data, o)) << 32n) | BigInt(be32(data, o + 4));
  const wr = (o, v) => {
    for (let i = 0; i < 8; i++) out[o + i] = Number((v >> BigInt(56 - i * 8)) & 0xffn);
  };
  for (let i = 0; i < data.length; i += 8) {
    const block = rd(i);
    plainXor ^= block;
    const [x, y] = decryptBlock(
      Number(plainXor >> 32n) >>> 0,
      Number(plainXor & 0xffffffffn) >>> 0,
      k,
    );
    plainXor = (BigInt(x) << 32n) | BigInt(y);
    wr(i, plainXor ^ prevXor);
    prevXor = block;
  }
  return out;
}
function dump(label, buf, from, to) {
  console.log(`--- ${label} ---`);
  for (let o = from; o < to; o += 16) {
    const row = buf.subarray(o, Math.min(o + 16, to));
    console.log(
      `${o.toString(16).padStart(4, '0')}  ${[...row]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47)}  ${[...row].map(ch).join('')}`,
    );
  }
}

const b = hexToBytes(RAW);
console.log(`帧长 ${b.length} B`);
console.log(`  be32@0 (总长前缀) = ${be32(b, 0)}`);
console.log(`  be32@4 (proto?)   = ${be32(b, 4)}`);
console.log(`  b[8] (encryptType)= ${b[8]}`);
console.log(`  b[9]              = ${b[9]}`);
dump('原始头部', b, 0, Math.min(b.length, 64));

// 找 ASCII uin "1707889225"
const needle = [...'1707889225'].map((c) => c.charCodeAt(0));
for (let o = 0; o + needle.length <= b.length; o++) {
  let ok = true;
  for (let i = 0; i < needle.length; i++) if (b[o + i] !== needle[i]) ok = false;
  if (ok) console.log(`  找到 uin "1707889225" @ offset ${o}`);
}

dump('uin 附近（90..130）', b, 90, 130);

const key = hexToBytes(D2KEY_HEX);
console.log('\n=== 扫描密文起点：找 TEA 解出后自洽的布局 ===');
const results = [];
for (let s = 0; s < b.length; s++) {
  const rest = b.length - s;
  if (rest % 8 !== 0 || rest < 8) continue;
  const raw = teaDecryptRaw(b.subarray(s), key);
  for (let f = 0; f <= 6; f++) {
    const p = raw.subarray(f, raw.length - 7);
    if (p.length < 16) continue;
    const hl = be32(p, 0);
    const bl = be32(p, hl);
    // 头部长度合理 + 头部+正文正好铺满 → 强信号
    if (hl >= 8 && hl <= p.length && hl + bl === p.length) {
      results.push({ s, f, hl, bl, head: [...p.subarray(0, 24)].map(ch).join('') });
    }
  }
}
if (results.length === 0) {
  console.log('  没有任何起点能解出「头长+正文长=总长」的自洽布局。');
  // 退一步：只按 fill 剪裁，看看第一个片段
  for (const s of [4, 12, 20, 28, 105, 116, 117, 124]) {
    const rest = b.length - s;
    if (rest % 8) continue;
    const raw = teaDecryptRaw(b.subarray(s), key);
    const f = (raw[0] & 7) + 3;
    console.log(
      `  start=${s} fill=${f} 前16字节(去填充): ${[...raw.subarray(f, f + 16)].map(ch).join('')}`,
    );
  }
} else {
  for (const r of results.slice(0, 12)) {
    console.log(`  start=${r.s} fill=${r.f} headlen=${r.hl} bodylen=${r.bl}  头前24="${r.head}"`);
    const raw = teaDecryptRaw(b.subarray(r.s), key);
    const p = raw.subarray(r.f, raw.length - 7);
    const head = p.subarray(0, r.hl);
    const body = p.subarray(r.hl + 4, r.hl + 4 + r.bl);
    const strs = (buf) => {
      const out = [];
      let cur = '';
      for (const byte of buf) {
        if (byte >= 0x20 && byte <= 0x7e) cur += String.fromCharCode(byte);
        else {
          if (cur.length >= 4) out.push(cur);
          cur = '';
        }
      }
      if (cur.length >= 4) out.push(cur);
      return out;
    };
    console.log(`     head 内可读串: ${JSON.stringify(strs(head))}`);
    console.log(`     body 内可读串: ${JSON.stringify(strs(body))}`);
  }
}
