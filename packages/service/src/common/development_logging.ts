import { observeSlowDatabaseOperations } from '@weq/db';
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
    getLogger()[sample.outcome === 'cancelled' ? 'debug' : 'warn']('数据库等待超过阈值', {
      scope: 'database',
      event: 'database-slow',
      ...sample,
    });
  });
}
