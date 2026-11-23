import type { AccountSession } from '@weq/account';
import { FetchGroupMemberListPage } from '@weqbot/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupInfoService } from '../src/account/group_info';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
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

it('一次访问多群后自动释放过期名单，强制更新延续该群的缓存有效期', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { service } = setup();
  const invoke = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockImplementation(async (_nt, _pid, { groupId }) => ({
      token: '',
      members: Array.from({ length: 400 }, (_, i) => ({
        ...member,
        uin: groupId * 400 + i,
        uid: `u_${groupId}_${i}`,
      })),
    }));
  // 过期条目只有从 Map 移除才能释放整份名单。
  const retained = Reflect.get(service, 'onlineMembersCache') as ReadonlyMap<
    number,
    { members: (typeof member)[] }
  >;
  for (let group = 1; group <= 80; group++) await service.fetchOnlineMembers(group);
  expect([...retained.values()].reduce((count, row) => count + row.members.length, 0)).toBe(32_000);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  const fresh = await service.fetchOnlineMembers(1, { force: true });
  await vi.advanceTimersByTimeAsync(30_000);
  expect([...retained.keys()]).toEqual([1]);
  expect(await service.fetchOnlineMembers(1)).toBe(fresh);
  expect(invoke).toHaveBeenCalledTimes(81);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(retained.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await service.fetchOnlineMembers(1);
  expect(invoke).toHaveBeenCalledTimes(82);
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

it('账号关闭清除在线名单及定时器，在途结果不能重新填充', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { service } = setup();
  let finish!: () => void;
  vi.spyOn(FetchGroupMemberListPage, 'invoke')
    .mockResolvedValueOnce({ members: [member], token: '' })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ members: [member], token: '' });
        }),
    );
  await service.fetchOnlineMembers(42);
  const inFlight = service.fetchOnlineMembers(43);
  expect(vi.getTimerCount()).toBe(1);
  service.disposeGroupProfiles();
  finish();
  await expect(inFlight).rejects.toThrow('账号已关闭');
  expect(Reflect.get(service, 'onlineMembersCache').size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
