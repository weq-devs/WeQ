import { statSync } from 'node:fs';
import { isLikelyCorruptionError } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import type { DbRepairTarget } from '@weq/service';
import { concludeCheckup, type DbRepairCheckup } from '@weq/service/db-checkup';
import { scanDatabaseBadPages } from '@weq/service/bad-pages';

/** 仅在独立只读进程中执行；停止进程即可中断没有取消接口的原生扫描。 */
export async function inspectDatabase(
  nt: NtHelperBinding,
  target: DbRepairTarget,
): Promise<DbRepairCheckup> {
  let bytes = 0;
  try {
    bytes = statSync(target.dbPath).size;
  } catch {
    // 文件状态不妨碍两项检查各自报告错误。
  }
  let integrity: DbRepairCheckup['integrity'];
  try {
    const health = await nt.checkDatabaseHealth(target.dbPath, target.key, target.algo);
    integrity = { ran: true, healthy: health.healthy, corruptedTables: health.corruptedTables };
  } catch (error) {
    integrity = {
      ran: false,
      error: error instanceof Error ? error.message : String(error),
      corrupt: isLikelyCorruptionError(error),
    };
  }
  let pages: DbRepairCheckup['pages'];
  try {
    pages = { ran: true, report: await scanDatabaseBadPages(nt, target) };
  } catch (error) {
    pages = { ran: false, error: error instanceof Error ? error.message : String(error) };
  }
  return {
    dbName: target.dbName,
    dbPath: target.dbPath,
    bytes,
    integrity,
    pages,
    ...concludeCheckup(integrity, pages),
  };
}
