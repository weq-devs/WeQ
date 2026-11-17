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
        if (!error && checkingStructure)
          onProgress({
            ...tick,
            // 只有整库已返回异常才会进入这一定位分支，不根据进度百分比猜结论。
            ...(tick.step === 'integrity-tables' && tick.message === '逐表定位结构异常'
              ? { outcome: 'abnormal' as const }
              : {}),
          });
      },
    );
    checkingStructure = false;
    onProgress({
      step: 'integrity',
      message: health.healthy ? '结构检查通过' : '结构检查发现异常',
      status: 'completed',
      outcome: health.healthy ? 'normal' : 'abnormal',
      detail: health.healthy
        ? undefined
        : health.corruptedTables.length
          ? `异常表：${health.corruptedTables.join('、')}`
          : '整体结构检查发现异常，未能定位到具体表。',
    });
    integrity = { ran: true, healthy: health.healthy, corruptedTables: health.corruptedTables };
  } catch (error) {
    onProgress({
      step: 'integrity',
      message: '结构检查未完成',
      status: 'failed',
      outcome: isLikelyCorruptionError(error) ? 'abnormal' : 'unverified',
      detail: error instanceof Error ? error.message : String(error),
    });
    integrity = {
      ran: false,
      error: error instanceof Error ? error.message : String(error),
      corrupt: isLikelyCorruptionError(error),
    };
  }
  checkingStructure = false;
  let pages: DbRepairCheckup['pages'];
  let foundBadPages = false;
  try {
    onProgress({ step: 'pages', message: '检查页签名' });
    pages = {
      ran: true,
      report: await scanDatabaseBadPages(nt, target, (tick) => {
        if (tick.badPages && tick.badPages > 0) foundBadPages = true;
        onProgress(tick);
      }),
    };
  } catch (error) {
    onProgress({
      step: 'pages',
      message: '页签名检查未完成',
      status: 'failed',
      outcome: foundBadPages ? 'abnormal' : 'unverified',
      detail: error instanceof Error ? error.message : String(error),
    });
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
