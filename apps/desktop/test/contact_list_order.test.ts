import { afterEach, expect, it, vi } from 'vitest';
import {
  sortFriends,
  sortGroups,
  groupFriends,
  locationGroup,
  FRIEND_SORTS,
  GROUP_SORTS,
  zodiac,
  defaultDescending,
  type FriendSort,
  type GroupSort,
} from '../src/renderer/src/lib/contactListOrder';
import type { Contact, Conversation } from '../src/renderer/src/im-template/template/types';
import type { ContactMetricRows } from '@weq/service';

const friend = (id: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  identityValue: id,
  identityLabel: 'QQ',
  username: id,
  displayName: id,
  createdAt: '',
  avatarUrl: null,
  ...extra,
});
const group = (
  id: string,
  extra: Partial<Extract<Conversation, { type: 'group' }>['group']> = {},
): Extract<Conversation, { type: 'group' }> => ({
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
    ...extra,
  },
});
const ready = (value: number) => ({ value, attemptedAt: 1, state: 'ready' as const });
afterEach(() => vi.useRealTimers());

it('年龄按完整生日精确排序，缺生日回退资料年龄，推算年龄不单独分档', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00+08:00'));
  const items = [
    friend('a-younger', { age: 99, birthYear: 2000, birthMonth: 6, birthDay: 2 }),
    friend('z-older', { age: 1, birthYear: 2000, birthMonth: 6, birthDay: 1 }),
    friend('derived', { birthYear: 1999, birthMonth: 12, birthDay: 31 }),
    friend('raw', { age: 26 }),
    friend('none'),
  ];
  expect(sortFriends(items, 'age', true, {}).map((row) => row.id)).toEqual([
    'derived',
    'z-older',
    'a-younger',
    'raw',
    'none',
  ]);
  expect(sortFriends(items, 'age', false, {}).map((row) => row.id)).toEqual([
    'raw',
    'a-younger',
    'z-older',
    'derived',
    'none',
  ]);
});

it('同一天生日按年龄继续双向排序，未知年龄沉底，不按名称或年龄来源分档', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00+08:00'));
  const items = [
    friend('a-unknown', { birthMonth: 6, birthDay: 1 }),
    friend('b-younger', { age: 20, birthMonth: 6, birthDay: 1 }),
    friend('z-older', { birthYear: 2000, birthMonth: 6, birthDay: 1 }),
  ];
  expect(sortFriends(items, 'birthday', false, {}).map((row) => row.id)).toEqual([
    'b-younger',
    'z-older',
    'a-unknown',
  ]);
  expect(sortFriends(items, 'birthday', true, {}).map((row) => row.id)).toEqual([
    'z-older',
    'b-younger',
    'a-unknown',
  ]);
});

it('添加时间按原始秒值双向排序，同一分钟内相差一秒也不按名称打平', () => {
  const rows: ContactMetricRows = {
    'friend:a': { addedAt: ready(1704038408) },
    'friend:b': { addedAt: ready(1704038407) },
  };
  const items = [friend('none'), friend('a'), friend('b')];
  expect(sortFriends(items, 'addedAt', false, rows).map((row) => row.id)).toEqual([
    'b',
    'a',
    'none',
  ]);
  expect(sortFriends(items, 'addedAt', true, rows).map((row) => row.id)).toEqual([
    'a',
    'b',
    'none',
  ]);
});

it('年龄排序保留已知出生年份；年份按每年分组，不根据年龄反推', () => {
  const a = friend('a', { age: 30, birthYear: 2005 }),
    b = friend('b', { age: 20, birthYear: 1990 }),
    c = friend('c', { age: 18 });
  expect(sortFriends([b, a], 'age', true, {}).map((row) => row.id)).toEqual(['b', 'a']);
  expect(groupFriends([b, c, a], 'birthYear', {}).map((row) => row.name)).toEqual([
    '2005 年',
    '1990 年',
    '出生年份未知',
  ]);
});

