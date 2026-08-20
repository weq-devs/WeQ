/**
 * Background database health checks for the currently opened QQ account,
 * plus damage-report writing and one-click feedback bundling (logs +
 * settings.db + key/algo config + report into a cache-dir folder).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type AccountSession, algoFor } from '@weq/account';
import type { DatabaseAlgorithms } from '@weq/native';
import { getNativeLogRoot } from '@weq/native';
import type { Platform } from '@weq/platform';
import { getLogDir, getLogger } from '../common/logger';
import { getHost } from '../common/host';

export const ACCOUNT_HEALTH_DATABASES = [
  'nt_msg.db',
  'emoji.db',
  'group_msg_fts.db',
  'buddy_msg_fts.db',
  'misc.db',
  'files_in_chat.db',
  'group_info.db',
  'profile_info.db',
  'file_assistant.db',
] as const;

export interface DbHealthFailure {
  dbName: string;
  dbPath: string;
  corruptedTables: string[];
  error?: string;
}

export async function checkAccountDatabaseHealth(
  session: AccountSession,
  platform: Platform,
): Promise<DbHealthFailure[]> {
  const dbDir = platform.ntDbDir(session.context.uin) ?? dirname(session.msgDbPath);
  const results = await Promise.all(
    ACCOUNT_HEALTH_DATABASES.map((dbName) =>
      checkOneDatabase(session, platform, dbName, join(dbDir, dbName)),
    ),
  );
  return results.filter((item): item is DbHealthFailure => item !== null);
}

export function formatDbHealthFailures(failures: DbHealthFailure[]): string[] {
  const details: string[] = [];

  for (const failure of failures) {
    if (failure.error) {
      details.push(`${failure.dbName} 无法完成健康检查：${failure.error}`);
      continue;
    }

    if (failure.corruptedTables.length === 0) {
      details.push(`${failure.dbName} 数据库整体损坏，未定位到具体表`);
      continue;
    }

    for (const table of failure.corruptedTables) {
      details.push(`${failure.dbName}.${table} 表损坏`);
    }
  }

  return details;
}

async function checkOneDatabase(
  session: AccountSession,
  platform: Platform,
  dbName: string,
  dbPath: string,
): Promise<DbHealthFailure | null> {
  if (!existsSync(dbPath)) {
    return {
      dbName,
      dbPath,
      corruptedTables: [],
      error: '文件不存在',
    };
  }

  try {
    const algo = algoFor(session.context, dbPath);
    if (!algo) {
      return {
        dbName,
        dbPath,
        corruptedTables: [],
        error: '无加密算法信息，跳过检查',
      };
    }
    const result = await platform.native.ntHelper.checkDatabaseHealth(
      dbPath,
      session.context.dbKey,
      algo,
    );
    if (result.healthy) return null;
    return {
      dbName,
      dbPath,
      corruptedTables: result.corruptedTables,
    };
  } catch (e) {
    return {
      dbName,
      dbPath,
      corruptedTables: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---- damage report ----

/** File-name prefix of damage reports written into the log dir. */
export const DB_HEALTH_REPORT_PREFIX = 'db_health_report_';

