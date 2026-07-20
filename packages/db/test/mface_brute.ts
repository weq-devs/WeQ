/**
 * TS 版商城表情密钥爆破 —— 测速 & 正确性验证，对标 Rust market_face_decrypt。
 *
 * 热路径（每个候选 ts 一次）：
 *   md5(str(ts))[:16] ASCII → 16B TEA key → fast_test_key 解前 2 块 → 验 GIF89a 头。
 *
 * 单核跑 updateTime ±14 天窗口（~240 万候选），对标 README 的 Rust ~20-25ms。
 *
 * 用法: pnpm --filter @weq/db test:mface-brute <packId>
 *   不传 packId 时用内置的本地包列表逐个探测。
 */

import { md5Hex16 } from './lib/md5_fast';

const DELTA = 0x9e3779b9;
const START_TS = 1356998400; // 2013-01-01

// ── TEA：只解前 2 块的验证器（对标 Rust fast_test_key，零堆分配热路径）──────────
/** 从 16 字节 ASCII key 填 4×u32（大端），复用同一个 out 数组避免分配。 */
function keyWords(keyAscii: Uint8Array, k: Uint32Array): void {
  for (let i = 0; i < 4; i++) {
    const o = i * 4;
    k[i] = ((keyAscii[o]! << 24) | (keyAscii[o + 1]! << 16) | (keyAscii[o + 2]! << 8) | keyAscii[o + 3]!) >>> 0;
  }
}

function teaDec(v0: number, v1: number, k: Uint32Array): [number, number] {
  let s = Math.imul(DELTA, 16) >>> 0;
  for (let i = 0; i < 16; i++) {
    v1 = (v1 - ((((v0 << 4) + k[2]!) ^ (v0 + s) ^ ((v0 >>> 5) + k[3]!)) >>> 0)) >>> 0;
    v0 = (v0 - ((((v1 << 4) + k[0]!) ^ (v1 + s) ^ ((v1 >>> 5) + k[1]!)) >>> 0)) >>> 0;
    s = (s - DELTA) >>> 0;
  }
  return [v0 >>> 0, v1 >>> 0];
}

/** 前 2 块解密 + GIF 头验证。c0..c3 为密文前 16 字节的 4×u32。 */
function fastTestKey(c0: number, c1: number, c2: number, c3: number, keyAscii: Uint8Array, k: Uint32Array): boolean {
  keyWords(keyAscii, k);
  const [d0, d1] = teaDec(c0, c1, k);
  const [d2, d3] = teaDec((c2 ^ d0) >>> 0, (c3 ^ d1) >>> 0, k);
  const out2 = (d2 ^ c0) >>> 0;
  const out3 = (d3 ^ c1) >>> 0;

  const buf = new Uint8Array(16);
  buf[0] = (d0 >>> 24) & 0xff; buf[1] = (d0 >>> 16) & 0xff; buf[2] = (d0 >>> 8) & 0xff; buf[3] = d0 & 0xff;
  buf[4] = (d1 >>> 24) & 0xff; buf[5] = (d1 >>> 16) & 0xff; buf[6] = (d1 >>> 8) & 0xff; buf[7] = d1 & 0xff;
  buf[8] = (out2 >>> 24) & 0xff; buf[9] = (out2 >>> 16) & 0xff; buf[10] = (out2 >>> 8) & 0xff; buf[11] = out2 & 0xff;
  buf[12] = (out3 >>> 24) & 0xff; buf[13] = (out3 >>> 16) & 0xff; buf[14] = (out3 >>> 8) & 0xff; buf[15] = out3 & 0xff;

  const pad = buf[0]! & 7;
  const start = 1 + pad + 2;
  if (start + 6 > 16) return false;
  // GIF89a / GIF87a
  return (
    buf[start] === 0x47 && buf[start + 1] === 0x49 && buf[start + 2] === 0x46 && buf[start + 3] === 0x38 &&
    (buf[start + 4] === 0x39 || buf[start + 4] === 0x37) && buf[start + 5] === 0x61
  );
}

/** 单核扫描 [lo, hi)（倒序，对齐 Rust find_any().rev()）。命中返回 ts，否则 null。 */
function scanRange(lo: number, hi: number, c0: number, c1: number, c2: number, c3: number): number | null {
  const keyAscii = new Uint8Array(16);
  const k = new Uint32Array(4);
  for (let ts = hi - 1; ts >= lo; ts--) {
    md5Hex16(ts, keyAscii); // 写入 16 字节 ASCII hex
    if (fastTestKey(c0, c1, c2, c3, keyAscii, k)) return ts;
  }
  return null;
}

