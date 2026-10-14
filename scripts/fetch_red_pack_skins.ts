/**
 * 红包皮肤元数据批量抓取脚本。
 *
 * 以「skin_id 范围」批量调 `trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo`
 * （协议层见 `@weq/protocol` 的 `GetRedPackSkin`），把每只皮肤的
 * 名称 / 封面 / 跳转 / 图链 / TTL 落盘成一份**给人看**的 JSON。
 *
 * 产物：`resources/redpack/skins.json`（**入库**，不 ignore —— 这是要长期留的数据）
 *   {
 *     "generatedAt": 1791964334,      // 最近一次写入时间（unix 秒）
 *     "count": 836,                   // 收录的皮肤总数
 *     "range": [1039, 2683],          // 文件里实际覆盖的 id 区间（非本次运行参数）
 *     "skins": [ { "id": 2658, "name": "生日祝福", ... } ]
 *   }
 *
 * 只记录**看得懂**的字段（id/name/state 与一组可读图链 + 跳转），原始 protobuf 不落盘。
 * 重新运行会按 id 去重合并、原地按 id 排序，所以可以分段增量抓：
 *
 *   pnpm tsx scripts/fetch_red_pack_skins.ts --1-3000
 *   pnpm tsx scripts/fetch_red_pack_skins.ts --1-3000 --concurrency 4 --throttle 200
 *   pnpm tsx scripts/fetch_red_pack_skins.ts --meta-only   # 只按现有数据重算元信息，不发包
 *
 * ⚠️ 服务端有风控：这是**逐个 id 单独请求**的接口（不能像 fetch_dress 那样一次带
 * 一把 scid）。务必先用小范围慢跑探路（`--concurrency 2 --throttle 300`），
 * 别一上来就几千个并发。默认并发 4、无间隔；被限流 / 超时会在进度里报出来。
 *
 * 需要目标 QQ（testEnv.uin）在线并已登录 —— 会话物料与 SSO 登记的流程与
 * `fetch_dress_resources.ts` 完全一致。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { GetRedPackSkin, type RedPackSkinInfo } from '../packages/protocol/src';

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const opt = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * `--meta-only`：不连 QQ、不发包，只把已有 skins.json 按当前格式重写
 * （重算 `count` / `range`、补 `count` 字段、按 id 排序）。用于格式升级或修元信息。
 */
const META_ONLY = has('--meta-only');

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
if (!META_ONLY && TO < FROM) {
  console.error('请指定 skin_id 范围，如 --1-3000');
  process.exit(1);
}

const CONCURRENCY = Number(opt('--concurrency') ?? 4);
const RETRY = Number(opt('--retry') ?? 2);
/** 每发一个请求后停 `THROTTLE` 毫秒（默认 0）—— 服务端有风控，慢跑时调大。 */
const THROTTLE = Number(opt('--throttle') ?? 0);
const OUT_DIR = path.resolve(opt('--out') ?? path.join('resources', 'redpack'));
const OUT_FILE = path.join(OUT_DIR, 'skins.json');
const NO_PROGRESS = has('--no-progress');

// ─────────────────────────── 落盘格式 ───────────────────────────

/**
 * 一只红包皮肤 —— 只留看得懂的字段：原始 wire 里的图链分散在 f4.4 / f4.8 / f4.9 /
 * f4.10 / f4.11 / f4.26，这里归成有意义的名字（封面 / 主图 / 预览 / 弹窗 / 背景 / 附加图）。
 */
interface SkinRecord {
  id: number;
  name: string;
  /** 状态，1 = 生效/在售。 */
  state: number;
  /** 来源标注（多为「腾讯设计开放平台」）。 */
  source: string;
  cover: string;
  /** 详情/横幅主图。 */
  image: string;
  /** 聊天列表预览图。 */
  preview: string;
  /** 弹窗预览图。 */
  popup: string;
  /** 封面背景图。 */
  background: string;
  /** 附加图（部分皮肤没有）。 */
  extra: string;
  /** 跳转按钮文案 + 地址（多为「领取同款封面」）。 */
  jumpText: string;
  jumpUrl: string;
  /** 服务端给的缓存 TTL（秒）。 */
  ttl: number;
}

