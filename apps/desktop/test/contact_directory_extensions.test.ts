import { expect, it } from 'vitest';
import {
  sortFriends,
  sortGroups,
  groupFriends,
  groupExtendedGroups,
  directoryTimeSeeds,
  type DirectoryRows,
} from '../src/renderer/src/lib/contactListOrder';
import {
  friendSortDetail,
  groupSortDetail,
} from '../src/renderer/src/lib/contactDirectoryPresentation';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';
const friend = (id: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  identityValue: id,
  identityLabel: 'QQ',
  username: id,
  displayName: id,
  avatarUrl: null,
  createdAt: '',
  ...extra,
});
const group = (id: string): GroupConversation => ({
  id,
  type: 'group',
  updatedAt: '',
  otherUser: null,
  lastMessage: null,
  members: [],
  group: {
    id,
    name: id,
    identityLabel: '群',
    identityValue: id,
    avatarUrl: null,
    memberCount: 1,
    role: 'member',
  },
});
const ready = (value: number | string | string[]) => ({
  value,
  state: 'ready' as const,
  attemptedAt: 1,
});

it('新增数值排序保留零值、旧缓存与双向未知沉底', () => {
  for (const sort of ['energy', 'affinity', 'lastMessageAt'] as const) {
    const rows: DirectoryRows = {
      'friend:a': { [sort]: ready(100) },
      'friend:z': { [sort]: ready(sort === 'lastMessageAt' ? 1 : 0) },
    };
    const items = [friend('none'), friend('z'), friend('a')];
    expect(sortFriends(items, sort, true, rows).map((row) => row.id)).toEqual(['a', 'z', 'none']);
    expect(sortFriends(items, sort, false, rows).map((row) => row.id)).toEqual(['z', 'a', 'none']);
  }
  for (const sort of ['joinedAt', 'lastMessageAt', 'lastSpokeAt'] as const) {
    const rows: DirectoryRows = {
      'group:a': { [sort]: ready(101) },
      'group:z': { [sort]: ready(100) },
    };
    expect(
      sortGroups([group('none'), group('a'), group('z')], sort, false, rows).map((row) => row.id),
    ).toEqual(['z', 'a', 'none']);
    expect(
      sortGroups([group('none'), group('a'), group('z')], sort, true, rows).map((row) => row.id),
    ).toEqual(['a', 'z', 'none']);
  }
});
it('学校合并本地及全部可见经历，同校去重，未知沉底', () => {
  const a = friend('a', {
    extInfo: { school: ' 厦门大学 ', interests: [], privileges: [], interactMarks: [], album: [] },
  });
  const rows: DirectoryRows = {
    'friend:a': { schools: ready(['厦门大学', '实验中学', ' 实验中学 ']) },
  };
  const groups = groupFriends([a, a, friend('none')], 'school', rows);
  expect(groups.map((row) => row.name)).toEqual(['厦门大学', '实验中学', '学校未知']);
  expect(groups.map((row) => row.items.map((item) => item.id))).toEqual([['a'], ['a'], ['none']]);
  expect(new Set(groups.flatMap((row) => row.items.map((item) => item.id))).size).toBe(2);
});
it('关系类型优先级固定，非好友不变成已删除好友', () => {
  const items = [
    friend('none'),
    friend('non', { isFriend: false }),
    friend('friend', { isFriend: true }),
    friend('bot', { kind: 'bot', isFriend: true }),
    friend('device', { identityLabel: '设备' }),
    friend('self:me'),
  ];
  expect(groupFriends(items, 'type', {}).map((row) => row.name)).toEqual([
    '我自己',
    '我的设备',
    '机器人',
    '当前好友',
    '非好友',
    '关系待确认',
  ]);
});
it('添加来源只使用明确文案，数字扩展按原值分组，冻结零为正常', () => {
  expect(
    groupFriends([friend('a'), friend('b')], 'source', {
      'friend:a': { source: ready(' 通过群聊 ') },
    }).map((row) => row.name),
  ).toEqual(['QQ 群', '添加来源未知']);
  const rows: DirectoryRows = {
    'group:a': { grade: ready(0), freezeState: ready(0) },
    'group:b': { grade: ready(5), freezeState: ready(1) },
    'group:c': { grade: ready(1), freezeState: ready(9) },
  };
  const items = ['none', 'b', 'c', 'a'].map(group);
  expect(groupExtendedGroups(items, 'grade', rows).map((row) => row.label)).toEqual([
    'grade：0',
    'grade：1',
    'grade：5',
    'grade 未知',
  ]);
  expect(groupExtendedGroups(items, 'freezeState', rows).map((row) => row.label)).toEqual([
    '正常',
    '已冻结',
    '冻结状态：9',
    '冻结状态未知',
  ]);
});
it('不同 QQ 群及不同群来源文案统一归类，但保留各自的来源群指标', () => {
  const rows: DirectoryRows = {
    'friend:a': { source: ready('通过群聊：实验群'), sourceGroup: ready('10001') },
    'friend:b': { source: ready('来自另一个群'), sourceGroup: ready('10002') },
    'friend:c': { source: ready('通过 QQ 群搜索') },
    'friend:d': { source: ready('QQ 号搜索') },
  };
  const groups = groupFriends(
    ['a', 'b', 'c', 'd'].map((id) => friend(id)),
    'source',
    rows,
  );
  const qq = groups.find((group) => group.name === 'QQ 群');
  expect(qq?.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  expect(groups).toHaveLength(2);
  expect(rows['friend:a']?.sourceGroup?.value).toBe('10001');
  expect(rows['friend:b']?.sourceGroup?.value).toBe('10002');
});
it('时间与画像空状态不伪造默认值', () => {
  expect(
    friendSortDetail(friend('device', { identityLabel: '设备' }), 'lastMessageAt', {})?.text,
  ).toBe('私聊联系时间不适用');
  expect(friendSortDetail(friend('a'), 'affinity', {})?.text).toBe('AI 好感度未分析');
  const rows: DirectoryRows = {
    'friend:a': { lastMessageAt: { state: 'ready', attemptedAt: 0 } },
    'group:a': { lastSpokeAt: { state: 'ready', attemptedAt: 0 } },
  };
  expect(friendSortDetail(friend('a'), 'lastMessageAt', rows)?.text).toBe('无本地私聊消息记录');
  expect(groupSortDetail(group('a').group, 'lastSpokeAt', rows)?.text).toBe('无本地本人发言记录');
  expect(
    groupSortDetail(group('a').group, 'joinedAt', { 'group:a': { joinedAt: ready(1704038407) } })
      ?.text,
  ).toContain('2024-01-01 00:00:07');
});
it('会话种子只接受有效消息，不使用草稿时间或失败发送', () => {
  const row = group('a');
  const message = {
    id: 'm',
    senderId: 'u_me',
    body: '你好',
    directoryTime: 1704067200,
    createdAt: '2024-01-01T00:00:00Z',
  };
  row.lastMessage = message;
  expect(directoryTimeSeeds([row], 'u_me')['group:a']?.lastSpokeAt?.value).toBe(1704067200);
  for (const body of ['[发送中] 你好', '[排队中] 你好', '[发送失败] 你好']) {
    row.lastMessage = { ...message, directoryTime: undefined, body };
    expect(directoryTimeSeeds([row])).toEqual({});
  }
  row.lastMessage = { ...message, directoryTime: undefined, kind: 'grayTipRevoke' };
  expect(directoryTimeSeeds([row])).toEqual({});
});
