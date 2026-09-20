/**
 * 日志保留清理（设置 → 日志 → 日志保留时长）。
 *
 * 覆盖两处日志目录：WeQ 自身的 `logs/`（`YYYY-MM-DD.log`，JSONL）和原生组件的
 * 日志目录（`nt_helper_<date>.log` / `native_loader_<date>.log`）。两者都是**按天
 * 拆文件**，所以「过期」直接看文件名里的日期（`pruneExpiredLogs` 兜底没有日期的
 * 文件，退回修改时间）。
 *
 * 触发点三处：
 *   1. 应用启动 —— 上次退出到今天之间攒下的旧日志一次清掉；
 *   2. 后台定时 —— 常驻托盘的应用可能几周不重启，而日志是按天的；
 *   3. 设置改动 —— 用户调小保留天数后立刻生效，不用等下一轮。
 *
 * 清理失败永远不抛给调用方：日志清理是家务，不能影响启动或设置保存。
 */

import { getLogDir, getLogger, logErrorContext, pruneExpiredLogs } from '@weq/service';
import { getNativeLogRoot } from '@weq/native';

const logger = getLogger().child({ scope: 'log-retention' });

/** 后台兜底清理的间隔——日志按天切分，6 小时足够把「跨零点」的不确定性磨平。 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** WeQ 自身日志目录 + 原生日志目录（拿不到的去重后忽略）。 */
function logDirs(): string[] {
  const dirs: string[] = [];
  const weqDir = getLogDir();
  if (weqDir) dirs.push(weqDir);
  try {
    const nativeDir = getNativeLogRoot();
    // 两处可能指向同一个目录（web 部署下 WEQ_LOG_DIR 就是这么设的）。
    if (nativeDir && nativeDir !== weqDir) dirs.push(nativeDir);
  } catch {
    // 原生组件尚未初始化时忽略——下次启动/下一轮再清。
  }
  return dirs;
}

/**
 * 立刻按 `retentionDays` 清一轮过期日志。`retentionDays <= 0` = 永久保留，直接跳过。
 * 返回被删掉的文件名（跨目录合并，仅供日志记录）。
 */
export function runLogRetentionSweep(retentionDays: number): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const removed: string[] = [];
  for (const dir of logDirs()) {
    removed.push(...pruneExpiredLogs(dir, retentionDays));
  }
  if (removed.length > 0) {
    logger.info('pruned expired log files', {
      event: 'log-prune',
      retentionDays,
      removedCount: removed.length,
      // 只记前若干个名字，避免一次清理几百个文件时日志自己膨胀。
      files: removed.slice(0, 50),
    });
  }
  return removed;
}

/**
 * 启动时清一轮，并挂上后台定时器；`readRetentionDays` 每次 tick 现读，这样用户在
 * 设置页改了保留天数，下一轮自动按新值走（改动后的即时清理见 bootstrap 的
 * `setLogRetentionDays`）。
 *
 * 返回的 stop 函数用于取消定时器（`unref` 已保证它不会阻止进程退出）。
 */
export function startLogRetention(readRetentionDays: () => number): () => void {
  const sweep = (): void => {
    try {
      runLogRetentionSweep(readRetentionDays());
    } catch (error) {
      logger.warn('log retention sweep failed', {
        event: 'log-prune-failed',
        ...logErrorContext(error),
      });
    }
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
