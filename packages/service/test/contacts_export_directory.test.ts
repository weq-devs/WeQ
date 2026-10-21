import type { AccountSession } from '@weq/account';
import type { Buddy, GroupDetail, GroupMember } from '@weq/db';
import { describe, expect, it, vi } from 'vitest';
import { ProfileService } from '../src/account/profile';
import { GroupInfoService } from '../src/account/group_info';

describe('联系人导出目录覆盖', () => {
  it('好友目录补齐超过两千条的昵称，未缓存资料不丢弃好友身份', async () => {
    const buddies = Array.from({ length: 2005 }, (_, index) => ({
      uid: `u_${index}`,
      uin: BigInt(10001 + index),
      categoryId: index % 2,
    })) as Buddy[];
    const names = buddies.map((buddy, index) => ({
      uid: buddy.uid,
      uin: buddy.uin.toString(),
      nick: `合成昵称 ${index}`,
      remark: index === 2004 ? '最后一位的备注' : '',
      intimacy: 1,
    }));
    const listBuddies = vi.fn(async () => buddies);
    const listNames = vi.fn(async (limit: number, offset: number) =>
      names.slice(offset, offset + limit),
    );
    const session = {
      buddies: { listBuddies },
      profileInfo: { listFriendsByIntimacy: listNames },
    } as unknown as AccountSession;
    const result = await new ProfileService(session).listExportFriends();
    expect(result).toHaveLength(2005);
    expect(result.at(-1)).toMatchObject({ uid: 'u_2004', name: '最后一位的备注' });
    expect(listBuddies).toHaveBeenCalledWith(undefined, 0);
    expect(listNames.mock.calls).toEqual([
      [1000, 0],
      [1000, 1000],
      [1000, 2000],
    ]);
    listNames.mockResolvedValue([]);
    expect((await new ProfileService(session).listExportFriends())[0]).toMatchObject({
      uid: 'u_0',
      name: '10001',
    });
  });

  it('群目录和单群成员均读取全部页，不设置总量截断', async () => {
    const groups = Array.from({ length: 2005 }, (_, index) => ({
      groupCode: BigInt(10001 + index),
      groupName: `合成群 ${index}`,
      remark: '',
      memberCount: 605,
    })) as GroupDetail[];
    const members = Array.from({ length: 605 }, (_, index) => ({
      uid: `member_${index}`,
      uin: BigInt(20001 + index),
      card: index === 604 ? '最后一位群名片' : '',
      nick: `合成成员 ${index}`,
    })) as GroupMember[];
    const listGroups = vi.fn(async (limit: number, offset: number) =>
      groups.slice(offset, offset + limit),
    );
    const listMembers = vi.fn(async (_code: bigint, limit: number, offset: number) =>
      members.slice(offset, offset + limit),
    );
    const session = {
      groupDetail: { listAll: listGroups },
      groupMembers: { listMembersInGroup: listMembers },
    } as unknown as AccountSession;
    const service = new GroupInfoService(session);
    expect(await service.listExportGroups()).toHaveLength(2005);
    expect(listGroups.mock.calls).toEqual([
      [1000, 0],
      [1000, 1000],
      [1000, 2000],
    ]);
    const result = await service.listExportMembers(10001n);
    expect(result).toHaveLength(605);
    expect(result.at(-1)).toMatchObject({ uid: 'member_604', name: '最后一位群名片' });
    expect(listMembers.mock.calls).toEqual([
      [10001n, 300, 0],
      [10001n, 300, 300],
      [10001n, 300, 600],
    ]);
  });
});
