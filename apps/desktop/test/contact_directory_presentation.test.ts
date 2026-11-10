import { expect, it } from 'vitest';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';
import type { ContactMetricRows } from '@weq/service';
import {
  friendDirectoryTitle,
  friendSortDetail,
  groupDirectoryTitle,
  groupSortDetail,
} from '../src/renderer/src/lib/contactDirectoryPresentation';
import {
  FRIEND_SORTS,
  GROUP_SORTS,
  type FriendSort,
  type GroupSort,
} from '../src/renderer/src/lib/contactListOrder';

const friend: Contact = {
  id: 'u_test',
  identityValue: '12345',
  identityLabel: 'QQ',
  username: '昵称',
  displayName: '备注',
  avatarUrl: null,
  createdAt: '',
  nick: '昵称',
  remark: '备注',
  age: 23,
  birthYear: 2000,
  birthMonth: 2,
  birthDay: 29,
  intimacy: 86,
};
const group: GroupConversation['group'] = {
  id: '67890',
  identityValue: '67890',
  identityLabel: '群',
  name: '群名',
  remark: '群备注',
  avatarUrl: null,
  memberCount: 328,
  role: 'member',
  createTime: '2018-06-11T16:30:00Z',
};
const ready = (value: number) => ({ value, state: 'ready' as const, attemptedAt: 1 });
const rows: ContactMetricRows = {
  'friend:12345': {
    level: ready(64),
    likeCount: ready(12580),
    addedAt: ready(Date.UTC(2022, 7, 31, 16, 30, 7) / 1000),
    commonFriends: ready(12),
    commonGroups: { ...ready(0), value: [] },
  },
  'group:67890': { activityScore: ready(78), friendCount: ready(16) },
};

