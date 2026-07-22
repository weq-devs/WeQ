/**
 * TS 多核爆破测速 —— worker_threads 把 ±14天窗口切成 N 段并行扫，SharedArrayBuffer
 * 标志位早退（对标 Rust rayon find_any）。和 README 的 Rust ~20-25ms 对标。
 *
 * 用法: pnpm --filter @weq/db test:mface-brute-mt [packId] [workers]
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';

const START_TS = 1356998400;
const WORKER = new URL('./lib/brute_worker.ts', import.meta.url).href;

async function getMeta(packId: string): Promise<{ name: string; updateTime?: number; firstHash: string } | null> {
  const url = `https://i.gtimg.cn/club/item/parcel/${Number(packId) % 10}/${packId}_android.json`;
  try {
    const j = (await (await fetch(url)).json()) as { name?: string; updateTime?: number; imgs?: Array<{ id?: string }> };
    const firstHash = j.imgs?.find((e) => e.id)?.id ?? '';
    if (!firstHash) return null;
    return { name: j.name ?? '?', updateTime: j.updateTime, firstHash };
  } catch { return null; }
}

async function fetchSample(hash: string): Promise<Uint8Array | null> {
  for (const res of ['300_300', '200_200']) {
    const url = `https://i.gtimg.cn/club/item/parcel/item/${hash.slice(0, 2)}/${hash}/${res}`;
    try {
      const r = await fetch(url, { headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length >= 16 && b.length % 8 === 0 && b[0] !== 0x3c) return b;
    } catch { /* next */ }
  }
  return null;
}

function scanParallel(
  lo: number, hi: number, c0: number, c1: number, c2: number, c3: number, nWorkers: number,
): Promise<number> {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const span = hi - lo;
  const chunk = Math.ceil(span / nWorkers);
  const workers: Worker[] = [];
  const results: Promise<number>[] = [];

  // tsx 的 loader 不会随 execArgv 传到 worker 入口解析，故用 eval 引导：先注册
  // tsx ESM hook，再动态 import 真正的 .ts worker（workerData 照常可用）。
  const bootstrap = `
    import { register } from 'tsx/esm/api';
    register();
    await import(${JSON.stringify(WORKER)});
  `;

  for (let i = 0; i < nWorkers; i++) {
    const wLo = lo + i * chunk;
    const wHi = Math.min(wLo + chunk, hi);
    if (wLo >= wHi) break;
    const w = new Worker(bootstrap, {
      eval: true,
      workerData: { lo: wLo, hi: wHi, c0, c1, c2, c3, flag },
    });
    workers.push(w);
    results.push(new Promise<number>((resolve, reject) => {
      w.on('message', (ts: number) => resolve(ts));
      w.on('error', reject);
    }));
  }

  return Promise.all(results).then((all) => {
    for (const w of workers) w.terminate();
    return all.find((ts) => ts !== -1) ?? -1;
  });
}

async function brute(packId: string, nWorkers: number): Promise<void> {
  console.log(`\n════════ pack ${packId} (workers=${nWorkers}) ════════`);
  const meta = await getMeta(packId);
  if (!meta) { console.log('  ❌ 拿不到 android.json'); return; }
  const sample = await fetchSample(meta.firstHash);
  if (!sample) { console.log('  ❌ CDN 无有效加密流'); return; }
  const ct = sample;
  const c0 = ((ct[0]! << 24) | (ct[1]! << 16) | (ct[2]! << 8) | ct[3]!) >>> 0;
  const c1 = ((ct[4]! << 24) | (ct[5]! << 16) | (ct[6]! << 8) | ct[7]!) >>> 0;
  const c2 = ((ct[8]! << 24) | (ct[9]! << 16) | (ct[10]! << 8) | ct[11]!) >>> 0;
  const c3 = ((ct[12]! << 24) | (ct[13]! << 16) | (ct[14]! << 8) | ct[15]!) >>> 0;

  const now = Math.floor(Date.now() / 1000);
  const hint = meta.updateTime!;
  const WIN = 14 * 86400;
  const lo = Math.max(hint - WIN, START_TS);
  const hi = Math.min(hint + WIN, now) + 1;
  const span = hi - lo;
  console.log(`  name=${meta.name} ±14天窗口=${span.toLocaleString()} 候选`);

  const t0 = performance.now();
  const found = await scanParallel(lo, hi, c0, c1, c2, c3, nWorkers);
  const ms = performance.now() - t0;
  console.log(found !== -1
    ? `  ✅ 命中 ts=${found} | ${nWorkers}核耗时=${ms.toFixed(1)}ms | ${(span / (ms / 1000) / 1e6).toFixed(1)}M cand/s`
    : `  ⚠️ 窗口未命中（${ms.toFixed(1)}ms）`);
}

async function main(): Promise<void> {
  const packId = process.argv[2] ?? '203473';
  const nWorkers = process.argv[3] ? Number(process.argv[3]) : Math.max(1, os.cpus().length - 2);
  // 两轮：第一轮含 worker 冷启动（tsx 编译+线程创建），第二轮反映稳态并行算力。
  console.log('【第 1 轮：含 worker 冷启动】');
  await brute(packId, nWorkers);
  console.log('\n【第 2 轮：worker 已预热（Node module cache 命中）】');
  await brute(packId, nWorkers);
}

main().catch((e) => { console.error(e); process.exit(1); });