export interface DbHealthReportInput {
  failures: DbHealthFailure[];
  uin: string;
  dbDir: string;
  /** Set when the health check itself crashed before completing. */
  checkError?: string;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function stampParts(d = new Date()): { date: string; time: string; ts: string } {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    ts: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

export function renderDbHealthReportMarkdown(input: DbHealthReportInput): string {
  const { date, time } = stampParts();
  const lines: string[] = [];
  lines.push('# WeQ 数据库健康检查报告');
  lines.push('');
  lines.push(`- 生成时间：${date} ${time}`);
  lines.push(`- 账号：${input.uin}`);
  lines.push(`- 数据库目录：${input.dbDir}`);
  lines.push(`- WeQ 版本：${getHost().appVersion()}`);
  lines.push('');
  lines.push('## 检查结果');
  lines.push('');
  if (input.checkError) {
    lines.push(`- 状态：健康检查未能完成（${input.checkError}）`);
  } else if (input.failures.length === 0) {
    lines.push('- 状态：未检出损坏');
  } else {
    lines.push(`- 状态：检出数据库损坏（${input.failures.length} 项失败）`);
  }
  lines.push('');
  lines.push('### 失败明细');
  lines.push('');
  if (input.failures.length === 0 && !input.checkError) {
    lines.push('（无）');
  } else {
    for (const f of input.failures) {
      if (f.error) {
        lines.push(`- ${f.dbName}：无法完成健康检查（${f.error}）`);
      } else if (f.corruptedTables.length === 0) {
        lines.push(`- ${f.dbName}：数据库整体损坏，未定位到具体表`);
      } else {
        lines.push(`- ${f.dbName}：${f.corruptedTables.map((t) => `${t} 表损坏`).join('、')}`);
      }
    }
  }
  lines.push('');
  lines.push('## 建议修复方案');
  lines.push('');
  lines.push(
    'QQ NT 数据库在 SQLite 文件前带有一个 1024 字节的自定义头。数据库损坏时，可尝试以下步骤抢救数据：',
  );
  lines.push('');
  lines.push('1. 移除 1024 字节自定义头（从第 1025 字节开始截取）：');
  lines.push('');
  lines.push('   ```bash');
  lines.push('   tail -c +1025 nt_msg.db > nt_msg_stripped.db');
  lines.push('   ```');
  lines.push('');
  lines.push(
    '2. 用 Windows 版 sqlcipher 解密并导出为 SQL 文件（密钥见反馈包中的 db_key_and_algos.json）：',
  );
  lines.push('');
  lines.push('   ```');
  lines.push('   sqlcipher nt_msg_stripped.db');
  lines.push('   PRAGMA key="<dbKey>";');
  lines.push('   PRAGMA cipher_migrate;');
  lines.push('   .output nt_msg.sql');
  lines.push('   .dump');
  lines.push('   ```');
  lines.push('');
  lines.push(
    '3. 用 msys2 将 SQL 导入生成新的 db 文件（sed 会把出错中止的 ROLLBACK 改成 COMMIT，跳过损坏的行）：',
  );
  lines.push('');
  lines.push('   ```bash');
  lines.push(
    "   cat nt_msg.sql | sed -e 's|^ROLLBACK;\\( -- due to errors\\)*$|COMMIT;|g' | sqlite3 nt_msg.db",
  );
  lines.push('   ```');
  lines.push('');
  lines.push(
    '4. 修复完成后，用 WeQ 的「静态目录」方案（首页 → 新的开始 → 静态目录）打开修复后的数据库目录继续使用。',
  );
  lines.push('');
  lines.push('> 注意：解密密钥只存在于反馈包 db_key_and_algos.json 中，请勿公开分享该文件。');
  return lines.join('\n');
}

/**
 * Write a damage report into `targetDir` (defaults to the app log dir).
 * Returns the absolute file path, or null when logging isn't configured yet
 * or the write failed.
 */
export function writeDbHealthReport(input: DbHealthReportInput, targetDir?: string): string | null {
  const dir = targetDir ?? getLogDir();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${DB_HEALTH_REPORT_PREFIX}${stampParts().ts}.md`);
    writeFileSync(file, renderDbHealthReportMarkdown(input), 'utf8');
    return file;
  } catch (e) {
    getLogger().warn('failed to write db health report', {
      event: 'db-report-write-failed',
      targetDir: dir,
      ...(e instanceof Error ? { error: e.message } : { error: String(e) }),
    });
    return null;
  }
}

/** Newest existing damage report under the log dir, if any. */
export function findLatestDbHealthReport(): string | null {
  const dir = getLogDir();
  if (!dir) return null;
  try {
    const names = readdirSync(dir).filter(
      (name) => name.startsWith(DB_HEALTH_REPORT_PREFIX) && name.endsWith('.md'),
    );
    if (names.length === 0) return null;
    names.sort();
    return join(dir, names[names.length - 1]!);
  } catch {
    return null;
  }
}

// ---- one-click feedback bundling ----

/** Where the user wants to report the damage: GitHub Issues or the QQ group. */
export type DbDamageFeedbackTarget = 'github' | 'qqgroup';

export interface DbDamageFeedbackInput {
  /** Account uin — used in the bundle folder name. */
  uin: string;
  /** SQLCipher key for this account's databases. */
  dbKey: string;
  /** Per-database cipher algorithms, keyed by filename. */
  algos: Record<string, DatabaseAlgorithms>;
  /** Directory holding the QQ databases (settings.db lives here). */
  dbDir: string;
  /** Folder inside the cache dir where the per-report bundle is created. */
  cacheDir: string;
  /** Damage report to copy in; falls back to the newest report in the log dir. */
  reportPath?: string | null;
}

export interface DbDamageFeedbackResult {
  folder: string;
  files: string[];
  errors: string[];
}

/** Copy `src` into `destDir`; failures are recorded in `errors` instead of thrown. */
function tryCopy(src: string, destDir: string, errors: string[], tag: string): string | null {
  if (!src) return null;
  if (!existsSync(src)) {
    errors.push(`${tag}：源文件不存在（${src}）`);
    return null;
  }
  try {
    const dest = join(destDir, basename(src));
    copyFileSync(src, dest);
    return dest;
  } catch (e) {
    errors.push(`${tag}：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Create a timestamped bundle folder under `cacheDir` and copy everything a
 * maintainer needs to diagnose the damage: today's app logs + native
 * (nt_helper / native_loader) logs, `settings.db` (no sensitive info), the
 * key + algo config, and the damage report. Returns the folder + copied files.
 */
export function collectDbDamageFeedback(input: DbDamageFeedbackInput): DbDamageFeedbackResult {
  const logger = getLogger().child({ scope: 'db-damage-feedback', accountUin: input.uin });
  const errors: string[] = [];
  const files: string[] = [];

  const folder = join(input.cacheDir, `db-damage-feedback-${input.uin}-${stampParts().ts}`);
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw new Error(`无法创建反馈目录：${e instanceof Error ? e.message : String(e)}`);
  }

  // 今天的应用日志 + 原生（nt_helper / native_loader）日志。
  const today = stampParts().date;
  const scannedDirs = new Set<string>();
  const copyTodayLogs = (dir: string | null): void => {
    if (!dir || scannedDirs.has(dir)) return;
    scannedDirs.add(dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      errors.push(`读取日志目录失败（${dir}）：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const name of names) {
      if (!name.startsWith(today) || !name.endsWith('.log')) continue;
      const dest = tryCopy(join(dir, name), folder, errors, '日志');
      if (dest) files.push(dest);
    }
  };
  copyTodayLogs(getLogDir());
  copyTodayLogs(getNativeLogRoot());

  // settings.db —— 纯本地配置，无敏感信息。
  const settingsDest = tryCopy(join(input.dbDir, 'settings.db'), folder, errors, 'settings.db');
  if (settingsDest) files.push(settingsDest);

  // 密钥 + 算法配置（敏感，仅供修复与排查）。
  try {
    const keyFile = join(folder, 'db_key_and_algos.json');
    writeFileSync(
      keyFile,
      JSON.stringify({ uin: input.uin, dbKey: input.dbKey, algos: input.algos }, null, 2),
      'utf8',
    );
    files.push(keyFile);
  } catch (e) {
    errors.push(`写入密钥配置失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 检查报告：优先复用日志目录里最新一份；没有就现场生成一份到反馈目录。
  const reportSource =
    input.reportPath && existsSync(input.reportPath)
      ? input.reportPath
      : findLatestDbHealthReport();
  if (reportSource) {
    const dest = tryCopy(reportSource, folder, errors, '检查报告');
    if (dest) files.push(dest);
  } else {
    const fresh = writeDbHealthReport(
      {
        failures: [],
        uin: input.uin,
        dbDir: input.dbDir,
        checkError: '反馈时未找到已有检查报告，未能生成新的完整报告',
      },
      folder,
    );
    if (fresh) files.push(fresh);
  }

  logger.info('collected db damage feedback bundle', {
    event: 'db-damage-feedback-collected',
    folder,
    fileCount: files.length,
    errorCount: errors.length,
  });
  return { folder, files, errors };
}
