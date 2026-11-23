// @vitest-environment node
import { expect, it } from 'vitest';
import { configFixture } from '../../../packages/service/test/support/user_config';
import {
  snapshotWeqSettings,
  validateWeqAppSettings,
} from '../../../packages/service/src/bootstrap/backup_settings';
import {
  DEFAULT_APP_SETTINGS,
  WELCOME_POLICY_VERSION,
} from '../../../packages/service/src/bootstrap/user_config';
import { fullModeAllowed } from '../src/main/context/full_mode';

it.each([
  [false, false, false],
  [true, true, true],
  [true, false, true],
  [false, true, false],
])('还原备份保留自动上报 %s、手动上报 %s、QQ 在线能力 %s', (automaticRead, manualRead, enabled) => {
  const source = configFixture({
    welcomePolicyVersion: WELCOME_POLICY_VERSION,
    settings: {
      autoAttachQq: enabled,
      reportReadEnabled: automaticRead,
      manualReadReportEnabled: manualRead,
      restrictedModeBannerEnabled: false,
    },
  });
  const account = { uin: '10001', configId: 'synthetic-live' };
  const snapshot = snapshotWeqSettings(source.service.getSettings());
  expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
  expect(snapshot).toMatchObject({
    autoAttachQq: enabled,
    reportReadEnabled: automaticRead,
    manualReadReportEnabled: manualRead,
    restrictedModeBannerEnabled: false,
  });
  expect(Object.keys(snapshot).sort()).toEqual(
    Object.keys(snapshotWeqSettings(DEFAULT_APP_SETTINGS)).sort(),
  );
  for (const key of ['manualFullMode', 'fullModeRequest', 'effective', 'temporaryPrivacy'])
    expect(() => validateWeqAppSettings({ ...snapshot, [key]: true })).toThrow('字段无效');
    const target = configFixture({ welcomePolicyVersion: WELCOME_POLICY_VERSION });
  target.service.setSettings(snapshot);
  const reopened = target.open();
  expect(reopened.getSettings()).toMatchObject(snapshot);
  expect(fullModeAllowed({ account: { ...account }, bootstrap: { userConfig: reopened } })).toBe(
    enabled,
  );
});
it('缺少新增字段的旧配置/部分备份保留本机设置，默认值与配置作用域不互相覆盖', () => {
  const f = configFixture({
    welcomePolicyVersion: WELCOME_POLICY_VERSION,
    settings: { autoAttachQq: true, manualReadReportEnabled: true },
  });
  expect(f.service.getSettings()).toMatchObject({
    autoAttachQq: true,
    restrictedModeBannerEnabled: DEFAULT_APP_SETTINGS.restrictedModeBannerEnabled,
    reportReadEnabled: DEFAULT_APP_SETTINGS.reportReadEnabled,
    manualReadReportEnabled: true,
  });
  f.service.setSettings({ restrictedModeBannerEnabled: false });
  f.service.setSettings({ renderTextMarkdown: false });
  expect(f.open().getSettings()).toMatchObject({
    autoAttachQq: true,
    restrictedModeBannerEnabled: false,
    reportReadEnabled: DEFAULT_APP_SETTINGS.reportReadEnabled,
    manualReadReportEnabled: true,
  });
});
