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
  mode: 'checkup' | 'scan' | 'deep' = 'checkup',
): Promise<DbRepairCheckup> {
  let bytes = 0;
  try {
    bytes = statSync(target.dbPath).size;
  } catch {
    // 文件状态不妨碍两项检查各自报告错误。
  }
  let integrity: DbRepairCheckup['integrity'] = {
    ran: false,
    error: '本次常规扫描不执行额外结构体检。',
  };
  let checkingStructure = true;
  if (mode !== 'scan') {
    onProgress({ step: 'integrity', message: '检查数据库整体结构' });
    try {
      const health =
        target.key === ''
          ? await (async () => {
              const rows = await nt.executeSql(target.dbPath, 'PRAGMA main.integrity_check');
              return {
                healthy: rows.length === 1 && rows[0]?.[0] === 'ok',
                corruptedTables: [] as string[],
                complete: true,
                unverifiedTables: [] as string[],
              };
            })()
          : await nt.checkDatabaseHealth(target.dbPath, target.key, target.algo, (error, tick) => {
              if (!error && checkingStructure)
                onProgress({
                  ...tick,
                  // 只有整库已返回异常才会进入这一定位分支，不根据进度百分比猜结论。
                  ...(tick.step === 'integrity-tables' && tick.message === '逐表定位结构异常'
                    ? { outcome: 'abnormal' as const }
                    : {}),
                  ...(tick.step === 'integrity-unverified'
                    ? {
                        status: 'skipped' as const,
                        outcome: 'unverified' as const,
                        detail: 'QQ 专用分词器不可用，相关虚拟表未完成核验。',
                      }
                    : {}),
                });
            });
      checkingStructure = false;
      onProgress({
        step: 'integrity',
        message: !health.healthy
          ? '结构检查发现异常'
          : health.complete === false
            ? '可检查的结构部分已完成，仍有未核验项'
            : '结构检查通过',
        status: 'completed',
        outcome: !health.healthy ? 'abnormal' : health.complete === false ? 'unverified' : 'normal',
        detail: health.healthy
          ? health.complete === false
            ? `未核验：${health.unverifiedTables?.join('、') || '部分结构检查'}`
            : undefined
          : health.corruptedTables.length
            ? `异常表：${health.corruptedTables.join('、')}`
            : '整体结构检查发现异常，未能定位到具体表。',
      });
      integrity = {
        ran: true,
        healthy: health.healthy,
        corruptedTables: health.corruptedTables,
        ...(health.complete === undefined
          ? {}
          : { complete: health.complete, unverifiedTables: health.unverifiedTables }),
      };
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
  }
  checkingStructure = false;
  let pages: DbRepairCheckup['pages'] = { ran: false, error: '使用当前维护中已有的常规扫描结果。' };
  let foundBadPages = false;
  if (mode !== 'deep') {
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
