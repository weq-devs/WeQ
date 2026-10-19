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
 *   # 固定范围
 *   pnpm tsx scripts/fetch_dress_resources.ts --font --4000-8000
 *   pnpm tsx scripts/fetch_dress_resources.ts --bubble --2000000-2000100 --concurrency 8
 *   pnpm tsx scripts/fetch_dress_resources.ts --widget --100000-101000 --batch 40 --no-progress
 *
 *   # 续爬（推荐）：每类按已知分段，各自从文件里实际最大 id 往后扫，
 *   # 连续 200 个空 id 就收手 —— 自动覆盖「上次边界 → 边界 + 200」的确认。
 *   pnpm tsx scripts/fetch_dress_resources.ts --bubble --font --widget --extend
 *
 * 可选参数：
 *   --timeout <秒>   单次 GetUrl 的客户端超时（默认 4）。到点即二分拆小；拆到单条仍超时
 *                    说明该 id 服务端不回包（dataset 里正常的空洞），直接跳过不重试。
 *   --empty <n>      [--extend] 连续 n 个空 id 判定「到头了」（默认 200）。
 *   --tail <n>       [--extend] 至少越过各段上界这么多再允许收手（默认 200）。
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

/** `--extend`：不填范围，按已知分段自动续爬（见下方配置区说明）。 */
const EXTEND = has('--extend');

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
if (!EXTEND && TO < FROM) {
  console.error('请指定 id 范围（如 --4000-8000），或加 --extend 自动续爬');
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
/**
 * 单次 GetUrl 的客户端超时（秒，默认 4）。
 *
 * 原生 SSO 的等待是写死的 30s，但**有些 id 服务端根本不会回包**（不是风控）——
 * 死等 30s 会让整段奇慢。这里加一层更短的超时，到点即当作失败交给上层二分拆小：
 * 拆到单条仍超时，说明就是那个 id 不回包，直接算 miss 跳过，不再重试。
 */
const REQUEST_TIMEOUT = Number(opt('--timeout') ?? 4) * 1000;
const OUT_DIR = path.resolve(opt('--out') ?? path.join('resources', 'dress'));
const NO_PROGRESS = has('--no-progress');
/**
 * 以下三项只在 `--extend`（按分段自动续爬）时生效：从每段**文件里实际最大 id**
 * 往后接着扫，保证至少扫过「上次边界 + TAIL_MARGIN」以确认那之后全空；一旦连续
 * `EMPTY_STOP` 个 id 一个都没命中就收手（dataset 尾部的正常空洞）。
 */
/** 连续多少个空 id 判定「到头了」。 */
const EMPTY_STOP = Number(opt('--empty') ?? 200);
/** 至少多扫这么多 id（越过上次边界），确保尾部确实是空的。 */
const TAIL_MARGIN = Number(opt('--tail') ?? 200);
/** 开区间续爬时每轮取多少个 id。 */
const WINDOW = 40;

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

/** 从 (id:part) 键集合里抽出出现过的 id，升序去重。 */
function idsOf(keys: Set<string>): number[] {
  const ids = new Set<number>();
  for (const k of keys) ids.add(Number(k.slice(0, k.indexOf(':'))));
  return [...ids].sort((a, b) => a - b);
}

/**
 * 每类的已知 id 分段（据脚本底部「已跑过的范围」）。
 *
 * `lo`/`hi` 是**半开区间** `[lo, hi)`，用来圈定「哪段属于同一批 id」，续爬时取该段
 * 内已有的最大 id 往下接；`hi` 取下一段的 `lo`（最后一段用 MAX_SAFE_INTEGER），这样
 * 越过旧边界的新记录也算在本段里，不会每次重扫。
 *
 * `floor` 是**上次跑到的边界**：至少要扫到 `floor + TAIL_MARGIN` 才能收手，用来确认
 * 「旧边界之后确实是空的」（否则连续空可能在旧边界之前就凑够，漏掉中间的空档）。
 */
interface Band {
  lo: number;
  hi: number;
  floor: number;
}
const BANDS: Record<Type, Band[]> = {
  bubble: [
    { lo: 1, hi: 1_000_000, floor: 60_000 },
    { lo: 1_000_000, hi: 2_000_000, floor: 1_000_050 },
    { lo: 2_000_000, hi: Number.MAX_SAFE_INTEGER, floor: 2_180_000 },
  ],
  font: [{ lo: 1, hi: Number.MAX_SAFE_INTEGER, floor: 62_000 }],
  widget: [{ lo: 1, hi: Number.MAX_SAFE_INTEGER, floor: 200_000 }],
};

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

/** 客户端超时（区别于原生 30s 超时），到点即拒绝，交给上层拆分/跳过。 */
class RequestTimeout extends Error {}

/** 给 Promise 加一层更短的超时；原 Promise 仍在后台跑完（结果丢弃）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestTimeout(`client timeout ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

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
  /** 单条超时被跳过的 id 数（服务端对这些 id 根本不回包，属正常空洞）。 */
  timeouts = 0;
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
    const line = `\r\x1b[K[${bar}] ${(pct * 100).toFixed(1).padStart(5)}%  ${String(done).padStart(6)}/${total}  hit ${String(hit).padStart(6)}  new ${String(written).padStart(6)}  ${String(kb).padStart(8)}K  ${secs}s  retry ${this.retries}  tmo ${this.timeouts}${tail}`;
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

/** 打印一次抓取的收尾统计。`unit` 为「任务」或「扫过」这类量词。 */
function report(
  file: string,
  reqCount: number,
  hitCount: number,
  total: number,
  writtenCount: number,
  progress: Progress,
  unit = '任务',
): void {
  const fileSize = existsSync(file) ? readFileSync(file).length : 0;
  console.log(
    `  完成: 请求 ${reqCount} 次  命中 ${hitCount}  写入 ${writtenCount} 条（共 ${total} ${unit}）  ` +
      `文件 ${file}（${(fileSize / 1024).toFixed(1)} KB，含历史）  ` +
      `重试 ${progress.retries} 次  超时空洞 ${progress.timeouts}  失败批次 ${progress.failures}\n`,
  );
}

async function fetchType(nt: Nt, pid: number, type: Type): Promise<void> {
  const parts = PARTS[type];
  const file = path.join(OUT_DIR, `${type}_resources`);
  mkdirSync(OUT_DIR, { recursive: true });

  const existing = readExistingKeys(file);
  const progress = new Progress();
  let hitCount = 0;
  let writtenCount = 0;
  let writtenBytes = 0;
  let reqCount = 0;
  let scanned = 0;

  /**
   * 发一批 scid 并取回结果。失败时（超时 / 抛错）二分拆小重试：
   *   - `refs.length > 1` → 拆成两半各发一次（服务端单包有条数上限，且个别 id
   *     根本不回包，拆小正好绕开这两类）；
   *   - 单条仍超时 → 该 id 服务端不回包，是 dataset 里本来就有的**空洞**，记
   *     `progress.timeouts` 后跳过，不再重试；
   *   - 单条其他失败 → 记 `progress.fail`（只统计，不刷屏）。
   */
  /**
   * 按 `BATCH` 分块并发发送，再把各块结果拼起来。extend 模式一次窗口可能凑出上百
   * 个 scid，直接整包发会超服务端条数上限被静默丢弃，所以这里先切块。
   */
  const sendRefs = async (refs: ScidRef[]): Promise<ResourceUrl[]> => {
    if (refs.length <= BATCH) return sendRefsChunk(refs);
    const resultChunks = await poolMap(chunk(refs, BATCH), CONCURRENCY, (c) => sendRefsChunk(c));
    return resultChunks.flat();
  };

  const sendRefsChunk = async (refs: ScidRef[]): Promise<ResourceUrl[]> => {
    if (refs.length === 0) return [];
    let results: ResourceUrl[] | null = null;
    let lastErr: unknown = null;
    // 整批只试一次就拆（多等一轮没意义）；单条才走 RETRY 次重试。
    const attempts = refs.length > 1 ? 1 : RETRY;
    for (let attempt = 1; attempt <= attempts && results === null; attempt++) {
      try {
        results = await withTimeout(getResourceUrls(nt, pid, refs, CLIENT), REQUEST_TIMEOUT);
      } catch (err) {
        lastErr = err;
        progress.retries++;
        if (attempt < attempts) await sleep(250 * attempt);
      }
      if (THROTTLE > 0) await sleep(THROTTLE);
    }
    reqCount++;

    if (results !== null) return results;
    if (refs.length > 1) {
      const mid = Math.ceil(refs.length / 2);
      return [
        ...(await sendRefsChunk(refs.slice(0, mid))),
        ...(await sendRefsChunk(refs.slice(mid))),
      ];
    }
    // 单条仍失败：超时 = 服务端对此 id 不回包（正常的空洞），其余才算失败。
    if (lastErr instanceof RequestTimeout) progress.timeouts++;
    else progress.fail(lastErr instanceof Error ? lastErr.message : String(lastErr));
    return [];
  };

  /** 把结果按 (id, part) 归位、编码落盘；返回本次命中的 id 集合。 */
  const collect = (
    results: ResourceUrl[],
    byScid: Map<string, { id: number; part: string }>,
  ): Set<number> => {
    const records: Buffer[] = [];
    const hitIds = new Set<number>();
    for (const r of results) {
      const t = byScid.get(r.scid);
      if (!t || !r.ok) continue;
      hitCount++;
      hitIds.add(t.id);
      records.push(encodeRecord(t.id, t.part, stripHost(r.url), r.size));
    }
    if (records.length > 0) {
      appendFileSync(file, Buffer.concat(records));
      writtenCount += records.length;
      writtenBytes += records.reduce((a, b) => a + b.length, 0);
    }
    return hitIds;
  };

  // ── 模式一：固定范围（显式给 --from/--to 或 --A-B）──────────────
  if (!EXTEND) {
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
      `  需抓取 ${total} 个（已有 ${skipped} 个跳过）  batch=${BATCH} 并发=${CONCURRENCY} ` +
        `重试=${RETRY} 超时=${REQUEST_TIMEOUT / 1000}s\n`,
    );

    let done = 0;
    await poolMap(chunk(tasks, BATCH), CONCURRENCY, async (batch) => {
      const byScid = new Map<string, { id: number; part: string }>();
      for (const t of batch) byScid.set(scidFor(type, t.id, t.part).scid, t);
      collect(await sendRefs(batch.map((t) => scidFor(type, t.id, t.part))), byScid);
      done += batch.length;
      progress.tick(done, total, hitCount, writtenCount, writtenBytes);
    });
    progress.done();
    report(file, reqCount, hitCount, total, writtenCount, progress);
    return;
  }

  // ── 模式二：--extend（按分段续爬，连续空到达阈值即停）────────────
  console.log(
    `══ ${type}  extend（每段从已有最大 id 续爬，连续空 ${EMPTY_STOP} 个即停；` +
      `至少越过各段上界 +${TAIL_MARGIN}）══`,
  );
  // 已出现过的 id（含历史记录里任一分包），用来判断某 id 是否「有货」。
  const present = new Set<number>(idsOf(existing));

  for (const band of BANDS[type]) {
    // 取本段内已有最大的 id（不能用 Math.max(...)：尾部段十几万条会把调用栈撑爆）。
    let maxKnown = 0;
    for (const id of present) {
      if (id >= band.lo && id < band.hi && id > maxKnown) maxKnown = id;
    }
    const start = (maxKnown > 0 ? maxKnown : band.lo - 1) + 1;
    // 至少要扫过「上次边界 + TAIL_MARGIN」，确保那之后确实全空。
    const floorEnd = band.floor + TAIL_MARGIN;
    console.log(
      `\n  ── 段 [${band.lo}, ${band.hi === Number.MAX_SAFE_INTEGER ? '∞' : band.hi})：` +
        `已有最大 ${start - 1}，从 ${start} 起，至少扫到 ${floorEnd}`,
    );

    let cursor = start;
    let consecEmpty = 0;
    let bandHits = 0;
    let bandScanned = 0;
    while (true) {
      const ids: number[] = [];
      for (let i = cursor; i < cursor + WINDOW; i++) ids.push(i);
      const windowEnd = ids[ids.length - 1];

      const refs: ScidRef[] = [];
      const byScid = new Map<string, { id: number; part: string }>();
      for (const id of ids) {
        for (const part of parts) {
          if (existing.has(`${id}:${part}`)) continue;
          const ref = scidFor(type, id, part);
          refs.push(ref);
          byScid.set(ref.scid, { id, part });
        }
      }
      const hitIds = collect(await sendRefs(refs), byScid);

      for (const id of ids) {
        if (present.has(id) || hitIds.has(id)) {
          consecEmpty = 0;
          if (hitIds.has(id)) {
            bandHits++;
            present.add(id);
          }
        } else {
          consecEmpty++;
        }
        bandScanned++;
        scanned++;
      }
      progress.tick(scanned, Math.max(scanned, 1), hitCount, writtenCount, writtenBytes);

      if (consecEmpty >= EMPTY_STOP && windowEnd >= floorEnd) {
        console.log(
          `\n    段 [${band.lo}, ${band.hi === Number.MAX_SAFE_INTEGER ? '∞' : band.hi}) 收手：` +
            `扫 ${bandScanned} 个，新增命中 ${bandHits}，到 ${windowEnd} 已连续 ${consecEmpty} 个空 id`,
        );
        break;
      }
      cursor += WINDOW;
    }
  }
  progress.done();
  report(file, reqCount, hitCount, scanned, writtenCount, progress, '扫过');
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
 *   2026/10/16  bubble →2181294   font →61274   widget →200723   （--extend 续爬）
 *               （各段连续空 200 即停，已复跑确认三类尾部全空；font 段尾部最稀疏）
 *
 * 下次直接跑：
 *   pnpm tsx scripts/fetch_dress_resources.ts --bubble --font --widget --extend
 * 它会从各段真实最大 id 往后扫，连续 200 个空 id 自动收手，并至少越过旧边界 +200。
 * 
 * 2026-10-19
 * */
