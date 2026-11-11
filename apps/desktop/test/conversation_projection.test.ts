import { expect, it, vi } from 'vitest';
import { createConversationProjection } from '../src/renderer/src/lib/conversationProjection';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';

const demo = createTemplateDemoData();
const group = demo.conversations.find((row) => row.type === 'group')!;

it('未变群资料和不同层的会话投影分别复用，不因基准行交替而打散缓存', () => {
  const project = vi.fn((_detail: object, previous: Conversation = group) => ({ ...previous }));
  const cache = createConversationProjection(project);
  const detail = {};
  const base = { ...group },
    badge = { ...group, unreadCount: 2 };
  const plain = cache.group(detail);
  const first = cache.group(detail, base);
  const second = cache.group(detail, badge);
  expect(cache.group(detail, base)).toBe(first);
  expect(cache.group(detail, badge)).toBe(second);
  expect(cache.group(detail)).toBe(plain);
  expect(project).toHaveBeenCalledTimes(3);
});

it('元数据和会话任一不可变输入变化均重投影，新上下文不借用旧账号结果', () => {
  const project = vi.fn((_detail: object, previous: Conversation = group) => ({ ...previous }));
  const cache = createConversationProjection(project);
  const detail = {};
  const old = cache.group(detail, group);
  expect(cache.group({ ...detail }, group)).not.toBe(old);
  expect(cache.group(detail, { ...group, unreadCount: 8 })).not.toBe(old);
  expect(createConversationProjection(project).group(detail, group)).not.toBe(old);
});

it('成员状态按输入和归属复用，变更仍可撤销，不给非群会话套群资料', () => {
  const cache = createConversationProjection(
    (_detail: object, previous: Conversation = group) => previous,
  );
  const unknown = { ...group, group: { ...group.group, membershipKnown: false } };
  const listed = cache.membership(unknown, true);
  expect(cache.membership(unknown, true)).toBe(listed);
  expect(cache.membership(listed, true)).toBe(listed);
  const left = cache.membership(unknown, false);
  expect(left).not.toBe(listed);
  expect(left.type === 'group' && left.group.listed).toBe(false);
  const direct = demo.conversations.find((row) => row.type === 'direct')!;
  expect(cache.membership(direct, true)).toBe(direct);
});
