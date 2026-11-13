import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// workspace 测试命令会追加 Vitest 并发参数；本包使用 Node 原生测试器，无需依赖。
const result = spawnSync(
  process.execPath,
  ['--test', fileURLToPath(new URL('./time.test.mjs', import.meta.url))],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
