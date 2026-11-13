// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { UserProfile, GroupDetail } from '@weq/db';
import type { GroupInfoService, ProfileService } from '@weq/service';
import { userProfileToWire } from '../src/main/ipc/serde';
import { createContactsExportDeps } from '../src/main/context/export_contacts';

const profile: UserProfile = {
  uid: 'u_one',
  uin: 10001n,
  nick: '本地昵称',
  remark: '本地备注',
  signature: '本地签名',
  sigUpdateTime: 1794326462,
  qid: '',
  avatarUrl: '',
  birthYear: 0,
  birthMonth: 0,
  birthDay: 0,
  gender: 0,
  age: 0,
  intimacy: 0,
  isFriend: true,
  isBot: false,
  extInfo: {
    occupation: 13,
    bloodType: 5,
    zodiac: 12,
    interactMarks: [{ type: 'fire', markId: 7 }],
    privileges: [],
    interests: [],
    album: [],
  },
};

it('资料 wire 完整保留本地字段，序列化不覆盖原始内容', () => {
  const before = structuredClone(profile);
  expect(userProfileToWire(profile)).toMatchObject({
    signature: '本地签名',
    sigUpdateTime: 1794326462,
    extInfo: {
      occupation: 13,
      bloodType: 5,
      zodiac: 12,
      interactMarks: [{ type: 'fire', markId: 7 }],
    },
  });
  expect(profile).toEqual(before);
});

it('导出适配器保留签名时间和群标签来源，BigInt 转换不损失精度', async () => {
  const group: GroupDetail = {
    groupCode: 12345n,
    groupName: '群',
    ownerUid: '',
    pinnedAnnounce: '',
    description: '',
    remark: '',
    createTime: 0,
    maxMemberCount: 200,
    memberCount: 1,
    labels: '',
    entranceQ: '',
    leaveFlag: 0,
    customLabels: [
      {
        groupCode: 12345n,
        labelId: 9007199254740993123n,
        setterUid: 'u_one',
        setTimestamp: 1794326462n,
        content: '标签',
      },
    ],
  };
  const groups = {
    listAllGroups: vi.fn(async () => [group]),
    getGroupDetail: vi.fn(async () => group),
  } as unknown as GroupInfoService;
  const profiles = { profilesByUids: vi.fn(async () => [profile]) } as unknown as ProfileService;
  const deps = createContactsExportDeps(profiles, groups);
  expect((await deps.profilesByUids(['u_one']))[0]).toMatchObject({
    sigUpdateTime: 1794326462,
    extInfo: profile.extInfo,
  });
  const row = (await deps.listGroups!(100, 0))[0]!;
  expect(row.customLabels?.[0]).toMatchObject({
    labelId: '9007199254740993123',
    setterUid: 'u_one',
    setTimestamp: '1794326462',
    content: '标签',
  });
  expect(await deps.groupByCode!('12345')).toEqual(row);
  expect(group.customLabels[0]!.labelId).toBe(9007199254740993123n);
});
