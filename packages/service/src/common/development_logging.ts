import { observeSlowDatabaseOperations, SLOW_DATABASE_OPERATION_MS } from '@weq/db';
import { configureConsoleLogger, getLogger } from './logger';

let stopSlow: (() => void) | undefined;
export function configureDevelopmentLogging(development: boolean, processName: string): void {
  configureConsoleLogger({
    development,
    processName,
    infoScopes: new Set([
      'startup',
      'logger',
      'desktop-main',
      'app-context',
      'account-monitor',
      'media-download',
      'mcp-server',
      'web',
      'renderer',
    ]),
  });
  stopSlow?.();
  stopSlow = observeSlowDatabaseOperations((sample) => {
    const slow = sample.nativePromiseAwaitMs > SLOW_DATABASE_OPERATION_MS;
    if (!slow && sample.outcome === 'ok') return;
    getLogger()[sample.outcome === 'cancelled' ? 'debug' : 'warn'](
      slow ? '数据库慢操作' : sample.outcome === 'failed' ? '数据库操作失败' : '数据库操作已取消',
      {
        scope: 'database',
        event: slow
          ? 'database-slow'
          : sample.outcome === 'failed'
            ? 'database-failed'
            : 'database-cancelled',
        caller: sample.caller,
        nativePromiseAwaitMs: sample.nativePromiseAwaitMs,
        ...(sample.nativeTiming ? { nativeTiming: sample.nativeTiming } : {}),
        ...(sample.affectedQueryCount
          ? { affectedQueryCount: sample.affectedQueryCount, maxBlockedMs: sample.maxBlockedMs }
          : {}),
        jsQueueWaitMs: sample.jsQueueWaitMs,
        priority: sample.priority,
        outcome: sample.outcome,
        fingerprint: sample.fingerprint,
      },
    );
  });
}
