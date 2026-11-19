// @vitest-environment node
import { expect, it } from 'vitest';
import {
  countMessageNavigationUnread,
  firstUnreadConversation,
  firstUnreadMessage,
} from '../src/renderer/src/lib/unreadNavigation';
import type { MergedConversation } from '../src/renderer/src/im-template/template/types';
import { createTemplateDemoData } from './support/templateDemoData';

it('首条未读序号缺失时选择区间内最早的消息，不落到已读消息或依赖输入顺序', () => {
  const read = { msgSeq: '9007199254740992' };
  const first = { msgSeq: '9007199254740994' };
  const later = { msgSeq: '9007199254740995' };
  const rows = [later, read, { msgSeq: '' }, first];
  expect(firstUnreadMessage(rows, '9007199254740993')).toBe(first);
  expect(firstUnreadMessage(rows, first.msgSeq)).toBe(first);
  expect(firstUnreadMessage([read], '9007199254740993')).toBeUndefined();
  expect(firstUnreadMessage([], '9007199254740993')).toBeUndefined();
});

it('定位遵循列表的置顶顺序，普通未读优先；不改变会话或未读数', () => {
  const base = createTemplateDemoData().conversations[0]!;
  const rows = [
    { ...base, id: 'read', unreadCount: 0 },
    {
      ...base,
      id: 'ordinary',
      unreadCount: 10,
      preference: { pinned: false, muted: false, blocked: false },
    },
    {
      ...base,
      id: 'muted',
      unreadCount: 3,
      preference: { pinned: true, muted: true, blocked: false },
    },
    {
      ...base,
      id: 'pinned',
      unreadCount: 2,
      preference: { pinned: true, muted: false, blocked: false },
    },
  ];
  const before = JSON.stringify(rows);
  expect(firstUnreadConversation(rows, {}, {})?.id).toBe('pinned');
  expect(firstUnreadConversation(rows, { pinned: { pinned: false } }, {})?.id).toBe('ordinary');
  expect(firstUnreadConversation(rows, { muted: { muted: false } }, {})?.id).toBe('muted');
  expect(
    firstUnreadConversation(rows, { pinned: { muted: true }, ordinary: { muted: true } }, {}),
  ).toHaveProperty('id', 'muted');
  expect(firstUnreadConversation([], {}, {})).toBeNull();
  expect(JSON.stringify(rows)).toBe(before);
});

it('普通未读优先于置顶免打扰，全部已读时没有定位目标', () => {
  const base = createTemplateDemoData().conversations[0]!;
  const rows = [
    { ...base, id: 'muted', unreadCount: 5, preference: { pinned: true, muted: true } },
    { ...base, id: 'ordinary', unreadCount: 1, preference: { pinned: false, muted: false } },
  ];
  expect(firstUnreadConversation(rows, {}, {})?.id).toBe('ordinary');
  expect(firstUnreadConversation(rows, { ordinary: { muted: true } }, {})?.id).toBe('muted');
  expect(
    firstUnreadConversation(
      rows.map((row) => ({ ...row, unreadCount: 0 })),
      {},
      {},
    ),
  ).toBeNull();
});

it('关闭角标的聚合入口连置顶也排在免打扰之后，仍可作为最后的定位目标', () => {
  const base = createTemplateDemoData().conversations[0]!;
  const assistant: MergedConversation = {
    ...base,
    id: 'merged:group-assistant',
    type: 'merged',
    mergedKind: 'groupAssistant',
    title: '群助手',
    otherUser: null,
    group: null,
    members: [],
    unreadCount: 10,
    preference: { pinned: true, muted: true, blocked: false },
  };
  const muted = { ...base, id: 'muted', unreadCount: 2, preference: { muted: true } };
  const rows = [assistant, muted];
  expect(firstUnreadConversation(rows, {}, { groupAssistant: false })).toBe(muted);
  expect(firstUnreadConversation(rows, {}, { groupAssistant: true })).toBe(assistant);
  expect(firstUnreadConversation([assistant], {}, { groupAssistant: false })).toBe(assistant);
  expect(firstUnreadConversation([{ ...assistant, unreadCount: 0 }], {}, {})).toBeNull();
});

it('主导航只汇总已开启角标的聚合成员，并排除免打扰未读', () => {
  const base = createTemplateDemoData().conversations[0]!;
  const aggregate: MergedConversation = {
    ...base,
    id: 'merged:guild-direct',
    type: 'merged',
    mergedKind: 'guildDirect',
    title: '频道私聊',
    otherUser: null,
    group: null,
    members: [],
    unreadCount: 12,
  };
  const ordinary = { ...base, id: 'ordinary', unreadCount: 3 };
  const guildRow = { ...base, id: 'guild:first', unreadCount: 5 };
  const muted = { ...base, id: 'guild:muted', unreadCount: 7, preference: { muted: true } };
  const directory = {
    regular: [aggregate, ordinary],
    groupAssistant: [],
    official: [],
    service: [],
    guild: [guildRow, muted],
    hidden: [],
    deleted: [],
    clone: [],
    assistant: [],
  };
  expect(countMessageNavigationUnread(directory, {}, { guildDirect: false })).toBe(3);
  expect(countMessageNavigationUnread(directory, {}, { guildDirect: true })).toBe(8);
  expect(countMessageNavigationUnread(directory, { ordinary: { muted: true } }, {})).toBe(0);
  expect(firstUnreadConversation([aggregate, muted], {}, { guildDirect: false })).toBe(muted);
  expect(firstUnreadConversation([aggregate, muted], {}, { guildDirect: true })).toBe(aggregate);
});
