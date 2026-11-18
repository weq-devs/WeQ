// @vitest-environment node
import { expect, it } from 'vitest';
import {
  firstUnreadConversation,
  firstUnreadMessage,
} from '../src/renderer/src/lib/unreadNavigation';
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
  expect(firstUnreadConversation(rows, {})?.id).toBe('pinned');
  expect(firstUnreadConversation(rows, { pinned: { pinned: false } })?.id).toBe('ordinary');
  expect(firstUnreadConversation(rows, { muted: { muted: false } })?.id).toBe('muted');
  expect(
    firstUnreadConversation(rows, { pinned: { muted: true }, ordinary: { muted: true } }),
  ).toHaveProperty('id', 'muted');
  expect(firstUnreadConversation([], {})).toBeNull();
  expect(JSON.stringify(rows)).toBe(before);
});

it('普通未读优先于置顶免打扰，全部已读时没有定位目标', () => {
  const base = createTemplateDemoData().conversations[0]!;
  const rows = [
    { ...base, id: 'muted', unreadCount: 5, preference: { pinned: true, muted: true } },
    { ...base, id: 'ordinary', unreadCount: 1, preference: { pinned: false, muted: false } },
  ];
  expect(firstUnreadConversation(rows, {})?.id).toBe('ordinary');
  expect(firstUnreadConversation(rows, { ordinary: { muted: true } })?.id).toBe('muted');
  expect(
    firstUnreadConversation(
      rows.map((row) => ({ ...row, unreadCount: 0 })),
      {},
    ),
  ).toBeNull();
});

it('群助手有未读就参与定位，不再依赖角标显示偏好', () => {
  const base = createTemplateDemoData().conversations[0]!;
  const assistant = {
    ...base,
    id: 'merged:group-assistant',
    type: 'merged' as const,
    mergedKind: 'groupAssistant' as const,
    title: '群助手',
    otherUser: null,
    group: null,
    members: [],
    unreadCount: 10,
    preference: { pinned: true, muted: true, blocked: false },
  };
  const muted = { ...base, id: 'muted', unreadCount: 2, preference: { muted: true } };
  expect(firstUnreadConversation([assistant, muted], {})?.id).toBe(assistant.id);
  expect(firstUnreadConversation([assistant], {})?.id).toBe(assistant.id);
  expect(firstUnreadConversation([{ ...assistant, unreadCount: 0 }], {})).toBeNull();
});
