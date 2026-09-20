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
  private readonly store: JsonStore<HistoryFile>;

  constructor(paths: DbRepairPaths) {
    this.store = new JsonStore<HistoryFile>(paths.history, () => ({ version: 1, records: [] }), {
      normalize: normalizeHistory,
      pretty: true,
    });
  }

  /** 全部记录，**最新在前**。 */
  list(): DbRepairRecord[] {
    return [...this.store.data.records].sort((left, right) => right.at.localeCompare(left.at));
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
   * 彻底删掉一条记录（带它自己的备份目录，由调用方清）。
   *
   * 与 `pruneBackups` 的区别：那边只清备份、记录留着（打 `purgedAt`），因为"上次修了
   * 什么"本身有价值；这里是用户主动不要这条历史了 —— 记录与备份一起消失。备份目录的
   * 删除交给 service（这里只碰 JSON 状态，方便离线单测）。
   */
  remove(id: string): boolean {
    const before = this.store.data.records.length;
    this.store.data.records = this.store.data.records.filter((record) => record.id !== id);
    if (this.store.data.records.length === before) return false;
    this.store.save();
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
    const withBackup = this.store.data.records
      .filter((record) => record.backupPath !== null && record.purgedAt === undefined)
      .sort((left, right) => right.at.localeCompare(left.at));

    const purged: string[] = [];
    for (const record of withBackup.slice(keep)) {
      const backupPath = record.backupPath;
      if (backupPath) removeDirQuietly(dirname(backupPath));
      const index = this.store.data.records.findIndex((item) => item.id === record.id);
      if (index >= 0) {
        this.store.data.records[index] = {
          ...this.store.data.records[index]!,
          purgedAt: new Date().toISOString(),
        };
      }
      purged.push(record.id);
    }
    if (purged.length > 0) this.store.save();
    return purged;
  }

  /** 这份记录对应的备份文件还在不在。 */
  backupExists(record: DbRepairRecord): boolean {
    if (!record.backupPath) return false;
    return fileBytes(record.backupPath) !== null;
  }
}
