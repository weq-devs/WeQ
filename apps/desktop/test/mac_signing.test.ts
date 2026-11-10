// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { macSigningOptions } from '../../../scripts/sign-macos.mjs';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import {
  macSigningIdentity,
  macSigningRequirement,
  verifyMacCertificate,
  verifyMacDesignatedRequirement,
} from '../../../scripts/verify-macos-signing.mjs';

describe('macOS 无证书构建签名', () => {
  it('固定自签模式显式使用专用钥匙串和公开指纹，保留运行权限并关闭时间戳', () => {
    const options = {
      app: '/build/weQ.app',
      platform: 'darwin',
      keychain: '/private/signing.keychain-db',
      identity: 'other-certificate',
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: '/build/main.plist' }),
    };
    const signed = macSigningOptions(options, { WEQ_MAC_SIGNING_MODE: 'self-signed' });
    expect(signed.identity).toBe(macSigningIdentity.certificateSha1);
    expect(signed.keychain).toBe(options.keychain);
    expect(signed.optionsForFile(options.app)).toEqual({
      hardenedRuntime: true,
      entitlements: '/build/main.plist',
      timestamp: 'none',
    });
  });
  it('正式模式缺钥匙串或模式拼错时拒绝，不能静默降级', () => {
    const options = { app: '/build/weQ.app', platform: 'darwin' };
    expect(() => macSigningOptions(options, { WEQ_MAC_SIGNING_MODE: 'self-signed' })).toThrow(
      '钥匙串',
    );
    expect(() => macSigningOptions(options, { WEQ_MAC_SIGNING_MODE: 'self-sign' })).toThrow('模式');
    expect(
      macSigningOptions({ ...options, identity: 'unrelated' }, { WEQ_MAC_SIGNING_MODE: 'adhoc' })
        .identity,
    ).toBe('-');
  });
  it('公开证书与两种指纹一致；DR 必须是固定证书，单次 cdhash 或放宽条件均拒绝', async () => {
    verifyMacCertificate(
      await readFile(new URL('../../../resources/signing/macos-release.pem', import.meta.url)),
    );
    expect(() => verifyMacCertificate('invalid certificate')).toThrow();
    verifyMacDesignatedRequirement(
      `Executable=/build/weQ.app\n# designated => ${macSigningRequirement}\n`,
    );
    expect(() => verifyMacDesignatedRequirement('designated => cdhash H"012345"')).toThrow(
      '固定证书',
    );
    expect(() =>
      verifyMacDesignatedRequirement(
        `designated => ${macSigningRequirement} or identifier "other"`,
      ),
    ).toThrow('固定证书');
  });
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
