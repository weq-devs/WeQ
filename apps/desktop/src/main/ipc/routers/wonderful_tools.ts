/**
 * 妙妙工具 router — 主窗口「更多功能 → 妙妙工具」的后端。
 *
 *   - `overview`   遍历 login.db 的全部历史账号，逐个解析数据库目录
 *                  (`nt_msg.db`) 与在线状态（pid 反查），供密钥扫描面板
 *                  点亮/置灰账号卡片。
 *   - `scanKey`    对单个账号做零注入内存扫描（nt_helper 的
 *                  `scanKeyFromDatabase`），以该账号自己的 `nt_msg.db`
 *                  作为候选密钥的验证过滤。
 *   - `pickDatabase` / `peekDatabaseHeader` / `fetchOtherDeviceKey`
 *                  「其它设备密钥」：选一个其它设备导出的 `nt_msg.db`，
 *                  先展示其头部 hexdump（高亮发包用的 db_salt），再按
 *                  bootstrap 的实例取密钥流程（唯一区别：不注入，直接向
 *                  在线 QQ 发 OIDB 0xCDE_2）要密钥。
 *
 * 平台差异（win32 / linux）由 `platform.resolveQqPid` 封装：
 *   - win32: Restart Manager 句柄枚举
 *   - linux: /proc fcntl 写锁持有者 + uid 哈希目录解析
 *
 * 在线判定以 db 锁探测为准：探测成功但没有 QQ 持有者 = 离线；只有在探测
 * 本身报错（如无权限、会话隔离）或找不到数据库文件时才回退端口扫描，所以
 * 离线账号列表可以秒出，不会被逐进程端口探测拖慢。
 */

import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { open as openFile, writeFile } from 'node:fs/promises';
import { observable } from '@trpc/server/observable';
import {
  readSipEnabled,
  resolveNtHelperPath,
  type KeyScanProgress,
  type KeyScanResult,
  type LoginAccount,
} from '@weq/native';
import {
  rvNodesToJson,
  tryDecodeAfterLengthPrefix,
  tryDecodeJce,
  tryDecodeProtobuf,
} from '@weq/codec/raw';
import {
  attachAndRegisterSsoSession,
  getHost,
  registerSsoSessionFromStored,
  requestDecryptKeyFromInstance,
  resolveDeviceGuid,
} from '@weq/service';
import { getLogger } from '@weq/service';
import { requireBootstrap, requirePlatform } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { ensureUidForUin } from './bootstrap';
import {
  toCaptureFrameWire,
  type CaptureBatchWire,
  type CaptureSessionWire,
  type CaptureStatsWire,
} from '../../capture_protocol';
import { startElevatedCaptureWorker, type ElevatedCaptureWorker } from '../../capture_elevation';
import { SIP_ENABLED_MESSAGE } from '../../attach_elevation';
import { scanKeyElevated } from '../../key_scan_elevation';

const logger = getLogger().child({ scope: 'wonderful-tools' });

/** 展示给用户的数据库头部字节数：≥192 字节，取 16 的倍数整行展示。 */
const HEADER_READ_BYTES = 192;
/** nt_helper 发包前从数据库头提取的 db_salt 所在字节区间（含头不含尾）。 */
const DB_SALT_START = 0x2f;
const DB_SALT_END = 0xaf;

/** 抓包后端可用性（Windows 缺 Npcap 时用于引导安装）。 */
export interface CaptureSupportWire {
  available: boolean;
  backend: string;
  elevated: boolean;
  hint: string;
  platform: string;
}

/** 导出抓包结果时落盘的文件格式。 */
const CAPTURE_EXPORT_FORMATS = ['json', 'jsonl'] as const;

/**
 * 渲染层提交的一帧导出数据 —— 就是抓包线上协议的 hex 形态（`CaptureFrameWire`）。
 * 主进程拿到后用 `@weq/codec/raw` 自己把 `bodyHex` 解析成 `{tag: value}` 树，渲染层
 * 不必再复制一份解析结果过来。
 */
