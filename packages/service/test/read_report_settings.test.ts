import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('已读上报偏好', () => {
  it('默认关闭，保存和重开后保留，与在线模式及其它设置独立', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-read-report-settings-'));
    roots.push(root);
    const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
    const service = new UserConfigService(platform);
    expect(service.getSettings().reportReadEnabled).toBe(false);
    expect(service.getSettings().manualReadReportEnabled).toBe(false);
    service.setSettings({ reportReadEnabled: true });
    expect(new UserConfigService(platform).getSettings().reportReadEnabled).toBe(true);
    expect(new UserConfigService(platform).getSettings().manualReadReportEnabled).toBe(false);
    service.setSettings({ manualReadReportEnabled: true });
    expect(new UserConfigService(platform).getSettings().manualReadReportEnabled).toBe(true);
    service.setSettings({ autoAttachQq: false, realtimeEnabled: false });
    expect(service.getSettings().reportReadEnabled).toBe(true);
    service.setSettings({ reportReadEnabled: false });
    const saved = new UserConfigService(platform).getSettings();
    expect(saved.reportReadEnabled).toBe(false);
    expect(saved.manualReadReportEnabled).toBe(true);
    expect(saved.realtimeEnabled).toBe(false);
    expect(saved.autoAttachQq).toBe(false);
  });
});
