import { beforeEach, expect, it, vi } from 'vitest';
import type { Platform } from '@weq/platform';
import type { AccountConfig } from '../src/account/user_config';
import type { AttachHook } from '../src/bootstrap/attach';
import {
  createOtherDeviceKeyContext,
  fetchOtherDeviceDatabaseKey,
} from '../src/account/other_device_key';

const f = vi.hoisted(() => ({
  register: vi.fn(),
  attach: vi.fn(),
  request: vi.fn(),
  guid: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('../src/account/sso_session', () => ({
  registerSsoSessionFromStored: f.register,
  attachAndRegisterSsoSession: f.attach,
  resolveDeviceGuid: f.guid,
}));
vi.mock('../src/account/online_ticket', () => ({ requestDecryptKeyFromInstance: f.request }));
const platform = { native: { ntHelper: {} } } as unknown as Platform;
const hook = { reset: f.reset } as unknown as AttachHook;
const record = (patch: Partial<AccountConfig> = {}): AccountConfig => ({
  uin: '12345',
  dbKey: 'old',
  algos: {},
  lastLoginAt: 0,
  ...patch,
});
const online = vi.fn(async () => [
  { uin: '12345', uid: 'u_online', pid: 42 },
  { uin: '99999', uid: 'u_other', pid: 99 },
]);
beforeEach(() => {
  vi.resetAllMocks();
  f.guid.mockReturnValue('current-guid');
  f.register.mockResolvedValue(true);
  f.attach.mockResolvedValue({ registered: true });
  f.request.mockResolvedValue('synthetic-key');
  online.mockResolvedValue([
    { uin: '12345', uid: 'u_online', pid: 42 },
    { uin: '99999', uid: 'u_other', pid: 99 },
  ]);
});
it('仅请求同账号，旧配置缺 UID 时使用在线账号身份及当前设备 GUID', async () => {
  const result = await fetchOtherDeviceDatabaseKey(
    platform,
    [record({ guid: 'stale-backup-guid' })],
    hook,
    '/backup/nt_msg.db',
    { enabled: true, expectedUin: '12345', resolveOnline: online },
  );
  expect(result).toMatchObject({ success: true, key: 'synthetic-key', uin: '12345', pid: 42 });
  expect(f.register).toHaveBeenCalledWith(
    platform.native.ntHelper,
    platform,
    42,
    '12345',
    expect.objectContaining({ uid: 'u_online', guid: 'current-guid' }),
  );
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.attach).not.toHaveBeenCalled();
});
it('遍历同账号已有配置，找到可复用物料后不提权', async () => {
  f.register.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await fetchOtherDeviceDatabaseKey(
    platform,
    [record(), record({ dataDir: '/second' })],
    hook,
    '/backup/nt_msg.db',
    { enabled: true, expectedUin: '12345', resolveOnline: online },
  );
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(f.attach).not.toHaveBeenCalled();
});
it('必要时读取一次物料，同批第二份备份复用成功登记的会话', async () => {
  f.register.mockResolvedValue(false);
  const context = createOtherDeviceKeyContext();
  for (const db of ['/backup/one/nt_msg.db', '/backup/two/nt_msg.db'])
    expect(
      await fetchOtherDeviceDatabaseKey(platform, [record()], hook, db, {
        enabled: true,
        expectedUin: '12345',
        resolveOnline: online,
        context,
      }),
    ).toMatchObject({ success: true });
  expect(f.attach).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledTimes(2);
});
it('取消提权不会反复提示；完全离线甚至不探测在线实例', async () => {
  f.register.mockResolvedValue(false);
  f.attach.mockRejectedValue(new Error('已取消读取'));
  const context = createOtherDeviceKeyContext();
  for (let i = 0; i < 2; i++)
    expect(
      await fetchOtherDeviceDatabaseKey(platform, [record()], hook, '/backup/nt_msg.db', {
        enabled: true,
        expectedUin: '12345',
        resolveOnline: online,
        context,
      }),
    ).toMatchObject({ success: false });
  expect(f.attach).toHaveBeenCalledOnce();
  expect(f.request).not.toHaveBeenCalled();
  online.mockClear();
  expect(
    await fetchOtherDeviceDatabaseKey(platform, [record()], hook, '/backup/nt_msg.db', {
      enabled: false,
      resolveOnline: online,
    }),
  ).toMatchObject({ success: false });
  expect(online).not.toHaveBeenCalled();
});
it('指定账号不在线时不借用其它账号', async () => {
  expect(
    await fetchOtherDeviceDatabaseKey(platform, [record()], hook, '/backup/nt_msg.db', {
      enabled: true,
      expectedUin: '77777',
      resolveOnline: online,
    }),
  ).toMatchObject({ success: false });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});
it('在线探测本身失败时保留明确失败结果，调用方仍可手动输入', async () => {
  online.mockRejectedValueOnce(new Error('synthetic process lookup failed'));
  expect(
    await fetchOtherDeviceDatabaseKey(platform, [record()], hook, '/backup/nt_msg.db', {
      enabled: true,
      expectedUin: '12345',
      resolveOnline: online,
    }),
  ).toMatchObject({
    success: false,
    error: expect.stringContaining('synthetic process lookup failed'),
  });
  expect(f.request).not.toHaveBeenCalled();
});
it('缓存票据被 SSO 层拒绝时只刷新一次，业务不匹配不反复读取内存', async () => {
  f.request
    .mockRejectedValueOnce(new Error('SSO error 9999: synthetic stale session'))
    .mockResolvedValueOnce('fresh-key');
  expect(
    await fetchOtherDeviceDatabaseKey(platform, [record()], hook, '/backup/nt_msg.db', {
      enabled: true,
      expectedUin: '12345',
      resolveOnline: online,
    }),
  ).toMatchObject({ success: true, key: 'fresh-key' });
  expect(f.reset).toHaveBeenCalledWith(42);
  expect(f.attach).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledTimes(2);
  f.attach.mockClear();
  f.reset.mockClear();
  f.request.mockRejectedValueOnce(new Error('数据库不匹配！检查数据库是否属于当前帐号'));
  expect(
    await fetchOtherDeviceDatabaseKey(platform, [record()], hook, '/backup/nt_msg.db', {
      enabled: true,
      expectedUin: '12345',
      resolveOnline: online,
    }),
  ).toMatchObject({ success: false });
  expect(f.attach).not.toHaveBeenCalled();
  expect(f.reset).not.toHaveBeenCalled();
});
