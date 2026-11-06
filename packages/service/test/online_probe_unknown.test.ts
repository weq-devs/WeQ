import { expect, test, vi } from 'vitest';
import type { Platform } from '@weq/platform';
import type { UserConfigService } from '../src/bootstrap/user_config';
import { GlobalConfigService } from '../src/bootstrap/global_config';

test('状态文件不可读保留未知，不能冒充已确认零在线', () => {
  const platform = { launcherCount: () => null, isQqLoggedIn: vi.fn() };
  const service = new GlobalConfigService(platform as unknown as Platform, {} as UserConfigService);
  expect(service.probeOnline(['10001'])).toEqual({ count: null, byUin: null });
  expect(platform.isQqLoggedIn).not.toHaveBeenCalled();
});

test('状态文件明确零在线与单实例账号细化仍保留原语义', () => {
  const platform = { launcherCount: vi.fn(() => 0), isQqLoggedIn: vi.fn(() => true) };
  const service = new GlobalConfigService(platform as unknown as Platform, {} as UserConfigService);
  expect(service.probeOnline()).toEqual({ count: 0, byUin: null });
  platform.launcherCount.mockReturnValue(1);
  expect(service.probeOnline(['10001'])).toEqual({ count: 1, byUin: { '10001': true } });
});