const captureExportFrameSchema = z.object({
  cursor: z.number(),
  ts: z.number(),
  direction: z.enum(['c2s', 's2c']),
  proto: z.number(),
  encryptType: z.number(),
  seq: z.number(),
  cmd: z.string().nullable(),
  rawHex: z.string(),
  plainHex: z.string(),
  bodyHex: z.string(),
});

/** 导出结果：`saved=false` 且 `canceled=true` 表示用户在保存框里点了取消。 */
export interface CaptureExportResult {
  saved: boolean;
  canceled?: boolean;
  /** 桌面端 = 落盘路径；Web 端 = `/_download/<id>` 下载地址。 */
  path?: string;
  downloadId?: string | null;
  /** 本次导出的字节数。 */
  bytes?: number;
  /** 导出的帧数。 */
  frames?: number;
  error?: string;
}

/** 一个账号在密钥扫描面板里的状态行。 */
export interface WonderfulToolAccountWire {
  uin: string;
  uid: string;
  userName: string;
  avatarUrl: string;
  lastLoginAt: number;
  /** 该账号的 `nt_msg.db` 绝对路径；目录不存在时为 null。 */
  dbPath: string | null;
  /** 反查到的在线 QQ 进程 pid；离线时为 null。 */
  pid: number | null;
}

/** 密钥扫描进度事件（订阅用；带上 uin 好让面板过滤出自己那次扫描）。 */
export interface WonderfulToolScanProgressWire extends KeyScanProgress {
  uin: string;
}

/**
 * 密钥扫描进度总线。扫描在 `scanKey` 里同步跑（长任务），进度通过
 * `onKeyScanProgress` 订阅推给渲染进程 —— 与 `db_repair` / `update` 同一套
 * EventEmitter→observable 桥接方式。
 */
const scanProgressBus = new EventEmitter();

/** 逐账号容错解析密钥扫描面板的状态行。 */
async function resolveAccountRows(
  boot: ReturnType<typeof requireBootstrap>,
  platform: ReturnType<typeof requirePlatform>,
): Promise<WonderfulToolAccountWire[]> {
  let accounts: LoginAccount[] = [];
  try {
    accounts = await boot.detect.listAccounts();
  } catch {
    return [];
  }
  const rows: WonderfulToolAccountWire[] = [];
  for (const acc of accounts) {
    // linux 需要 uin→uid 映射才能解析账号目录；win32 是无操作。
    await ensureUidForUin(boot, acc.uin);
    let dbPath: string | null = null;
    let pid: number | null = null;
    try {
      dbPath = platform.ntMsgDbPath(acc.uin);
    } catch {
      dbPath = null;
    }
    try {
      pid = platform.resolveQqPid(acc.uin);
    } catch {
      pid = null;
    }
    rows.push({
      uin: acc.uin,
      uid: acc.uid,
      userName: acc.userName,
      avatarUrl: acc.avatarUrl,
      lastLoginAt: acc.lastLoginAt,
      dbPath,
      pid,
    });
  }
  return rows;
}

/**
 * 汇总当前在线的 QQ 实例（按账号反查，pid 去重）—— 连同归属账号的 uin / uid
 * 一起返回，登记 SSO 会话时直接用（不用再探一遍）。
 */
async function resolveOnlineInstances(
  boot: ReturnType<typeof requireBootstrap>,
  platform: ReturnType<typeof requirePlatform>,
): Promise<Array<{ pid: number; uin: string; uid: string }>> {
  const rows = await resolveAccountRows(boot, platform);
  const seen = new Set<number>();
  const instances: Array<{ pid: number; uin: string; uid: string }> = [];
  for (const row of rows) {
    if (row.pid !== null && row.uid && !seen.has(row.pid)) {
      seen.add(row.pid);
      instances.push({ pid: row.pid, uin: row.uin, uid: row.uid });
    }
  }
  return instances;
}

