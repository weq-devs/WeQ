import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  authorizationArtifact,
  AUTHORIZATION_PROTOCOL,
  AUTHORIZATION_TARGETS,
  validateAuthorizationBuildInfo,
  validateNativeBuildInfo,
} from '../packages/native/authorization.mjs';
test('旧清单不假造助手，新资产与原生平台目录共用分发', () => {
  assert.equal(authorizationArtifact({}, 'darwin-arm64', 'native/darwin/arm64'), null);
  const metadata = {
    asset: 'weq-authorization-helper-win32-x64.exe',
    sha256: 'a'.repeat(64),
    size: 1234,
  };
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

test('桌面 release 必须有有效、同源的助手，普通开发仍兼容旧清单', () => {
  const platform = 'darwin-arm64';
  const buildTime = Math.floor(Date.now() / 1000) - 10;
  const info = {
    protocol: AUTHORIZATION_PROTOCOL,
    target: AUTHORIZATION_TARGETS[platform],
    capabilities: ['attach', 'key-scan', 'capture'],
    buildTime,
    expireTime: buildTime + 3600,
    validitySecs: 3600,
    isDev: false,
  };
  const meta = {
    ...info,
    asset: `weq-authorization-helper-${platform}`,
    sha256: 'a'.repeat(64),
    size: 1234,
  };
  const manifest = {
    buildTime: new Date(buildTime * 1000).toISOString(),
    expiresAt: new Date(info.expireTime * 1000).toISOString(),
    authorization: { [platform]: meta },
  };
  assert.throws(() => validateNativeBuildInfo({ ...info, isDev: true }, { production: true }));
  assert.doesNotThrow(() =>
    validateNativeBuildInfo(
      { validitySecs: info.validitySecs, isDev: true },
      {
        expected: { ...info, isDev: true, buildTime: null, expireTime: null },
      },
    ),
  );
  assert.throws(() =>
    validateNativeBuildInfo({ ...info, buildTime: buildTime - 1 }, { expected: info }),
  );
  assert.ok(authorizationArtifact(manifest, platform, 'native/darwin/arm64', { required: true }));
  assert.throws(() =>
    authorizationArtifact({}, platform, 'native/darwin/arm64', { required: true }),
  );
  for (const patch of [
    { target: AUTHORIZATION_TARGETS['darwin-x64'] },
    { protocol: AUTHORIZATION_PROTOCOL + 1 },
    { isDev: true },
    { expireTime: buildTime },
    { capabilities: ['attach'] },
  ])
    assert.throws(() =>
      validateAuthorizationBuildInfo({ ...info, ...patch }, platform, { production: true }),
    );
  assert.throws(() =>
    authorizationArtifact(
      { ...manifest, expiresAt: new Date((info.expireTime + 1) * 1000).toISOString() },
      platform,
      'native/darwin/arm64',
      { required: true },
    ),
  );
  assert.throws(() =>
    validateAuthorizationBuildInfo(info, platform, {
      expected: { ...info, buildTime: buildTime - 1 },
    }),
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
