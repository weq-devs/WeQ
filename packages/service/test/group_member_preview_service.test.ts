import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { FetchGroupMemberListPage } from '@weq/protocol';
import { GroupInfoService } from '../src/account/group_info';
import { GROUP_PREVIEW_CANDIDATES } from '../src/account/group_member_preview';
afterEach(() => vi.restoreAllMocks());
it('真实服务使用单页协议，即使返回续页 token 也不续读或写入完整名单缓存', async () => {
  const local = vi.fn(async () => []);
  const session = {
    groupMembers: { listMembersInGroup: local },
    buddies: { listBuddies: async () => [{ uid: 'u_9', uin: 10009n }] },
  } as unknown as AccountSession;
  const service = new GroupInfoService(session, {
    resolvePid: () => 1350,
    nt: { sendOidbPacket: vi.fn() },
  });
  const rows = Array.from({ length: 10 }, (_, n) => ({
    uid: `u_${n}`,
    uin: 10000 + n,
    nickname: `成员${n}`,
    card: '',
    permission: 4,
    level: 1,
    specialTitle: '',
    joinTime: 0,
    lastSentTime: 0,
    shutUpTime: 0,
  }));
  const page = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockResolvedValueOnce({ members: rows, token: 'next-page' })
    .mockResolvedValue({ members: rows, token: '' });
  const full = vi.spyOn(service, 'fetchOnlineMembers');
  const result = await service.getMemberPreview('12345', true);
  expect(result.members).toHaveLength(8);
  expect(result.members[0]?.uid).toBe('u_9');
  expect(local).toHaveBeenCalledWith(12345n, GROUP_PREVIEW_CANDIDATES, 0);
  expect(page).toHaveBeenCalledTimes(1);
  expect(page.mock.calls[0]?.[2]).toEqual({ groupId: 12345 });
  expect(full).not.toHaveBeenCalled();
  await service.fetchOnlineMembers(12345);
  expect(page).toHaveBeenCalledTimes(2);
  service.disposeGroupProfiles();
});
