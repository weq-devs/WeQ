import {
  replaceMacApp,
  validateMacUpdatePlan,
  verifyMacBundle,
  writeMacUpdateResult,
  type MacUpdatePlan,
} from './mac_install';
import { join } from 'node:path';

let prepared: { plan: MacUpdatePlan; parentPid: number } | undefined;
let committed = false;
const timer = setTimeout(() => process.exit(1), 120_000);

process.on('message', async (input: unknown) => {
  const message = input as { type?: string; parentPid?: number; plan?: unknown };
  try {
    if (
      message.type === 'prepare' &&
      !prepared &&
      !committed &&
      message.parentPid === process.ppid
    ) {
      const plan = validateMacUpdatePlan(message.plan);
      await verifyMacBundle(plan.target, plan.previousVersion);
      await verifyMacBundle(join(plan.staging, 'weQ.app'), plan.version, plan.arch);
      prepared = { plan, parentPid: message.parentPid };
      process.send?.({ type: 'ready' });
    } else if (message.type === 'commit' && prepared && !committed) {
      const { plan, parentPid } = prepared;
      await writeMacUpdateResult(plan, 'installing');
      committed = true;
      clearTimeout(timer);
      process.send?.({ type: 'committed' });
      try {
        const deadline = Date.now() + 30_000;
        for (;;) {
          try {
            process.kill(parentPid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
            throw error;
          }
          if (Date.now() >= deadline) throw new Error('应用仍在运行，未替换应用。');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await replaceMacApp(plan);
        await writeMacUpdateResult(plan, 'installed');
      } catch (error) {
        await writeMacUpdateResult(
          plan,
          'error',
          error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
      }
      if (process.connected) process.disconnect();
    }
  } catch (error) {
    if (process.connected)
      process.send?.({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    clearTimeout(timer);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
});
process.on('disconnect', () => {
  if (!committed) process.exit(1);
});
