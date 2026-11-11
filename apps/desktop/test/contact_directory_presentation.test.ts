import { afterEach, expect, it, vi } from 'vitest';
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
  friendMetric,
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
afterEach(() => vi.useRealTimers());
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

it('机器人和企业用户不展示获赞排序详情，也不使用旧获赞缓存排序', () => {
  const bot: Contact = { ...friend, kind: 'bot' };
  const enterprise: Contact = {
    ...friend,
    extInfo: { isEnterprise: true, interactMarks: [], privileges: [], interests: [], album: [] },
  };
  for (const contact of [bot, enterprise]) {
    expect(friendSortDetail(contact, 'likeCount', rows)).toBeNull();
    expect(friendMetric(rows, contact, 'likeCount')).toBeNull();
    expect(friendMetric(rows, contact, 'level')).toBe(64);
  }
  expect(friendMetric(rows, friend, 'likeCount')).toBe(12580);
});

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
  '按 %s 排序统一显示出生日期与年龄，缺年龄且无有效完整生日时显示问号',
  (sort) => {
    expect(friendSortDetail(friend, sort, rows)?.text).toBe('2000-02-29 （23 岁）');
    expect(friendSortDetail({ ...friend, birthYear: undefined }, sort, rows)?.text).toBe(
      '????-02-29 （23 岁）',
    );
    expect(friendSortDetail({ ...friend, birthYear: 2001, age: 0 }, sort, rows)?.text).toBe(
      '2001-02-?? （?? 岁）',
    );
    expect(friendSortDetail({ ...friend, birthMonth: 13 }, sort, rows)?.text).toBe(
      '2000-??-?? （23 岁）',
    );
  },
);
it('缺失年龄按北京时间的完整生日推算周岁，与原始年龄使用相同文案', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T16:00:00Z'));
  const contact = { ...friend, age: undefined, birthYear: 2000, birthMonth: 11, birthDay: 10 };
  expect(friendSortDetail(contact, 'age', {})?.text).toBe('2000-11-10 （26 岁）');
  expect(friendSortDetail({ ...contact, birthDay: 11 }, 'age', {})?.text).toBe(
    '2000-11-11 （25 岁）',
  );
  expect(friendSortDetail({ ...contact, birthYear: undefined }, 'age', {})?.text).toBe(
    '????-11-10 （?? 岁）',
  );
});
it('星座补全摘要不显示排序边界，唯一推断年标注来源并提供候选详情', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T12:00:00+08:00'));
  const contact = {
    ...friend,
    age: 16,
    birthYear: undefined,
    birthMonth: undefined,
    birthDay: undefined,
    extInfo: { ...friend.extInfo!, constellation: 1 },
  };
  for (const sort of ['age', 'birthday'] as const) {
    const detail = friendSortDetail(contact, sort, {});
    expect(detail?.text).toBe('2010 年（推断） · 水瓶座 · 月日未记录 （16 岁）');
    expect(detail?.text).not.toContain('01-20');
    expect(detail?.title).toBe('候选生日：2010 年 1 月 20 日至2 月 18 日');
  }
});
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
