import { expect, it, vi } from 'vitest';
import * as protocol from '@weq/protocol';
import { ProfileExtrasService } from '../src/account/profile_extras';

const readers = {
  ...protocol,
  getSelfAvatarHistory: vi.fn(async () => ({
    items: [],
    nextCursor: null,
    hasMore: false,
    paginationError: null,
  })),
};
it('本人来源由服务绑定，不接受外部目标，同游标复用在途请求', async () => {
  const read = vi.fn(async () => ({
    items: [],
    nextCursor: null,
    hasMore: false,
    paginationError: null,
  }));
  const nt = { sendPacket: vi.fn() };
  const service = new ProfileExtrasService(nt, '10001', () => 5, {
    ...readers,
    getSelfAvatarHistory: read,
  });
  const [a, b] = await Promise.all([service.avatarHistory(300), service.avatarHistory(300)]);
  expect(a).toEqual({
    targetUin: '10001',
    items: [],
    nextCursor: null,
    hasMore: false,
    paginationError: null,
  });
  expect(b).toEqual(a);
  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith(nt, 5, 300);
});
it('切换进程后拒绝旧头像响应', async () => {
  let pid = 5;
  const service = new ProfileExtrasService({ sendPacket: vi.fn() }, '10001', () => pid, {
    ...readers,
    getSelfAvatarHistory: async () => {
      pid = 6;
      return { items: [], nextCursor: null, hasMore: false, paginationError: null };
    },
  });
  await expect(service.avatarHistory()).rejects.toThrow('切换');
});
