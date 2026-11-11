import { describe, expect, it, vi } from 'vitest';
import type { GroupMember } from '@weq/db';
import {
  GroupMemberPreviewReader,
  selectPreviewMembers,
  GROUP_PREVIEW_LIMIT,
} from '../src/account/group_member_preview';

const member = (id: number, patch: Partial<GroupMember> = {}): GroupMember => ({
  groupCode: 12345n,
  uid: `u_${id}`,
  uin: BigInt(10000 + id),
  card: '',
  nick: `成员${id}`,
  joinTime: id,
  lastSpeakTime: 0,
  muteUntil: 0,
  adminFlag: 0,
  memberFlag: 0,
  customTitle: '',
  memberLevel: 0,
  ...patch,
});
describe('有界群成员预览', () => {
  it('已知好友优先，稳定去重并排除已退群／无效成员', () => {
    const rows = Array.from({ length: 12 }, (_, i) => member(i));
    const result = selectPreviewMembers(
      [member(99, { memberFlag: 1 }), member(98, { uin: 0n }), ...rows, rows[1]!],
      new Set(['u_10', '10011']),
    );
    expect(result).toHaveLength(GROUP_PREVIEW_LIMIT);
    expect(result.map((row) => row.uid)).toEqual([
      'u_10',
      'u_11',
      'u_0',
      'u_1',
      'u_2',
      'u_3',
      'u_4',
      'u_5',
    ]);
  });
  it('本地八位足够时不调用在线首屏，缓存与在途请求复用', async () => {
    const reader = new GroupMemberPreviewReader();
    const local = vi.fn(async () => Array.from({ length: 32 }, (_, i) => member(i)));
    const online = vi.fn(async () => []);
    const readers = { local, online, friends: async () => new Set<string>(), cached: () => [] };
    const [a, b] = await Promise.all([
      reader.read('12345', readers),
      reader.read('12345', readers),
    ]);
    expect(a.members).toHaveLength(8);
    expect(b).toEqual(a);
    await reader.read('12345', readers);
    expect(local).toHaveBeenCalledTimes(1);
    expect(online).not.toHaveBeenCalled();
  });
  it('只调用一次在线页，局部失败保留本地值且允许重试', async () => {
    const reader = new GroupMemberPreviewReader();
    const online = vi
      .fn()
      .mockRejectedValueOnce(new Error('离线'))
      .mockResolvedValue(Array.from({ length: 20 }, (_, i) => member(i)));
    const readers = {
      local: async () => [member(0)],
      online,
      friends: async () => new Set(['u_19']),
      cached: () => [],
    };
    const failed = await reader.read('12345', readers);
    expect(failed.members.map((row) => row.uid)).toEqual(['u_0']);
    expect(failed.error).toContain('保留已有成员');
    const success = await reader.read('12345', readers);
    expect(success.members[0]?.uid).toBe('u_19');
    expect(success.members).toHaveLength(8);
    expect(online).toHaveBeenCalledTimes(2);
    expect(success.partial).toBe(true);
  });
  it('有界候选之外的好友不触发扫描，离线不启动在线查询', async () => {
    const result = await new GroupMemberPreviewReader().read('12345', {
      local: async () => Array.from({ length: 100 }, (_, i) => member(i)),
      friends: async () => new Set(['u_99']),
      cached: () => [],
    });
    expect(result.members.some((row) => row.uid === 'u_99')).toBe(false);
    expect(result.members).toHaveLength(8);
  });
});
