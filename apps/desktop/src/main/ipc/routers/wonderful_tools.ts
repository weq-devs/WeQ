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
import { readSipEnabled, type KeyScanProgress, type KeyScanResult } from '@weq/native';
import {
  rvNodesToJson,
  tryDecodeAfterLengthPrefix,
  tryDecodeJce,
  tryDecodeProtobuf,
} from '@weq/codec/raw';
import {
  attachAndRegisterSsoSession,
  getHost,
  requestDecryptKeyFromInstance,
  resolveDeviceGuid,
} from '@weq/service';
import { requireBootstrap, requirePlatform } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { ensureUidForUin } from './bootstrap';
import type { CaptureBatchWire, CaptureStatsWire } from '../../capture_protocol';
import {
  probeCaptureBackend,
  resolveAccountRows,
  resolveOnlineInstances,
  startAccountCapture,
  stopAccountCapture,
  takeAccountFrames,
  type AccountCaptureRow,
} from '../../capture_session';

// 退出时清理提权抓包子进程 —— 保持旧出口名不变（main/index.ts 依赖它）。
export { disposeElevatedCaptures } from '../../capture_session';
import { SIP_ENABLED_MESSAGE } from '../../attach_elevation';
import { scanKeyElevated } from '../../key_scan_elevation';

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

/** 一个账号在密钥扫描面板里的状态行（与抓包会话共用同一份账号行结构）。 */
export type WonderfulToolAccountWire = AccountCaptureRow;

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

/** 把实例取密钥的失败原因转成用户可读文案（OIDB 1006 = 无权获取）。 */
function humanizeKeyFetchError(error: string): string {
  if (error.includes('1006')) {
    return `无权获取该数据库的密钥：${error}`;
  }
  return error;
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

  /**
   * 抓包后端可用性（Windows 上缺 Npcap 时前端弹窗引导安装）。
   *
   * 走 `probeCaptureBackend()` 而不是直接调 native —— 老产物里没有
   * `probeCaptureSupport` 时也返回一条带引导的「不可用」，别把 TypeError 抛给界面。
   */
  captureSupport: procedure.query((): CaptureSupportWire => {
    return { ...probeCaptureBackend(), platform: process.platform };
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
      const handle = await startAccountCapture(input.uin, {
        iface: input.iface,
        port: input.port,
      });
      return {
        ...handle.session,
        pid: handle.pid,
        elevated: handle.elevated,
        hasD2Key: handle.hasD2Key,
      };
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
      return await takeAccountFrames(input.pid, {
        cursor: input.cursor,
        waitMs: input.waitMs ?? 1200,
      });
    }),

  /** 停止抓包并释放网卡会话。会话已不存在时返回 null（前端幂等停止）。 */
  captureStop: procedure
    .input(z.object({ pid: z.number().int().positive() }))
    .mutation(async ({ input }): Promise<CaptureStatsWire | null> => {
      return await stopAccountCapture(input.pid);
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
