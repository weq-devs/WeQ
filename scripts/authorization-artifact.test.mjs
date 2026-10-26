import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { authorizationArtifact } from '../packages/native/authorization.mjs';
test('旧清单不假造助手，新资产与原生平台目录共用分发', () => {
  assert.equal(authorizationArtifact({}, 'darwin-arm64', 'native/darwin/arm64'), null);
  const metadata = { asset: 'helper-win32-x64.exe', sha256: 'a'.repeat(64), size: 1234 };
  assert.deepEqual(
    authorizationArtifact(
      { authorization: { 'win32-x64': metadata } },
      'win32-x64',
      'native/win32/x64',
    ),
    {
      label: 'authorization/win32-x64',
      path: 'native/win32/x64/weq-authorization-helper.exe',
      ...metadata,
      executable: true,
    },
  );
});
test('拒绝路径逃逸、缺失校验和及异常体积', () => {
  for (const metadata of [
    { asset: '../helper', sha256: 'a'.repeat(64), size: 1234 },
    { asset: '..', sha256: 'a'.repeat(64), size: 1234 },
    { asset: 'helper', size: 1234 },
    { asset: 'helper', sha256: 'a'.repeat(64), size: 100 * 1024 * 1024 },
  ])
    assert.throws(() =>
      authorizationArtifact({ authorization: { linux: metadata } }, 'linux', 'native/linux/x64'),
    );
});