interface SkinFile {
  /** 最近一次写入时间（unix 秒）。 */
  generatedAt: number;
  /** 收录的皮肤总数（= `skins.length`）。 */
  count: number;
  /** 文件里实际覆盖的 id 区间 `[min, max]`；空文件为 `[0, 0]`。 */
  range: [number, number];
  skins: SkinRecord[];
}

function toRecord(info: RedPackSkinInfo, ttl: number): SkinRecord {
  return {
    id: info.id,
    name: info.name,
    state: info.state,
    source: info.cover.label,
    cover: info.cover.url,
    image: info.image,
    preview: info.preview,
    popup: info.popup,
    background: info.background.url,
    extra: info.extra,
    jumpText: info.jump.label,
    jumpUrl: info.jump.url,
    ttl,
  };
}

/** 读已有的 skins.json 做增量合并；不存在 / 损坏就当空表。 */
function readExisting(): Map<number, SkinRecord> {
  const out = new Map<number, SkinRecord>();
  if (!existsSync(OUT_FILE)) return out;
  try {
    const parsed = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as Partial<SkinFile>;
    for (const s of parsed.skins ?? []) if (s && typeof s.id === 'number') out.set(s.id, s);
  } catch {
    console.warn(`  ⚠ 已有 ${OUT_FILE} 解析失败，本次视为从零开始`);
  }
  return out;
}

function writeAll(merged: Map<number, SkinRecord>): number {
  mkdirSync(OUT_DIR, { recursive: true });
  const skins = [...merged.values()].sort((a, b) => a.id - b.id);
  const payload: SkinFile = {
    generatedAt: Math.floor(Date.now() / 1000),
    count: skins.length,
    range: skins.length > 0 ? [skins[0]!.id, skins[skins.length - 1]!.id] : [0, 0],
    skins,
  };
  writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  return skins.length;
}

// ─────────────────────────── 并发池 / 进度 ───────────────────────────