it('月日未知时按年龄落到已知年份的两端，升降序均保留年份顺序', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00+08:00'));
  const items = [
    friend('start', { birthYear: 2000, age: 26 }),
    friend('january', { birthYear: 2000, birthMonth: 1, birthDay: 1 }),
    friend('december', { birthYear: 2000, birthMonth: 12, birthDay: 31 }),
    friend('end', { birthYear: 2000, age: 25 }),
    friend('next-year', { birthYear: 2001, birthMonth: 1, birthDay: 1 }),
    friend('none'),
  ];
  expect(sortFriends(items, 'age', true, {}).map((row) => row.id)).toEqual([
    'start',
    'january',
    'december',
    'end',
    'next-year',
    'none',
  ]);
  expect(sortFriends(items, 'age', false, {}).map((row) => row.id)).toEqual([
    'next-year',
    'end',
    'december',
    'january',
    'start',
    'none',
  ]);
});
it('备注回退昵称、中文拼音、空值双向沉底且同值稳定', () => {
  const rows = [
    friend('none'),
    friend('b', { nick: '张三' }),
    friend('a', { remark: '阿明', nick: '其他' }),
  ];
  expect(sortFriends(rows, 'remark', false, {}).map((row) => row.id)).toEqual(['a', 'b', 'none']);
  expect(sortFriends(rows, 'nick', true, {}).at(-1)?.id).toBe('none');
  expect(
    sortFriends([friend('b', { age: 20 }), friend('a', { age: 20 })], 'age', true, {}).map(
      (row) => row.id,
    ),
  ).toEqual(['a', 'b']);
});
it('生日忽略年份，支持闰日并拒绝无效日期', () => {
  const rows = [
    friend('invalid', { birthMonth: 2, birthDay: 30 }),
    friend('march', { birthMonth: 3, birthDay: 1, birthYear: 1900 }),
    friend('leap', { birthMonth: 2, birthDay: 29, birthYear: 2000 }),
  ];
  expect(sortFriends(rows, 'birthday', false, {}).map((row) => row.id)).toEqual([
    'leap',
    'march',
    'invalid',
  ]);
  expect(zodiac(13, 1)).toBeNull();
  expect(zodiac(2, 29)).toBe('双鱼座');
});
it('境内按省、境外按国家并统一编码与名称', () => {
  const regions = [
    { code: '1', name: '中国', children: [{ code: '35', name: '福建', children: [] }] },
    { code: '2', name: '美国', children: [] },
  ];
  const ext = (country: string, province = '') => ({
    country,
    province,
    interests: [],
    album: [],
    interactMarks: [],
    privileges: [],
  });
  expect(locationGroup(ext('1', '35'), regions)).toBe('福建');
  expect(locationGroup(ext('中国', '福建'), regions)).toBe('福建');
  expect(locationGroup(ext('2', '加利福尼亚'), regions)).toBe('美国');
  expect(locationGroup(ext('日本', '东京'), regions)).toBe('日本');
  expect(locationGroup(ext('境外'), regions)).toBe('境外（国家未知）');
  expect(locationGroup(undefined, regions)).toBe('所在地未知');
});
it('在线共同群列表长度参与排序，真实零排在未知前', () => {
  const rows: ContactMetricRows = {
    'friend:a': { commonGroups: { value: [], attemptedAt: 1, state: 'ready' } },
    'friend:b': {
      commonGroups: {
        value: [{ groupCode: '123', name: '合成群' }],
        attemptedAt: 1,
        state: 'ready',
      },
    },
  };
  expect(
    sortFriends([friend('none'), friend('a'), friend('b')], 'commonGroups', false, rows).map(
      (row) => row.id,
    ),
  ).toEqual(['a', 'b', 'none']);
});
it.each(Object.keys(FRIEND_SORTS) as FriendSort[])('好友全部排序依据可用：%s', (sort) => {
  const metrics: ContactMetricRows = {
    'friend:a': {
      level: ready(1),
      likeCount: ready(1),
      addedAt: ready(1),
      commonFriends: ready(1),
      commonGroups: { value: [], attemptedAt: 1, state: 'ready' },
    },
  };
  expect(
    sortFriends(
      [
        friend('none'),
        friend('a', {
          identityValue: '123',
          remark: '阿',
          nick: '阿',
          age: 20,
          intimacy: 1,
          birthMonth: 1,
          birthDay: 1,
        }),
      ],
      sort,
      true,
      metrics,
    )[0]?.id,
  ).toBe('a');
});
it.each(Object.keys(GROUP_SORTS) as GroupSort[])('群全部排序依据可用且空值沉底：%s', (sort) => {
  const metrics: ContactMetricRows = {
    'group:a': { activityScore: ready(1), friendCount: ready(0) },
  };
  expect(
    sortGroups(
      [
        group('none', { memberCount: 0 }),
        group('a', {
          identityValue: '123',
          remark: '阿',
          name: '阿',
          memberCount: 2,
          createTime: '2020-01-01',
        }),
      ],
      sort,
      true,
      metrics,
    )[0]?.id,
  ).toBe('a');
});

it('QQ 号和群号按数值而非字典序排列，不转换为浮点数，未知号码双向沉底', () => {
  const ids = ['100', '9', '9007199254740993', '9007199254740992', '0', 'u_unknown'];
  const expected = ['9', '100', '9007199254740992', '9007199254740993'];
  for (const descending of [false, true]) {
    const known = descending ? [...expected].reverse() : expected;
    expect(
      sortFriends(
        ids.map((id) => friend(id)),
        'uin',
        descending,
        {},
      )
        .slice(0, 4)
        .map((row) => row.id),
    ).toEqual(known);
    expect(
      sortGroups(
        ids.map((id) => group(id)),
        'groupCode',
        descending,
        {},
      )
        .slice(0, 4)
        .map((row) => row.id),
    ).toEqual(known);
  }
  expect(defaultDescending('uin')).toBe(false);
  expect(defaultDescending('groupCode')).toBe(false);
  expect(
    sortFriends([friend('1', { identityLabel: '设备' }), friend('100')], 'uin', false, {}).map(
      (row) => row.id,
    ),
  ).toEqual(['100', '1']);
});
it('派生分组使用非 QQ ID，预设关系不当作已建立关系', () => {
  const groups = groupFriends(
    [
      friend('a', { extRelation: { preselectedIds: [1] } }),
      friend('b', { extRelation: { preselectedIds: [], displayId: 26 } }),
    ],
    'relation',
    {},
  );
  expect(groups.map((row) => row.name)).toEqual(['死党', '无亲密关系']);
  expect(groups.every((row) => typeof row.id === 'string')).toBe(true);
});

it('群名按原始详情判断缺失，不把兜底群号当名称，也不误伤恰好等于群号的真实名称', () => {
  const rows = [group('1', { name: '旧的显示名' }), group('123', { name: '123' })];
  expect(
    sortGroups(
      rows,
      'name',
      true,
      {},
      new Map([
        ['1', ''],
        ['123', '123'],
      ]),
    ).map((row) => row.id),
  ).toEqual(['123', '1']);
});
