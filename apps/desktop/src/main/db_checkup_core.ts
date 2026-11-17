import { statSync } from 'node:fs';
import { isLikelyCorruptionError } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import type { DbRepairTarget, DatabaseWorkProgress } from '@weq/service';
import { concludeCheckup, type DbRepairCheckup } from '@weq/service/db-checkup';
import { scanDatabaseBadPages } from '@weq/service/bad-pages';

/** 仅在独立只读进程中执行；停止进程即可中断没有取消接口的原生扫描。 */
export async function inspectDatabase(
  nt: NtHelperBinding,
  target: DbRepairTarget,
  onProgress: (progress: DatabaseWorkProgress) => void = () => {},
): Promise<DbRepairCheckup> {
  let bytes = 0;
  try {
    bytes = statSync(target.dbPath).size;
  } catch {
    // 文件状态不妨碍两项检查各自报告错误。
  }
  let integrity: DbRepairCheckup['integrity'];
  let checkingStructure = true;
  onProgress({ step: 'integrity', message: '检查数据库整体结构' });
  try {
    const health = await nt.checkDatabaseHealth(
      target.dbPath,
      target.key,
      target.algo,
      (error, tick) => {
        if (!error && checkingStructure) onProgress(tick);
      },
    );
    checkingStructure = false;
    onProgress({
      step: 'integrity',
      message: health.healthy ? '结构检查通过' : '结构检查发现异常',
      status: 'completed',
    });
    integrity = { ran: true, healthy: health.healthy, corruptedTables: health.corruptedTables };
  } catch (error) {
    onProgress({ step: 'integrity', message: '结构检查未完成', status: 'failed' });
    integrity = {
      ran: false,
      error: error instanceof Error ? error.message : String(error),
      corrupt: isLikelyCorruptionError(error),
    };
  }
  checkingStructure = false;
  let pages: DbRepairCheckup['pages'];
  try {
    onProgress({ step: 'pages', message: '检查页签名' });
    pages = { ran: true, report: await scanDatabaseBadPages(nt, target, onProgress) };
  } catch (error) {
    onProgress({ step: 'pages', message: '页签名检查未完成', status: 'failed' });
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
