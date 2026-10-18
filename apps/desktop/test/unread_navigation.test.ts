import { expect, it } from 'vitest';
import { firstUnreadConversation } from '../src/renderer/src/lib/unreadNavigation';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

it('定位遵循列表的置顶顺序，跳过已读和免打扰；不改变会话或未读数', () => {
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
  ).toBeNull();
  expect(firstUnreadConversation([], {})).toBeNull();
  expect(JSON.stringify(rows)).toBe(before);
});