it('备注、昵称与群名排序仅切换第一行，第二行不返回替代信息', () => {
  expect(friendDirectoryTitle(friend, 'remark')).toBe('备注');
  expect(friendDirectoryTitle(friend, 'nick')).toBe('昵称');
  expect(friendDirectoryTitle(friend, 'uin')).toBe('备注');
  expect(friendDirectoryTitle({ ...friend, remark: ' ' }, 'remark')).toBe('昵称');
  expect(groupDirectoryTitle(group, 'remark')).toBe('群备注');
  expect(groupDirectoryTitle(group, 'name')).toBe('群名');
  expect(friendSortDetail(friend, 'remark', rows)).toBeNull();
  expect(friendSortDetail(friend, 'nick', rows)).toBeNull();
  expect(groupSortDetail(group, 'remark', rows)).toBeNull();
  expect(groupSortDetail(group, 'name', rows)).toBeNull();
});
it('群名使用原始详情，缺失和恰好等于群号的真实名称分别处理', () => {
  expect(groupDirectoryTitle(group, 'name', new Map([[group.id, '原始群名']]))).toBe('原始群名');
  expect(groupDirectoryTitle(group, 'name', new Map([[group.id, '']]))).toBe('群名未读取');
  expect(groupDirectoryTitle(group, 'name', new Map([[group.id, group.id]]))).toBe(group.id);
});
it.each(['age', 'birthday'] as const)(
  '按 %s 排序统一显示完整出生日期及原始年龄，不从年份反推年龄',
  (sort) => {
    expect(friendSortDetail(friend, sort, rows)?.text).toBe('2000-02-29 （23 岁）');
    expect(friendSortDetail({ ...friend, birthYear: undefined }, sort, rows)?.text).toBe(
      '????-02-29 （23 岁）',
    );
    expect(friendSortDetail({ ...friend, birthYear: 2001, age: 0 }, sort, rows)?.text).toBe(
      '2001-02-?? （年龄未读取）',
    );
    expect(friendSortDetail({ ...friend, birthMonth: 13 }, sort, rows)?.text).toBe(
      '2000-??-?? （23 岁）',
    );
  },
);
it.each([
  ['uin', 'QQ 号：12345'],
  ['intimacy', '亲密度：86'],
  ['level', 'QQ 等级：64'],
  ['likeCount', '获赞：12,580'],
  ['addedAt', '2022-09-01 00:30:07'],
  ['commonFriends', '共同好友：12 人'],
  ['commonGroups', '共同群聊：0 个'],
] as const)('好友 %s 显示对应值', (sort, expected) => {
  expect(friendSortDetail(friend, sort, rows)?.text).toBe(expected);
});
it.each([
  ['groupCode', '群号：67890'],
  ['memberCount', '328 位成员'],
  ['activityScore', '活跃度：78'],
  ['createTime', '创建于 2018-06-12'],
  ['friendCount', '群内好友：16 / 328 人'],
] as const)('群聊 %s 显示对应值', (sort, expected) => {
  expect(groupSortDetail(group, sort, rows)?.text).toBe(expected);
});
it('共同群聊列表计数，与排序一样支持 UID 别名和真实零值', () => {
  const aliases: ContactMetricRows = {
    'friend:u_test': { commonGroups: { ...ready(0), value: [{ groupCode: '1', name: '合成群' }] } },
  };
  expect(friendSortDetail(friend, 'commonGroups', aliases)?.text).toBe('共同群聊：1 个');
  expect(friendSortDetail(friend, 'level', { 'friend:12345': { level: ready(0) } })?.text).toBe(
    'QQ 等级：0',
  );
  expect(
    groupSortDetail(group, 'friendCount', { 'group:67890': { friendCount: ready(0) } })?.text,
  ).toBe('群内好友：0 / 328 人');
  expect(groupSortDetail({ ...group, memberCount: 0 }, 'friendCount', rows)?.text).toBe(
    '群内好友：16 / 未知 人',
  );
});
it('缺失不冒充零，读取失败与陈旧缓存保留状态及北京时间更新时间', () => {
  expect(friendSortDetail(friend, 'level', {})?.text).toBe('QQ 等级未读取');
  const failed: ContactMetricRows = {
    'friend:12345': { level: { state: 'failed', attemptedAt: 1, error: '离线' } },
  };
  expect(friendSortDetail(friend, 'level', failed)).toEqual({
    text: 'QQ 等级读取失败',
    title: '离线',
  });
  const stale: ContactMetricRows = {
    'friend:12345': {
      level: { ...ready(64), state: 'stale', updatedAt: Date.UTC(2026, 10, 9, 16, 30) },
    },
  };
  expect(friendSortDetail(friend, 'level', stale)?.text).toBe('QQ 等级：64');
  expect(friendSortDetail(friend, 'level', stale)?.title).toContain('缓存已过期');
  expect(friendSortDetail(friend, 'level', stale)?.title).toContain('0:30');
  expect(friendSortDetail(friend, 'level', stale)?.title).toContain('北京时间');
  expect(friendSortDetail({ ...friend, identityValue: 'u_missing' }, 'uin', rows)?.text).toBe(
    'QQ 号未读取',
  );
  expect(groupSortDetail(group, 'activityScore', {})?.text).toBe('活跃度未读取');
  expect(friendSortDetail({ ...friend, identityLabel: '设备' }, 'uin', rows)?.text).toBe(
    'QQ 号未读取',
  );
});
it('每个排序选项都有明确的行内展示策略', () => {
  for (const sort of Object.keys(FRIEND_SORTS) as FriendSort[]) {
    const detail = friendSortDetail(friend, sort, rows);
    expect(detail === null ? ['remark', 'nick'].includes(sort) : Boolean(detail.text)).toBe(true);
  }
  for (const sort of Object.keys(GROUP_SORTS) as GroupSort[]) {
    const detail = groupSortDetail(group, sort, rows);
    expect(detail === null ? ['remark', 'name'].includes(sort) : Boolean(detail.text)).toBe(true);
  }
});
