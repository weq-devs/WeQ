/**
 * 修复历史与备份保留策略。
 *
 * 历史是"后悔"的唯一依据，所以它有两个刻意的性质：
 *
 *   1. **记录宁可留着也不删** —— 备份文件被保留策略清掉之后，记录仍在，只是打上
 *      `purgedAt`（界面据此把"回滚"置灰并说明原因）。用户问"上次修了什么、什么时候
 *      修的"永远有答案。
 *   2. **读盘永不抛** —— 复用 `JsonStore`（缺失 / 损坏 / 结构不符一律回落初始值）。
 *      历史坏了不该让修复功能整个崩掉，最坏是这次记录重来。
 *
 * 备份只保留最近 `keep` 份（默认 3）：一次修复的备份 ≈ 一个库（nt_msg.db 约 90MB），
 * 无上限增长迟早吃掉用户磁盘。
 */

import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonStore } from '../../common/json_store';
import { fileBytes, removeDirQuietly } from './files';
import type { DbRepairPaths } from './paths';
import type { DbRepairRecord } from './types';

/** 默认保留的备份份数。 */
export const DEFAULT_BACKUP_KEEP = 3;

interface HistoryFile {
  /** 结构版本；将来若改字段形状可据此迁移，现在是 1。 */
  version: number;
  records: DbRepairRecord[];
}

function isRecordLike(value: unknown): value is DbRepairRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<DbRepairRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.at === 'string' &&
    typeof record.uin === 'string' &&
    typeof record.dbPath === 'string' &&
    typeof record.dbName === 'string'
  );
}

function normalizeHistory(raw: unknown): HistoryFile {
  const parsed = (raw ?? {}) as Partial<HistoryFile>;
  const records = Array.isArray(parsed.records) ? parsed.records.filter(isRecordLike) : [];
  return { version: 1, records };
}

export class DbRepairHistory {
  private store: JsonStore<HistoryFile>;

  constructor(private readonly paths: DbRepairPaths) {
    this.store = new JsonStore<HistoryFile>(paths.history, () => ({ version: 1, records: [] }), {
      normalize: normalizeHistory,
      pretty: true,
    });
  }

  /** 空间清理也会更新同一份记录，业务入口重新加载，避免旧内存覆盖清理结果。 */
  reload(): void {
    this.store = new JsonStore<HistoryFile>(
      this.paths.history,
      () => ({ version: 1, records: [] }),
      {
        normalize: normalizeHistory,
        pretty: true,
      },
    );
  }

  /** 全部记录，**最新在前**。 */
  list(): DbRepairRecord[] {
    return [...this.store.data.records]
      .reverse()
      .sort((left, right) => right.at.localeCompare(left.at));
  }

  find(id: string): DbRepairRecord | undefined {
    return this.store.data.records.find((record) => record.id === id);
  }

  add(record: DbRepairRecord): DbRepairRecord {
    // 同 id 覆盖（理论上不会发生：id 带到秒的时间戳 + 库名）。
    this.store.data.records = [
      ...this.store.data.records.filter((item) => item.id !== record.id),
      record,
    ];
    this.store.save();
    return record;
  }

  update(id: string, patch: Partial<DbRepairRecord>): DbRepairRecord | undefined {
    const index = this.store.data.records.findIndex((record) => record.id === id);
    if (index < 0) return undefined;
    const next = { ...this.store.data.records[index]!, ...patch };
    this.store.data.records[index] = next;
    this.store.save();
    return next;
  }

  /**
   * 最后一条引用先清除备份再删除记录；失败时仍能从同一条记录重试。
   */
  remove(id: string): boolean {
    this.store.assertReadable();
    const record = this.find(id);
    if (!record) return false;
    const records = this.store.data.records.filter((item) => item.id !== id);
    const path = record.backupPath;
    if (path && !records.some((item) => item.backupPath === path)) {
      try {
        rmSync(dirname(path), { recursive: true, force: true });
        if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('数据库备份仍存在');
      } catch (error) {
        throw new Error('无法清理数据库备份，修复记录已保留。请检查备份位置后重试。', {
          cause: error,
        });
      }
    }
    this.store.replace({ ...this.store.data, records }, true);
    return true;
  }

  /**
   * 只保留最近 `keep` 份**备份仍在**的记录，其余删目录 + 标 `purgedAt`。
   *
   * 返回被清理的记录 id（供日志/界面提示）。当前正在进行的修复不受影响：它记录还没
   * 落盘，而清理发生在记录写入之后。
   */
  pruneBackups(keep: number = DEFAULT_BACKUP_KEEP): string[] {
    if (keep < 0) return [];
    const withBackup = this.list().filter(
      (record) => record.backupPath !== null && record.purgedAt === undefined,
    );
    // 同一次维护的重试记录可以共用备份；保留份数按文件而不是报告数计算。
    const backupPaths = [...new Set(withBackup.map((record) => record.backupPath!))];

    const purged: string[] = [];
    for (const backupPath of backupPaths.slice(keep)) {
      removeDirQuietly(dirname(backupPath));
      if (existsSync(backupPath)) continue;
      for (const record of withBackup.filter((item) => item.backupPath === backupPath)) {
        const index = this.store.data.records.findIndex((item) => item.id === record.id);
        this.store.data.records[index] = {
          ...record,
          purgedAt: new Date().toISOString(),
        };
        purged.push(record.id);
      }
    }
    if (purged.length > 0) this.store.save();
    return purged;
  }

  /** 这份记录对应的备份文件还在不在。 */
  backupExists(record: DbRepairRecord): boolean {
    if (!record.backupPath) return false;
    return fileBytes(record.backupPath) !== null;
  }

  /** 先确认文件确实删除，再标记记录；删除失败不得让界面误以为备份已清除。 */
  deleteBackup(id: string, at = new Date().toISOString()): { removed: boolean } {
    const store = new JsonStore<HistoryFile>(
      this.paths.history,
      () => ({ version: 1, records: [] }),
      {
        normalize: normalizeHistory,
        pretty: true,
        strict: true,
      },
    );
    const record = store.data.records.find((record) => record.id === id);
    if (!record) throw new Error('找不到修复记录，请刷新后重试');
    if (!record.backupPath) return { removed: false };
    rmSync(dirname(record.backupPath), { recursive: true, force: true });
    if (existsSync(record.backupPath)) throw new Error('数据库备份仍存在，未更新修复记录');
    store.replace({
      ...store.data,
      records: store.data.records.map((item) =>
        item.backupPath === record.backupPath ? { ...item, purgedAt: at } : item,
      ),
    });
    this.store = store;
    return { removed: true };
  }
}
