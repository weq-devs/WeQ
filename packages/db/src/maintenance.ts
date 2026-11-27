import { resolve } from 'node:path';

const maintained = new Set<string>();
const listeners = new Set<() => void>();
export const DATABASE_MAINTENANCE_MESSAGE = '数据库正在维护中，暂不能写入；仍可只读浏览。';

export const QQ_READ_ONLY_MESSAGE = '当前为只读模式，切换到可写档位后可修改 QQ 数据。';
let qqReadOnly = () => false;
let activeQqWrites = 0;

export function configureQqDatabaseReadOnly(readOnly: () => boolean): void {
  qqReadOnly = readOnly;
}

export function qqDatabaseReadOnly(): boolean {
  return qqReadOnly();
}

export function assertQqDatabaseWriteAllowed(): void {
  if (qqDatabaseReadOnly()) throw new Error(QQ_READ_ONLY_MESSAGE);
}

export function assertQqDatabaseWritesIdle(): void {
  if (activeQqWrites > 0) throw new Error('正在修改 QQ 数据，请等待当前操作完成后再切换。');
}

export function beginQqWrite(): () => void {
  assertQqDatabaseWriteAllowed();
  activeQqWrites++;
  return () => {
    activeQqWrites--;
  };
}

/** 包住一次写入或必须完整执行的多步修改，以便在切入只读前确认它已经结束。 */
export async function withQqDatabaseWrite<T>(run: () => Promise<T>): Promise<T> {
  const finish = beginQqWrite();
  try {
    return await run();
  } finally {
    finish();
  }
}

export function databaseUnderMaintenance(path: string): boolean {
  return maintained.has(resolve(path));
}
export function assertDatabaseWritable(path: string): void {
  assertQqDatabaseWriteAllowed();
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
