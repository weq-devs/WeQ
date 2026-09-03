/**
 * 装扮资源批量抓取脚本（私有，不入库）。
 *
 * 以「id 范围 × 资源分包」批量换取真实下载地址，去掉 https://<host> 公共前缀后
 * 以二进制 protobuf 追加写入 resources/dress/{type}_resources。
 *
 * 存储格式（每条 = [4 字节大端长度][protobuf]）：
 *   message DressResource {
 *     uint32 item_id = 1;   // 装扮 itemId
 *     string part    = 2;   // 资源名称: config.json / static.zip / other.zip / aio_50.png / xydata.js / main / fzfont
 *     string path    = 3;   // 去掉 https://<host> 前缀后的资源路径（老资源没有 uuid 概念，直接就是完整路径）
 *     uint32 size    = 4;   // 服务端 filesize
 *   }
 *
 * 用法：
 *   pnpm tsx scripts/fetch_dress_resources.ts --font --4000-8000
 *   pnpm tsx scripts/fetch_dress_resources.ts --bubble --2000000-2000100 --concurrency 8
 *   pnpm tsx scripts/fetch_dress_resources.ts --widget --100000-101000 --batch 40 --no-progress
 *
 * 需要目标 QQ（testEnv.uin）在线并已登录。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadNative } from '../packages/native/src';
import { ensureSendable, testEnv } from '../packages/testkit/src';
import {
  getResourceUrls,
  bubbleScid,
  fontScid,
  pendantScid,
  VasBid,
} from '../packages/protocol/src/scupdate';
import type { ResourceUrl, ScidRef } from '../packages/protocol/src/scupdate/get-url';

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const opt = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

type Type = 'bubble' | 'font' | 'widget';

const TYPES: Type[] = (['bubble', 'font', 'widget'] as const).filter((t) => has(`--${t}`));
if (TYPES.length === 0) {
  console.error('请指定类型: --bubble / --font / --widget');
  process.exit(1);
}

let FROM = 0;
let TO = -1;
const rangeTok = argv.find((a) => /^--?\d+-\d+$/.test(a));
if (rangeTok) {
  const m = rangeTok.match(/^--?(\d+)-(\d+)$/)!;
  FROM = Number(m[1]);
  TO = Number(m[2]);
} else if (opt('--from') && opt('--to')) {
  FROM = Number(opt('--from'));
  TO = Number(opt('--to'));
}
if (TO < FROM) {
  console.error('请指定 id 范围，如 --4000-8000');
  process.exit(1);
}

const CONCURRENCY = Number(opt('--concurrency') ?? 5);
const BATCH = Number(opt('--batch') ?? 50); // 服务端单次 GetUrl 最多回 ~50 条
const RETRY = Number(opt('--retry') ?? 3);
const OUT_DIR = path.resolve(opt('--out') ?? path.join('resources', 'dress'));
const NO_PROGRESS = has('--no-progress');

const CLIENT = { from: 'WeQFetchDress' } as const;

// ─────────────────────────── 分包定义 ───────────────────────────

/** 每类的资源分包：bubble/widget 三包，字体两族。 */
const PARTS: Record<Type, string[]> = {
  bubble: ['config.json', 'static.zip', 'other.zip'],
  widget: ['aio_50.png', 'xydata.js', 'other.zip'],
  font: ['main', 'fzfont'],
};

function scidFor(type: Type, id: number, part: string): ScidRef {
  if (type === 'bubble') return { bid: VasBid.Bubble, scid: bubbleScid(id, part as never) };
  if (type === 'widget') return { bid: VasBid.Pendant, scid: pendantScid(id, part as never) };
  return { bid: VasBid.Font, scid: fontScid(id, part as never) };
}

/** 注意：存储只保留去掉 https://<host> 后的 path，重建完整 URL 时需按前缀补域名：
 *   /qqcontent/ → https://showv6.gtimg.cn
 *   /club/      → https://iv6.gtimg.cn
 *   /zip/       → https://gxh.material.qq.com
 * 当初只按 gxh.material.qq.com 一个域名去掉前缀，实际有三个域名，重建时千万别只拼 gxh。 */
