/**
 * 修复相关的路径与时间戳。
 *
 * 目录布局（全部在 WeQ 缓存里，**不往 QQ 目录塞任何东西**，除了替换那一刻的临时产物）：
 *
 * ```
 * <cacheDir>/db_repair/<accountConfigId>/
 * ├─ history.json                 # 记录数组
 * ├─ backups/<stamp>/<dbName>     # 只有目标库这一份（+ meta.json）
 * ├─ reports/repair-<stamp>.md    # 人读报告
 * └─ work/                        # native 的 workDir（明文中间件，native 自清）
 * ```
 *
 * 为什么按 `accountConfigId(uin, dataDir)` 分目录：同一个 uin 可以对应多个数据目录
 * （QQ 换了安装位置、或者用户导入的静态备份目录），它们的损坏情况与备份必须分开 ——
 * 与宽容级别用的是同一个主键。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountConfigId } from '../user_config';

/** 缓存里存放修复数据的顶层目录名。 */
export const DB_REPAIR_CACHE_DIR = 'db_repair';

/** 一个账号在缓存里的修复根目录。 */
export function dbRepairRoot(
  cacheDir: (...segments: string[]) => string,
  uin: string,
  dataDir: string | null,
): string {
  return cacheDir(DB_REPAIR_CACHE_DIR, accountConfigId(uin, dataDir));
}

/** 路径碎片，避免各处再拼字符串。 */
export interface DbRepairPaths {
  root: string;
  history: string;
  workDir: string;
  reportsDir: string;
  backupsDir: string;
  /** 某一次修复的备份目录。 */
  backupDir(stamp: string): string;
  /** 某一次修复的备份文件。 */
  backupFile(stamp: string, dbName: string): string;
  /** 某一次修复的备份元数据。 */
  backupMetaFile(stamp: string): string;
  /** 某一次修复的人读报告。 */
  reportFile(stamp: string): string;
}

export function dbRepairPaths(root: string): DbRepairPaths {
  const backupsDir = join(root, 'backups');
  const reportsDir = join(root, 'reports');
  return {
    root,
    history: join(root, 'history.json'),
    workDir: join(root, 'work'),
    reportsDir,
    backupsDir,
    backupDir: (stamp) => join(backupsDir, stamp),
    backupFile: (stamp, dbName) => join(backupsDir, stamp, dbName),
    backupMetaFile: (stamp) => join(backupsDir, stamp, 'meta.json'),
    reportFile: (stamp) => join(reportsDir, `repair-${stamp}.md`),
  };
}

/**
 * 替换用的临时产物路径 —— **必须与目标库同目录**（同分区的 `rename` 才是原子的；
 * 跨盘 rename 会直接 `EXDEV` 失败）。以 `.` 开头，尽量不打扰用户对目录的观感。
 */
export function productTempPath(dbDir: string, dbName: string, stamp: string): string {
  return join(dbDir, `.${dbName}.weq-repair-${stamp}`);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * 解析一个账号的**库目录**（存放 `.db` 的那个目录）。
 *
 * 顺序很关键：
 *
 * 1. **账号配置里的 `dataDir` 优先**。静态账号（导入的目录）、换过安装位置的账号，
 *    它的库都不在 QQ 的默认位置上；只认 platform 会解析到**另一个账号**的库 ——
 *    那是这个功能最坏的失败方式。两种布局都认：`dataDir` 直接是库目录，或者它的
 *    子目录 `nt_db`（在线账号的 `nt_qq_<hash>` 就是后者）。
 * 2. 再回退 `platform.ntDbDir(uin)`，最后用 `ntMsgDbPath(uin)` 的父目录兜底。
 *
 * `probe` 与 `exists` 都注入，所以这段逻辑能离线单测（它决定"修哪个库"，值得钉住）。
 */
export function resolveAccountDbDir(
  platform: { ntDbDir(uin: string): string | null; ntMsgDbPath(uin: string): string | null },
  uin: string,
  dataDir: string | null,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (dataDir) {
    if (exists(join(dataDir, 'nt_msg.db'))) return dataDir;
    const nested = join(dataDir, 'nt_db');
    if (exists(join(nested, 'nt_msg.db'))) return nested;
  }
  const byPlatform = platform.ntDbDir(uin);
  if (byPlatform) return byPlatform;
  try {
    const msgPath = platform.ntMsgDbPath(uin);
    return msgPath ? dirname(msgPath) : null;
  } catch {
    return null;
  }
}

/** 记录用时间戳：`20260920-053012`（本地时间，文件名可读、字典序即时间序）。 */
export function makeStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
