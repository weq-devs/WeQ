// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { macSigningOptions } from '../../../scripts/sign-macos.mjs';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';

describe('macOS 无证书构建签名', () => {
  it('主进程 entitlement 保留 Electron 运行权限并启用调试读取，不开放 WeQ 自身的 get-task-allow', async () => {
    const xml = await readFile(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf8');
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    const keys = [...document.getElementsByTagName('key')];
    for (const key of [
      'com.apple.security.cs.debugger',
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ]) {
      const element = keys.find((node) => node.textContent === key);
      let value = element?.nextSibling;
      while (value && value.nodeType !== 1) value = value.nextSibling;
      expect(value?.nodeName).toBe('true');
    }
    expect(keys.some((node) => node.textContent === 'com.apple.security.get-task-allow')).toBe(
      false,
    );
  });
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