function stripHost(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '');
}
// ─────────────────────────── protobuf writer ───────────────────────────

class Pb {
  private b: number[] = [];

  private varint(v: number): void {
    let x = v >>> 0;
    while (x >= 0x80) {
      this.b.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    this.b.push(x);
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  uint32(field: number, v: number): void {
    if (v !== 0) {
      this.tag(field, 0);
      this.varint(v >>> 0);
    }
  }

  str(field: number, s: string): void {
    if (!s) return;
    const u8 = Buffer.from(s, 'utf8');
    this.tag(field, 2);
    this.varint(u8.length);
    for (const c of u8) this.b.push(c);
  }

  done(): Buffer {
    return Buffer.from(this.b);
  }
}

function encodeRecord(itemId: number, part: string, p: string, size: number): Buffer {
  const pb = new Pb();
  pb.uint32(1, itemId);
  pb.str(2, part);
  pb.str(3, p);
  pb.uint32(4, size);
  const body = pb.done();
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

/** 解析已有文件里的 (item_id, part) 键，用于追加去重。 */
function readExistingKeys(file: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(file)) return keys;
  const buf = readFileSync(file);
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    if (off + len > buf.length) break;
    const msg = buf.subarray(off, off + len);
    off += len;
    let p = 0;
    let itemId = 0;
    let part = '';
    while (p < msg.length) {
      let tag = 0;
      let shift = 0;
      for (;;) {
        const c = msg[p++];
        tag |= (c & 0x7f) << shift;
        if (!(c & 0x80)) break;
        shift += 7;
      }
      const field = tag >>> 3;
      const wire = tag & 7;
      if (wire === 0) {
        let v = 0;
        let s = 0;
        for (;;) {
          const c = msg[p++];
          v |= (c & 0x7f) << s;
          if (!(c & 0x80)) break;
          s += 7;
        }
        if (field === 1) itemId = v >>> 0;
      } else if (wire === 2) {
        let ln = 0;
        let s = 0;
        for (;;) {
          const c = msg[p++];
          ln |= (c & 0x7f) << s;
          if (!(c & 0x80)) break;
          s += 7;
        }
        if (p + ln > msg.length) break;
        const raw = msg.subarray(p, p + ln);
        p += ln;
        if (field === 2) part = Buffer.from(raw).toString('utf8');
      } else if (wire === 1) {
        p += 8;
      } else if (wire === 5) {
        p += 4;
      } else {
        break;
      }
    }
    if (itemId > 0 && part) keys.add(`${itemId}:${part}`);
  }
  return keys;
}

// ─────────────────────────── 并发池 ───────────────────────────

async function poolMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─────────────────────────── 进度条 ───────────────────────────

class Progress {
  private readonly start = Date.now();
  private last = 0;
  retries = 0;

  tick(done: number, total: number, hit: number, written: number, bytes: number): void {
    if (NO_PROGRESS || !process.stdout.isTTY) return;
    const now = Date.now();
    if (now - this.last < 100 && done < total) return;
    this.last = now;
    const pct = total ? done / total : 1;
    const w = 22;
    const filled = Math.round(pct * w);
    const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
    const secs = ((now - this.start) / 1000).toFixed(1);
    const kb = (bytes / 1024).toFixed(1);
    const line = `\r[${bar}] ${(pct * 100).toFixed(1).padStart(5)}%  ${String(done).padStart(6)}/${total}  hit ${String(hit).padStart(6)}  new ${String(written).padStart(6)}  ${String(kb).padStart(8)}K  ${secs}s  retry ${this.retries}`;
    process.stdout.write(line);
  }

