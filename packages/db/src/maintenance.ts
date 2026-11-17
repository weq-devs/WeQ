import { resolve } from 'node:path';

const maintained = new Set<string>();
const listeners = new Set<() => void>();
export const DATABASE_MAINTENANCE_MESSAGE = '数据库正在维护中，暂不能写入；仍可只读浏览。';

export function databaseUnderMaintenance(path: string): boolean {
  return maintained.has(resolve(path));
}
export function assertDatabaseWritable(path: string): void {
  if (databaseUnderMaintenance(path)) throw new Error(DATABASE_MAINTENANCE_MESSAGE);
}
export async function waitForDatabaseWritable(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!databaseUnderMaintenance(path)) return;
  await new Promise<void>((done, reject) => {
    const cleanup = () => {
      listeners.delete(changed);
      signal?.removeEventListener('abort', aborted);
    };
    const changed = () => {
      if (!databaseUnderMaintenance(path)) {
        cleanup();
        done();
      }
    };
    const aborted = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('后台写入已取消', 'AbortError'));
    };
    listeners.add(changed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else changed();
  });
}
/** 先发布维护状态，再等待在途写入结束和取得原生锁。 */
export function maintainDatabases(paths: readonly string[]): () => void {
  const keys = paths.map((path) => resolve(path));
  if (keys.some((path) => maintained.has(path))) throw new Error('此数据源已经在维护中。');
  for (const path of keys) maintained.add(path);
  for (const listener of listeners) listener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const path of keys) maintained.delete(path);
    for (const listener of listeners) listener();
  };
}
export function onDatabaseMaintenanceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
