// @vitest-environment node
import { expect, it } from 'vitest';
import { firstUnreadConversation } from '../src/renderer/src/lib/unreadNavigation';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

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

it('群助手仅在显示汇总数且有未读时参与免打扰定位，并遵循置顶顺序', () => {
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
  expect(firstUnreadConversation([assistant, muted], {})?.id).toBe('muted');
  expect(firstUnreadConversation([assistant], {})).toBeNull();
  expect(firstUnreadConversation([assistant, muted], {}, true)?.id).toBe(assistant.id);
  expect(firstUnreadConversation([{ ...assistant, unreadCount: 0 }], {}, true)).toBeNull();
});
