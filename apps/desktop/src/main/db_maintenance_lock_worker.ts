import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { loadNative, resolveNtHelperPath, type DatabaseProgress } from '@weq/native';
import type { DbRepairTarget } from '@weq/service';

/** 此进程持锁后不再读取源库文件，避免 POSIX close(fd) 释放本进程的 SQLite 文件锁。 */
async function main() {
  process.chdir(dirname(resolveNtHelperPath()));
  const { ntHelper: nt } = loadNative();
  if (
    !nt.beginDatabaseMaintenance ||
    !nt.protectDatabaseMaintenanceProduct ||
    !nt.endDatabaseMaintenance
  )
    throw new Error('原生组件不支持持续维护锁。');
  let sessionId: string | undefined;
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('维护锁请求过大。');
      const request = JSON.parse(line);
      try {
        if (request.kind === 'begin' && !sessionId) {
          sessionId = request.id;
          const targets: DbRepairTarget[] = request.targets;
          const names = new Map(targets.map(({ dbPath, dbName }) => [dbPath, dbName]));
          const databases = await nt.beginDatabaseMaintenance(
            sessionId!,
            targets,
            (error, tick: DatabaseProgress) => {
              if (!error)
                send({
                  requestId: request.requestId,
                  progress: {
                    ...tick,
                    objectName: names.get(tick.objectName ?? '') ?? '',
                  },
                });
            },
          );
          send({ requestId: request.requestId, databases });
        } else if (request.kind === 'protect' && sessionId) {
          nt.protectDatabaseMaintenanceProduct(sessionId, request.dbPath, request.product);
          send({ requestId: request.requestId, ok: true });
        } else if (request.kind === 'end' && sessionId) {
          nt.endDatabaseMaintenance(sessionId);
          sessionId = undefined;
          send({ requestId: request.requestId, ok: true });
          break;
        } else throw new Error('维护锁命令或会话状态无效。');
      } catch (error) {
        send({
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (request.kind === 'begin') break;
      }
    }
  } finally {
    if (sessionId) nt.endDatabaseMaintenance(sessionId);
    lines.close();
  }
}
void main()
  .then(() => process.stdout.write('', () => process.exit(0)))
  .catch(() => process.exit(1));
