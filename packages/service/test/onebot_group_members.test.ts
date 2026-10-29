import type { AccountSession } from '@weq/account';
import { FetchGroupMemberListPage } from '@weq/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupInfoService } from '../src/account/group_info';

afterEach(() => vi.restoreAllMocks());
function setup() {
  let pid = 1;
  const service = new GroupInfoService({} as AccountSession, {
    nt: { sendOidbPacket: vi.fn() },
    resolvePid: () => pid,
  });
  return {
    service,
    changePid: () => {
      pid++;
    },
  };
}
const member = {
  uin: 7,
  uid: 'u_peer',
  nickname: '合成成员',
  card: '',
  permission: 0,
  level: 1,
  specialTitle: '',
  joinTime: 1,
  lastSentTime: 1,
  shutUpTime: 0,
};

it('完整翻页、去重，缓存与 force 使用同一条实现', async () => {
  const invoke = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockResolvedValueOnce({ members: [member], token: 'next' })
    .mockResolvedValue({ members: [member, { ...member, uin: 8, uid: 'u_second' }], token: '' });
  const { service, changePid } = setup();
  expect(await service.fetchOnlineMembers(42)).toHaveLength(2);
  await service.fetchOnlineMembers(42);
  expect(invoke).toHaveBeenCalledTimes(2);
  await service.fetchOnlineMembers(42, { force: true });
  expect(invoke).toHaveBeenCalledTimes(3);
  changePid();
  await service.fetchOnlineMembers(42);
  expect(invoke).toHaveBeenCalledTimes(4);
});

it('分页游标循环失败，不缓存部分成员', async () => {
  const invoke = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockResolvedValue({ members: [member], token: 'loop' });
  const { service } = setup();
  await expect(service.fetchOnlineMembers(42)).rejects.toThrow('截断');
  expect(invoke).toHaveBeenCalledTimes(2);
  invoke.mockResolvedValue({ members: [member], token: '' });
  expect(await service.fetchOnlineMembers(42)).toHaveLength(1);
});

it('分页途中运行时切换不发布旧结果', async () => {
  const { service, changePid } = setup();
  vi.spyOn(FetchGroupMemberListPage, 'invoke').mockImplementationOnce(async () => {
    changePid();
    return { members: [member], token: '' };
  });
  await expect(service.fetchOnlineMembers(42)).rejects.toThrow('运行时已切换');
});
