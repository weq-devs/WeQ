import { randomUUID } from 'node:crypto';
import type { DatabaseReadRequest, NtHelperBinding } from '@weq/native';
import {
  currentDatabaseRead,
  prepareDatabaseReadBinding,
  recordNativeReadTiming,
} from './query_schedule';

/** 调度已获准后才登记请求；取消 ID 与某一次 native 读取绑定，不中断复用连接的下一次查询。 */
export async function executeNativeRead(
  nt: NtHelperBinding,
  input: Omit<DatabaseReadRequest, 'requestId' | 'bulk'>,
) {
  if (!nt.executeDatabaseRead) throw new Error('原生组件不支持并行读取');
  prepareDatabaseReadBinding(nt);
  const { bulk, signal } = currentDatabaseRead();
  signal?.throwIfAborted();
  const requestId = randomUUID();
  const pending = nt.executeDatabaseRead({ ...input, requestId, bulk });
  const cancel = () => nt.cancelDatabaseRead?.(requestId);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const result = await pending;
    recordNativeReadTiming(result.timing);
    signal?.throwIfAborted();
    if (result.error === 'database_query_cancelled')
      throw new DOMException('数据库读取已取消', 'AbortError');
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
