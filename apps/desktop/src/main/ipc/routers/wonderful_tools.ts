/**
 * 妙妙工具 router — 主窗口「更多功能 → 妙妙工具」的后端。
 *
 *   - `overview`   遍历 login.db 的全部历史账号，逐个解析数据库目录
 *                  (`nt_msg.db`) 与在线状态（pid 反查），供密钥扫描面板
 *                  点亮/置灰账号卡片。
 *   - `scanKey`    对单个账号做零注入内存扫描（nt_helper 的
 *                  `scanKeyFromDatabase`），以该账号自己的 `nt_msg.db`
 *                  作为候选密钥的验证过滤。
 *
 * 平台差异（win32 / linux）由 `platform.resolveQqPid` 封装：
 *   - win32: Restart Manager 句柄枚举
 *   - linux: /proc fcntl 写锁持有者 + uid 哈希目录解析
 */

import { z } from 'zod';
import type { LoginAccount } from '@weq/native';
import { requireBootstrap, requirePlatform } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { ensureUidForUin } from './bootstrap';

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

export const wonderfulToolsRouter = router({
  /**
   * 列出全部历史账号 + 各自的在线状态。逐个账号容错：单个账号探测失败
   * 不会拖垮整个列表。
   */
  overview: procedure.query(async (): Promise<WonderfulToolAccountWire[]> => {
    const boot = requireBootstrap();
    const platform = requirePlatform();
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
});

export type WonderfulToolsRouter = typeof wonderfulToolsRouter;
