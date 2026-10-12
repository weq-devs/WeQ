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
import { ensureAttached, testEnv } from '../packages/testkit/src';
import {
  createDarwinPlatform,
  createLinuxPlatform,
  createWin32Platform,
  type Platform,
} from '../packages/platform/src';
import { registerSsoSession, resolveDeviceGuid } from '../packages/service/src/account/sso_session';
import {
  ANDROID_QQ_CLIENT,
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
// 服务端单次 GetUrl 有条数上限：实测一次带 18 个 scid 就会被**静默丢弃**
// （服务端不回包，本地 30s 超时；17 个稳定成功）。而且个别区间即使 ≤17 个也会
// 丢，所以这里默认 16，并在整批失败时自动二分拆小重试（见 sendBatch）。
const BATCH = Number(opt('--batch') ?? 16);
const RETRY = Number(opt('--retry') ?? 3);
/** 每发一个请求后停 `THROTTLE` 毫秒（默认 0）—— 服务端有风控，慢跑时调大。 */
const THROTTLE = Number(opt('--throttle') ?? 0);
const OUT_DIR = path.resolve(opt('--out') ?? path.join('resources', 'dress'));
const NO_PROGRESS = has('--no-progress');

/**
 * 抓取身份固定用手Q 形状、与默认(PC)身份无关:这份本地 bundle 是按 android 段 scid
 * 攒起来的,别让包默认身份的改动悄悄改变历史脚本发出的报文。
 */
const CLIENT = { ...ANDROID_QQ_CLIENT, from: 'WeQFetchDress' } as const;

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
  /** 重试若干次后仍失败的批次数（只统计，不再逐条刷屏）。 */
  failures = 0;
  private lastError = '';

  /**
   * 记录一次批次失败 —— 不打印、不换行，只把原因并进下一步的进度行。
   * 这样几百个失败批次也只占屏幕上一行，不会把进度条冲走。
   */
  fail(reason: string): void {
    this.failures++;
    this.lastError = reason.replace(/\s+/g, ' ').trim();
  }

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
    const tail =
      this.failures > 0 ? `  ⚠ fail ${this.failures}: ${truncate(this.lastError, 48)}` : '';
    const line = `\r\x1b[K[${bar}] ${(pct * 100).toFixed(1).padStart(5)}%  ${String(done).padStart(6)}/${total}  hit ${String(hit).padStart(6)}  new ${String(written).padStart(6)}  ${String(kb).padStart(8)}K  ${secs}s  retry ${this.retries}${tail}`;
    process.stdout.write(line);
  }

  done(): void {
    if (!NO_PROGRESS && process.stdout.isTTY) process.stdout.write('\n');
  }
}

/** 截断到 `max` 列，超出补省略号 —— 保持进度行宽度稳定。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
// ─────────────────────────── 目标进程 ───────────────────────────

type Nt = ReturnType<typeof loadNative>['ntHelper'];

/**
 * 建一个只用于路径解析的 Platform：`~/.config/QQ` 数据根 + uid→目录哈希。
 * `qqDataRoot()` 供 `readDeviceGuid` 离线读 guid，`qqWrapperNodePath` /
 * `qqMajorNodePath` 供登记 SSO 时定位 `wrapper.node` 与 `major.node`。
 */
function createPlatform(native: ReturnType<typeof loadNative>): Platform {
  const uidFor = (): string => testEnv.uid;
  if (process.platform === 'linux') return createLinuxPlatform(native, () => null, uidFor);
  if (process.platform === 'darwin') return createDarwinPlatform(native, () => null, uidFor);
  return createWin32Platform(
    native,
    () => null,
    () => null,
  );
}

/**
 * 反查目标账号的 QQ pid，并**登记原生 SSO 会话**。
 *
 * 关键：`ensureAttached` 只把 a2/d2/d2key 读出来，**不会**把它们交给原生侧；
 * 而 `@weq/protocol` 的 `sendPacket` 是按 pid 去原生侧的会话表里取凭据的，取不到
 * 就报「pid X 还没有登记 SSO 会话」。所以在读到物料之后必须走 `registerSsoSession`
 * 登记一次（与桌面端 `AccountMonitorService` 在线采集后走的是同一条路），否则
 * 换地址的第一包必然失败 —— 这正是本脚本抓不到任何资源的根因。
 */
