import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  executeStorageCleanup,
  type StorageCleanupPlan,
  type StorageCleanupResult,
} from '@weq/service/storage-cleanup';
import { restartAfterStorageCleanup, type StorageCleanupRestart } from './storage_cleanup_restart';

let prepared:
  | { plan: StorageCleanupPlan; parentPid: number; restart?: StorageCleanupRestart }
  | undefined;
const timer = setTimeout(() => process.exit(1), 120_000);

process.on(
  'message',
  async (message: {
    type: string;
    plan?: StorageCleanupPlan;
    parentPid?: number;
    restart?: StorageCleanupRestart;
  }) => {
    if (
      message.type === 'prepare' &&
      !prepared &&
      message.plan &&
      message.parentPid === process.ppid
    ) {
      prepared = { plan: message.plan, parentPid: message.parentPid, restart: message.restart };
      process.send?.({ type: 'ready' });
    } else if (message.type === 'commit' && prepared) {
      const { plan, parentPid, restart } = prepared;
      prepared = undefined;
      clearTimeout(timer);
      process.disconnect?.();
      let canRestart = false;
      let result: StorageCleanupResult = {
        at: new Date().toISOString(),
        cleared: [],
        freedBytes: 0,
        failed: [],
      };
      try {
        const deadline = Date.now() + 30_000;
        for (;;) {
          let alive = true;
          try {
            process.kill(parentPid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
            else throw error;
          }
          if (!alive) break;
          if (Date.now() >= deadline) throw new Error('应用仍未退出，未执行清除');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        canRestart = true;
        result = await executeStorageCleanup(plan);
      } catch (error) {
        result = {
          at: new Date().toISOString(),
          cleared: [],
          freedBytes: 0,
          failed: [
            { label: '退出后清除', error: error instanceof Error ? error.message : String(error) },
          ],
        };
        await mkdir(dirname(plan.reportPath), { recursive: true });
        await writeFile(plan.reportPath, JSON.stringify(result), { mode: 0o600 });
        process.exitCode = 1;
      } finally {
        if (plan.lockPath) {
          try {
            await rm(plan.lockPath, { force: true });
          } catch (error) {
            canRestart = false;
            result.failed.push({
              label: '解除清理锁',
              error: error instanceof Error ? error.message : String(error),
            });
            await writeFile(plan.reportPath, JSON.stringify(result), { mode: 0o600 });
            process.exitCode = 1;
          }
        }
      }
      // 先完成全部清理、落盘回执并释放锁，防止新实例被启动守卫拦截。
      if (canRestart && restart) {
        try {
          await restartAfterStorageCleanup(restart);
        } catch (error) {
          result.failed.push({
            label: '重新启动 WeQ',
            error: error instanceof Error ? error.message : String(error),
          });
          await writeFile(plan.reportPath, JSON.stringify(result), { mode: 0o600 });
          process.exitCode = 1;
        }
      }
    }
  },
);
process.on('disconnect', () => {
  if (prepared) process.exit(1);
});
