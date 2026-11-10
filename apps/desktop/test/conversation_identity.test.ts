import { expect, it } from 'vitest';
import { reconcileConversationRows } from '../src/renderer/src/lib/conversationListOrder';

it('未读或排序变化只替换受影响会话，当前未变会话及其成员保持引用', () => {
  const first = { id: 'one', unreadCount: 0, group: { name: 'one' }, members: [{ id: 'member' }] };
  const second = { ...first, id: 'two' };
  const previous = [first, second];
  const next = reconcileConversationRows(previous, [
    { ...second, unreadCount: 1 },
    { ...first, group: { ...first.group }, members: [{ id: 'member' }] },
  ]);
  expect(next[1]).toBe(first);
  expect(next[0]).not.toBe(second);
  expect(next[0]?.members).toBe(second.members);
  expect(reconcileConversationRows(next, structuredClone(next))).toBe(next);
});

it('真实名称、预览与成员变化仍替换，删除会话不会留在结果中', () => {
  const previous = [{ id: 'one', group: { name: 'old' }, preview: 'old' }];
  const next = reconcileConversationRows(previous, [
    { id: 'one', group: { name: 'new' }, preview: 'new' },
  ]);
  expect(next[0]).not.toBe(previous[0]);
  expect(next[0]?.group.name).toBe('new');
  expect(reconcileConversationRows(next, [])).toEqual([]);
});
