import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MIN_REMOTE_GO_VERSION,
  remoteNetworkTarget,
  verifyRemoteNetworkBinary,
} from './package-remote-network.mjs';

test('五个平台目标不共享构建文件，拒绝未支持架构', () => {
  const paths = [];
  for (const [platform, arch] of [
    ['darwin', 1],
    ['darwin', 3],
    ['linux', 1],
    ['linux', 3],
    ['win32', 1],
  ]) {
    paths.push(remoteNetworkTarget({ electronPlatformName: platform, arch }).directory);
  }
  assert.equal(new Set(paths).size, 5);
  assert.throws(() => remoteNetworkTarget({ electronPlatformName: 'darwin', arch: 4 }), /不支持/);
});

test('包内校验拒绝缺件、空文件、无执行权限及错误平台/架构', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-pack-remote-'));
  const helper = join(root, 'helper');
  const inspect = () =>
    JSON.stringify({
      GoVersion: `go${MIN_REMOTE_GO_VERSION}`,
      Path: 'weq.local/remote-network',
      Settings: [
        { Key: 'GOOS', Value: 'linux' },
        { Key: 'GOARCH', Value: 'arm64' },
      ],
    });
  try {
    assert.throws(() => verifyRemoteNetworkBinary(helper, 'linux', 'arm64', inspect));
    writeFileSync(helper, '');
    assert.throws(() => verifyRemoteNetworkBinary(helper, 'linux', 'arm64', inspect), /为空/);
    writeFileSync(helper, 'synthetic');
    chmodSync(helper, 0o700);
    verifyRemoteNetworkBinary(helper, 'linux', 'arm64', inspect);
    const oldGo = JSON.parse(inspect());
    oldGo.GoVersion = 'go1.27.2';
    assert.throws(
      () => verifyRemoteNetworkBinary(helper, 'linux', 'arm64', () => JSON.stringify(oldGo)),
      /更高稳定版/,
    );
    assert.throws(
      () => verifyRemoteNetworkBinary(helper, 'darwin', 'arm64', inspect),
      /目标架构不符/,
    );
    assert.throws(() => verifyRemoteNetworkBinary(helper, 'linux', 'x64', inspect), /目标架构不符/);
    if (process.platform !== 'win32') {
      chmodSync(helper, 0o600);
      assert.throws(() => verifyRemoteNetworkBinary(helper, 'linux', 'arm64', inspect));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
