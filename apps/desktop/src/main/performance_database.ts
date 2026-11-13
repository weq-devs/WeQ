import { databasePerformance } from '@weq/db';
import { getAppContext } from './context/app_context';

/** 仅返回固定聚合，不带账号、SQL 或诊断调用栈。 */
export function performanceDatabaseDetails(): Record<string, unknown> {
  const session = getAppContext().account;
  if (!session) return { database: null };
  const data = databasePerformance(session.msgDbPath);
  return {
    database: {
      queued: data.queued,
      inFlight: data.inFlight,
      oldestWaitMs: data.oldestWaitMs,
      peakQueued: data.peakQueued,
      failed: data.failed,
      returnedRows: data.returnedRows,
      jsQueueWait: data.jsQueueWait,
      nativePromiseAwait: data.nativePromiseAwait,
    },
  };
}
