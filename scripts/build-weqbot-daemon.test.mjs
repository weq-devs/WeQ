import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertNoNativeBinary, buildWeqbotDaemon } from './build-weqbot-daemon.mjs';
import { releaseDesktopManifest } from './prepare-electron-builder-manifest.mjs';

test('桌面打包清单只保留外部运行依赖，不追到工作区的 WeqBot 源码', async () => {
  const pkg = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url)));
  const { dependencies } = releaseDesktopManifest(pkg);
  assert.equal(pkg.dependencies['@weqbot/control'], 'workspace:*');
  assert.equal(dependencies['@weqbot/control'], undefined);
  assert.equal(dependencies['@weqbot/protocol'], undefined);
  assert.equal(dependencies['@trpc/server'], pkg.dependencies['@trpc/server']);
});

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
