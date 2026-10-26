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
import { fullModeAllowed, requestFullMode } from '../src/main/context/full_mode';

it.each([
  [false, false],
  [true, true],
  [true, false],
  [false, true],
])('运行请求不进入真实配置快照，已读旧组合 %s/%s 备份重开保持', (automaticRead, manualRead) => {
  const source = configFixture({
    welcomePolicyVersion: WELCOME_POLICY_VERSION,
    settings: {
      autoAttachQq: false,
      reportReadEnabled: automaticRead,
      manualReadReportEnabled: manualRead,
      restrictedModeBannerEnabled: false,
    },
  });
  const account = { uin: '10001', configId: 'synthetic-live' };
  const host = { account, bootstrap: { userConfig: source.service } };
  expect(fullModeAllowed(host)).toBe(false);
  requestFullMode(host, account);
  expect(fullModeAllowed(host)).toBe(true);
  const snapshot = snapshotWeqSettings(source.service.getSettings());
  expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
  expect(snapshot).toMatchObject({
    autoAttachQq: false,
    reportReadEnabled: automaticRead,
    manualReadReportEnabled: manualRead,
    restrictedModeBannerEnabled: false,
  });
  expect(Object.keys(snapshot).sort()).toEqual(
    Object.keys(snapshotWeqSettings(DEFAULT_APP_SETTINGS)).sort(),
  );
  for (const key of ['manualFullMode', 'fullModeRequest', 'effective', 'temporaryPrivacy'])
    expect(() => validateWeqAppSettings({ ...snapshot, [key]: true })).toThrow('字段无效');
  const target = configFixture();
  target.service.setSettings(snapshot);
  const reopened = target.open();
  expect(reopened.getSettings()).toMatchObject(snapshot);
  expect(fullModeAllowed({ account: { ...account }, bootstrap: { userConfig: reopened } })).toBe(
    false,
  );
  expect(fullModeAllowed({ ...host })).toBe(false);
});
it('缺少新增字段的旧配置/部分备份保留本机设置，默认值与配置作用域不互相覆盖', () => {
  const f = configFixture({
    welcomePolicyVersion: WELCOME_POLICY_VERSION,
    settings: { autoAttachQq: true, manualReadReportEnabled: true },
  });
  expect(f.service.getSettings()).toMatchObject({
    autoAttachQq: true,
    restrictedModeBannerEnabled: DEFAULT_APP_SETTINGS.restrictedModeBannerEnabled,
    reportReadEnabled: false,
    manualReadReportEnabled: true,
  });
  f.service.setSettings({ restrictedModeBannerEnabled: false });
  f.service.setSettings({ renderTextMarkdown: false });
  expect(f.open().getSettings()).toMatchObject({
    autoAttachQq: true,
    restrictedModeBannerEnabled: false,
    reportReadEnabled: false,
    manualReadReportEnabled: true,
  });
});
