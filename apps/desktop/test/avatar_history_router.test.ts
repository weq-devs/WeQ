// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ProfileExtrasService } from '@weq/service';
import * as protocol from '@weq/protocol';
import { createProfileExtrasRouter } from '../src/main/ipc/routers/profile_extras';

it('本人接口拒绝额外目标参数，来源绑定后才读取', async () => {
  const read = vi.fn(async () => ({
    items: [],
    nextCursor: null,
    hasMore: false,
    paginationError: null,
  }));
  const service = new ProfileExtrasService({ sendPacket: vi.fn() }, '10001', () => 5, {
    ...protocol,
    getSelfAvatarHistory: read,
  });
  const services = { profileExtras: service };
  const caller = createProfileExtrasRouter((input) => {
    if (input.expectedAccountConfigId !== 'a') throw new Error('账号已切换');
    return services;
  }).createCaller({});
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'a' };
  expect(await caller.avatarHistory(binding)).toMatchObject({ targetUin: '10001' });
  await expect(caller.avatarHistory({ ...binding, expectedAccountConfigId: 'b' })).rejects.toThrow(
    '切换',
  );
  await expect(
    caller.avatarHistory({ ...binding, uin: '10002' } as typeof binding),
  ).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
});
