import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import {
  DEVELOPMENT_DRESS_FLAG,
  developmentDressToolsEnabled,
  requireDevelopmentDressTools,
  resolveDevelopmentDressTools,
} from '../src/common/development_dress';
import { withHost, type HostBridge } from '../src/common/host';
import { EmojiService } from '../src/account/emoji';

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
});

it.each([
  [false, 'development', [], false],
  [false, 'development', [DEVELOPMENT_DRESS_FLAG], true],
  [true, 'development', [DEVELOPMENT_DRESS_FLAG], false],
  [true, 'production', [DEVELOPMENT_DRESS_FLAG], false],
  [false, 'production', [DEVELOPMENT_DRESS_FLAG], false],
  [false, undefined, [DEVELOPMENT_DRESS_FLAG], false],
  [false, 'test', [DEVELOPMENT_DRESS_FLAG], false],
  [false, 'development', [`${DEVELOPMENT_DRESS_FLAG}=false`], false],
] as const)('开发判断 packaged=%s env=%s args=%j', (packaged, nodeEnv, args, expected) => {
  expect(resolveDevelopmentDressTools({ packaged, nodeEnv, args })).toBe(expected);
});

it('未安装宿主时默认关闭，正式宿主即使携带参数也不开放', () => {
  vi.stubEnv('NODE_ENV', 'development');
  process.argv = [...argv, DEVELOPMENT_DRESS_FLAG];
  expect(developmentDressToolsEnabled()).toBe(false);
  withHost({ isPackaged: () => true } as HostBridge, () => {
    expect(developmentDressToolsEnabled()).toBe(false);
    expect(requireDevelopmentDressTools).toThrow('未启用');
  });
  withHost({ isPackaged: () => false } as HostBridge, () => {
    expect(developmentDressToolsEnabled()).toBe(true);
    expect(requireDevelopmentDressTools).not.toThrow();
  });
});

it('普通模式在访问 native、网络、缓存和手动密钥前停止商城解密', async () => {
  const nativeKey = vi.fn();
  const root = vi.fn();
  const service = new EmojiService(
    { context: {} } as Pick<AccountSession, 'context'>,
    {
      appDataRoot: root,
      native: { ntHelper: { getMarketFaceKey: nativeKey } },
    } as unknown as Platform,
  );
  expect(await service.getMarketPackKey('123')).toBeNull();
  expect(await service.getMarketPackKey('123', 123456)).toBeNull();
  expect(await service.getMarketPackImage('123', 'abcdef123456', '0123456789abcdef')).toBeNull();
  expect(nativeKey).not.toHaveBeenCalled();
  expect(root).not.toHaveBeenCalled();
});

it('仅开发环境和显式参数共同存在时允许手动派生，关掉后不返回已缓存密钥', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  process.argv = [...argv, DEVELOPMENT_DRESS_FLAG];
  const recover = vi.fn(async () => ({ key: 'synthetic-key', timestamp: 123, source: 'xydata' }));
  const service = new EmojiService(
    { context: {} } as Pick<AccountSession, 'context'>,
    { native: { ntHelper: { getMarketFaceKey: recover } } } as unknown as Platform,
  );
  await withHost({ isPackaged: () => false } as HostBridge, async () => {
    const manual = await service.getMarketPackKey('123', 123456);
    expect(manual?.key).toBe(createHash('md5').update('123456').digest('hex').slice(0, 16));
    expect(recover).not.toHaveBeenCalled();
    expect(await service.getMarketPackKey('123')).toMatchObject({ source: 'xydata' });
    expect(recover).toHaveBeenCalledOnce();
    process.argv = argv;
    expect(await service.getMarketPackKey('123')).toBeNull();
  });
});
