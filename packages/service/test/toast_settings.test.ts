import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';
import {
  DEFAULT_TOAST_DURATIONS,
  isToastDuration,
  MAX_TOAST_DURATION_SECONDS,
} from '../src/common/toast_settings';

const roots: string[] = [];
function fixture(settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weq-toast-settings-'));
  roots.push(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ settings }));
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  return {
    service: new UserConfigService(platform),
    reopen: () => new UserConfigService(platform),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('通知停留时长配置', () => {
  it('旧配置默认成功三秒、失败不自动关闭', () => {
    expect(DEFAULT_TOAST_DURATIONS).toEqual({ successSeconds: 3, failureSeconds: -1 });
    expect(fixture().service.getSettings().toastDurations).toEqual(DEFAULT_TOAST_DURATIONS);
  });
  it('两类设置独立保存，重启与修改其他偏好后仍然保留', () => {
    const f = fixture();
    f.service.setSettings({ toastDurations: { successSeconds: 6 } });
    f.service.setSettings({ toastDurations: { failureSeconds: 10 } });
    f.service.setSettings({ showMessageTime: true });
    expect(f.reopen().getSettings()).toMatchObject({
      toastDurations: { successSeconds: 6, failureSeconds: 10 },
      showMessageTime: true,
    });
    f.service.setSettings({ toastDurations: { successSeconds: -1 } });
    expect(f.reopen().getSettings().toastDurations).toEqual({
      successSeconds: -1,
      failureSeconds: 10,
    });
  });
  it.each([0, -2, 1.5, NaN, Infinity, MAX_TOAST_DURATION_SECONDS + 1, '3', null])(
    '拒绝非法时长 %s，不覆盖有效偏好',
    (value) => {
      expect(isToastDuration(value)).toBe(false);
      const f = fixture({ toastDurations: { successSeconds: value, failureSeconds: 8 } });
      expect(f.service.getSettings().toastDurations).toEqual({
        successSeconds: 3,
        failureSeconds: 8,
      });
      f.service.setSettings({ toastDurations: { successSeconds: 7 } });
      f.service.setSettings(
        JSON.parse(JSON.stringify({ toastDurations: { successSeconds: value } })),
      );
      expect(f.reopen().getSettings().toastDurations).toEqual({
        successSeconds: 7,
        failureSeconds: 8,
      });
    },
  );
});
