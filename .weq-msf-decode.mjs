/** 临时排查 v3：逐字节看 F1/F2 头部 + F3 的 TEA 输出。用完即删。 */
const D2KEY_HEX = '4971396358745f40726d737d2d457236';
const FRAMES = {
  'F1 心跳发(c2s proto13 et0)':
    '000000990000000d000056d74000000000040000007f000000134865617274626561742e416c697665000000040000006462203931376163663061616533626338306263316637373830393432623765303530820118755f6d47494254425737674634576f6377387a6170633677ba011d0a0f636c69656e745f636f6e6e5f736571120a31373931333734353336d001650000000800000004',
  'F2 心跳收(s2c proto13 et0)':
    '000000500000000d00000000000530000000390056d7400000000000000004000000134865617274626561742e416c69766500000004000000000000000aa80100c801026ac686450000000800000004',
  'F3 加密收包(s2c? proto12 et1)':
    '000000f80000000c01000000000e3137303738383932323522ede2a3ca5d49bdd3b464d56c05f91bb599ce79e5c9cc8aa0fb1881e85f8ef1ca609f1cc65e736236a20a5c1cc77b8cdd2b21223fa9de1732706f74ec3edfc38facb1d899c153642414a64c085cf4b44765f546ef2139c0078bc71d292b85e21451d8ab1714280b9b80f3bf6f378defc01d8d87287ba519cb557555c3a6150ad15dd4ea06e4cab5df4db5fe1aa36720b133046312d6c19a9931841b235d16b3c860df235fcea18cb2ed350a70768bed8318888e22cd1e6611fef29cd8a12acd95a5c91bdd3ab60952b88542b2aca0bacf16970937f8c9464b0a95cf64e7eefa',
};
const hexToBytes = (h) =>
  Uint8Array.from(
    h
      .replace(/[^0-9a-f]/gi, '')
      .match(/../g)
      .map((b) => parseInt(b, 16)),
  );
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ch = (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.');
const DELTA = 0x9e3779b9,
  ROUNDS = 16;
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
  let plainXor = 0n,
    prevXor = 0n;
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
const d2key = hexToBytes(D2KEY_HEX);
for (const [name, hex] of Object.entries(FRAMES)) {
  const b = hexToBytes(hex);
  console.log(
    `\n============ ${name} · ${b.length} B · proto=${be32(b, 4)} · et=${b[8]} ============`,
  );
  dump('原始（头部 + 密文）', b, 0, Math.min(b.length, 64));
  // 找 4B BE 长度前缀 + ASCII 数字（uin）
  for (let o = 9; o <= 20; o++) {
    const l = be32(b, o);
    if (l < 5 || l > 24 || o + l > b.length) continue;
    const s = [...b.subarray(o + 4, o + l)].map(ch).join('');
    if (/^\d{4,12}$/.test(s))
      console.log(
        `  候选 uin 前缀 @${o}: len=${l} uin="${s}" → 密文起 @${o + l}（${b.length - o - l} B, %8=${(b.length - o - l) % 8}）`,
      );
  }
  if (b[8] !== 0) {
    // 按上面最有把握的偏移解一次
    const start = 10 + be32(b, 10);
    const raw = teaDecryptRaw(b.subarray(start), d2key);
    console.log(
      `  TEA(d2key) 输入 ${b.length - start} B → 输出 ${raw.length} B，raw[0]=0x${raw[0].toString(16)} (fill=(x&7)+3=${(raw[0] & 7) + 3})`,
    );
    dump('TEA 原始输出（含填充）', raw, 0, Math.min(raw.length, 96));
    for (let f = 0; f <= 6; f++) {
      const p = raw.subarray(f, raw.length - 7);
      const hl = be32(p, 0);
      const bl = be32(p, hl);
      console.log(
        `   fill=${f}: headlen=${hl} bodylen=${bl} 自洽=${hl >= 8 && hl + bl === p.length} 头前 24 = ${[...p.subarray(0, 24)].map(ch).join('')}`,
      );
    }
  }
}
