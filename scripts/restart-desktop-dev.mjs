import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

// 由桌面主进程通过 IPC 准备和提交；不能在旧进程仍占有单实例锁时启动。
const plan = JSON.parse(process.argv[2]);
let committed = false;
const deadline = setTimeout(() => process.exit(1), 120_000);
process.on('disconnect', () => {
  if (!committed) process.exit(0);
});
process.on('message', async (message) => {
  if (message?.type !== 'commit' || committed) return;
  committed = true;
  process.send?.({ type: 'committed' });
  try {
    while (true) {
      try {
        process.kill(plan.parentPid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    delete env.ELECTRON_CLI_ARGS;
    delete env.ELECTRON_ENTRY;
    const log = await open(plan.logPath, 'w', 0o600);
    try {
      const child = spawn(process.execPath, [plan.cli, 'dev', '--', ...plan.args], {
        cwd: plan.appPath,
        env,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    await appendFile(plan.logPath, `开发版重启失败：${String(error)}\n`, { mode: 0o600 }).catch(
      () => {},
    );
    process.exit(1);
  }
});
try {
  await access(plan.cli);
  await mkdir(dirname(plan.logPath), { recursive: true });
  const log = await open(plan.logPath, 'a', 0o600);
  await log.close();
  process.send?.({ type: 'ready' });
} catch (error) {
  process.send?.({ type: 'error', message: String(error) });
  process.exitCode = 1;
  clearTimeout(deadline);
  process.disconnect?.();
}
