import { afterEach, expect, it, vi } from 'vitest';
import {
  dataSaverBehaviorDefaults,
  allowNetwork,
  shouldPauseTransfer,
  networkCost,
  UNKNOWN_NETWORK,
} from '../src/common/data_saver';
import { preferenceDefaults, validatePreferencePatch } from '../src/common/client_preferences';
import { networkScope, scopedNetworkAllowed } from '../src/common/network_scope';
import { updateTransferPolicy } from '../src/common/transfer_policy';
import { ManagedDownload } from '../src/common/managed_download';

afterEach(() => updateTransferPolicy('auto', UNKNOWN_NETWORK));

it('十二项默认值兼容旧配置，行为偏好具有严格类型和整数阈值', () => {
  expect(preferenceDefaults).toMatchObject(dataSaverBehaviorDefaults);
  expect(() => validatePreferencePatch(dataSaverBehaviorDefaults)).not.toThrow();
  for (const dataSaverImageLoading of ['none', 'thumbnail', 'original'])
    expect(() => validatePreferencePatch({ dataSaverImageLoading })).not.toThrow();
  for (const dataSaverLargeMiB of [1, 10, 1024, 1048576])
    expect(() => validatePreferencePatch({ dataSaverLargeMiB })).not.toThrow();
  for (const dataSaverLargeMiB of [0, -1, 1.5, Infinity, NaN, '10', 1048577])
    expect(() => validatePreferencePatch({ dataSaverLargeMiB })).toThrow();
  expect(() => validatePreferencePatch({ dataSaverAvatars: 'false' })).toThrow();
  expect(() => validatePreferencePatch({ dataSaverImageLoading: 'auto' })).toThrow();
});

it.each([
  ['avatar', 'dataSaverAvatars'],
  ['video-cover', 'dataSaverVideoCovers'],
  ['emoji', 'dataSaverEmoji'],
  ['dress', 'dataSaverDress'],
  ['link-preview', 'dataSaverLinkPreviews'],
] as const)('%s 自动联网分别服从自己的开关，不受预取开关替代', (resource, key) => {
  expect(
    allowNetwork(true, 'prefetch', { ...dataSaverBehaviorDefaults, [key]: true }, resource),
  ).toBe(true);
  expect(
    allowNetwork(
      true,
      'thumbnail',
      { ...dataSaverBehaviorDefaults, [key]: false, dataSaverPrefetch: true },
      resource,
    ),
  ).toBe(false);
  expect(
    allowNetwork(true, 'interactive', { ...dataSaverBehaviorDefaults, [key]: false }, resource),
  ).toBe(true);
  expect(
    allowNetwork(false, 'prefetch', { ...dataSaverBehaviorDefaults, [key]: false }, resource),
  ).toBe(true);
});

it('图片三档、预取及批量任务各自独立，关闭省流量时不限制', () => {
  for (const dataSaverImageLoading of ['none', 'thumbnail', 'original'] as const)
    expect(
      allowNetwork(
        true,
        'thumbnail',
        { ...dataSaverBehaviorDefaults, dataSaverImageLoading },
        'image',
      ),
    ).toBe(dataSaverImageLoading !== 'none');
  expect(allowNetwork(true, 'prefetch')).toBe(false);
  expect(
    allowNetwork(true, 'prefetch', { ...dataSaverBehaviorDefaults, dataSaverPrefetch: true }),
  ).toBe(true);
  expect(
    allowNetwork(true, 'batch', { ...dataSaverBehaviorDefaults, dataSaverPauseBatch: false }),
  ).toBe(true);
  expect(allowNetwork(false, 'batch')).toBe(true);
});

it('后台和客户端请求读取同一份共享策略，并保留明确的主动操作', () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, {
    dataSaverDress: true,
    dataSaverAvatars: false,
  });
  expect(scopedNetworkAllowed('dress')).toBe(true);
  expect(scopedNetworkAllowed('avatar')).toBe(false);
  expect(
    networkScope.run({ restricted: true, intent: 'thumbnail', resource: 'avatar' }, () =>
      scopedNetworkAllowed(),
    ),
  ).toBe(false);
  expect(
    networkScope.run({ restricted: true, intent: 'interactive', resource: 'avatar' }, () =>
      scopedNetworkAllowed(),
    ),
  ).toBe(true);
});

it('大文件阈值和批量暂停独立，未知大小按实际接收量判断', () => {
  const behavior = {
    ...dataSaverBehaviorDefaults,
    dataSaverLargeMiB: 2,
    dataSaverPauseBatch: false,
  };
  expect(shouldPauseTransfer(true, true, 0, 0, behavior)).toBe(false);
  expect(shouldPauseTransfer(true, false, 2 * 1024 * 1024 - 1, 0, behavior)).toBe(false);
  expect(shouldPauseTransfer(true, false, 0, 2 * 1024 * 1024, behavior)).toBe(true);
  expect(
    shouldPauseTransfer(true, false, 100 * 1024 * 1024, 0, {
      ...behavior,
      dataSaverPauseLarge: false,
    }),
  ).toBe(false);
  expect(
    shouldPauseTransfer(true, true, 0, 0, {
      ...behavior,
      dataSaverPauseBatch: true,
      dataSaverPauseLarge: false,
    }),
  ).toBe(true);
});

it('关闭自动继续后网络恢复仍保持暂停，手动继续不改变共享设置', async () => {
  const states: Array<{ paused: boolean; reasons: string[] }> = [];
  updateTransferPolicy('auto', networkCost(true, false, 'fixture'), { dataSaverAutoResume: false });
  const transfer = new ManagedDownload({ batch: true, state: (state) => states.push(state) });
  const response = transfer.response(new Response('ok'));
  const done = vi.fn();
  const reading = response.text().then(done);
  await vi.waitFor(() => expect(states.at(-1)?.paused).toBe(true));
  updateTransferPolicy('auto', networkCost(false, false, 'fixture'), {
    dataSaverAutoResume: false,
  });
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  expect(states.at(-1)).toMatchObject({ paused: true, reasons: ['resume-required'] });
  transfer.continue();
  await reading;
  expect(done).toHaveBeenCalledWith('ok');
});

it('禁用大文件暂停后已等待的下载可继续，用户手动暂停仍保留', async () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverLargeMiB: 1 });
  const transfer = new ManagedDownload();
  const response = transfer.response(
    new Response('ok', { headers: { 'Content-Length': String(1024 * 1024) } }),
  );
  const done = vi.fn();
  const reading = response.text().then(done);
  await Promise.resolve();
  transfer.pause();
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverPauseLarge: false });
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  transfer.continue();
  await reading;
  expect(done).toHaveBeenCalledWith('ok');
});
