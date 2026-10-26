// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { Arch } from 'electron-builder';
import { verifyDesktopAuthorization } from '../../../scripts/trim-desktop-package.mjs';
import afterSign from '../../../scripts/verify-desktop-authorization.mjs';

const fixture = vi.hoisted(() => ({ manifest: { authorization: {} }, verify: vi.fn() }));
vi.mock('../../../scripts/check-authorization-helper.mjs', () => ({
  installedNativeManifest: () => fixture.manifest,
  verifyPackagedAuthorization: fixture.verify,
}));
afterEach(() => {
  fixture.verify.mockClear();
  vi.unstubAllEnvs();
});

it('签名前后从 PackContext 获取真实架构，不依赖 mac.sign 的缺失字段', () => {
  vi.stubEnv('WEQ_REQUIRE_AUTHORIZATION_HELPER', '1');
  const context = {
    arch: Arch.arm64,
    electronPlatformName: 'darwin',
    appOutDir: '/fixture/output',
    packager: { appInfo: { productFilename: 'WeQ' } },
  };
  verifyDesktopAuthorization(context, true);
  afterSign(context);
  expect(fixture.verify.mock.calls).toEqual([
    [
      '/fixture/output/WeQ.app',
      'darwin-arm64',
      { required: true, manifest: fixture.manifest, beforeSigning: true },
    ],
    [
      '/fixture/output/WeQ.app',
      'darwin-arm64',
      { required: true, manifest: fixture.manifest, beforeSigning: false },
    ],
  ]);
});
it('Windows 复用同一签名后门禁，开发构建不被误当成发布检查', () => {
  const context = {
    arch: Arch.x64,
    electronPlatformName: 'win32',
    appOutDir: '/fixture/output',
    packager: { appInfo: { productFilename: 'WeQ' } },
  };
  vi.stubEnv('WEQ_REQUIRE_AUTHORIZATION_HELPER', '0');
  afterSign(context);
  expect(fixture.verify).not.toHaveBeenCalled();
  vi.stubEnv('WEQ_REQUIRE_AUTHORIZATION_HELPER', '1');
  afterSign(context);
  expect(fixture.verify).toHaveBeenCalledWith('/fixture/output', 'win32-x64', {
    required: true,
    manifest: fixture.manifest,
    beforeSigning: false,
  });
  expect(() => afterSign({ ...context, arch: 999 })).toThrow('未知打包架构');
});