/** 把实例取密钥的失败原因转成用户可读文案（OIDB 1006 = 无权获取）。 */
function humanizeKeyFetchError(error: string): string {
  if (error.includes('1006')) {
    return `无权获取该数据库的密钥：${error}`;
  }
  return error;
}

/**
 * 为一个在线实例登记 SSO 会话物料（读内存拿 a2/d2/d2key），并回带 d2key。
 *
 * 抓包要拿 d2key 才能把 TEA 密文解成明文。d2key 在两条路径上都要**显式传给
 * `startCapture`**：
 *   - 提权路径：子进程是**另一个 native 实例**，主进程 `setSsoSession` 注册的物料
 *     在它那边看不见，不传就永远解不出明文；
 *   - 本进程路径（Windows / 本来就是 root）：注册过的物料它能自己回退查到，但显式
 *     传参才不依赖那条回退 —— 少了这一句，Windows 上就是「有密文、没明文」。
 *
 * 登记失败（缺 uid / guid）**不再是致命错误**：抓包只需要 d2key，发送能力用不上。
 * 这时照样开抓包，只是前端会标明「只能看密文」。
 *
 * **优先复用本地账号配置里已存的物料**（a2 / d2 / d2key + pid）直接登记 —— 抓包只
 * 要 d2key，本地这份就是上次从同一个 pid 读到的，没必要为了它再撞一次提权门。
 * 只有物料缺失 / pid 对不上（QQ 重启过，密钥已失效）才回退到读内存。
 */
async function prepareCaptureSession(
  uin: string,
): Promise<{ pid: number; d2Key: string | undefined }> {
  const boot = requireBootstrap();
  const platform = requirePlatform();
  const instances = await resolveOnlineInstances(boot, platform);
  const inst = instances.find((i) => i.uin === uin);
  if (!inst) {
    throw new Error(`账号 ${uin} 当前没有在线的 QQ 实例，无法抓包`);
  }
  const guid = resolveDeviceGuid(platform.native.ntHelper, platform);

  // 先试本地已存物料：不读内存、不提权。`config.qqPid` 只在老记录缺 `session.pid`
  // 时当兜底判据 —— 它是从磁盘读的、独立于本次调用（不是刚被写成 inst.pid）。
  const stored = boot.userConfig.listAccountConfigs().find((c) => c.uin === uin);
  const reused = await registerSsoSessionFromStored(
    platform.native.ntHelper,
    platform,
    inst.pid,
    inst.uin,
    {
      material: stored?.session,
      pid: stored?.qqPid ?? null,
      uid: stored?.uid ?? inst.uid,
      guid: stored?.guid ?? guid,
    },
  );
  if (reused) {
    logger.info('capture registered the native sso session from stored material', {
      event: 'capture-reuse-stored',
      pid: inst.pid,
      uin: inst.uin,
    });
    return { pid: inst.pid, d2Key: stored?.session?.d2Key };
  }

  // 回退：本地没有可用物料（或 pid 对不上）→ 读内存（可能触发提权）。
  const { material, registered } = await attachAndRegisterSsoSession(
    platform.native.ntHelper,
    platform,
    boot.attachHook,
    inst.pid,
    inst.uin,
    { uid: inst.uid, guid },
  );
  if (!material.d2Key) {
    logger.warn('capture started without d2key; frames will stay encrypted', {
      event: 'capture-no-d2key',
      pid: inst.pid,
      uin: inst.uin,
      registered,
    });
  }
  return { pid: inst.pid, d2Key: material.d2Key };
}

/**
 * 睁着的提权抓包子进程（一次抓包会话一个）。key = pid —— native 侧会话本身也是按
 * pid 记的，而 `capturePoll` / `captureStop` 只带 pid，所以只能按 pid 找回子进程。
 */