async function poolMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Progress {
  private readonly start = Date.now();
  private last = 0;
  retries = 0;
  failures = 0;
  private lastError = '';

  /** 记一次失败（不打印，只把原因并进下一步的进度行，避免刷屏）。 */
  fail(reason: string): void {
    this.failures++;
    this.lastError = reason.replace(/\s+/g, ' ').trim();
  }

  tick(done: number, total: number, hits: number): void {
    if (NO_PROGRESS || !process.stdout.isTTY) return;
    const now = Date.now();
    if (now - this.last < 100 && done < total) return;
    this.last = now;
    const pct = total ? done / total : 1;
    const w = 22;
    const bar = '█'.repeat(Math.round(pct * w)) + '░'.repeat(w - Math.round(pct * w));
    const secs = ((now - this.start) / 1000).toFixed(1);
    const tail =
      this.failures > 0 ? `  ⚠ fail ${this.failures}: ${truncate(this.lastError, 48)}` : '';
    const line = `\r\x1b[K[${bar}] ${(pct * 100).toFixed(1).padStart(5)}%  ${String(done).padStart(5)}/${total}  hit ${String(hits).padStart(5)}  ${secs}s  retry ${this.retries}${tail}`;
    process.stdout.write(line);
  }

  done(): void {
    if (!NO_PROGRESS && process.stdout.isTTY) process.stdout.write('\n');
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ─────────────────────────── 目标进程 ───────────────────────────

type Nt = ReturnType<typeof loadNative>['ntHelper'];

/**
 * 建一个只用于路径解析的 Platform：`~/.config/QQ` 数据根 + uid→目录哈希，与
 * `fetch_dress_resources.ts` 同款。`qqDataRoot()` 供 `readDeviceGuid` 离线读 guid，
 * `qqWrapperNodePath` / `qqMajorNodePath` 供登记 SSO 时定位 wrapper / major。
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
 * 反查目标账号的 QQ pid，并登记原生 SSO 会话（读到物料后必须 `registerSsoSession`
 * 一次，否则 `sendPacket` 报「pid X 还没有登记 SSO 会话」）。
 */
async function resolveTarget(native: ReturnType<typeof loadNative>): Promise<number> {
  const nt = native.ntHelper;
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
    throw new Error('读不到设备 guid（QQ 数据根不可用）：无法登记 SSO 会话，请检查安装/数据目录');
  }

  const material = await ensureAttached(nt, holder.pid, testEnv.uin, { label: 'fetch-rpskin' });
  const registered = await registerSsoSession(
    nt,
    platform,
    holder.pid,
    { uin: testEnv.uin, uid: testEnv.uid, guid },
    material,
  );
  if (!registered) {
    throw new Error('会话物料不齐（缺 a2 / d2 / d2key），无法登记 SSO 会话：请确认账号已完全登录');
  }

  console.log(`[fetch-rpskin] pid=${holder.pid}  SSO 会话已登记\n`);
  return holder.pid;
}

// ─────────────────────────── 抓取 ───────────────────────────

async function fetchSkins(nt: Nt, pid: number): Promise<void> {
  const existing = readExisting();
  const ids: number[] = [];
  let skipped = 0;
  for (let id = FROM; id <= TO; id++) {
    if (existing.has(id)) {
      skipped++;
      continue;
    }
    ids.push(id);
  }

  console.log(
    `══ 红包皮肤 ${FROM}-${TO}（${TO - FROM + 1} 个 id，已缓存 ${skipped}，待抓 ${ids.length}）══`,
  );
  if (ids.length === 0) {
    console.log(`  范围内全部已在 ${OUT_FILE} 中，无需抓取\n`);
    return;
  }
  console.log(`  并发=${CONCURRENCY}  重试=${RETRY}  间隔=${THROTTLE}ms\n`);

  const progress = new Progress();
  const merged = new Map(existing);
  let done = 0;
  let hits = 0;

  await poolMap(ids, CONCURRENCY, async (id) => {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= RETRY; attempt++) {
      try {
        const resp = await GetRedPackSkin.invoke(nt, pid, { skinId: id });
        if (resp.skin) {
          merged.set(id, toRecord(resp.skin, resp.ttl));
          hits++;
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        progress.retries++;
        if (attempt < RETRY) await sleep(250 * attempt);
      }
    }
    if (lastErr) progress.fail(lastErr instanceof Error ? lastErr.message : String(lastErr));
    if (THROTTLE > 0) await sleep(THROTTLE);
    done++;
    progress.tick(done, ids.length, hits);
  });
  progress.done();

  const total = writeAll(merged);
  console.log(
    `  完成: 命中 ${hits}/${ids.length}  文件 ${OUT_FILE}（共 ${total} 只皮肤）  ` +
      `重试 ${progress.retries} 次  失败 ${progress.failures} 个\n`,
  );
}

// ─────────────────────────── main ───────────────────────────

async function main(): Promise<void> {
  if (META_ONLY) {
    const existing = readExisting();
    const total = writeAll(existing);
    console.log(
      `[fetch-rpskin] --meta-only：已按现有数据重写 ${OUT_FILE}（共 ${total} 只皮肤），未发包`,
    );
    return;
  }
  const native = loadNative();
  const pid = await resolveTarget(native);
  await fetchSkins(native.ntHelper, pid);
  console.log('全部完成 ✔');
}

main().catch((e) => {
  console.error('\n[fetch-rpskin] 失败:', e);
  process.exit(1);
});

/*
 * 已跑过的范围 —— 记到「当前最大 id」，下次从这里往后接着跑（尾部之后才有新增；
 * 范围里的空洞是服务端本来就没有，不会随更新补齐）。
 *   （暂无）
 * */