async function fetchSample(hash: string): Promise<{ ct: Uint8Array; res: string } | null> {
  for (const res of ['300_300', '200_200']) {
    const url = `https://i.gtimg.cn/club/item/parcel/item/${hash.slice(0, 2)}/${hash}/${res}`;
    try {
      const r = await fetch(url, { headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length >= 16 && b.length % 8 === 0 && b[0] !== 0x3c) return { ct: b, res };
    } catch { /* next */ }
  }
  return null;
}

async function getMeta(packId: string): Promise<{ name: string; updateTime?: number; firstHash: string } | null> {
  const url = `https://i.gtimg.cn/club/item/parcel/${Number(packId) % 10}/${packId}_android.json`;
  try {
    const j = (await (await fetch(url)).json()) as {
      name?: string; updateTime?: number; imgs?: Array<{ id?: string }>;
    };
    const firstHash = j.imgs?.find((e) => e.id)?.id ?? '';
    if (!firstHash) return null;
    return { name: j.name ?? '?', updateTime: j.updateTime, firstHash };
  } catch {
    return null;
  }
}

async function brute(packId: string): Promise<void> {
  console.log(`\n════════ pack ${packId} ════════`);
  const meta = await getMeta(packId);
  if (!meta) { console.log('  ❌ 拿不到 android.json'); return; }
  console.log(`  name=${meta.name} updateTime=${meta.updateTime} firstHash=${meta.firstHash}`);

  const sample = await fetchSample(meta.firstHash);
  if (!sample) { console.log('  ❌ CDN 无有效加密流'); return; }
  const { ct, res } = sample;
  const c0 = ((ct[0]! << 24) | (ct[1]! << 16) | (ct[2]! << 8) | ct[3]!) >>> 0;
  const c1 = ((ct[4]! << 24) | (ct[5]! << 16) | (ct[6]! << 8) | ct[7]!) >>> 0;
  const c2 = ((ct[8]! << 24) | (ct[9]! << 16) | (ct[10]! << 8) | ct[11]!) >>> 0;
  const c3 = ((ct[12]! << 24) | (ct[13]! << 16) | (ct[14]! << 8) | ct[15]!) >>> 0;
  console.log(`  样本 res=${res} 密文=${ct.length}B`);

  const now = Math.floor(Date.now() / 1000);
  const hint = meta.updateTime;

  // 阶段1：updateTime ±14 天窗口。
  if (hint) {
    const WIN = 14 * 86400;
    const lo = Math.max(hint - WIN, START_TS);
    const hi = Math.min(hint + WIN, now) + 1;
    const span = hi - lo;
    console.log(`  ⚡ ±14天窗口: [${lo}, ${hi}) = ${span.toLocaleString()} 候选`);
    const t0 = performance.now();
    const found = scanRange(lo, hi, c0, c1, c2, c3);
    const ms = performance.now() - t0;
    if (found !== null) {
      console.log(`  ✅ 命中 ts=${found} | 单核耗时=${ms.toFixed(1)}ms | ${(span / (ms / 1000) / 1e6).toFixed(1)}M cand/s`);
      return;
    }
    console.log(`  ⚠️ 窗口未命中（${ms.toFixed(1)}ms），退全量`);
  }

  // 阶段2：全量。
  const span = now + 1 - START_TS;
  console.log(`  🐢 全量: ${span.toLocaleString()} 候选`);
  const t0 = performance.now();
  const found = scanRange(START_TS, now + 1, c0, c1, c2, c3);
  const ms = performance.now() - t0;
  console.log(found !== null
    ? `  ✅ 命中 ts=${found} | 单核耗时=${(ms / 1000).toFixed(2)}s | ${(span / (ms / 1000) / 1e6).toFixed(1)}M cand/s`
    : `  ❌ 全量未命中（${(ms / 1000).toFixed(2)}s）— key 可能服务端下发`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const packs = arg ? [arg] : ['203265', '203473', '203453', '243630'];
  for (const p of packs) await brute(p);
}

main().catch((e) => { console.error(e); process.exit(1); });
