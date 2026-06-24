/**
 * Background database health checks for the currently opened QQ account.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

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
    const result = await platform.native.ntHelper.checkDatabaseHealth(
      dbPath,
      session.context.dbKey,
      session.context.algo,
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