const elevatedCaptures = new Map<number, ElevatedCaptureWorker>();

/** 取（或起）某 pid 的提权抓包子进程；需要密码时由它自己弹框。 */
async function acquireElevatedCaptureWorker(pid: number): Promise<ElevatedCaptureWorker> {
  const existing = elevatedCaptures.get(pid);
  if (existing) return existing;
  const worker = await startElevatedCaptureWorker(resolveNtHelperPath());
  elevatedCaptures.set(pid, worker);
  return worker;
}

/**
 * 关掉所有提权抓包子进程（退出 / 卸载会话时调用）。幂等：子进程那边也会在环回连接
 * 断开时自己收尾，这里只是让它早点走。
 */
export function disposeElevatedCaptures(): void {
  for (const [, worker] of elevatedCaptures) worker.dispose();
  elevatedCaptures.clear();
}

/** 用 `@weq/codec/raw` 把正文按 protobuf → JCE → 去长度前缀的顺序解析成 JSON 树。 */
function decodeCaptureBody(bytes: Uint8Array): {
  kind: 'protobuf' | 'jce';
  json: ReturnType<typeof rvNodesToJson>;
} | null {
  if (bytes.length === 0) return null;
  const proto = tryDecodeProtobuf(bytes);
  if (proto) return { kind: 'protobuf', json: rvNodesToJson(proto) };
  const jce = tryDecodeJce(bytes);
  if (jce) return { kind: 'jce', json: rvNodesToJson(jce) };
  const stripped = tryDecodeAfterLengthPrefix(bytes);
  if (stripped) return { kind: stripped.kind, json: rvNodesToJson(stripped.nodes) };
  return null;
}

/** 加密类型文案（native：0 = 不加密，1 = d2key，2 = 全零 key）。 */
function captureEncryptLabel(type: number): string {
  if (type === 0) return 'plain';
  if (type === 1) return 'd2key';
  if (type === 2) return 'zero-key';
  return `#${type}`;
}

/** `20261008-153012` 形态的时间戳，用于默认文件名（避免非法字符）。 */
function captureFileStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

