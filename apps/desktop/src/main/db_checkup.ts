import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNtHelperPath } from '@weq/native';
import { runOwnedChild, type DbRepairCheckup, type DbRepairTarget } from '@weq/service';
import { resolveChildWorkerPath } from './worker_path';

export async function runDatabaseCheckup(
  target: DbRepairTarget,
  signal: AbortSignal,
  options: { workerPath?: string; executable?: string; nativeRoot?: string } = {},
): Promise<DbRepairCheckup> {
  const worker =
    options.workerPath ??
    resolveChildWorkerPath('dbCheckupWorker.mjs', dirname(fileURLToPath(import.meta.url)));
  const nativeRoot = options.nativeRoot ?? dirname(dirname(dirname(resolveNtHelperPath())));
  const result = await runOwnedChild(options.executable ?? process.execPath, [worker], {
    input: JSON.stringify(target),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WEQ_NATIVE_DIR: nativeRoot },
    signal,
    timeoutMs: 24 * 60 * 60_000,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  if (result.signal || result.code !== 0) throw new Error('数据库体检进程异常退出，请重新体检。');
  const report = JSON.parse(result.stdout) as DbRepairCheckup;
  if (
    report.dbName !== target.dbName ||
    report.dbPath !== target.dbPath ||
    !report.integrity ||
    !report.pages ||
    typeof report.summary !== 'string'
  ) {
    throw new Error('数据库体检进程未返回有效结果。');
  }
  return report;
}

/** 取消只命中本次调用，等待子进程真正关闭后才释放任务。 */
export class DatabaseCheckupTasks {
  private readonly tasks = new Map<
    string,
    { uin: string; abort: AbortController; done: Promise<DbRepairCheckup> }
  >();

  constructor(private readonly run = runDatabaseCheckup) {}

  start(uin: string, taskId: string, target: DbRepairTarget): Promise<DbRepairCheckup> {
    if (this.tasks.has(taskId)) throw new Error('这个体检任务已经在运行。');
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(() => this.run(target, abort.signal))
      .finally(() => this.tasks.delete(taskId));
    this.tasks.set(taskId, { uin, abort, done });
    return done;
  }

  async cancel(uin: string, taskId: string): Promise<{ cancelled: boolean }> {
    const task = this.tasks.get(taskId);
    if (!task || task.uin !== uin) return { cancelled: false };
    task.abort.abort(new Error('数据库体检已停止。'));
    await task.done.catch(() => {});
    return { cancelled: true };
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.tasks].map(([taskId, task]) => this.cancel(task.uin, taskId)));
  }
}

export const databaseCheckups = new DatabaseCheckupTasks();
