/**
 * 端到端验证：mface element 自带的 encryptKey 能否直接解出 CDN 加密动图流。
 *
 * 证明「聊天渲染无需爆破」——element 里的 encryptKey 就是 QQTEA 的 16 字节 key
 * （md5(时间戳)[:16] 的 ASCII 形式）。用纯 TS 版 qqtea_decrypt 解密真实 CDN 样本，
 * 检查是否得到 GIF89a 头。同时测单张耗时。
 *
 * 用法: pnpm --filter @weq/db test:mface-tea-decrypt
 */

import { writeFileSync } from 'node:fs';

// ── 真实样本（来自 dump_mface_elements 的输出）──────────────────────────────────
// pack / hash(marketEmoticonId) / encryptKey，三者都取自消息 element。
const SAMPLES = [
  { pack: '209590', hash: 'fbf5a88c0bfd089e67a8bac58b955a4d', key: '304d5508c9b0e62f', desc: '[生气]' },
  { pack: '237493', hash: '590da2260d24269af54f33870137c02a', key: '5cfda6afe0c5784f', desc: '[心心]' },
  { pack: '242229', hash: '41af35c78ea3125b8575da86abc9009e', key: 'b10a6abd3ec7f30e', desc: '[emo]' },
];

const DELTA = 0x9e3779b9;

/** QQTEA 16 轮单块解密（大端序）。对齐 Rust 的 tea_dec。 */
function teaDec(v0: number, v1: number, k: Uint32Array, r: number): [number, number] {
  let s = Math.imul(DELTA, r) >>> 0;
  for (let i = 0; i < r; i++) {
    v1 = (v1 - ((((v0 << 4) + k[2]!) ^ (v0 + s) ^ ((v0 >>> 5) + k[3]!)) >>> 0)) >>> 0;
    v0 = (v0 - ((((v1 << 4) + k[0]!) ^ (v1 + s) ^ ((v1 >>> 5) + k[1]!)) >>> 0)) >>> 0;
    s = (s - DELTA) >>> 0;
  }
  return [v0 >>> 0, v1 >>> 0];
}

function beU32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function putBeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/** 全量 QQTEA 解密（交织链式 CBC + 头尾处理）。对齐 Rust 的 qqtea_decrypt。 */
function qqteaDecrypt(ct: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (ct.length === 0 || ct.length % 8 !== 0) return null;

  const k = new Uint32Array(4);
  for (let i = 0; i < 4; i++) k[i] = beU32(key, i * 4);

  const out = new Uint8Array(ct.length);
  let pm0 = 0, pm1 = 0;
  let pc0 = 0, pc1 = 0;

  for (let off = 0; off < ct.length; off += 8) {
    const c0 = beU32(ct, off);
    const c1 = beU32(ct, off + 4);
    const [d0, d1] = teaDec((c0 ^ pm0) >>> 0, (c1 ^ pm1) >>> 0, k, 16);
    putBeU32(out, off, (d0 ^ pc0) >>> 0);
    putBeU32(out, off + 4, (d1 ^ pc1) >>> 0);
    pm0 = d0; pm1 = d1;
    pc0 = c0; pc1 = c1;
  }

  // 头部：1 控制位 + (控制位&7) 填充 + 2 salt。
  const pad = out[0]! & 7;
  const start = 1 + pad + 2;
  if (start > out.length) return null;
  const body = out.subarray(start);

  // 尾部：截到最后一个 GIF trailer 0x3b。
  let pos = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i] === 0x3b) { pos = i; break; }
  }
  return pos >= 0 ? body.subarray(0, pos + 1) : body;
}

async function main(): Promise<void> {
  for (const s of SAMPLES) {
    const keyBytes = new TextEncoder().encode(s.key); // 16 ASCII 字节 = TEA key
    console.log(`\n=== ${s.desc} pack=${s.pack} key=${s.key} (${keyBytes.length}B) ===`);

    let ct: Uint8Array | null = null;
    let usedRes = '';
    for (const res of ['300_300', '200_200']) {
      const url = `https://i.gtimg.cn/club/item/parcel/item/${s.hash.slice(0, 2)}/${s.hash}/${res}`;
      try {
        const r = await fetch(url, { headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) continue;
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length >= 16 && b.length % 8 === 0 && b[0] !== 0x3c) {
          ct = b; usedRes = res; break;
        }
      } catch { /* try next */ }
    }
    if (!ct) { console.log('   ❌ CDN 无有效加密流（300/200 都不行）'); continue; }

    const t0 = performance.now();
    const dec = qqteaDecrypt(ct, keyBytes);
    const ms = performance.now() - t0;

    if (!dec) { console.log(`   ❌ 解密失败（res=${usedRes}, ${ct.length}B）`); continue; }
    const magic = Buffer.from(dec.subarray(0, 6)).toString('latin1');
    const ok = magic === 'GIF89a' || magic === 'GIF87a';
    console.log(`   res=${usedRes} 密文=${ct.length}B → 明文=${dec.length}B  magic=${JSON.stringify(magic)}  ${ok ? '✅' : '❌'}  解密耗时=${ms.toFixed(3)}ms`);
    if (ok) {
      const p = `mface_${s.pack}_${s.desc.replace(/[\[\]]/g, '')}.gif`;
      writeFileSync(p, dec);
      console.log(`   → 已保存 ${p}`);
    }
  }
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