async function resolveTarget(native: ReturnType<typeof loadNative>): Promise<number> {
  const nt = native.ntHelper;
  // 用目标账号 nt_msg.db 的写锁反查 pid —— 不再枚举进程（见 packages/platform）。
  const probe = nt.probeDbLock(testEnv.msgDbPath);
  if (!probe.success) {
    throw new Error(`读不到 ${testEnv.msgDbPath} 的占用者（${probe.msg}）：请先打开并登录目标账号`);
  }
  const holder =
    probe.holders.find(
      (h) =>
        h.name
          .trim()
          .toLowerCase()
          .replace(/\.exe$/, '') === 'qq',
    ) ?? probe.holders[0];
  if (!holder) throw new Error('目标账号的 nt_msg.db 没有 QQ 持有：请先打开并登录目标账号');

  const platform = createPlatform(native);
  const guid = resolveDeviceGuid(nt, platform);
  if (!guid) {
    throw new Error(
      '读不到设备 guid（QQ 数据根不可用）：无法登记 SSO 会话，请检查 QQ 安装/数据目录',
    );
  }

  const material = await ensureAttached(nt, holder.pid, testEnv.uin, { label: 'fetch-dress' });
  const registered = await registerSsoSession(
    nt,
    platform,
    holder.pid,
    { uin: testEnv.uin, uid: testEnv.uid, guid },
    material,
  );
  if (!registered) {
    throw new Error(
      '会话物料不齐（缺 a2 / d2 / d2key），无法登记 SSO 会话：请确认目标账号已完全登录',
    );
  }

  console.log(`[fetch-dress] pid=${holder.pid}  SSO 会话已登记\n`);
  return holder.pid;
}

// ─────────────────────────── 单类型抓取 ───────────────────────────

async function fetchType(nt: Nt, pid: number, type: Type): Promise<void> {
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

  /**
   * 发一个 `batch` 并把命中的记录落盘。失败时（超时 / 抛错）：
   *   - `batch.length > 1` → 二分拆小再各发一次（服务端对条数有硬上限，且
   *     个别区间会静默丢弃，拆小正好绕开这两类）；
   *   - 单条仍失败 → 记一次 `progress.fail`（只统计，不刷屏）。
   */
  const sendBatch = async (batch: { id: number; part: string }[]): Promise<void> => {
    const byScid = new Map<string, { id: number; part: string }>();
    for (const t of batch) byScid.set(scidFor(type, t.id, t.part).scid, t);

    let results: ResourceUrl[] | null = null;
    let lastErr: unknown = null;
    // 整批只试一次就拆（超时是 30s，整批重试代价太大）；单条才走 RETRY 次重试。
    const attempts = batch.length > 1 ? 1 : RETRY;
    for (let attempt = 1; attempt <= attempts && results === null; attempt++) {
      try {
        results = await getResourceUrls(
          nt,
          pid,
          batch.map((t) => scidFor(type, t.id, t.part)),
          CLIENT,
        );
      } catch (err) {
        lastErr = err;
        progress.retries++;
        if (attempt < attempts) await sleep(250 * attempt);
      }
      // 服务端有风控：可选的每请求间隔，慢跑时把 `--throttle` 调大。
      if (THROTTLE > 0) await sleep(THROTTLE);
    }
    reqCount++;

    if (results === null) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await sendBatch(batch.slice(0, mid));
        await sendBatch(batch.slice(mid));
        return;
      }
      progress.fail(lastErr instanceof Error ? lastErr.message : String(lastErr));
      doneCount += 1;
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
  };

  await poolMap(batches, CONCURRENCY, (batch) => sendBatch(batch));
  progress.done();

  const fileSize = existsSync(file) ? readFileSync(file).length : 0;
  console.log(
    `  完成: 请求 ${reqCount} 次  命中 ${hitCount}/${total}  新写入 ${writtenCount} 条  ` +
      `文件 ${file}（${(fileSize / 1024).toFixed(1)} KB，含历史）  ` +
      `重试 ${progress.retries} 次  失败批次 ${progress.failures}\n`,
  );
}

// ─────────────────────────── main ───────────────────────────

async function main(): Promise<void> {
  const native = loadNative();
  const pid = await resolveTarget(native);
  for (const type of TYPES) {
    await fetchType(native.ntHelper, pid, type);
  }
  console.log('全部完成 ✔');
}

main().catch((e) => {
  console.error('\n[fetch-dress] 失败:', e);
  process.exit(1);
});

/*
 * 已跑过的范围 —— 记到「当前最大 id」，下次从这里往后接着跑（尾部之后才有新增；
 * 范围里的空洞多半是服务端本来就没有（not-found），不会随更新补齐）。
 *   2026/09/30  bubble 1-60000 // 1000000-1000050 // 2000000-2180000   font 1-62000   widget 1-200000
 *   2026/10/13  bubble →2180200   font →61257   widget →200386
 *               （补齐上次尾部：bubble 2179440+、widget 199742+、font 61210+）
 * */
