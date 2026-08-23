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
 *                  bootstrap 的实例取密钥流程（唯一区别：不注入，直接调
 *                  nt_helper 的 `requestDecryptKey`）向在线 QQ 要密钥。
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
import { existsSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import type { LoginAccount } from '@weq/native';
import { getHost } from '@weq/service';
import { requireBootstrap, requirePlatform } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { ensureUidForUin } from './bootstrap';

/** 展示给用户的数据库头部字节数：≥192 字节，取 16 的倍数整行展示。 */
const HEADER_READ_BYTES = 192;
/** nt_helper 发包前从数据库头提取的 db_salt 所在字节区间（含头不含尾）。 */
const DB_SALT_START = 0x2f;
const DB_SALT_END = 0xaf;

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

/** 汇总当前在线的 QQ 实例 pid（按账号反查，去重）。 */
async function resolveOnlinePids(
  boot: ReturnType<typeof requireBootstrap>,
  platform: ReturnType<typeof requirePlatform>,
): Promise<number[]> {
  const rows = await resolveAccountRows(boot, platform);
  const seen = new Set<number>();
  const pids: number[] = [];
  for (const row of rows) {
    if (row.pid !== null && !seen.has(row.pid)) {
      seen.add(row.pid);
      pids.push(row.pid);
    }
  }
  return pids;
}

/** 把实例取密钥的失败原因转成用户可读文案（OIDB 1006 = 无权获取）。 */
function humanizeKeyFetchError(error: string): string {
  if (error.includes('1006')) {
    return `无权获取该数据库的密钥：${error}`;
  }
  return error;
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

    try {
      const result = await platform.native.ntHelper.scanKeyFromDatabase(dbPath, pid);
      return { ...result, pid };
    } catch (error) {
      return {
        success: false,
        key: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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

  /**
   * 「其它设备密钥」：按 bootstrap 的实例取密钥流程，但跳过注入，
   * 直接调 nt_helper 的 `requestDecryptKey(pid, dbPath)`。db_salt 由
   * native 侧从 dbPath 头部自行提取并发包；这里逐个尝试在线实例，
   * 第一个成功即返回。
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
        const pids = await resolveOnlinePids(boot, platform);
        if (pids.length === 0) {
          return {
            success: false,
            error: '没有可用的在线 QQ 实例：请先登录 QQ 并保持在线（或先用 WeQ 打开一个账号）',
          };
        }
        let lastError: string | null = null;
        for (const pid of pids) {
          try {
            const key = await platform.native.ntHelper.requestDecryptKey(pid, input.dbPath);
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
