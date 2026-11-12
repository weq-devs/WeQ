import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { GroupInfoService } from '../src/account/group_info';
import { GroupProfileReader, type GroupProfileResult } from '../src/account/group_profile';
import type { ContactMetricsService } from '../src/account/contact_metrics';
import { validGroupProfile } from '../src/account/contact_cache_validation';

const profile = {
  joinedAt: 1704038407,
  grade: null,
  activeMemberCount: null,
  freezeState: null,
  freezeReason: null,
  portraitSequence: null,
  portrait: null,
};
afterEach(() => vi.restoreAllMocks());
function fixture(joinedAt: number | null = profile.joinedAt, local = 1704124800) {
  const result: GroupProfileResult = {
    groupId: 123,
    profile: { ...profile, joinedAt },
    updatedAt: 1000,
    source: 'online',
    error: null,
  };
  const read = vi.spyOn(GroupProfileReader.prototype, 'read').mockResolvedValue(result);
  const member = vi.fn(async () => ({ memberFlag: 0, joinTime: local }));
  const byUin = vi.fn(async () => [{ memberFlag: 0, joinTime: local }]);
  const session = {
    selfUid: 'u_self',
    context: { uin: '10001' },
    groupMembers: { getMember: member, getMembersByUins: byUin },
  };
  const service = new GroupInfoService(session as unknown as AccountSession);
  const project = vi.fn(async (_key: string, _values: Record<string, unknown>, _at?: number) => {}),
    failed = vi.fn(async () => {});
  const row = vi.fn(async (): Promise<{ joinedAt?: { value: number } }> => ({}));
  service.contactMetrics = { project, failed, row } as unknown as ContactMetricsService;
  return { service, session, member, byUin, read, result, project, failed, row };
}
it('直接本人时间优先于本地旧值，同步到群排序指标，不查成员列表', async () => {
  const f = fixture();
  const members = vi.spyOn(f.service, 'fetchOnlineMembers');
  expect((await f.service.getExtendedProfile(123, true)).joinedAt).toBe(profile.joinedAt);
  expect(f.project).toHaveBeenCalledWith('group:123', { joinedAt: profile.joinedAt }, 1000);
  expect(f.member).not.toHaveBeenCalled();
  expect(members).not.toHaveBeenCalled();
});
it('旧快照、缺字段和在线失败仍可用本地本人时间，不拉全群', async () => {
  const f = fixture(null);
  f.result.profile = { ...profile, joinedAt: undefined };
  f.result.source = 'cache';
  f.result.error = '在线读取失败';
  expect((await f.service.getExtendedProfile(123, true)).joinedAt).toBe(1704124800);
  expect(f.member).toHaveBeenCalledWith(123n, 'u_self');
  expect(f.project).toHaveBeenCalledWith('group:123', { joinedAt: 1704124800 }, 1000);
});
it('无 UID 时仅按本人号码查找；退出成员及 0／1 占位不投影为日期', async () => {
  const f = fixture(null);
  f.session.selfUid = '';
  expect((await f.service.getExtendedProfile(123)).joinedAt).toBe(1704124800);
  expect(f.byUin).toHaveBeenCalledWith(123n, [10001n]);
  for (const member of [
    { memberFlag: 1, joinTime: 1704124800 },
    { memberFlag: 0, joinTime: 0 },
    { memberFlag: 0, joinTime: 1 },
  ]) {
    f.byUin.mockResolvedValueOnce([member]);
    f.project.mockClear();
    expect((await f.service.getExtendedProfile(123)).joinedAt).toBeNull();
    expect(f.project.mock.calls.some(([, values]) => Object.hasOwn(values, 'joinedAt'))).toBe(
      false,
    );
  }
});
it('直接字段和本地均缺失时保留先前已知指标，不清空或伪造新日期', async () => {
  const f = fixture(null, 0);
  f.row.mockResolvedValue({ joinedAt: { value: profile.joinedAt } });
  expect((await f.service.getExtendedProfile(123)).joinedAt).toBe(profile.joinedAt);
  expect(f.project.mock.calls.some(([, values]) => Object.hasOwn(values, 'joinedAt'))).toBe(false);
});
it('本地补值期间账号关闭后不回填排序指标', async () => {
  const f = fixture(null);
  f.member.mockImplementationOnce(async () => {
    f.service.disposeGroupProfiles();
    return { memberFlag: 0, joinTime: 1704124800 };
  });
  await expect(f.service.getExtendedProfile(123)).rejects.toThrow('关闭');
  expect(f.project).not.toHaveBeenCalled();
});
it('兼容没有新字段的旧缓存，拒绝无效新日期字段', () => {
  const { joinedAt: _old, ...legacy } = profile;
  expect(validGroupProfile(legacy)).toBe(true);
  expect(validGroupProfile(profile)).toBe(true);
  for (const joinedAt of [1, 0, -1, 0x100000000, '1704038407', Number.NaN])
    expect(validGroupProfile({ ...profile, joinedAt })).toBe(false);
});