  done(): void {
    if (!NO_PROGRESS && process.stdout.isTTY) process.stdout.write('\n');
  }
}
// ─────────────────────────── 目标进程 ───────────────────────────

async function resolveTarget(nt: ReturnType<typeof loadNative>['ntHelper']): Promise<number> {
  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe，请先打开并登录目标账号');
  const hit = pids.find((p) => {
    try {
      const info = nt.probeQqLoginInfo(p);
      return info?.uin === testEnv.uin && info.loggedIn;
    } catch {
      return false;
    }
  });
  const pid = hit ?? pids[0]!;
  const status = await ensureSendable(nt, pid, testEnv.uin, { label: 'fetch-dress' });
  console.log(`[fetch-dress] pid=${pid} uin=${status.uin} loggedIn=${status.loggedIn}\n`);
  return pid;
}

// ─────────────────────────── 单类型抓取 ───────────────────────────

async function fetchType(
  nt: ReturnType<typeof loadNative>['ntHelper'],
  pid: number,
  type: Type,
): Promise<void> {
  const parts = PARTS[type];
  const file = path.join(OUT_DIR, `${type}_resources`);
  mkdirSync(OUT_DIR, { recursive: true });

  const existing = readExistingKeys(file);
  const tasks: { id: number; part: string }[] = [];
  let skipped = 0;
  for (let id = FROM; id <= TO; id++) {
    for (const part of parts) {
      if (existing.has(`${id}:${part}`)) {
        skipped++;
        continue;
      }
      tasks.push({ id, part });
    }
  }

  const total = tasks.length;
  const idCount = TO - FROM + 1;
  console.log(
    `══ ${type}  ${FROM}-${TO}（${idCount} 个 id × ${parts.length} 分包 = ${idCount * parts.length} 任务）══`,
  );
  if (total === 0) {
    console.log(`  全部已在 ${file} 中，无需抓取\n`);
    return;
  }
  console.log(
    `  需抓取 ${total} 个（已有 ${skipped} 个跳过）  batch=${BATCH} 并发=${CONCURRENCY} 重试=${RETRY}\n`,
  );

  const batches = chunk(tasks, BATCH);
  const progress = new Progress();
  let doneCount = 0;
  let hitCount = 0;
  let writtenCount = 0;
  let writtenBytes = 0;
  let reqCount = 0;

  await poolMap(batches, CONCURRENCY, async (batch) => {
    const refs = batch.map((t) => scidFor(type, t.id, t.part));
    const byScid = new Map<string, { id: number; part: string }>();
    for (let i = 0; i < batch.length; i++) byScid.set(refs[i].scid, batch[i]);

    let results: ResourceUrl[] | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= RETRY && results === null; attempt++) {
      try {
        results = await getResourceUrls(nt, pid, refs, CLIENT);
      } catch (err) {
        lastErr = err;
        progress.retries++;
        if (attempt < RETRY) await sleep(250 * attempt);
      }
    }
    reqCount++;
    if (results === null) {
      console.error(
        `\n  ⚠ 批次失败（重试 ${RETRY} 次后放弃）: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
      );
      doneCount += batch.length;
      progress.tick(doneCount, total, hitCount, writtenCount, writtenBytes);
      return;
    }

    const records: Buffer[] = [];
    for (const r of results) {
      const t = byScid.get(r.scid);
      if (!t || !r.ok) continue;
      hitCount++;
      records.push(encodeRecord(t.id, t.part, stripHost(r.url), r.size));
    }
    if (records.length > 0) {
      appendFileSync(file, Buffer.concat(records));
      writtenCount += records.length;
      writtenBytes += records.reduce((a, b) => a + b.length, 0);
    }
    doneCount += batch.length;
    progress.tick(doneCount, total, hitCount, writtenCount, writtenBytes);
  });
  progress.done();

  const fileSize = existsSync(file) ? readFileSync(file).length : 0;
  console.log(
    `  完成: 请求 ${reqCount} 次  命中 ${hitCount}/${total}  新写入 ${writtenCount} 条  ` +
      `文件 ${file}（${(fileSize / 1024).toFixed(1)} KB，含历史）  重试 ${progress.retries} 次\n`,
  );
}

// ─────────────────────────── main ───────────────────────────

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const pid = await resolveTarget(nt);
  for (const type of TYPES) {
    await fetchType(nt, pid, type);
  }
  console.log('全部完成 ✔');
}

main().catch((e) => {
  console.error('\n[fetch-dress] 失败:', e);
  process.exit(1);
});

/*
 * 2026/09/04  font 1-60000-61000  bubble 1-60000 // 2000000-2175000  widget 100000-200000
 * */
