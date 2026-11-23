import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** JSON 保留原备份格式，SQLite 只负责序列化跨进程的读改写。 */
export function withSharedConfigLock<T>(root: string, operation: () => T): T {
  const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite',
  ) as typeof import('node:sqlite');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'settings-writes.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 1500; BEGIN IMMEDIATE');
    return operation();
  } finally {
    db.close();
  }
}