/** 默认文件名主体：把账号 / 网卡里的路径分隔符与控制字符换成下划线。 */
function safeCaptureName(raw: string, fallback: string): string {
  const cleaned = (raw || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return cleaned || fallback;
}

export const wonderfulToolsRouter = router({
  /**
   * 列出全部历史账号 + 各自的在线状态。逐个账号容错：单个账号探测失败
   * 不会拖垮整个列表。
   */
  overview: procedure.query(async (): Promise<WonderfulToolAccountWire[]> => {
    const boot = requireBootstrap();
    const platform = requirePlatform();
    return resolveAccountRows(boot, platform);
  }),

  /**
   * 对单个账号做零注入密钥扫描。离线（反查不到 pid）或数据库目录缺失时
   * 直接返回失败原因，不发起扫描。
   */
  scanKey: procedure.input(z.object({ uin: z.string().min(1) })).query(async ({ input }) => {
    const boot = requireBootstrap();
    const platform = requirePlatform();
    await ensureUidForUin(boot, input.uin);

    let dbPath: string | null = null;
    try {
      dbPath = platform.ntMsgDbPath(input.uin);
    } catch {
      dbPath = null;
    }
    if (!dbPath) {
      return {
        success: false,
        key: undefined,
        error: `未找到账号 ${input.uin} 的数据库目录（nt_msg.db）`,
      };
    }

    let pid: number | null = null;
    try {
      pid = platform.resolveQqPid(input.uin);
    } catch {
      pid = null;
    }
    if (pid === null) {
      return {
        success: false,
        key: undefined,
        error: `账号 ${input.uin} 当前离线，无法扫描其进程内存中的密钥`,
      };
    }

    // 下面几个闭包里要用的、已经过非空校验的值（闭包不保留 let 的收窄结果）。
    const dbFile = dbPath;
    const qqPid = pid;
    const nt = platform.native.ntHelper;
    const emit = (progress: KeyScanProgress): void => {
      scanProgressBus.emit('progress', {
        uin: input.uin,
        ...progress,
      } satisfies WonderfulToolScanProgressWire);
    };
    // 新产物：扫描时持续推两阶段进度（锚点 → 回退全内存）。老产物没有这个方法，
    // 退回无进度的扫描 —— 面板那边会显示成不确定进度。
    const scanWithProgress = nt.scanKeyFromDatabaseWithProgress?.bind(nt);
    const runInProcess = (): Promise<KeyScanResult> =>
      scanWithProgress
        ? scanWithProgress(dbFile, qqPid, (error, progress) => {
            if (error) return; // 单次投递失败不影响扫描本身
            emit(progress);
          })
        : nt.scanKeyFromDatabase(dbFile, qqPid);

    let result: KeyScanResult;
    try {
      result = await runInProcess();
    } catch (error) {
      return {
        success: false,
        key: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.success) return { ...result, pid };

    // unix 上读别的进程内存（Linux `process_vm_readv` / macOS `task_for_pid`）基本都要
    // root：普通用户跑的内存扫描多半「读不到 / 没候选」而失败。这时像 attach / 抓包
    // 一样弹密码框，起一个 root 子进程重扫一遍。已 root 或非 unix 平台直接返回。
    const isUnix = process.platform === 'linux' || process.platform === 'darwin';
    if (!isUnix || process.geteuid?.() === 0) return { ...result, pid };

    // macOS 的硬门槛：SIP 开着时读内存连 root 都拒，别让人白输一次密码。
    if (process.platform === 'darwin' && readSipEnabled() === true) {
      return { ...result, pid, error: SIP_ENABLED_MESSAGE };
    }

    try {
      const elevated = await scanKeyElevated({
        dbPath: dbFile,
        pid: qqPid,
        runInProcess,
        onProgress: emit,
      });
      return { ...elevated, pid };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const base = result.error ?? '内存扫描未成功';
      return { success: false, key: undefined, pid, error: `${base}；提权重试未完成：${message}` };
    }
  }),

  /**
   * 密钥扫描进度流。`scanKey` 是长任务（强力模式回退扫全内存时更久），面板在
   * 扫描期间挂上它，按 `uin` 过滤自己那次；事后解绑。
   */
  onKeyScanProgress: procedure.subscription(() => {
    return observable<WonderfulToolScanProgressWire>((emit) => {
      const handler = (progress: WonderfulToolScanProgressWire): void => emit.next(progress);
      scanProgressBus.on('progress', handler);
      return () => {
        scanProgressBus.off('progress', handler);
      };
    });
  }),

  /**
   * 让用户挑一个其它设备导出的 `nt_msg.db`。取消时返回 null。
   */
  pickDatabase: procedure.mutation(async (): Promise<string | null> => {
    return getHost().pickFile({ title: '选择其它设备的 nt_msg.db', extensions: ['db'] });
  }),

  /**
   * 读取数据库头部字节（≥192B，实际读 256B）并提取发包用的 db_salt
   * （文件偏移 0x2f..0xaf，与 nt_helper `request_decrypt_key` 一致）。
   */
  peekDatabaseHeader: procedure.input(z.object({ dbPath: z.string().min(1) })).query(
    async ({
      input,
    }): Promise<
      | {
          ok: true;
          /** 头部字节小写 hex，长度 = byteLength * 2。 */
          hex: string;
          /** 实际读到的字节数（文件不足时小于 HEADER_READ_BYTES）。 */
          byteLength: number;
          /** 发包时用的 db_salt 文本（128 个 ASCII hex 字符）。 */
          dbSalt: string;
          /** db_salt 是否为 128 位合法 hex。 */
          saltValid: boolean;
          saltStart: number;
          saltEnd: number;
        }
      | { ok: false; error: string }
    > => {
      if (!existsSync(input.dbPath)) {
        return { ok: false, error: `未找到数据库文件：${input.dbPath}` };
      }
      try {
        const handle = await openFile(input.dbPath, 'r');
        try {
          const buf = Buffer.alloc(HEADER_READ_BYTES);
          const { bytesRead } = await handle.read(buf, 0, HEADER_READ_BYTES, 0);
          const bytes = buf.subarray(0, bytesRead);
          const saltBytes = bytes.subarray(DB_SALT_START, DB_SALT_END);
          const dbSalt = saltBytes.toString('utf8');
          return {
            ok: true,
            hex: bytes.toString('hex'),
            byteLength: bytes.length,
            dbSalt,
            saltValid: /^[0-9a-fA-F]{128}$/.test(dbSalt),
            saltStart: DB_SALT_START,
            saltEnd: Math.min(DB_SALT_END, bytes.length),
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  ),

  // ── ntqq 抓包 ─────────────────────────────────────────────────────────

  /** 抓包后端可用性（Windows 上缺 Npcap 时前端弹窗引导安装）。 */
  captureSupport: procedure.query((): CaptureSupportWire => {
    const platform = requirePlatform();
    const support = platform.native.ntHelper.probeCaptureSupport();
    return { ...support, platform: process.platform };
  }),

  /**
   * 开始抓包：先给该账号登记 SSO 会话物料（拿 d2key），再 armed 网卡会话。
   * 失败原因（未提权 / 缺 Npcap / 账号离线）原样抛出，前端展示。
   */
  captureStart: procedure
    .input(
      z.object({
        uin: z.string().min(1),
        iface: z.string().optional(),
        port: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const platform = requirePlatform();
      const support = platform.native.ntHelper.probeCaptureSupport();
      if (!support.available) {
        throw new Error(support.hint || '抓包后端不可用');
      }
      const { pid, d2Key } = await prepareCaptureSession(input.uin);

      // 本来就是 root（headless web server）或 Windows（Npcap 自己管权限）：本进程直接抓。
      if (support.elevated || process.platform === 'win32') {
        // d2key 显式传：native 的「回退到已登记物料」只在同一实例内有效，显式传参
        // 才能保证和提权路径完全一致（Windows 上少了它就一直只有密文）。
        const session = await platform.native.ntHelper.startCapture(pid, {
          iface: input.iface,
          port: input.port,
          // ⚠️ native 的字段名是 `d2Key`（napi 从 Rust `d2key` 转来）；写成小写
          // `d2key` 会被静默忽略 → 密文全部解不开。
          d2Key: d2Key,
        });
        return { ...session, pid, elevated: false, hasD2Key: Boolean(d2Key) };
      }

      // Electron 不能以 root 运行，而抓包要 root / CAP_NET_RAW —— 把会话放进一个
      // 提权子进程（必要时弹密码框），主进程只做代理。
      const worker = await acquireElevatedCaptureWorker(pid);
      const session = await worker.request<CaptureSessionWire>({
        op: 'start',
        pid,
        iface: input.iface,
        port: input.port,
        d2key: d2Key,
      });
      return { ...session, pid, elevated: true, hasD2Key: Boolean(d2Key) };
    }),

  /**
   * 拉取新增帧（长轮询）：`waitMs` 内一直收集，到窗口结束一次性取回。
   * 前端把上一次返回的 `nextCursor` 原样传回即可续取。
   */
  capturePoll: procedure
    .input(
      z.object({
        pid: z.number().int().positive(),
        cursor: z.number().int().nonnegative().optional(),
        waitMs: z.number().int().min(0).max(10_000).optional(),
      }),
    )
    .query(async ({ input }): Promise<CaptureBatchWire> => {
      const waitMs = input.waitMs ?? 1200;
      // 提权抓包的会话在子进程里 —— 帧要问它要。
      const elevated = elevatedCaptures.get(input.pid);
      if (elevated) {
        return await elevated.request<CaptureBatchWire>({
          op: 'take',
          pid: input.pid,
          cursor: input.cursor,
          waitMs,
        });
      }
      const platform = requirePlatform();
      const batch = await platform.native.ntHelper.takeFrames(input.pid, {
        cursor: input.cursor,
        waitMs,
      });
      return {
        frames: batch.frames.map(toCaptureFrameWire),
        nextCursor: batch.nextCursor,
        dropped: batch.dropped,
      };
    }),

  /** 停止抓包并释放网卡会话。会话已不存在时返回 null（前端幂等停止）。 */
  captureStop: procedure
    .input(z.object({ pid: z.number().int().positive() }))
    .mutation(async ({ input }): Promise<CaptureStatsWire | null> => {
      // 提权路径：先问子进程要统计，再把子进程送走（它是这次会话专用的）。
      const elevated = elevatedCaptures.get(input.pid);
      if (elevated) {
        elevatedCaptures.delete(input.pid);
        try {
          return await elevated.request<CaptureStatsWire>({ op: 'stop', pid: input.pid });
        } catch {
          return null; // 幂等停止：子进程已经没了也无所谓。
        } finally {
          elevated.dispose();
        }
      }
      const platform = requirePlatform();
      try {
        return await platform.native.ntHelper.stopCapture(input.pid);
      } catch {
        return null;
      }
    }),

  /**
   * 把当前抓到的帧导出成文件（桌面端弹保存框落盘；Web 端写进导出目录并回带
   * 下载地址）。`frames` 由渲染层把当前列表（或过滤后可见的列表）原样递过来，
   * 主进程按与面板一致的 protobuf / JCE 解析口径补上 `decoded` 树再序列化。
   *
   * 格式：
   *   - `json`  —— 一份自包含的文档（meta + frames），适合直接看 / 发给别人；
   *   - `jsonl` —— 每行一帧，方便用 jq / grep 流式筛。
   */
  captureExport: procedure
    .input(
      z.object({
        /** 建议文件名主体（不含扩展名），如 `capture_14000_20261008-153012`。 */
        name: z.string().min(1).max(120).optional(),
        /** 账号 / 环境说明，只写进 meta，不参与解析。 */
        uin: z.string().max(64).optional(),
        iface: z.string().max(120).optional(),
        port: z.string().max(120).optional(),
        format: z.enum(CAPTURE_EXPORT_FORMATS).default('json'),
        frames: z.array(captureExportFrameSchema).max(20_000),
      }),
    )
    .mutation(async ({ input }): Promise<CaptureExportResult> => {
      if (input.frames.length === 0) {
        return { saved: false, error: '没有可导出的帧' };
      }

      const frames = input.frames.map((f) => {
        // 与面板「解密数据」栏一致：优先正文，退回完整明文。
        const payloadHex = f.bodyHex || f.plainHex;
        const payload = payloadHex ? Buffer.from(payloadHex, 'hex') : new Uint8Array(0);
        const decoded = decodeCaptureBody(payload);
        return {
          cursor: f.cursor,
          time: new Date(f.ts).toISOString(),
          ts: f.ts,
          direction: f.direction,
          directionLabel: f.direction === 'c2s' ? '客户端 → 服务端' : '服务端 → 客户端',
          proto: f.proto,
          encryptType: f.encryptType,
          encrypt: captureEncryptLabel(f.encryptType),
          seq: f.seq,
          cmd: f.cmd,
          rawBytes: Math.floor(f.rawHex.length / 2),
          plainBytes: Math.floor(f.plainHex.length / 2),
          bodyBytes: Math.floor(f.bodyHex.length / 2),
          /** 解析结果：`{kind, json}`；解不开 / 无正文时为 null。 */
          decoded: decoded ? { kind: decoded.kind, json: decoded.json } : null,
          /** 原始 / 解密 / 正文的十六进制，便于二次分析。 */
          rawHex: f.rawHex,
          plainHex: f.plainHex,
          bodyHex: f.bodyHex,
        };
      });

      const meta = {
        tool: 'weq-wonderful-tools-capture',
        version: 1,
        exportedAt: new Date().toISOString(),
        uin: input.uin ?? null,
        iface: input.iface ?? null,
        port: input.port ?? null,
        frameCount: frames.length,
      };

      let bytes: Buffer;
      if (input.format === 'jsonl') {
        const lines = frames.map((f) => JSON.stringify(f));
        bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
      } else {
        bytes = Buffer.from(JSON.stringify({ meta, frames }, null, 2), 'utf8');
      }

      const defaultName = `${safeCaptureName(
        input.name ?? '',
        `capture_${captureFileStamp()}`,
      )}.${input.format}`;

      try {
        const target = await getHost().pickSaveTarget({
          defaultName,
          extension: input.format,
        });
        if (!target) return { saved: false, canceled: true };
        await writeFile(target.path, bytes);
        return {
          saved: true,
          path: target.path,
          downloadId: target.downloadId,
          bytes: bytes.length,
          frames: frames.length,
        };
      } catch (error) {
        return {
          saved: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),

  /**
   * 「其它设备密钥」：按 bootstrap 的实例取密钥流程，但跳过注入，
   * 直接向在线 QQ 发 OIDB 0xCDE_2。db_salt 由 TS 侧从 dbPath 头部自行
   * 提取并发包；这里逐个尝试在线实例，第一个成功即返回。
   */
  fetchOtherDeviceKey: procedure
    .input(z.object({ dbPath: z.string().min(1) }))
    .mutation(
      async ({
        input,
      }): Promise<
        { success: true; key: string; pid: number } | { success: false; error: string }
      > => {
        const boot = requireBootstrap();
        const platform = requirePlatform();
        if (!existsSync(input.dbPath)) {
          return { success: false, error: `未找到数据库文件：${input.dbPath}` };
        }
        if (boot.userConfig.getSettings().autoAttachQq === false) {
          return {
            success: false,
            error: '已开启完全离线模式（自动读取 QQ 内存 已关闭），无法向在线 QQ 请求密钥。',
          };
        }
        const instances = await resolveOnlineInstances(boot, platform);
        if (instances.length === 0) {
          return {
            success: false,
            error: '没有可用的在线 QQ 实例：请先登录 QQ 并保持在线（或先用 WeQ 打开一个账号）',
          };
        }
        let lastError: string | null = null;
        for (const { pid, uin, uid } of instances) {
          try {
            // 该 pid 首次发包前必须登记会话物料；同机 QQ 已在维持会话，我们只
            // 借凭据组帧（不建连、不上线）。身份里的 uin / uid 来自 login.db，
            // guid 从 QQ 数据根离线算 —— 都独立于用户当前打开的是哪个账号。
            const guid = resolveDeviceGuid(platform.native.ntHelper, platform);
            const { registered } = await attachAndRegisterSsoSession(
              platform.native.ntHelper,
              platform,
              boot.attachHook,
              pid,
              uin,
              { uid, guid },
            );
            if (!registered) {
              lastError =
                '已读取 QQ 进程内存，但会话身份不完整（缺少账号 uid 或设备 guid），无法向在线 QQ 请求密钥。';
              continue;
            }
            const key = await requestDecryptKeyFromInstance(
              platform.native.ntHelper,
              pid,
              input.dbPath,
            );
            return { success: true, key, pid };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          success: false,
          error: lastError
            ? humanizeKeyFetchError(lastError)
            : '获取密钥失败：所有在线实例均未返回密钥（数据库可能不属于任何在线账号）',
        };
      },
    ),
});

export type WonderfulToolsRouter = typeof wonderfulToolsRouter;
