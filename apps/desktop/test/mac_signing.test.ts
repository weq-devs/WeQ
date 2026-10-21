// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { macSigningOptions } from '../../../scripts/sign-macos.mjs';

describe('macOS 无证书构建签名', () => {
  it('仅无证书构建选择 ad-hoc，不要求身份验证、描述文件或时间戳服务', async () => {
    const options = {
      app: '/build/weQ.app',
      platform: 'darwin',
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: '/build/main.plist' }),
    };
    const signed = macSigningOptions(options);
    expect(signed).toMatchObject({
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
    });
    const file = signed.optionsForFile('/build/weQ.app');
    expect(file).not.toBeInstanceOf(Promise);
    expect(file).toEqual({
      hardenedRuntime: true,
      entitlements: '/build/main.plist',
      timestamp: 'none',
    });
    expect(options).not.toHaveProperty('identity');
  });
  it('真实证书沿用原身份和逐文件设置，不降级为 ad-hoc', () => {
    const options = {
      app: '/build/weQ.app',
      platform: 'darwin',
      identity: 'certificate-hash',
      identityValidation: false,
      optionsForFile: () => ({ hardenedRuntime: true }),
    };
    const signed = macSigningOptions(options);
    expect(signed).toEqual(options);
    expect(signed.optionsForFile).toBe(options.optionsForFile);
  });
  it('不接管非 macOS 桌面分发，也不将显式禁用签名伪装为已签名', () => {
    expect(() => macSigningOptions({ app: '/build/weQ.app', platform: 'mas' })).toThrow();
    expect(() =>
      macSigningOptions({ app: '/build/weQ.app', platform: 'darwin', identity: null }),
    ).toThrow();
  });
});
