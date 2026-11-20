import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertNoNativeBinary, buildWeqbotDaemon } from './build-weqbot-daemon.mjs';

test('打包 daemon 入口在带空格的目录中仍执行参数校验', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-daemon-'));
  try {
    const output = join(dir, '含空格的安装目录 sample', 'weqbot-daemon.mjs');
    await buildWeqbotDaemon(output);
    await assertNoNativeBinary(output);
    assert.throws(
      () => execFileSync(process.execPath, [output], { stdio: 'pipe', timeout: 5000 }),
      (error) => error.status === 2 && String(error.stderr).includes('--account'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
