import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { executeStorageCleanup, type StorageCleanupPlan } from '@weq/service/storage-cleanup';

let prepared: { plan: StorageCleanupPlan; parentPid: number } | undefined;
const timer = setTimeout(() => process.exit(1), 120_000);

process.on(
  'message',
  async (message: { type: string; plan?: StorageCleanupPlan; parentPid?: number }) => {
    if (
      message.type === 'prepare' &&
      !prepared &&
      message.plan &&
      message.parentPid === process.ppid
    ) {
      prepared = { plan: message.plan, parentPid: message.parentPid };
      process.send?.({ type: 'ready' });
    } else if (message.type === 'commit' && prepared) {
      const { plan, parentPid } = prepared;
      prepared = undefined;
      clearTimeout(timer);
      process.disconnect?.();
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
        await executeStorageCleanup(plan);
      } catch (error) {
        await mkdir(dirname(plan.reportPath), { recursive: true });
        await writeFile(
          plan.reportPath,
          JSON.stringify({
            at: new Date().toISOString(),
            cleared: [],
            freedBytes: 0,
            failed: [
              {
                label: '退出后清除',
                error: error instanceof Error ? error.message : String(error),
              },
            ],
          }),
          { mode: 0o600 },
        );
        process.exitCode = 1;
      } finally {
        if (plan.lockPath) await rm(plan.lockPath, { force: true });
      }
    }
  },
);
process.on('disconnect', () => {
  if (prepared) process.exit(1);
});
