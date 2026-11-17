import { observeSlowDatabaseOperations, SLOW_DATABASE_OPERATION_MS } from '@weq/db';
import { configureConsoleLogger, getLogger } from './logger';

let stopSlow: (() => void) | undefined;
export function configureDevelopmentLogging(development: boolean, processName: string): void {
  configureConsoleLogger({
    development,
    processName,
    detailEvents: new Set([
      'logger:init',
      'startup:native-ready',
      'desktop-main:tray-create',
      'desktop-main:create-window',
      'app-context:init-app-context',
      'app-context:open-account-start',
      'app-context:open-static-account-start',
      'app-context:apply-group-keyword',
      'account-monitor:monitor-start',
      'account-monitor:monitor-stop',
    ]),
    ...(processName === 'desktop-main' && process.env.WEQ_DEV_CONSOLE === '1'
      ? {
          startup: {
            startedAt:
              Number.isFinite(Number(process.env.WEQ_DEV_STARTED_AT)) &&
              Number(process.env.WEQ_DEV_STARTED_AT) > 0
                ? Number(process.env.WEQ_DEV_STARTED_AT)
                : Date.now(),
            restarting: process.env.WEQ_DEV_RESTART === '1',
            warning: process.env.WEQ_DEV_STARTUP_WARNING === '1',
          },
        }
      : {}),
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
